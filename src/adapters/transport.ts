import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { isAbsolute } from "node:path";

export type JsonObject = Record<string, unknown>;
export interface JsonTransport {
  send(value: JsonObject): Promise<void>;
  subscribe(listener: (value: JsonObject) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}
export type ProcessSpawner = (
  command: string,
  args: string[],
  cwd?: string,
) => ChildProcessWithoutNullStreams;

export function record(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

export function localString(value: string): string {
  if (
    !value ||
    value.length > 4096 ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Invalid local process option");
  return value;
}

export function localDirectory(value: string): string {
  if (!isAbsolute(localString(value)))
    throw new Error("Workspace must be absolute");
  return value;
}

export function spawnJsonProcess(
  command: "codex" | "claude",
  args: string[],
  cwd?: string,
  start: ProcessSpawner = (executable, argv, directory) =>
    spawn(executable, argv, { cwd: directory, stdio: "pipe", shell: false }),
): JsonTransport {
  args.forEach(localString);
  if (cwd !== undefined) localDirectory(cwd);
  return new ProcessTransport(start(command, args, cwd));
}

class ProcessTransport implements JsonTransport {
  private readonly listeners = new Set<(value: JsonObject) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private failure: Error | null = null;
  private closing: Promise<void> | null = null;
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    child.stdout.on("error", () =>
      this.fail(new Error("Provider stdout failed")),
    );
    child.stdin.on("error", () =>
      this.fail(new Error("Provider stdin failed")),
    );
    child.stderr.resume();
    child.stderr.on("error", () =>
      this.fail(new Error("Provider stderr failed")),
    );
    child.on("error", () => this.fail(new Error("Provider process failed")));
    child.on("close", () => this.fail(new Error("Provider process exited")));
  }
  private read(chunk: Buffer): void {
    if (this.failure) return;
    this.buffer += this.decoder.write(chunk);
    try {
      this.readLines();
      if (Buffer.byteLength(this.buffer) > 1024 * 1024)
        throw new Error("Provider frame exceeds limit");
    } catch {
      this.fail(new Error("Invalid provider JSON frame"));
    }
  }
  private readLines(): void {
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > 1024 * 1024)
        throw new Error("Provider frame exceeds limit");
      if (line) {
        const value: unknown = JSON.parse(line);
        if (value === null || typeof value !== "object" || Array.isArray(value))
          throw new Error("Expected JSON object");
        for (const listener of this.listeners) listener(value as JsonObject);
      }
      newline = this.buffer.indexOf("\n");
    }
  }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.buffer = "";
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 1000);
    kill.unref();
    this.child.once("close", () => clearTimeout(kill));
    this.child.kill("SIGTERM");
    for (const listener of this.closeListeners) listener(error);
  }
  send(value: JsonObject): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    const line = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(line) > 1024 * 1024)
      return Promise.reject(new Error("Provider request exceeds limit"));
    return new Promise((resolve, reject) =>
      this.child.stdin.write(line, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
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
    this.closing ??= this.stop();
    return this.closing;
  }
  private async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      this.child.once("close", resolve);
      this.child.stdin.end();
      this.fail(new Error("Provider transport closed"));
    });
  }
}
