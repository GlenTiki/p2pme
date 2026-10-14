import { createServer, type Socket, type Server } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  createHost,
  type HostController,
  type LocalProfile,
  type SessionAdapter,
} from "./host.js";
import { openHostStore, type HostStore } from "./host-store.js";
import { MAX_FRAME_BYTES } from "./protocol.js";
import { assertPrivateDirectory, type ControlRequest } from "./local-client.js";
import { openDaemonPolicy } from "./daemon-policy.js";
import {
  DaemonControl,
  type Approval,
  type DaemonTransport,
} from "./daemon-control.js";
import type { RtcChannel } from "./rtc-channel.js";
export type { ControlRequest } from "./local-client.js";
export type { Approval, DaemonTransport } from "./daemon-control.js";

export type DaemonExtension = (
  request: ControlRequest,
  socket: Socket,
  context: {
    host: HostController;
    store: HostStore;
    send(frame: Record<string, unknown>): Promise<void>;
  },
) => Promise<boolean>;
export interface DaemonOptions {
  stateDir: string;
  workspace: string;
  profiles: LocalProfile[];
  attachCodex(threadId: string): Promise<SessionAdapter>;
  confirm(approval: Approval, signal: AbortSignal): Promise<boolean>;
  transport: DaemonTransport;
  extensions?: DaemonExtension[];
}
export interface Daemon {
  host: HostController;
  store: HostStore;
  socketPath: string;
  close(): Promise<void>;
}
const requestSchema = z
  .object({
    id: z.uuid(),
    op: z.string().min(1).max(100),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();

function send(socket: Socket, frame: Record<string, unknown>): Promise<void> {
  const bytes = JSON.stringify(frame) + "\n";
  if (Buffer.byteLength(bytes) > MAX_FRAME_BYTES)
    return Promise.reject(new Error("Local response exceeds limit"));
  return new Promise((resolve, reject) => {
    socket.write(bytes, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
class LocalDaemon implements Daemon {
  readonly socketPath: string;
  readonly rooms = new Map<string, RtcChannel>();
  readonly sockets = new Set<Socket>();
  private server: Server;
  private control!: DaemonControl;
  private identity: { dev: number; ino: number } | null = null;
  private closing: Promise<void> | null = null;
  constructor(
    readonly host: HostController,
    readonly store: HostStore,
    private readonly options: DaemonOptions,
  ) {
    this.socketPath = join(options.stateDir, "control.sock");
    this.server = createServer((socket) => this.accept(socket));
    this.server.on("error", () => {
      void this.close().catch(() => {});
    });
  }
  async start(): Promise<void> {
    const policy = await openDaemonPolicy(
      this.options.stateDir,
      this.options.workspace,
      this.store.snapshot().grants.length > 0 ||
        this.store.snapshot().sessions.length > 0,
    );
    this.control = new DaemonControl({
      ...this.options,
      host: this.host,
      store: this.store,
      policy,
      rooms: this.rooms,
    });
    await listen(this.server, this.socketPath);
    this.identity = await lstat(this.socketPath);
    await chmod(this.socketPath, 0o600);
    this.control.restore();
  }
  private accept(socket: Socket): void {
    if (this.closing || this.sockets.size >= 16) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const abort = new AbortController();
    socket.on("error", () => {});
    socket.once("close", () => {
      abort.abort();
      this.sockets.delete(socket);
    });
    socket.once("end", () => socket.destroy());
    const timer = setTimeout(() => socket.destroy(), 10000);
    let bytes = Buffer.alloc(0);
    const receive = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      if (!bytes.includes(10)) return;
      clearTimeout(timer);
      socket.off("data", receive);
      socket.pause();
      void this.request(socket, bytes, abort.signal).catch(() =>
        socket.destroy(),
      );
    };
    socket.once("close", () => clearTimeout(timer));
    socket.on("data", receive);
  }
  private async request(
    socket: Socket,
    bytes: Buffer,
    signal: AbortSignal,
  ): Promise<void> {
    let request: ControlRequest;
    try {
      request = requestSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    } catch {
      socket.destroy();
      return;
    }
    try {
      if (
        [
          "status",
          "start",
          "register",
          "pair",
          "invite",
          "cancel-invite",
          "revoke",
          "publish",
        ].includes(request.op)
      ) {
        socket.on("data", () => socket.destroy());
        socket.resume();
      }
      const result = await this.control.handle(request, signal);
      if (result === null && (await this.extension(request, socket))) {
        socket.resume();
        return;
      }
      if (result === null) throw new Error("Unknown local operation");
      await send(socket, { id: request.id, ok: true, result });
    } catch {
      await send(socket, {
        id: request.id,
        ok: false,
        error: "Local host rejected the request",
      });
    }
    socket.end();
  }
  private async extension(
    request: ControlRequest,
    socket: Socket,
  ): Promise<boolean> {
    for (const extension of this.options.extensions ?? []) {
      if (
        await extension(request, socket, {
          host: this.host,
          store: this.store,
          send: (frame) => send(socket, frame),
        })
      )
        return true;
    }
    return false;
  }
  close(): Promise<void> {
    this.closing ??= this.dispose();
    return this.closing;
  }
  private async dispose(): Promise<void> {
    this.control?.stop();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    await Promise.allSettled(
      [...this.rooms.values()].map((room) => room.close()),
    );
    try {
      try {
        await this.control?.close();
      } finally {
        await this.host.close();
      }
    } finally {
      if (this.identity) {
        const current = await lstat(this.socketPath).catch(() => null);
        if (
          current?.ino === this.identity.ino &&
          current.dev === this.identity.dev
        )
          await unlink(this.socketPath);
      }
    }
  }
}
async function prepare(options: DaemonOptions): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("The local host requires macOS or Linux");
  if (!isAbsolute(options.workspace) || !isAbsolute(options.stateDir))
    throw new Error("Use absolute workspace and state paths");
  if (
    Buffer.byteLength(join(options.stateDir, "control.sock")) >
    (process.platform === "darwin" ? 103 : 107)
  )
    throw new Error("Control socket path is too long");
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(options.stateDir);
}
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  await prepare(options);
  const store = await openHostStore(options.stateDir);
  let daemon: LocalDaemon | undefined;
  try {
    const host = await createHost({
      store,
      profiles: options.profiles,
      emit: async (grantId, event) => {
        await daemon?.rooms.get(grantId)?.send(JSON.stringify(event));
      },
      onRevoke: async (grantId) => {
        try {
          await daemon?.rooms.get(grantId)?.close();
        } finally {
          daemon?.rooms.delete(grantId);
        }
      },
    });
    daemon = new LocalDaemon(host, store, options);
    const mask = process.umask(0o077);
    try {
      await daemon.start();
    } finally {
      process.umask(mask);
    }
    return daemon;
  } catch (error) {
    if (daemon) await daemon.close();
    else await store.close();
    throw error;
  }
}
