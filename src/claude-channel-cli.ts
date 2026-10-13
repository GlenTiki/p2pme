import { mkdir, realpath, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isId } from "./protocol.js";
import { createClaudeChannelServer } from "./adapters/channel.js";
import { localString, record, type JsonObject } from "./adapters/transport.js";
import { providerSession } from "./channel-ipc.js";
import { ChannelWire } from "./channel-wire.js";

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
function absolute(value: string): string {
  if (!isAbsolute(localString(value)))
    throw new Error("Expected absolute path");
  return value;
}
export async function createClaudeSetup(options: {
  directory: string;
  providerSessionId: string;
  socketPath: string;
  executable?: string;
}) {
  const directory = absolute(options.directory);
  const id = providerSession(options.providerSessionId);
  const socket = absolute(options.socketPath);
  const executable = localString(options.executable ?? "p2pme");
  const registration = crypto.randomUUID();
  const args = [
    "--registration",
    registration,
    "--session",
    id,
    "--socket",
    socket,
  ];
  const hook = [executable, "claude-hook", ...args].map(quote).join(" ");
  const settings = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: hook, timeout: 5 }] },
      ],
      SessionEnd: [{ hooks: [{ type: "command", command: hook, timeout: 5 }] }],
    },
  };
  await mkdir(directory, { mode: 0o700 });
  const mcpPath = join(directory, "mcp.json");
  const settingsPath = join(directory, "settings.json");
  await writeFile(
    mcpPath,
    JSON.stringify({
      mcpServers: {
        p2pme: { command: executable, args: ["claude-channel", ...args] },
      },
    }),
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(settingsPath, JSON.stringify(settings), {
    mode: 0o600,
    flag: "wx",
  });
  const command = `claude --resume ${quote(id)} --mcp-config ${quote(mcpPath)} --settings ${quote(settingsPath)} --dangerously-load-development-channels server:p2pme`;
  return { command, registrationId: registration, mcpPath, settingsPath };
}

