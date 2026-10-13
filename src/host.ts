import { HostLogPair, LogUnavailable } from "./host-logs.js";
import { createSurfaceRegistry } from "./host-surfaces.js";
import {
  createEnvelope,
  type Envelope,
  isId,
  MAX_FRAME_BYTES,
  MAX_SESSION_ENTRIES,
} from "./protocol.js";
import {
  parseHostRequest,
  type Grant,
  type HostRequest,
  type HostResponse,
  type JsonValue,
  type Scope,
  type SessionInfo,
  type SessionMetadata,
} from "./host-protocol.js";
import { createSessionLog } from "./session-log.js";
import type {
  ActiveSession,
  AdapterEvent,
  Attachment,
  HostController,
  HostOptions,
  LocalProfile,
  SessionAdapter,
} from "./host-types.js";
export type * from "./host-types.js";

const requiredScopes: Record<HostRequest["op"], Scope> = {
  "sessions.list": "sessions:list",
  "sessions.chat": "sessions:chat",
  "sessions.create": "sessions:create",
  "sessions.configure": "sessions:configure",
  "tasks.delegate": "tasks:delegate",
  "ui.action": "ui:action",
  "ui.get": "sessions:list",
};

type SubmitRequest = Extract<
  HostRequest,
  { op: "sessions.chat" | "tasks.delegate" | "ui.action" }
>;

class HostFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class LocalHost implements HostController {
  readonly hostEpoch = crypto.randomUUID();
  private readonly active = new Map<string, ActiveSession>();
  private readonly logs = new Map<string, Promise<HostLogPair>>();
  private readonly seen = new Map<string, Set<string>>();
  private readonly revoked = new Set<string>();
  private readonly operations = new Map<
    string,
    { grantId: string; requestId: string; abort: AbortController }
  >();
  private readonly surfaces = createSurfaceRegistry();
  private closing: Promise<void> | null = null;
  private attaching: Promise<void> = Promise.resolve();
  constructor(private readonly options: HostOptions) {}
  get hostId(): string {
    return this.options.store.hostId;
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  private timestamp(): string {
    return new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  private profile(id: string): LocalProfile {
    const profile = this.options.profiles.find((item) => item.id === id);
    if (!profile)
      throw new HostFailure("profile", "Local profile is unavailable");
    return profile;
  }

  private grant(grantId: string): Grant {
    if (this.closing || !this.options.store.healthy)
      throw new HostFailure("offline", "Host is unavailable");
    const grant = this.options.store
      .snapshot()
      .grants.find((item) => item.id === grantId);
    if (!grant || this.revoked.has(grantId) || grant.revokedAt !== null)
      throw new HostFailure("forbidden", "Device grant is unavailable");
    if (Date.parse(grant.expiresAt) <= this.now())
      throw new HostFailure("expired", "Device grant expired");
    return grant;
  }

  private visible(grant: Grant, session: SessionMetadata): boolean {
    return (
      grant.profileIds.includes(session.profileId) &&
      (grant.sessionAccess === "registered" ||
        grant.sessionAccess.includes(session.id))
    );
  }

  private authorize(grantId: string, request: HostRequest): Grant {
    const grant = this.grant(grantId);
    if (request.hostId !== this.hostId || request.hostEpoch !== this.hostEpoch)
      throw new HostFailure("stale", "Host identity or epoch changed");
    if (!grant.scopes.includes(requiredScopes[request.op]))
      throw new HostFailure(
        "forbidden",
        "Grant does not permit this operation",
      );
    this.authorizeTarget(grant, request);
    return grant;
  }

  private authorizeTarget(grant: Grant, request: HostRequest): void {
    if (request.op === "sessions.list") return;
    if (request.op === "sessions.create") {
      if (!grant.profileIds.includes(request.args.profileId))
        throw new HostFailure("forbidden", "Profile is not approved");
      this.profile(request.args.profileId);
      return;
    }
    const session = this.options.store
      .snapshot()
      .sessions.find((item) => item.id === request.args.sessionId);
    if (!session || !this.visible(grant, session))
      throw new HostFailure("forbidden", "Session is not approved");
    if (!this.active.has(session.id))
      throw new HostFailure("offline", "Session is offline");
  }

  private consume(grantId: string, id: string): void {
    const seen = this.seen.get(grantId) ?? new Set<string>();
    if (seen.has(id))
      throw new HostFailure("replay", "Request ID was already used");
    if (seen.size >= MAX_SESSION_ENTRIES)
      throw new HostFailure("limit", "Host request limit reached");
    seen.add(id);
    this.seen.set(grantId, seen);
  }

  async logPair(sessionId: string): Promise<HostLogPair> {
    let pair = this.logs.get(sessionId);
    if (!pair) {
      pair = this.openLogs(sessionId);
      this.logs.set(sessionId, pair);
    }
    return pair;
  }

  private async openLogs(sessionId: string): Promise<HostLogPair> {
    const factory =
      this.options.logFactory ??
      ((id: string) => createSessionLog({ sessionId: id }));
    const ingress = await factory(sessionId, "ingress");
    try {
      return new HostLogPair(
        { ingress, egress: await factory(sessionId, "egress") },
        () => this.operations.get(sessionId)?.abort.abort(),
      );
    } catch (error) {
      await ingress.close();
      throw error;
    }
  }

  async attach(attachment: Attachment): Promise<SessionInfo> {
    const result = this.attaching
      .then(() => this.attachSession(attachment))
      .catch(async (error: unknown) => {
        await attachment.adapter.detach();
        throw error;
      });
    this.attaching = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  sessions(): SessionInfo[] {
    return this.options.store.snapshot().sessions.map((metadata) => ({
      ...metadata,
      online: this.active.has(metadata.id),
    }));
  }

  async detach(sessionId: string, adapter: SessionAdapter): Promise<void> {
    if (this.active.get(sessionId)?.adapter !== adapter) return;
    this.active.delete(sessionId);
    this.surfaces.clear(sessionId);
    this.operations.get(sessionId)?.abort.abort();
    await adapter.detach();
  }

  private assertOpen(): void {
    if (this.closing || !this.options.store.healthy)
      throw new HostFailure("offline", "Host is unavailable");
  }

  private async attachSession(attachment: Attachment): Promise<SessionInfo> {
    this.assertOpen();
    const profile = this.profile(attachment.profileId);
    const metadata = this.metadata(
      profile,
      attachment.providerSessionId,
      attachment.label,
    );
    if (this.operations.has(metadata.id))
      throw new HostFailure("busy", "Session is busy");
    this.operations.set(metadata.id, {
      grantId: "local",
      requestId: crypto.randomUUID(),
      abort: new AbortController(),
    });
    try {
      await this.options.store.update((state) => {
        if (
          state.sessions.some(
            (item) =>
              item.provider === metadata.provider &&
              item.providerSessionId === metadata.providerSessionId &&
              item.id !== metadata.id,
          )
        )
          throw new HostFailure(
            "conflict",
            "Provider session is already registered",
          );
        state.sessions = state.sessions.filter(
          (item) => item.id !== metadata.id,
        );
        state.sessions.push(metadata);
      });
      this.assertOpen();
      const previous = this.active.get(metadata.id);
      this.active.delete(metadata.id);
      this.surfaces.clear(metadata.id);
      await previous?.adapter.detach();
      this.assertOpen();
      this.active.set(metadata.id, { metadata, adapter: attachment.adapter });
      return { ...metadata, online: true };
    } finally {
      this.operations.delete(metadata.id);
    }
  }

  private metadata(
    profile: LocalProfile,
    providerSessionId: string,
    label: string,
  ): SessionMetadata {
    const previous = this.options.store
      .snapshot()
      .sessions.find(
        (item) =>
          item.provider === profile.provider &&
          item.providerSessionId === providerSessionId,
      );
    if (previous) return { ...previous, profileId: profile.id, label };
    return {
      id: crypto.randomUUID(),
      provider: profile.provider,
      providerSessionId,
      profileId: profile.id,
      label,
      modelId: profile.defaultModelId,
      createdAt: this.timestamp(),
    };
  }

  async dispatch(grantId: string, value: unknown): Promise<HostResponse> {
    let request: HostRequest;
    try {
      request = parseHostRequest(value);
    } catch {
      return this.failure(
        this.requestId(value),
        new HostFailure("invalid", "Invalid host request"),
      );
    }
    try {
      this.authorize(grantId, request);
      this.consume(grantId, request.id);
      if (request.op === "ui.get")
        return this.success(
          request.id,
          this.surfaceResult(request.args.sessionId),
        );
      return await this.execute(grantId, request);
    } catch (error) {
      return this.failure(request.id, error);
    }
  }

  private requestId(value: unknown): string {
    if (value && typeof value === "object" && "id" in value && isId(value.id))
      return value.id;
    return crypto.randomUUID();
  }

  private async execute(
    grantId: string,
    request: HostRequest,
  ): Promise<HostResponse> {
    const sessionId =
      "sessionId" in request.args ? request.args.sessionId : this.hostEpoch;
    if (this.operations.has(sessionId))
      throw new HostFailure("busy", "Session is busy");
    const abort = new AbortController();
    this.operations.set(sessionId, { grantId, requestId: request.id, abort });
    let reservation: ReturnType<HostLogPair["reserve"]> | undefined;
    try {
      const logs = await this.logPair(sessionId);
      reservation = logs.reserve(
        ["sessions.chat", "tasks.delegate", "ui.action"].includes(request.op),
      );
      await logs.ingress.append(
        createEnvelope(sessionId, "host.request", {
          requestId: request.id,
          op: request.op,
          args: request.args,
        }),
      );
      this.authorize(grantId, request);
      reservation.check();
      const response = await this.runOperation(grantId, request, abort.signal);
      this.authorize(grantId, request);
      await reservation.appendResult(
        createEnvelope(sessionId, "host.result", {
          requestId: request.id,
          ok: response.ok,
          result: response.ok ? response.result : { error: response.error },
        }),
      );
      this.authorize(grantId, request);
      return response;
    } finally {
      reservation?.release();
      this.operations.delete(sessionId);
    }
  }

  private async runOperation(
    grantId: string,
    request: HostRequest,
    signal: AbortSignal,
  ): Promise<HostResponse> {
    try {
      return this.success(
        request.id,
        await this.perform(grantId, request, signal),
      );
    } catch (error) {
      return this.failure(request.id, error);
    }
  }

  private async perform(
    grantId: string,
    request: HostRequest,
    signal: AbortSignal,
  ): Promise<Record<string, JsonValue>> {
    switch (request.op) {
      case "sessions.list":
        return {
          sessions: this.options.store
            .snapshot()
            .sessions.filter((session) =>
              this.visible(this.grant(grantId), session),
            )
            .map((session) => ({
              ...session,
              online: this.active.has(session.id),
            })),
        };
      case "sessions.create":
        return this.create(grantId, request);
      case "sessions.configure":
        return this.configure(grantId, request);
      case "sessions.chat":
      case "tasks.delegate":
      case "ui.action":
        return this.submit(grantId, request, signal);
      case "ui.get":
        return this.surfaceResult(request.args.sessionId);
    }
  }

  private surfaceResult(sessionId: string): Record<string, JsonValue> {
    return {
      surface: JSON.parse(
        JSON.stringify(this.surfaces.get(sessionId)),
      ) as JsonValue,
    };
  }

  async publishSurface(sessionId: string, input: unknown): Promise<void> {
    this.assertOpen();
    const session = this.active.get(sessionId);
    if (!session) throw new HostFailure("offline", "Session is offline");
    let envelope!: Envelope;
    await this.surfaces.publish(sessionId, input, async (value) => {
      this.assertSurfaceSession(sessionId, session);
      envelope = createEnvelope(sessionId, "ui.render", {
        surface: value,
      });
      await (await this.logPair(sessionId)).egress.append(envelope);
      this.assertSurfaceSession(sessionId, session);
    });
    this.assertSurfaceSession(sessionId, session);
    const results = await Promise.allSettled(
      this.options.store.snapshot().grants.map(async (grant) => {
        if (!this.surfaceViewer(grant.id, session.metadata)) return;
        await this.options.emit?.(grant.id, envelope);
      }),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new HostFailure(
        "delivery",
        "Surface recorded; a device did not receive it",
      );
  }

  private assertSurfaceSession(
    sessionId: string,
    session: ActiveSession,
  ): void {
    this.assertOpen();
    if (this.active.get(sessionId) !== session)
      throw new HostFailure("stale", "Session adapter changed");
  }

  private surfaceViewer(grantId: string, session: SessionMetadata): boolean {
    let grant: Grant;
    try {
      grant = this.grant(grantId);
    } catch {
      return false;
    }
    return (
      grant.scopes.includes("sessions:list") && this.visible(grant, session)
    );
  }

  private submission(request: SubmitRequest): {
    text: string;
    kind: "chat" | "task" | "ui-action";
  } {
    if (request.op === "ui.action")
      return { text: this.surfaces.action(request.args), kind: "ui-action" };
    return {
      text: request.args.text,
      kind: request.op === "tasks.delegate" ? "task" : "chat",
    };
  }

  private async submit(
    grantId: string,
    request: SubmitRequest,
    signal: AbortSignal,
  ): Promise<Record<string, JsonValue>> {
    const session = this.active.get(request.args.sessionId)!;
    let outputFailure: unknown;
    let accepting = true;
    const pending: Promise<void>[] = [];
    const emit = (event: AdapterEvent): Promise<void> => {
      const output = accepting
        ? this.output(grantId, request, event)
        : Promise.reject(new HostFailure("stale", "Adapter turn has ended"));
      pending.push(
        output.catch((error: unknown) => {
          outputFailure = error;
        }),
      );
      return output;
    };
    try {
      await session.adapter.submit(
        {
          id: request.id,
          ...this.submission(request),
          principal: this.grant(grantId).principal,
          signal,
        },
        emit,
      );
    } finally {
      accepting = false;
      await Promise.all(pending);
    }
    if (outputFailure !== undefined) throw outputFailure;
    return { sessionId: session.metadata.id, status: "completed" };
  }

  private async output(
    grantId: string,
    request: HostRequest & { args: { sessionId: string } },
    event: AdapterEvent,
  ): Promise<void> {
    this.authorize(grantId, request);
    if (this.operations.get(request.args.sessionId)?.requestId !== request.id)
      throw new HostFailure("stale", "Adapter turn has ended");
    if (event.type !== "delta" && event.type !== "completed")
      throw new HostFailure("invalid", "Invalid adapter event");
    const envelope = createEnvelope(
      request.args.sessionId,
      event.type === "delta" ? "chat.delta" : "chat.completed",
      { text: event.text },
      request.id,
    );
    await (await this.logPair(request.args.sessionId)).egress.append(envelope);
    this.authorize(grantId, request);
    if (this.operations.get(request.args.sessionId)?.requestId !== request.id)
      throw new HostFailure("stale", "Adapter turn has ended");
    await this.options.emit?.(grantId, envelope);
  }

  private async create(
    grantId: string,
    request: Extract<HostRequest, { op: "sessions.create" }>,
  ): Promise<Record<string, JsonValue>> {
    const profile = this.profile(request.args.profileId);
    if (!profile.create)
      throw new HostFailure("unsupported", "Profile cannot create sessions");
    const created = await profile.create();
    try {
      this.authorize(grantId, request);
      const metadata = this.metadata(
        profile,
        created.providerSessionId,
        request.args.label,
      );
      await this.options.store.update((state) => {
        this.authorize(grantId, request);
        if (
          state.sessions.some(
            (item) =>
              item.provider === profile.provider &&
              item.providerSessionId === created.providerSessionId,
          )
        )
          throw new HostFailure(
            "conflict",
            "Provider session is already registered",
          );
        state.sessions.push(metadata);
        const grant = state.grants.find((item) => item.id === grantId)!;
        if (
          grant.sessionAccess !== "registered" &&
          !grant.sessionAccess.includes(metadata.id)
        )
          grant.sessionAccess.push(metadata.id);
      });
      this.authorize(grantId, request);
      this.active.set(metadata.id, { metadata, adapter: created.adapter });
      return { session: { ...metadata, online: true } };
    } catch (error) {
      await created.adapter.detach();
      throw error;
    }
  }

  private async configure(
    grantId: string,
    request: Extract<HostRequest, { op: "sessions.configure" }>,
  ): Promise<Record<string, JsonValue>> {
    const session = this.active.get(request.args.sessionId)!;
    const patch = request.args.patch;
    if (patch.modelId !== undefined) {
      if (
        !this.profile(session.metadata.profileId).models.includes(patch.modelId)
      )
        throw new HostFailure("forbidden", "Model is not approved");
      await session.adapter.configure({ modelId: patch.modelId });
    }
    this.authorize(grantId, request);
    const metadata = { ...session.metadata };
    if (patch.label !== undefined) metadata.label = patch.label;
    if (patch.modelId !== undefined) metadata.modelId = patch.modelId;
    await this.options.store.update((state) => {
      this.authorize(grantId, request);
      state.sessions = state.sessions.map((item) =>
        item.id === metadata.id ? metadata : item,
      );
    });
    session.metadata = metadata;
    return { session: { ...metadata, online: true } };
  }

  private success(
    replyTo: string,
    result: Record<string, JsonValue>,
  ): HostResponse {
    const response = {
      version: 1 as const,
      id: crypto.randomUUID(),
      hostId: this.hostId,
      hostEpoch: this.hostEpoch,
      replyTo,
      ok: true as const,
      result,
    };
    if (
      new TextEncoder().encode(JSON.stringify(response)).length >
      MAX_FRAME_BYTES
    )
      throw new HostFailure("limit", "Response exceeds the frame limit");
    return response;
  }

  private failure(replyTo: string, error: unknown): HostResponse {
    const detail =
      error instanceof HostFailure || error instanceof LogUnavailable
        ? { code: error.code, message: error.message }
        : { code: "failed", message: "Host operation failed" };
    return {
      version: 1,
      id: crypto.randomUUID(),
      hostId: this.hostId,
      hostEpoch: this.hostEpoch,
      replyTo,
      ok: false,
      error: detail,
    };
  }

  async revokeGrant(grantId: string): Promise<void> {
    this.revoked.add(grantId);
    for (const operation of this.operations.values())
      if (operation.grantId === grantId) operation.abort.abort();
    try {
      await this.options.store.update((state) => {
        const grant = state.grants.find((item) => item.id === grantId);
        if (grant) grant.revokedAt = this.timestamp();
      });
    } finally {
      await this.options.onRevoke?.(grantId);
    }
  }

  close(): Promise<void> {
    this.closing ??= this.dispose();
    return this.closing;
  }
  private async dispose(): Promise<void> {
    for (const operation of this.operations.values()) operation.abort.abort();
    const adapters = [...this.active.values()].map((session) => {
      this.surfaces.clear(session.metadata.id);
      return session.adapter.detach();
    });
    this.active.clear();
    const logs = [...this.logs.values()].map(async (pair) => {
      const { ingress, egress } = await pair;
      await Promise.all([ingress.close(), egress.close()]);
    });
    const results = await Promise.allSettled([...adapters, ...logs]);
    await this.options.store.close();
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}

export async function createHost(
  options: HostOptions,
): Promise<HostController> {
  for (const profile of options.profiles) {
    if (
      !profile.models.includes(profile.defaultModelId) &&
      !(
        profile.models.length === 0 &&
        profile.defaultModelId === "provider-default"
      )
    )
      throw new Error("Default model is not in the local profile");
  }
  const host = new LocalHost(options);
  await host.logPair(host.hostEpoch);
  return host;
}
