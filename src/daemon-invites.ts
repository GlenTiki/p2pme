import { z } from "zod";
import { hostStateSchema, scopes, type Grant } from "./host-protocol.js";
import { randomSecret, type ConnectionRecord } from "./rtc-identity.js";
import type { HostGrantPreparation, HostOffer } from "./host-pairing.js";
import type { Approval, ControlOptions } from "./daemon-control.js";

export const accessSchema = z
  .object({
    principal: z.enum(["human-device", "agent"]),
    scopes: z.array(z.enum(scopes)).min(1).max(scopes.length),
    profileIds: z.array(z.string().min(1).max(100)).min(1).max(32),
  })
  .strict();
type Access = Readonly<
  Omit<Approval, "label" | "scopes" | "profileIds"> & {
    scopes: readonly Grant["scopes"][number][];
    profileIds: readonly string[];
  }
>;
type Offer = HostOffer & { url: string };
interface Pending {
  abort: AbortController;
  access: Access;
  claimed: boolean;
  ready: Promise<Offer>;
  settled: Promise<void>;
  offer?: Offer;
}

export class DaemonInvites {
  private pending: Pending | null = null;
  private legacy = false;
  private stopped = false;
  private policyWrites = Promise.resolve();
  constructor(
    private readonly options: ControlOptions,
    private readonly activate: (grant: Grant) => void,
  ) {}

  reserveLegacy(): void {
    this.available();
    this.legacy = true;
  }
  releaseLegacy(): void {
    this.legacy = false;
  }
  private available(): void {
    if (this.stopped || !this.options.store.healthy)
      throw new Error("Host is unavailable");
    if (this.pending || this.legacy)
      throw new Error("Pairing is already pending");
  }
  stop(): void {
    this.stopped = true;
    this.pending?.abort.abort();
  }
  async close(): Promise<void> {
    this.stop();
    const pending = this.pending;
    try {
      if (pending) {
        const offer = await pending.ready.catch(() => null);
        await offer?.close();
        await pending.settled;
      }
    } finally {
      await this.policyWrites;
    }
  }
  consume(id: string, expiresAt: string, signal: AbortSignal): Promise<void> {
    const write = this.policyWrites.then(() => {
      signal.throwIfAborted();
      if (this.stopped || !this.options.store.healthy)
        throw new Error("Host is unavailable");
      return this.options.policy.consume(id, expiresAt);
    });
    this.policyWrites = write.catch(() => {});
    return write;
  }
  status(): Record<string, unknown> | null {
    const offer = this.pending?.offer;
    if (!offer) return null;
    return {
      attemptId: offer.invitation.roomId,
      expiresAt: offer.invitation.expiresAt,
      state: offer.state,
    };
  }
  async invite(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.available();
    const parsed = accessSchema.parse(args);
    const access: Access = Object.freeze({
      principal: parsed.principal,
      scopes: Object.freeze([...parsed.scopes]),
      profileIds: Object.freeze([...parsed.profileIds]),
      workspace: this.options.policy.workspace,
      sessionAccess: "registered",
      expiresAt: timestamp(Date.now() + 30 * 86400000),
    });
    this.checkAccess(access);
    const create = this.options.transport.offer;
    if (!create) throw new Error("Host invitations are unavailable");
    const pending: Pending = {
      abort: new AbortController(),
      access,
      claimed: false,
      ready: Promise.resolve().then(() =>
        create.call(this.options.transport, {
          label: "p2pme host",
          signal: pending.abort.signal,
          authorize: (label, signal, attempt) =>
            this.prepare(pending, label, signal, attempt),
        }),
      ),
      settled: Promise.resolve(),
    };
    this.pending = pending;
    pending.settled = this.observe(pending);
    const offer = await pending.ready;
    if (this.stopped || pending.abort.signal.aborted) {
      await offer.close();
      throw new Error("Host invitation closed");
    }
    return {
      attemptId: offer.invitation.roomId,
      expiresAt: offer.invitation.expiresAt,
      code: offer.code,
      url: offer.url,
      access,
    };
  }
  private async observe(pending: Pending): Promise<void> {
    try {
      const offer = await pending.ready;
      pending.offer = offer;
      try {
        await offer.completion;
      } finally {
        await offer.close();
      }
    } catch {
      return;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }
  async cancel(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { attemptId } = z
      .object({ attemptId: z.uuid() })
      .strict()
      .parse(args);
    const pending = this.pending;
    if (!pending?.offer || pending.offer.invitation.roomId !== attemptId)
      throw new Error("Invitation is unavailable");
    const status = await pending.offer.cancel();
    if (status === "cancelled") await pending.settled;
    return { attemptId, status };
  }
  private checkAccess(access: Access): void {
    if (this.stopped || !this.options.store.healthy)
      throw new Error("Host is unavailable");
    if (this.options.store.snapshot().grants.length >= 32)
      throw new Error("Host grant limit reached");
    for (const id of access.profileIds) {
      if (!this.options.profiles.some((profile) => profile.id === id))
        throw new Error("Local profile is unavailable");
    }
  }
  private checkPending(
    pending: Pending,
    signal: AbortSignal,
    expiresAt: string,
  ): void {
    signal.throwIfAborted();
    pending.abort.signal.throwIfAborted();
    if (this.pending !== pending || Date.now() >= Date.parse(expiresAt))
      throw new Error("Host invitation expired");
    this.checkAccess(pending.access);
  }
  private async prepare(
    pending: Pending,
    label: string,
    signal: AbortSignal,
    attempt: Readonly<{ attemptId: string; expiresAt: string }>,
  ): Promise<HostGrantPreparation> {
    this.checkPending(pending, signal, attempt.expiresAt);
    if (pending.claimed) throw new Error("Invitation was already claimed");
    pending.claimed = true;
    await this.consume(attempt.attemptId, attempt.expiresAt, signal);
    this.checkPending(pending, signal, attempt.expiresAt);
    const grant: Grant = {
      principal: pending.access.principal,
      sessionAccess: pending.access.sessionAccess,
      expiresAt: pending.access.expiresAt,
      scopes: [...pending.access.scopes],
      profileIds: [...pending.access.profileIds],
      label,
      id: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
      roomId: crypto.randomUUID(),
      roomSecret: randomSecret(),
      createdAt: timestamp(Date.now()),
      revokedAt: null,
    };
    const record: ConnectionRecord = {
      hostId: this.options.host.hostId,
      grantId: grant.id,
      roomId: grant.roomId,
      secret: grant.roomSecret,
      label: grant.label,
      expiresAt: grant.expiresAt,
    };
    return {
      record,
      persist: async (beginCommit) => {
        this.checkPending(pending, signal, attempt.expiresAt);
        await this.options.store.update((state) => {
          this.checkPending(pending, signal, attempt.expiresAt);
          if (state.grants.length >= 32)
            throw new Error("Host grant limit reached");
          state.grants.push(grant);
          hostStateSchema.parse(state);
          beginCommit();
        });
      },
      activate: async () => {
        if (!this.stopped) this.activate(grant);
      },
    };
  }
}
function timestamp(value: number): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}
