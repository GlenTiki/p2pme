import { MAX_SESSION_ENTRIES } from "./protocol.js";
import type { HostLog, LogPair } from "./host-types.js";

export class LogUnavailable extends Error {
  readonly code = "log_unavailable";
  constructor() {
    super(
      "Session log unavailable; restart the host. The request may have run; inspect the session before retrying.",
    );
  }
}

export class HostLogPair implements LogPair {
  readonly ingress: HostLog;
  readonly egress: HostLog;
  private readonly counts = { ingress: 0, egress: 0 };
  private reserved = 0;
  private failed = false;

  constructor(
    pair: LogPair,
    private readonly onUnavailable: () => void,
  ) {
    this.ingress = this.guard(pair.ingress, "ingress");
    this.egress = this.guard(pair.egress, "egress");
  }

  private requireCapacity(ingress: number, egress: number): void {
    if (
      this.failed ||
      this.counts.ingress + ingress > MAX_SESSION_ENTRIES ||
      this.counts.egress + this.reserved + egress > MAX_SESSION_ENTRIES
    )
      this.unavailable();
  }

  private unavailable(): never {
    if (!this.failed) {
      this.failed = true;
      this.onUnavailable();
    }
    throw new LogUnavailable();
  }

  private guard(log: HostLog, direction: "ingress" | "egress"): HostLog {
    return {
      append: async (value) => {
        this.requireCapacity(
          direction === "ingress" ? 1 : 0,
          direction === "egress" ? 1 : 0,
        );
        this.counts[direction]++;
        try {
          await log.append(value);
        } catch {
          this.unavailable();
        }
        this.requireCapacity(0, 0);
      },
      close: () => log.close(),
    };
  }

  reserve(output: boolean) {
    this.requireCapacity(1, output ? 2 : 1);
    this.reserved++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.reserved--;
    };
    return {
      check: () => this.requireCapacity(0, output ? 1 : 0),
      appendResult: (value: unknown) => {
        release();
        return this.egress.append(value);
      },
      release,
    };
  }
}
