import {
  connectionRecord,
  type ConnectionRecord,
  type PairingInvitation,
} from "./rtc-identity.js";
import type {
  HostGrantPreparation,
  HostOfferOptions,
  HostOfferState,
} from "./host-pairing-types.js";
import { observed, type PairWire } from "./host-pairing-wire.js";

export type PairPath = "qr" | "code";
export class OfferState {
  state: HostOfferState = "pending";
  readonly abort = new AbortController();
  readonly result = observed<ConnectionRecord>();
  private readonly paths = new Map<PairPath, Set<PairWire>>([
    ["qr", new Set()],
    ["code", new Set()],
  ]);
  private winner: PairPath | null = null;
  private commitStarted = false;
  private commitCalls = 0;
  private readonly cleanups = new Set<Promise<void>>();
  private commit: Promise<void> | null = null;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onAbort = () => {
    void this.close();
  };
  constructor(
    readonly invitation: PairingInvitation,
    readonly options: HostOfferOptions,
  ) {
    this.timer = setTimeout(
      () => {
        if (!this.commitStarted)
          this.fail(new Error("Pairing invitation expired"));
      },
      Math.max(0, Date.parse(invitation.expiresAt) - Date.now()),
    );
    options.signal?.addEventListener("abort", this.onAbort, { once: true });
  }
  add(name: PairPath, wire: PairWire): void {
    const path = this.paths.get(name);
    if (!path || this.state === "closed" || this.state === "complete") {
      void wire.close();
      return;
    }
    path.add(wire);
  }
  available(name: PairPath): boolean {
    return this.paths.has(name) && this.state === "pending";
  }
  check(): void {
    if (this.abort.signal.aborted || this.state === "closed")
      throw new Error("Pairing cancelled");
    if (
      !this.commitStarted &&
      Date.now() >= Date.parse(this.invitation.expiresAt)
    )
      throw new Error("Pairing invitation expired");
  }
  private stopPath(name: PairPath): Promise<void> {
    const wires = this.paths.get(name);
    this.paths.delete(name);
    const cleanup = Promise.all(
      Array.from(wires ?? [], (wire) => wire.close()),
    ).then(() => {});
    this.cleanups.add(cleanup);
    void cleanup.finally(() => this.cleanups.delete(cleanup));
    return cleanup;
  }
  pathFailed(name: PairPath, error: unknown): void {
    if (!this.paths.has(name) || this.commitStarted) return;
    void this.stopPath(name);
    if (this.winner === name || this.paths.size === 0) this.fail(error);
  }
  async claim(name: PairPath, label: string): Promise<HostGrantPreparation> {
    this.check();
    if (this.state !== "pending" || !this.paths.has(name))
      throw new Error("Offer was already claimed");
    this.state = "claimed";
    this.winner = name;
    await this.stopPath(name === "qr" ? "code" : "qr");
    this.check();
    const preparation = await this.options.authorize(
      label,
      this.abort.signal,
      Object.freeze({
        attemptId: this.invitation.roomId,
        expiresAt: this.invitation.expiresAt,
      }),
    );
    this.check();
    const grant = connectionRecord(preparation.record);
    if (grant.label !== label)
      throw new Error("Grant label does not match claim");
    return {
      record: { ...grant },
      persist: (begin) => preparation.persist(begin),
      activate: () => preparation.activate(),
    };
  }
  persist(preparation: HostGrantPreparation): Promise<void> {
    if (this.commit) throw new Error("Duplicate grant acknowledgement");
    this.commit = Promise.resolve().then(() => this.commitGrant(preparation));
    void this.commit.catch((error) => this.fail(error));
    return this.commit;
  }
  private async commitGrant(preparation: HostGrantPreparation): Promise<void> {
    this.check();
    await preparation.persist(() => {
      this.commitCalls++;
      if (this.commitStarted) throw new Error("Commit hook was already called");
      this.check();
      if (this.state !== "claimed") throw new Error("Offer cannot commit");
      this.commitStarted = true;
      this.state = "committing";
      clearTimeout(this.timer);
    });
    if (!this.commitStarted || this.commitCalls !== 1)
      throw new Error("Persistence must begin commit exactly once");
    await preparation.activate();
    this.state = "complete";
    this.result.resolve(preparation.record);
    await this.release();
  }
  fail(error: unknown): void {
    if (this.state === "complete" || this.state === "closed") return;
    this.state = "closed";
    if (!this.commitStarted) this.abort.abort();
    this.result.reject(error);
    void this.release();
  }
  async cancel(): Promise<"cancelled" | "too-late"> {
    if (this.commitStarted) return "too-late";
    this.fail(new Error("Pairing cancelled"));
    await this.release();
    return "cancelled";
  }
  async close(): Promise<void> {
    if (!this.commitStarted && this.state !== "complete")
      this.fail(new Error("Pairing cancelled"));
    await this.release();
    if (this.commitStarted) await this.commit?.catch(() => {});
  }
  private async release(): Promise<void> {
    clearTimeout(this.timer);
    this.options.signal?.removeEventListener("abort", this.onAbort);
    await Promise.all([
      this.stopPath("qr"),
      this.stopPath("code"),
      ...this.cleanups,
    ]);
  }
}
