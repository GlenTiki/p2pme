import { z } from "zod";
import { scopes, type Grant } from "./host-protocol.js";
import type {
  HostController,
  LocalProfile,
  SessionAdapter,
  Attachment,
} from "./host-types.js";
import type { HostStore } from "./host-store.js";
import {
  decodeInvitation,
  randomSecret,
  type ConnectionRecord,
  type PairingInvitation,
} from "./rtc-identity.js";
import type { RtcChannel } from "./rtc-channel.js";
import type { DaemonPolicy } from "./daemon-policy.js";
import type { ControlRequest } from "./local-client.js";

export interface Approval {
  label: string;
  principal: "human-device" | "agent";
  scopes: Grant["scopes"];
  profileIds: string[];
  workspace: string;
  sessionAccess: "registered";
  expiresAt: string;
}
export interface DaemonTransport {
  pair(
    invitation: PairingInvitation,
    record: ConnectionRecord,
    options: {
      signal: AbortSignal;
      persist(): Promise<void>;
      activate(): Promise<void>;
    },
  ): Promise<void>;
  serve(
    record: ConnectionRecord,
    options: {
      host: HostController;
      active(): boolean;
      dispatch(
        frame: string,
      ): Promise<import("./host-protocol.js").HostResponse>;
    },
  ): RtcChannel;
}
export interface ControlOptions {
  host: HostController;
  store: HostStore;
  policy: DaemonPolicy;
  profiles: LocalProfile[];
  attachCodex(threadId: string): Promise<SessionAdapter>;
  confirm(approval: Approval, signal: AbortSignal): Promise<boolean>;
  transport: DaemonTransport;
  rooms: Map<string, RtcChannel>;
}
const pairSchema = z
  .object({
    invitation: z.string().max(2048),
    principal: z.enum(["human-device", "agent"]),
    scopes: z.array(z.enum(scopes)).min(1).max(scopes.length),
    profileIds: z.array(z.string().min(1).max(100)).min(1).max(32),
  })
  .strict();