export async function openChannelControl(
  socketPath: string,
  op: string,
  args: JsonObject,
): Promise<{ wire: ChannelWire; result: JsonObject }> {
  const wire = new ChannelWire(connect(absolute(socketPath)));
  const timeout = setTimeout(() => wire.close(), 10000);
  timeout.unref();
  try {
    const response = wire.next();
    const id = crypto.randomUUID();
    const [, frame] = await Promise.all([
      wire.send({ id, op, args }),
      response,
    ]);
    if (frame.id !== id || frame.ok !== true)
      throw new Error("Claude channel setup unavailable");
    return { wire, result: record(frame.result) };
  } catch (error) {
    wire.close();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

class NativeRequests {
  private active: {
    id: string;
    abort: AbortController;
    resolve?: () => void;
    reject?: (error: Error) => void;
    done?: Promise<void>;
    delivered?: boolean;
  } | null = null;
  constructor(
    private readonly wire: ChannelWire,
    private readonly generation: string,
    private readonly channel: ReturnType<typeof createClaudeChannelServer>,
  ) {
    wire.onFrame((frame) => this.receive(frame));
    wire.onClose(() => {
      this.active?.abort.abort();
      this.active?.reject?.(new Error("Channel closed"));
      channel.invalidate();
      void channel.server.close();
    });
  }
  private receive(frame: JsonObject): void {
    if (frame.generation !== this.generation || !isId(frame.requestId)) {
      this.wire.close();
      return;
    }
    if (frame.op === "cancel") {
      void this.cancel(String(frame.requestId));
      return;
    }
    if (frame.op === "submit") {
      void this.submit(frame).catch(() => this.wire.close());
      return;
    }
    if (frame.requestId !== this.active?.id) {
      this.wire.close();
      return;
    }
    if (frame.op === "delivered") {
      this.active.delivered = true;
      this.active.resolve?.();
    } else this.wire.close();
  }
  private async cancel(requestId: string): Promise<void> {
    const active = this.active;
    if (active?.id === requestId) {
      active.abort.abort();
      active.reject?.(new Error("Request abandoned; Claude may still act"));
      await active.done;
    }
    await this.wire
      .send({ op: "cancelled", generation: this.generation, requestId })
      .catch(() => this.wire.close());
  }
  private async submit(frame: JsonObject): Promise<void> {
    if (this.active?.delivered) await this.active.done;
    if (
      this.active ||
      typeof frame.text !== "string" ||
      !["human-device", "agent"].includes(String(frame.principal)) ||
      !["chat", "task", "ui-action"].includes(String(frame.kind))
    ) {
      this.wire.close();
      return;
    }
    const active: NonNullable<NativeRequests["active"]> = {
      id: String(frame.requestId),
      abort: new AbortController(),
    };
    this.active = active;
    active.done = this.channel.adapter
      .submit(
        {
          id: active.id,
          text: frame.text,
          kind: frame.kind as "chat" | "task" | "ui-action",
          principal: frame.principal as "agent" | "human-device",
          signal: active.abort.signal,
        },
        async (event) => {
          await this.reply(active.id, event.text);
        },
      )
      .catch(async () => {
        if (!active.abort.signal.aborted)
          await this.wire
            .send({
              op: "failed",
              generation: this.generation,
              requestId: active.id,
            })
            .catch(() => this.wire.close());
      })
      .finally(() => {
        if (this.active === active) this.active = null;
      });
  }
  private async reply(requestId: string, text: string): Promise<void> {
    const active = this.active;
    if (!active || active.id !== requestId || active.abort.signal.aborted)
      throw new Error("Stale channel reply");
    const receipt = new Promise<void>((resolve, reject) => {
      active.resolve = resolve;
      active.reject = reject;
    });
    await Promise.all([
      this.wire.send({
        op: "reply",
        generation: this.generation,
        requestId,
        text,
      }),
      receipt,
    ]);
  }
}

export async function runNativeClaudeChannel(options: {
  socketPath: string;
  registrationId: string;
  providerSessionId: string;
  connectMcp?: (
    channel: ReturnType<typeof createClaudeChannelServer>,
  ) => Promise<void>;
}): Promise<void> {
  if (!isId(options.registrationId)) throw new Error("Invalid registration");
  providerSession(options.providerSessionId);
  const opened = await openChannelControl(
    options.socketPath,
    "claude.channel",
    {
      registrationId: options.registrationId,
      providerSessionId: options.providerSessionId,
      cwd: await realpath(process.cwd()),
    },
  );
  if (!isId(opened.result.generation)) {
    opened.wire.close();
    throw new Error("Invalid generation");
  }
  const channel = createClaudeChannelServer({
    sessionId: options.registrationId,
    generation: opened.result.generation,
  });
  const closed = new Promise<void>((resolve) => {
    channel.server.onclose = () => {
      channel.invalidate();
      opened.wire.close();
      resolve();
    };
  });
  opened.wire.onClose(() => {
    channel.invalidate();
    void channel.server.close();
  });
  const initialized = new Promise<void>((resolve) => {
    channel.server.oninitialized = resolve;
  });
  try {
    await (options.connectMcp
      ? options.connectMcp(channel)
      : channel.connectStdio());
    await Promise.race([
      initialized,
      closed.then(() => {
        throw new Error("MCP closed before initialization");
      }),
    ]);
    new NativeRequests(opened.wire, opened.result.generation, channel);
    await closed;
  } finally {
    opened.wire.close();
    await channel.server.close();
  }
}

async function readHook(input: Readable): Promise<JsonObject> {
  let text = "";
  let bytes = 0;
  const decoder = new StringDecoder("utf8");
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    text += decoder.write(buffer);
    if (bytes > 32768) throw new Error("Hook input exceeded");
  }
  const value: unknown = JSON.parse(text + decoder.end());
  if (record(value) !== value) throw new Error("Invalid hook input");
  return value as JsonObject;
}
function argumentsFor(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]!;
    const value = argv[index + 1];
    if (!key.startsWith("--") || value === undefined || flags.has(key))
      throw new Error("Invalid channel arguments");
    flags.set(key, value);
  }
  return flags;
}
function required(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (value === undefined) throw new Error("Missing channel argument");
  flags.delete(key);
  return value;
}
export async function runClaudeChannelCommand(
  argv: string[],
  options: {
    socketPath: string;
    input?: Readable;
    output?: Writable;
    executable?: string;
  },
): Promise<boolean> {
  const command = argv[0];
  if (
    !["claude-setup", "claude-hook", "claude-channel"].includes(String(command))
  )
    return false;
  if (command === "claude-setup") {
    const flags = argumentsFor(argv.slice(2));
    const directory = required(flags, "--output-dir");
    if (flags.size) throw new Error("Unknown channel argument");
    const setup = await createClaudeSetup({
      directory,
      providerSessionId: String(argv[1]),
      socketPath: options.socketPath,
      ...(options.executable ? { executable: options.executable } : {}),
    });
    (options.output ?? process.stdout).write(setup.command + "\n");
  } else await internalCommand(command!, argv.slice(1), options);
  return true;
}
async function internalCommand(
  command: string,
  argv: string[],
  options: { socketPath: string; input?: Readable },
) {
  const flags = argumentsFor(argv);
  const registrationId = required(flags, "--registration");
  const providerSessionId = providerSession(required(flags, "--session"));
  const socketPath = absolute(required(flags, "--socket"));
  if (!isId(registrationId) || flags.size || dirname(socketPath) === "/")
    throw new Error("Invalid channel arguments");
  if (command === "claude-channel") {
    await runNativeClaudeChannel({
      socketPath,
      registrationId,
      providerSessionId,
    });
    return;
  }
  const hook = await readHook(options.input ?? process.stdin);
  const actual = providerSession(hook.session_id);
  if (!["SessionStart", "SessionEnd"].includes(String(hook.hook_event_name)))
    throw new Error("Invalid lifecycle hook");
  const opened = await openChannelControl(socketPath, "claude.lifecycle", {
    registrationId,
    providerSessionId: actual,
    event: hook.hook_event_name,
    cwd: await realpath(absolute(String(hook.cwd))),
  });
  opened.wire.close();
}
