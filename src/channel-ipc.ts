import type { Socket } from "node:net";
import type { Attachment, SessionAdapter } from "./host-types.js";
import type { SessionInfo } from "./host-protocol.js";
import { isId, MAX_CHAT_BYTES } from "./protocol.js";
import {
  PendingTurn,
  type AdapterInput,
  type Output,
} from "./adapters/turn.js";
import type { JsonObject } from "./adapters/transport.js";
import { ChannelWire } from "./channel-wire.js";

interface Context {
  host: {
    attach(attachment: Attachment): Promise<SessionInfo>;
    detach(sessionId: string, adapter: SessionAdapter): Promise<void>;
  };
  send(frame: JsonObject): Promise<void>;
}
interface Request {
  id: string;
  op: string;
  args: JsonObject;
}
interface Entry {
  providerSessionId: string;
  generation: string;
  started: boolean;
  ended: boolean;
  wire?: ChannelWire;
  adapter?: RemoteChannel;
  sessionId?: string;
  timer: ReturnType<typeof setTimeout>;
  activation?: Promise<void>;
}
export function providerSession(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw new Error("Invalid provider session ID");
  return value;
}

class RemoteChannel implements SessionAdapter {
  private active: PendingTurn | null = null;
  private closed = false;
  private cancelled: {
    id: string;
    done: Promise<void>;
    resolve: () => void;
  } | null = null;
  constructor(
    private readonly wire: ChannelWire,
    private readonly generation: string,
  ) {
    wire.onFrame((frame) => this.receive(frame));
    wire.onClose(() => {
      void this.detach();
    });
  }
  async submit(input: AdapterInput, emit: Output): Promise<void> {
    if (this.closed || this.active)
      throw new Error("Channel unavailable or busy");
    if (Buffer.byteLength(input.text) > MAX_CHAT_BYTES)
      throw new Error("Input exceeded");
    const pending = new PendingTurn(input, emit, () => {
      void this.cancel(input.id);
    });
    this.active = pending;
    const timeout = setTimeout(() => {
      pending.fail(new Error("Request abandoned; Claude may still act"));
      void this.cancel(input.id);
    }, 300000);
    timeout.unref();
    try {
      await Promise.all([
        this.wire.send({
          op: "submit",
          generation: this.generation,
          requestId: input.id,
          text: input.text,
          kind: input.kind,
          principal: input.principal,
        }),
        pending.done,
      ]);
    } catch (error) {
      pending.fail(error);
      if (input.signal.aborted)
        throw new Error("Request abandoned; Claude may still act", {
          cause: error,
        });
      throw error;
    } finally {
      clearTimeout(timeout);
      await pending.drain();
      await this.cancelled?.done;
      if (this.active === pending) this.active = null;
    }
  }
  private async cancel(requestId: string): Promise<void> {
    if (this.cancelled?.id === requestId) return this.cancelled.done;
    let resolve!: () => void;
    const done = new Promise<void>((complete) => {
      resolve = complete;
    });
    this.cancelled = { id: requestId, done, resolve };
    const timeout = setTimeout(() => this.wire.close(), 5000);
    timeout.unref();
    try {
      await this.wire.send({
        op: "cancel",
        generation: this.generation,
        requestId,
      });
      await done;
    } catch {
      this.wire.close();
    } finally {
      clearTimeout(timeout);
    }
  }
  private cancelReply(frame: JsonObject): boolean {
    const cancelled = this.cancelled;
    if (
      !cancelled ||
      frame.generation !== this.generation ||
      frame.requestId !== cancelled.id
    )
      return false;
    if (frame.op === "cancelled") cancelled.resolve();
    else if (!["reply", "failed"].includes(String(frame.op))) this.wire.close();
    return true;
  }
  private receive(frame: JsonObject): void {
    if (this.cancelReply(frame)) return;
    const active = this.active;
    if (
      !active?.open ||
      frame.generation !== this.generation ||
      frame.requestId !== active.input.id
    ) {
      this.wire.close();
      return;
    }
    if (frame.op === "failed") {
      active.fail(new Error("Claude channel request failed"));
      return;
    }
    if (
      frame.op !== "reply" ||
      typeof frame.text !== "string" ||
      Buffer.byteLength(JSON.stringify(frame.text)) > 24576
    ) {
      this.wire.close();
      return;
    }
    active.finish(frame.text, false);
    void active.done
      .then(() =>
        this.wire.send({
          op: "delivered",
          generation: this.generation,
          requestId: active.input.id,
        }),
      )
      .catch(() => this.wire.close());
  }
  async configure(): Promise<void> {
    throw new Error("Channel model configuration is unsupported");
  }
  async detach(): Promise<void> {
    this.closed = true;
    this.cancelled?.resolve();
    this.active?.fail(new Error("Channel detached"));
    this.wire.close();
    await this.active?.drain();
  }
}

