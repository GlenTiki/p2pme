import {
  openRtcChannel,
  type ChannelOptions,
  type RtcChannel,
} from "./rtc-channel.js";
import type { HostJoinOptions } from "./host-pairing-types.js";

export function observed<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
export class PairWire {
  private channel: RtcChannel;
  private closing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(
    options: ChannelOptions,
    setup: HostJoinOptions,
    private readonly failure: (error: unknown) => void,
  ) {
    this.channel = (setup.channelFactory ?? openRtcChannel)(
      {
        ...options,
        onConnect: () => {
          if (!this.stopped) {
            this.deadline(30000);
            options.onConnect?.();
          }
        },
        onFrame: async (frame) => {
          if (!this.stopped)
            try {
              await options.onFrame?.(frame);
            } catch (error) {
              this.fail(error);
            }
        },
        onDisconnect: () => {
          if (!this.stopped) {
            if (options.onDisconnect) options.onDisconnect();
            else this.fail(new Error("Pairing peer disconnected"));
          }
        },
        onError: (error) => this.fail(error),
        onPeerError: () => {},
      },
      setup.network,
    );
  }
  get closed() {
    return this.stopped;
  }
  deadline(milliseconds: number): void {
    this.clearDeadline();
    this.timer = setTimeout(
      () => this.fail(new Error("Pairing peer timed out")),
      milliseconds,
    );
  }
  clearDeadline(): void {
    clearTimeout(this.timer);
  }
  async send(value: unknown): Promise<void> {
    if (this.stopped) throw new Error("Pairing path closed");
    await this.channel.send(JSON.stringify(value));
  }
  fail(error: unknown): void {
    if (this.stopped) return;
    void this.close();
    this.failure(error);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.clearDeadline();
    this.closing = Promise.resolve()
      .then(() => this.channel.close())
      .catch(() => {});
    return this.closing;
  }
}
