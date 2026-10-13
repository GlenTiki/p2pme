import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { RTCPeerConnection } from "werift";
import {
  attachCodex,
  createManagedCodex,
  createManagedClaude,
} from "./adapters.js";
import { createClaudeChannelExtension } from "./channel-ipc.js";
import { runClaudeChannelCommand } from "./claude-channel-cli.js";
import { startDaemon, type Daemon, type DaemonOptions } from "./daemon.js";
import { controlRequest } from "./local-client.js";
import { createTerminalApprover, terminalJson } from "./cli-consent.js";
import { approvePairing } from "./pairing.js";
import { serveHostConnection } from "./host-connection.js";
import type { LocalProfile } from "./host-types.js";

const help = `p2pme host --workspace PATH [--state-dir PATH]\np2pme pair --profiles codex,claude [--agent] [--scopes LIST]\np2pme status\np2pme start codex|claude\np2pme register codex THREAD_ID\np2pme revoke GRANT_ID\np2pme ui publish SESSION_ID FILE\np2pme claude-setup SESSION_UUID --output-dir PATH\nPair reads the invitation from stdin. Approve on the host terminal.\nAll commands accept --state-dir PATH.\n`;
export interface CliOptions {
  input?: Readable;
  output?: Writable;
  daemon?: (
    options: DaemonOptions,
  ) => Promise<Pick<Daemon, "close"> & { host: { hostId: string } }>;
  request?: typeof controlRequest;
}
function globalArguments(argv: string[]): { args: string[]; stateDir: string } {
  const args = [...argv];
  let stateDir = join(homedir(), ".p2pme");
  const index = args.indexOf("--state-dir");
  if (index >= 0) {
    if (!args[index + 1] || args[index + 1]!.startsWith("--"))
      throw new Error("Missing state directory");
    stateDir = resolve(args[index + 1]!);
    args.splice(index, 2);
  }
  return { args, stateDir };
}
async function readInput(input: Readable): Promise<string> {
  let result = "";
  for await (const chunk of input) {
    result += String(chunk);
    if (Buffer.byteLength(result) > 2048)
      throw new Error("Invitation exceeds limit");
  }
  return result.trim();
}
function pairingFlags(args: string[]): Record<string, unknown> {
  const parsed: Record<string, unknown> = {
    principal: "human-device",
    scopes: ["sessions:list", "sessions:chat"],
  };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) throw new Error("Duplicate pairing flag");
    seen.add(flag);
    if (flag === "--agent") {
      parsed.principal = "agent";
      continue;
    }
    if (flag !== "--scopes" && flag !== "--profiles")
      throw new Error("Unknown pairing flag");
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw new Error("Missing pairing value");
    parsed[flag === "--scopes" ? "scopes" : "profileIds"] = value.split(",");
  }
  if (!parsed.profileIds) throw new Error("Pair requires --profiles");
  return parsed;
}
async function command(
  args: string[],
  input: Readable,
): Promise<{ op: string; args: Record<string, unknown> }> {
  if (args[0] === "pair")
    return {
      op: "pair",
      args: {
        ...pairingFlags(args.slice(1)),
        invitation: await readInput(input),
      },
    };
  switch (`${args[0]}:${args.length}`) {
    case "status:1":
      return { op: "status", args: {} };
    case "start:2":
      return { op: "start", args: { profileId: args[1] } };
    case "register:3":
      return { op: "register", args: { provider: args[1], threadId: args[2] } };
    case "revoke:2":
      return { op: "revoke", args: { grantId: args[1] } };
    case "ui:4":
      if (args[1] === "publish")
        return {
          op: "publish",
          args: { sessionId: args[2], surface: await surfaceFile(args[3]!) },
        };
  }
  throw new Error("Unknown command. Run p2pme --help");
}

async function surfaceFile(path: string): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 24000)
    throw new Error("Surface file exceeds local request limit");
  return JSON.parse(await readFile(path, "utf8"));
}
function profiles(workspace: string): LocalProfile[] {
  return [
    {
      id: "codex",
      provider: "codex",
      models: [],
      defaultModelId: "provider-default",
      create: () => createManagedCodex({ cwd: workspace, models: [] }),
    },
    {
      id: "claude",
      provider: "claude",
      models: [],
      defaultModelId: "provider-default",
      create: async () => createManagedClaude({ cwd: workspace }),
    },
  ];
}
async function host(
  args: string[],
  stateDir: string,
  options: CliOptions,
): Promise<void> {
  if (args.length !== 3 || args[1] !== "--workspace")
    throw new Error("Host requires --workspace PATH");
  const workspace = await realpath(resolve(args[2]!));
  const network = {
    rtcPolyfill:
      RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
  };
  const terminal = createTerminalApprover();
  try {
    const daemon = await (options.daemon ?? startDaemon)({
      stateDir,
      workspace,
      profiles: profiles(workspace),
      confirm: terminal.confirm,
      attachCodex: (threadId) =>
        attachCodex({ threadId, expectedCwd: workspace }),
      extensions: [createClaudeChannelExtension({ workspace })],
      transport: {
        pair: (invitation, record, callbacks) =>
          approvePairing(invitation, record, { ...callbacks, network }),
        serve: (record, callbacks) =>
          serveHostConnection(record, {
            hostEpoch: callbacks.host.hostEpoch,
            active: callbacks.active,
            dispatch: callbacks.dispatch,
            network,
          }),
      },
    });
    (options.output ?? process.stdout).write(
      `p2pme host ${daemon.host.hostId}\nApprove device grants on this terminal.\n`,
    );
    await new Promise<void>((done, reject) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        void daemon.close().then(done, reject);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    await terminal.close();
  }
}
export async function runCli(
  argv: string[],
  options: CliOptions = {},
): Promise<void> {
  const { args, stateDir } = globalArguments(argv);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (args.length === 0 || args[0] === "--help") {
    output.write(help);
    return;
  }
  const socketPath = join(stateDir, "control.sock");
  if (await runClaudeChannelCommand(args, { socketPath, input, output }))
    return;
  if (args[0] === "host") return host(args, stateDir, options);
  const request = await command(args, input);
  const response = await (options.request ?? controlRequest)(
    socketPath,
    { id: crypto.randomUUID(), ...request },
    request.op === "pair" ? 600000 : 60000,
  );
  output.write(terminalJson(response.result) + "\n");
}