export function createClaudeChannelExtension(options: { workspace: string }) {
  const entries = new Map<string, Entry>();
  async function end(entry: Entry, context: Context): Promise<void> {
    if (entry.ended) return;
    entry.ended = true;
    clearTimeout(entry.timer);
    entry.wire?.close();
    if (entry.sessionId && entry.adapter)
      await context.host.detach(entry.sessionId, entry.adapter);
  }
  function entryFor(args: JsonObject, context: Context): Entry {
    if (!isId(args.registrationId)) throw new Error("Invalid registration");
    const id = providerSession(args.providerSessionId);
    let entry = entries.get(args.registrationId);
    if (!entry) {
      if (entries.size >= 64)
        throw new Error("Registration capacity reached; restart host");
      entry = {
        providerSessionId: id,
        generation: crypto.randomUUID(),
        started: false,
        ended: false,
        timer: setTimeout(() => {}, 0),
      };
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        void end(entry!, context).catch(() => {});
      }, 300000);
      entry.timer.unref();
      entries.set(args.registrationId, entry);
    }
    return entry;
  }
  async function activate(entry: Entry, context: Context): Promise<void> {
    if (entry.ended || !entry.started || !entry.wire || entry.activation)
      return;
    clearTimeout(entry.timer);
    const adapter = new RemoteChannel(entry.wire, entry.generation);
    entry.adapter = adapter;
    entry.activation = context.host
      .attach({
        profileId: "claude",
        providerSessionId: entry.providerSessionId,
        label: "Claude native channel",
        adapter,
      })
      .then(async (session) => {
        entry.sessionId = session.id;
        if (entry.ended) await context.host.detach(session.id, adapter);
      })
      .catch(async (error) => {
        await end(entry, context);
        throw error;
      });
    await entry.activation;
  }
  async function handle(
    request: Request,
    socket: Socket,
    context: Context,
  ): Promise<void> {
    const entry = entryFor(request.args, context);
    if (entry.ended) throw new Error("Registration ended; create a new setup");
    if (
      entry.providerSessionId !== request.args.providerSessionId ||
      request.args.cwd !== options.workspace
    ) {
      await end(entry, context);
      throw new Error("Conversation changed; create a new setup");
    }
    if (request.op === "claude.lifecycle") {
      await lifecycle(request.args, entry, context);
      await context.send({ id: request.id, ok: true, result: {} });
      socket.end();
    } else {
      if (entry.wire) throw new Error("Channel already connected");
      const wire = new ChannelWire(socket);
      entry.wire = wire;
      wire.onClose(() => {
        void end(entry, context).catch(() => {});
      });
      await context.send({
        id: request.id,
        ok: true,
        result: { generation: entry.generation },
      });
      await activate(entry, context);
    }
  }
  async function lifecycle(
    args: JsonObject,
    entry: Entry,
    context: Context,
  ): Promise<void> {
    if (args.event === "SessionEnd") {
      await end(entry, context);
      return;
    }
    if (args.event !== "SessionStart")
      throw new Error("Invalid lifecycle event");
    entry.started = true;
    await activate(entry, context);
  }
  return async (
    request: Request,
    socket: Socket,
    context: Context,
  ): Promise<boolean> => {
    if (!["claude.channel", "claude.lifecycle"].includes(request.op))
      return false;
    try {
      await handle(request, socket, context);
    } catch {
      await context
        .send({
          id: request.id,
          ok: false,
          error:
            "Claude channel unavailable; verify session and setup or restart host if full",
        })
        .catch(() => {});
      socket.end();
    }
    return true;
  };
}
