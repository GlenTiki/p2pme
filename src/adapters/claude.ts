import type { SessionAdapter } from "../host-types.js";
import {
  PendingTurn,
  promptText,
  type AdapterInput,
  type Output,
} from "./turn.js";
import {
  localDirectory,
  localString,
  record,
  spawnJsonProcess,
  type JsonObject,
  type JsonTransport,
  type ProcessSpawner,
} from "./transport.js";

export interface ClaudeCreateOptions {
  cwd: string;
  modelId?: string;
  transport?: JsonTransport;
  spawn?: ProcessSpawner;
}

class ClaudeAdapter implements SessionAdapter {
  private active: PendingTurn | null = null;
  private closed = false;
  private acknowledged = false;
  constructor(
    private readonly transport: JsonTransport,
    private readonly sessionId: string,
  ) {
    transport.subscribe((value) => this.receive(value));
    transport.onClose((error) => {
      this.closed = true;
      this.active?.fail(error);
    });
  }
  async submit(input: AdapterInput, emit: Output): Promise<void> {
    if (this.closed || this.active)
      throw new Error("Adapter is unavailable or busy");
    const pending = new PendingTurn(input, emit, () => {
      void this.detach();
    });
    this.active = pending;
    this.acknowledged = false;
    try {
      void this.transport
        .send({
          type: "user",
          uuid: input.id,
          session_id: this.sessionId,
          message: { role: "user", content: promptText(input) },
          parent_tool_use_id: null,
        })
        .catch((error) => pending.fail(error));
    } catch (error) {
      pending.fail(error);
    }
    try {
      await pending.done;
    } catch (error) {
      await this.detach();
      throw error;
    } finally {
      await pending.drain();
      if (this.active === pending) this.active = null;
    }
  }
  private receive(value: JsonObject): void {
    if (value.type === "control_request") {
      this.deny(value);
      return;
    }
    if (!this.active || !this.matches(value)) return;
    if (value.type === "result" && value.subtype !== "success") {
      this.output(value);
      return;
    }
    if (value.type === "user" && value.uuid === this.active.input.id) {
      this.acknowledged = true;
      return;
    }
    if (!this.acknowledged) return;
    this.output(value);
  }
  private matches(value: JsonObject): boolean {
    return (
      value.session_id === this.sessionId &&
      (value.parent_tool_use_id === undefined ||
        value.parent_tool_use_id === null)
    );
  }
  private output(value: JsonObject): void {
    if (value.type === "stream_event") {
      this.stream(record(value.event));
      return;
    }
    if (value.type !== "result") return;
    if (value.subtype !== "success" || value.is_error === true) {
      this.active?.fail(new Error("Claude turn failed"));
      return;
    }
    this.active?.finish(typeof value.result === "string" ? value.result : "");
  }
  private stream(event: JsonObject): void {
    const delta = record(event.delta);
    if (
      event.type === "content_block_delta" &&
      delta.type === "text_delta" &&
      typeof delta.text === "string"
    )
      this.active?.delta(delta.text);
  }
  private deny(value: JsonObject): void {
    if (typeof value.request_id !== "string") return;
    void this.transport
      .send({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: value.request_id,
          error: "Remote approvals are unavailable",
        },
      })
      .catch(() => {
        void this.detach();
      });
  }
  async configure(): Promise<void> {
    throw new Error("Managed Claude model configuration is unsupported");
  }
  async detach(): Promise<void> {
    this.closed = true;
    this.active?.fail(new Error("Adapter detached"));
    await this.transport.close();
    await this.active?.drain();
  }
}

export function createManagedClaude(options: ClaudeCreateOptions): {
  providerSessionId: string;
  adapter: SessionAdapter;
} {
  localDirectory(options.cwd);
  const providerSessionId = crypto.randomUUID();
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    "--session-id",
    providerSessionId,
    "--permission-prompts",
    "none",
    "--permission-mode",
    "default",
  ];
  if (options.modelId !== undefined)
    args.push("--model", localString(options.modelId));
  const transport =
    options.transport ??
    spawnJsonProcess("claude", args, options.cwd, options.spawn);
  return {
    providerSessionId,
    adapter: new ClaudeAdapter(transport, providerSessionId),
  };
}
