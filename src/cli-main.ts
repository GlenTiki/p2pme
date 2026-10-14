import QRCode from "qrcode";
import { reserveQrFile } from "./cli-qr.js";
import { createHostInvitationUrl } from "./rtc-identity.js";
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

const help = `p2pme host --workspace PATH [--state-dir PATH]\np2pme invite --profiles codex,claude [--agent] [--scopes LIST] [--qr-file ABSOLUTE_PATH]\np2pme cancel-invite ATTEMPT_UUID\np2pme pair --profiles codex,claude [--agent] [--scopes LIST]\np2pme status\np2pme start codex|claude\np2pme register codex THREAD_ID\np2pme revoke GRANT_ID\np2pme ui publish SESSION_ID FILE\np2pme claude-setup SESSION_UUID --output-dir PATH\nInvite prints a code and QR. Possession authorizes one device with the stated access.\n--qr-file writes a private PNG in an existing private directory.\nLegacy pair reads the invitation from stdin. Approve on the host terminal.\nAll commands accept --state-dir PATH.\n`;
export interface CliOptions {
  input?: Readable;
  output?: Writable;
  daemon?: (
    options: DaemonOptions,
  ) => Promise<Pick<Daemon, "close"> & { host: { hostId: string } }>;
  request?: typeof controlRequest;
  qrFile?: typeof reserveQrFile;
}
function qrArgument(args: string[]): string | undefined {
  const index = args.indexOf("--qr-file");
  if (index < 0) return;
  const path = args[index + 1];
  if (
    args[0] !== "invite" ||
    !path ||
    path.startsWith("--") ||
    args.lastIndexOf("--qr-file") !== index
  )
    throw new Error(
      "Invalid QR image path. Use a new file in an existing private directory with an absolute path.",
    );
  args.splice(index, 2);
  return path;
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
  if (!parsed.profileIds) throw new Error("Pairing requires --profiles");
  return parsed;
}
async function command(
  args: string[],
  input: Readable,
): Promise<{ op: string; args: Record<string, unknown> }> {
  if (args[0] === "invite")
    return { op: "invite", args: pairingFlags(args.slice(1)) };
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
    case "cancel-invite:2":
      return { op: "cancel-invite", args: { attemptId: args[1] } };
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
        offer: async (options) => {
          const { offerHostPairing } = await import("./host-pairing.js");
          const offer = await offerHostPairing({ ...options, network });
          return Object.assign(offer, {
            url: createHostInvitationUrl(offer.invitation),
          });
        },
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
      `p2pme host ${daemon.host.hostId}\nRun p2pme invite to authorize a device with a code or QR. Legacy pair approval uses this terminal.\n`,
    );
    await new Promise<void>((done, reject) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        process.off("SIGHUP", stop);
        void daemon.close().then(done, reject);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      process.once("SIGHUP", stop);
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
  await runControl(args, socketPath, input, output, options);
}

async function runControl(
  args: string[],
  socketPath: string,
  input: Readable,
  output: Writable,
  options: CliOptions,
): Promise<void> {
  const qrPath = qrArgument(args);
  const request = await command(args, input);
  const qr = qrPath
    ? await (options.qrFile ?? reserveQrFile)(qrPath)
    : undefined;
  try {
    const response = await (options.request ?? controlRequest)(
      socketPath,
      { id: crypto.randomUUID(), ...request },
      request.op === "pair" ? 600000 : 60000,
    );
    await printResponse(request.op, response.result, output);
    if (qr) {
      try {
        if (typeof response.result.url !== "string")
          throw new Error("Invalid invitation response");
        await qr.write(response.result.url);
      } catch {
        throw new Error(
          "QR image could not be written. Use the printed code or connection link.",
        );
      }
    }
  } finally {
    await qr?.close();
  }
}

async function printInvitation(
  result: Record<string, unknown>,
  output: Writable,
): Promise<void> {
  if (typeof result.url !== "string")
    throw new Error("Invalid invitation response");
  output.write(
    "This invitation authorizes one device. Access includes current and future registered sessions in these profiles. Chat, UI actions and delegated tasks can use the provider's existing tools and return local file content.\n",
  );
  output.write(terminalJson(result) + "\n");
  const qr = await QRCode.toString(result.url, {
    type: "terminal",
    small: true,
  });
  output.write(qr);
}

async function printResponse(
  op: string,
  result: Record<string, unknown>,
  output: Writable,
): Promise<void> {
  if (op === "invite") await printInvitation(result, output);
  else output.write(terminalJson(result) + "\n");
}
