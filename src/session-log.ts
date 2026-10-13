import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import Hypercore from "hypercore";
import {
  decodeEnvelope,
  isId,
  MAX_FRAME_BYTES,
  MAX_SESSION_ENTRIES,
  type Envelope,
} from "./protocol.js";

export interface SessionLogOptions {
  sessionId: string;
  key?: Uint8Array;
}

export interface SessionLog {
  readonly sessionId: string;
  readonly publicKey: Uint8Array;
  readonly length: number;
  append(value: unknown): Promise<void>;
  get(index: number): Promise<Envelope | null>;
  replicate(stream: boolean | Duplex): Duplex;
  close(): Promise<void>;
}

class LocalSessionLog implements SessionLog {
  private readonly streams = new Set<Duplex>();
  private readonly accepted = new Map<number, Envelope>();
  private readonly ids = new Map<string, number>();
  private readonly download;
  private failure: Error | null = null;
  private appending = Promise.resolve();
  private closing: Promise<void> | null = null;

  constructor(
    readonly sessionId: string,
    private readonly core: Hypercore,
    private readonly directory: string,
  ) {
    core.on("truncate", () =>
      this.fail(new Error("Signed log forks are not allowed")),
    );
    core.on("append", () => this.checkMetadata());
    core.on("download", (index: number) => {
      void this.get(index).catch((error: unknown) => this.fail(error));
    });
    core.on("error", (error: unknown) => this.fail(error));
    this.download = core.download({
      start: 0,
      end: MAX_SESSION_ENTRIES,
      linear: true,
    });
  }

  get publicKey(): Uint8Array {
    return Uint8Array.from(this.core.key);
  }
  get length(): number {
    return this.core.length;
  }

  private fail(error: unknown): void {
    this.failure ??=
      error instanceof Error ? error : new Error("Invalid session log");
    this.download.destroy();
    for (const stream of this.streams) stream.destroy();
  }

  private checkMetadata(): void {
    if (
      this.core.length > MAX_SESSION_ENTRIES ||
      this.core.byteLength > MAX_SESSION_ENTRIES * MAX_FRAME_BYTES
    ) {
      this.fail(new Error("Replicated log exceeds the session limit"));
    }
    if (this.core.fork !== 0)
      this.fail(new Error("Signed log forks are not allowed"));
  }

  private assertUsable(): void {
    this.checkMetadata();
    if (this.failure) throw this.failure;
    if (this.closing) throw new Error("Session log is closed");
  }

  private accept(index: number, frame: string): Envelope {
    const envelope = decodeEnvelope(frame, this.sessionId);
    const previous = this.ids.get(envelope.id);
    if (previous !== undefined && previous !== index)
      throw new Error("Duplicate message ID in log");
    this.ids.set(envelope.id, index);
    this.accepted.set(index, envelope);
    return envelope;
  }

  append(value: unknown): Promise<void> {
    const append = this.appending.then(() => this.appendEntry(value));
    this.appending = append.catch(() => {});
    return append;
  }

  private async appendEntry(value: unknown): Promise<void> {
    this.assertUsable();
    if (!this.core.writable) throw new Error("This log has no signing key");
    if (this.length >= MAX_SESSION_ENTRIES)
      throw new Error("Session entry limit reached");
    const frame = JSON.stringify(value);
    const envelope = decodeEnvelope(frame, this.sessionId);
    if (this.ids.has(envelope.id))
      throw new Error("Duplicate message ID in log");
    const index = this.length;
    await this.core.append(frame);
    this.accept(index, frame);
  }

  async get(index: number): Promise<Envelope | null> {
    this.assertUsable();
    if (!Number.isInteger(index) || index < 0 || index >= MAX_SESSION_ENTRIES)
      throw new Error("Invalid log index");
    const accepted = this.accepted.get(index);
    if (accepted) return accepted;
    const frame = await this.core.get(index, { wait: false });
    if (frame === null) return null;
    try {
      this.assertUsable();
      return this.accept(index, frame);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  replicate(stream: boolean | Duplex): Duplex {
    this.assertUsable();
    const replication = this.core.replicate(stream);
    this.streams.add(replication);
    replication.on("error", () => {});
    replication.once("close", () => this.streams.delete(replication));
    return replication;
  }

  close(): Promise<void> {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose(): Promise<void> {
    this.download.destroy();
    for (const stream of this.streams) stream.destroy();
    await this.appending;
    await this.core.close();
    await rm(this.directory, { recursive: true });
  }
}

export async function createSessionLog(
  options: SessionLogOptions,
): Promise<SessionLog> {
  if (!isId(options.sessionId)) throw new Error("Invalid session ID");
  if (options.key && options.key.length !== 32)
    throw new Error("Invalid writer public key");
  const directory = await mkdtemp(join(tmpdir(), "p2pme-"));
  const config = { valueEncoding: "utf-8" as const, allowFork: false };
  const core = options.key
    ? new Hypercore(directory, options.key, config)
    : new Hypercore(directory, config);
  try {
    await core.ready();
    return new LocalSessionLog(options.sessionId, core, directory);
  } catch (error) {
    await core.close();
    await rm(directory, { recursive: true });
    throw error;
  }
}
