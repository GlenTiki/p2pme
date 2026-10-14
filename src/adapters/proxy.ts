import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Duplex } from "node:stream";
import WebSocket from "ws";
import type { JsonObject, JsonTransport, ProcessSpawner } from "./transport.js";

export function spawnCodexProxy(
  start: ProcessSpawner = (command, args) =>
    spawn(command, args, { stdio: "pipe", shell: false }),
  handshakeTimeout = 10000,
  terminationTimeout = 1000,
): JsonTransport {
  return new ProxyTransport(
    start("codex", ["app-server", "proxy"], undefined),
    handshakeTimeout,
    terminationTimeout,
  );
}

class ProxyTransport implements JsonTransport {
  private readonly listeners = new Set<(value: JsonObject) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private readonly sends = new Set<(error: Error) => void>();
  private failure: Error | null = null;
  private closing: Promise<void> | null = null;
  private readonly socket: WebSocket;
  private readonly ready: Promise<void>;
  private readonly handshakeTimer: ReturnType<typeof setTimeout>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    handshakeTimeout: number,
    private readonly terminationTimeout: number,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.ready.catch(() => {});
    child.on("error", () => this.fail("Codex proxy process failed"));
    child.on("close", () => this.fail("Codex proxy process exited"));
    child.stderr.resume();
    child.stderr.on("error", () => this.fail("Codex proxy stderr failed"));
    const pipe = Duplex.from({ readable: child.stdout, writable: child.stdin });
    pipe.on("error", () => this.fail("Codex proxy pipe failed"));
    this.handshakeTimer = setTimeout(
      () => this.fail("Codex proxy connection failed"),
      handshakeTimeout,
    );
    this.socket = new WebSocket("ws://localhost/rpc", {
      createConnection: () => pipe,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
      followRedirects: false,
    });
    this.socket.on("open", () => {
      clearTimeout(this.handshakeTimer);
      this.resolveReady();
    });
    this.socket.on("error", () => this.fail("Codex proxy connection failed"));
    this.socket.on("close", () => this.fail("Codex proxy connection closed"));
    this.socket.on("message", (data, binary) => this.receive(data, binary));
  }

  private receive(data: WebSocket.RawData, binary: boolean) {
    if (this.failure) return;
    try {
      if (binary) throw new Error("Binary frame");
      const value: unknown = JSON.parse(data.toString());
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid JSON object");
      for (const listener of this.listeners) listener(value as JsonObject);
    } catch {
      this.fail("Invalid Codex proxy JSON frame");
    }
  }

  private fail(message: string) {
    if (this.failure) return;
    this.failure = new Error(message);
    clearTimeout(this.handshakeTimer);
    this.rejectReady(this.failure);
    for (const reject of this.sends) reject(this.failure);
    this.sends.clear();
    this.closing ??= this.stop();
    for (const listener of this.closeListeners) listener(this.failure);
  }

  async send(value: JsonObject): Promise<void> {
    if (this.failure) throw this.failure;
    const frame = JSON.stringify(value);
    if (Buffer.byteLength(frame) > 1024 * 1024)
      throw new Error("Provider request exceeds limit");
    await this.ready;
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => {
      this.sends.add(reject);
      this.socket.send(frame, (error) => {
        this.sends.delete(reject);
        if (error) {
          this.fail("Codex proxy send failed");
          reject(this.failure);
        } else resolve();
      });
    });
  }

  subscribe(listener: (value: JsonObject) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onClose(listener: (error: Error) => void): () => void {
    if (this.failure) listener(this.failure);
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  close(): Promise<void> {
    this.fail("Codex proxy transport closed");
    return this.closing!;
  }

  private async stop(): Promise<void> {
    this.socket.terminate();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(
        () => this.child.kill("SIGKILL"),
        this.terminationTimeout,
      );
      timer.unref();
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    });
  }
}