const empty = z.object({}).strict();
export class DaemonControl {
  private pairing = false;
  private stopped = false;
  constructor(private readonly options: ControlOptions) {}
  stop(): void {
    this.stopped = true;
  }
  restore(): void {
    for (const grant of this.options.store.snapshot().grants)
      if (this.active(grant.id)) this.activate(grant);
  }
  active(id: string): boolean {
    const grant = this.options.store
      .snapshot()
      .grants.find((item) => item.id === id);
    return (
      !this.stopped &&
      this.options.store.healthy &&
      grant !== undefined &&
      grant.revokedAt === null &&
      Date.parse(grant.expiresAt) > Date.now()
    );
  }
  private record(grant: Grant): ConnectionRecord {
    return {
      hostId: this.options.host.hostId,
      grantId: grant.id,
      roomId: grant.roomId,
      secret: grant.roomSecret,
      label: grant.label,
      expiresAt: grant.expiresAt,
    };
  }
  activate(grant: Grant): void {
    if (this.stopped) return;
    const { host, transport, rooms } = this.options;
    const channel = transport.serve(this.record(grant), {
      host,
      active: () => this.active(grant.id),
      dispatch: (frame) => host.dispatch(grant.id, frame),
    });
    rooms.set(grant.id, channel);
  }
  async handle(
    request: ControlRequest,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    switch (request.op) {
      case "status":
        empty.parse(request.args);
        return this.status();
      case "start":
        return this.start(
          request.args,
          AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        );
      case "register":
        return this.register(
          request.args,
          AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        );
      case "pair":
        return this.pair(request.args, signal);
      case "revoke":
        return this.revoke(request.args);
      case "publish":
        return this.publish(request.args);
      default:
        return null;
    }
  }
  private status(): Record<string, unknown> {
    const { host, store, profiles, policy } = this.options;
    return {
      hostId: host.hostId,
      hostEpoch: host.hostEpoch,
      workspace: policy.workspace,
      profiles: profiles.map(({ id, provider }) => ({ id, provider })),
      sessions: host.sessions(),
      grants: store
        .snapshot()
        .grants.map(
          ({
            id,
            label,
            principal,
            scopes,
            profileIds,
            expiresAt,
            revokedAt,
          }) => ({
            id,
            label,
            principal,
            scopes,
            profileIds,
            expiresAt,
            revokedAt,
          }),
        ),
    };
  }
  private profile(id: string): LocalProfile {
    const profile = this.options.profiles.find((item) => item.id === id);
    if (!profile) throw new Error("Local profile is unavailable");
    return profile;
  }
  private async start(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const { profileId } = z
      .object({ profileId: z.string() })
      .strict()
      .parse(args);
    const profile = this.profile(profileId);
    if (!profile.create) throw new Error("Profile cannot create a session");
    signal.throwIfAborted();
    const created = await profile.create();
    const session = await this.attach(
      {
        profileId,
        providerSessionId: created.providerSessionId,
        adapter: created.adapter,
        label: profileId,
      },
      signal,
    );
    return { session };
  }
  private async register(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const { provider, threadId } = z
      .object({
        provider: z.literal("codex"),
        threadId: z.string().min(1).max(200),
      })
      .strict()
      .parse(args);
    this.profile(provider);
    signal.throwIfAborted();
    const adapter = await this.options.attachCodex(threadId);
    const session = await this.attach(
      {
        profileId: provider,
        providerSessionId: threadId,
        label: "Codex session",
        adapter,
      },
      signal,
    );
    return { session };
  }
  private async attach(attachment: Attachment, signal: AbortSignal) {
    if (signal.aborted) {
      await attachment.adapter.detach();
      signal.throwIfAborted();
    }
    const session = await this.options.host.attach(attachment);
    if (signal.aborted) {
      await this.options.host.detach(session.id, attachment.adapter);
      signal.throwIfAborted();
    }
    return session;
  }
  private async revoke(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { grantId } = z.object({ grantId: z.uuid() }).strict().parse(args);
    const grant = this.options.store
      .snapshot()
      .grants.find((item) => item.id === grantId);
    if (!grant) throw new Error("Device grant is unavailable");
    if (grant.revokedAt !== null) return { grantId, status: "already-revoked" };
    await this.options.host.revokeGrant(grantId);
    return { revoked: grantId };
  }
  private async publish(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { sessionId, surface } = z
      .object({ sessionId: z.uuid(), surface: z.unknown() })
      .strict()
      .parse(args);
    const host = this.options.host as HostController & {
      publishSurface?: (id: string, input: unknown) => Promise<void>;
    };
    if (!host.publishSurface)
      throw new Error("Surface registry is unavailable");
    await host.publishSurface(sessionId, surface);
    return { sessionId };
  }
  private async pair(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (this.pairing) throw new Error("Pairing is already pending");
    const parsed = pairSchema.parse(args);
    const invitation = decodeInvitation(parsed.invitation);
    if (this.options.store.snapshot().grants.length >= 32)
      throw new Error("Host grant limit reached");
    for (const id of parsed.profileIds) this.profile(id);
    this.pairing = true;
    try {
      return await this.approve(invitation, parsed, signal);
    } finally {
      this.pairing = false;
    }
  }
  private async approve(
    invitation: PairingInvitation,
    parsed: z.infer<typeof pairSchema>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const { store, policy, confirm, transport } = this.options;
    const expiry = AbortSignal.timeout(
      Math.max(1, Date.parse(invitation.expiresAt) - Date.now()),
    );
    const pending = AbortSignal.any([signal, expiry]);
    const approval: Approval = {
      label: invitation.label,
      principal: parsed.principal,
      scopes: parsed.scopes,
      profileIds: parsed.profileIds,
      workspace: policy.workspace,
      sessionAccess: "registered",
      expiresAt: timestamp(Date.now() + 30 * 86400000),
    };
    if (!(await confirm(structuredClone(approval), pending)))
      throw new Error("Pairing was not approved");
    pending.throwIfAborted();
    decodeInvitation(parsed.invitation);
    await policy.consume(invitation.roomId, invitation.expiresAt);
    const grant: Grant = {
      label: approval.label,
      principal: approval.principal,
      scopes: approval.scopes,
      profileIds: approval.profileIds,
      sessionAccess: approval.sessionAccess,
      expiresAt: approval.expiresAt,
      id: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
      roomId: crypto.randomUUID(),
      roomSecret: randomSecret(),
      createdAt: timestamp(Date.now()),
      revokedAt: null,
    };
    await transport.pair(invitation, this.record(grant), {
      signal: pending,
      persist: async () => {
        pending.throwIfAborted();
        await store.update((state) => {
          pending.throwIfAborted();
          state.grants.push(grant);
        });
      },
      activate: async () => {
        this.activate(grant);
      },
    });
    return { grantId: grant.id, expiresAt: grant.expiresAt };
  }
}
function timestamp(value: number): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}
