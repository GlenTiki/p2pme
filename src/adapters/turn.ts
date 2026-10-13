import type { SessionAdapter, AdapterEvent } from "../host-types.js";
import { isId, MAX_CHAT_BYTES } from "../protocol.js";

export type AdapterInput = Parameters<SessionAdapter["submit"]>[0];
export type Output = (event: AdapterEvent) => Promise<void>;

export function promptText(input: AdapterInput): string {
  return input.principal === "agent"
    ? `[p2pme delegated agent content]\n${input.text}`
    : input.text;
}

export class PendingTurn {
  readonly done: Promise<void>;
  private resolve!: () => void;
  private reject!: (error: Error) => void;
  private queue = Promise.resolve();
  private text = "";
  private buffered = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private events = 0;
  private accepting = true;
  private stopped = false;
  private readonly abort: () => void;
  get open(): boolean {
    return this.accepting && !this.stopped;
  }
  constructor(
    readonly input: AdapterInput,
    private readonly emit: Output,
    onAbort: () => void,
  ) {
    if (
      !isId(input.id) ||
      !input.text ||
      Buffer.byteLength(input.text) > MAX_CHAT_BYTES
    )
      throw new Error("Invalid adapter input");
    if (!["agent", "human-device"].includes(input.principal))
      throw new Error("Invalid adapter principal");
    if (input.signal.aborted) throw new Error("Request aborted");
    this.done = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.abort = () => {
      this.fail(new Error("Request aborted"));
      onAbort();
    };
    input.signal.addEventListener("abort", this.abort, { once: true });
  }
  delta(text: string): void {
    if (!this.accepting || this.stopped) return;
    if (Buffer.byteLength(JSON.stringify(this.text + text)) > 24 * 1024) {
      this.fail(new Error("Provider output exceeds limit"));
      return;
    }
    this.text += text;
    this.buffered += text;
    if (Buffer.byteLength(this.buffered) >= 512) this.flush();
    else if (!this.timer && this.events < 32)
      this.timer = setTimeout(() => this.flush(), 50);
  }
  finish(fallback = "", streamFallback = true): void {
    if (!this.accepting || this.stopped) return;
    if (!this.text && streamFallback) this.delta(fallback);
    if (!streamFallback) this.text = fallback;
    if (Buffer.byteLength(JSON.stringify(this.text)) > 24 * 1024) {
      this.fail(new Error("Provider output exceeds limit"));
      return;
    }
    this.flush();
    this.accepting = false;
    this.enqueue(async () => {
      await this.emit({ type: "completed", text: this.text });
      if (this.stopped) return;
      this.stopped = true;
      this.cleanup();
      this.resolve();
    });
  }
  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const text = this.buffered;
    this.buffered = "";
    if (!this.open || !text) return;
    let part = "";
    for (const character of text) {
      part += character;
      if (part.length >= 1024) {
        this.emitDelta(part);
        part = "";
      }
    }
    if (part) this.emitDelta(part);
  }
  private emitDelta(text: string): void {
    if (++this.events > 128) {
      this.fail(new Error("Provider output event limit exceeded"));
      return;
    }
    this.enqueue(async () => this.emit({ type: "delta", text }));
  }
  drain(): Promise<void> {
    return this.queue;
  }
  private enqueue(run: () => Promise<void>): void {
    this.queue = this.queue
      .then(async () => {
        if (!this.stopped) await run();
      })
      .catch((error) => this.fail(error));
  }
  fail(error: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cleanup();
    this.reject(
      error instanceof Error ? error : new Error("Provider request failed"),
    );
  }
  private cleanup(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.buffered = "";
    this.input.signal.removeEventListener("abort", this.abort);
  }
}
