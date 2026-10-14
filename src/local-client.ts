import { createConnection } from "node:net";
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { MAX_FRAME_BYTES, isId } from "./protocol.js";

export const HOST_UNAVAILABLE_MESSAGE =
  "Local host is not running. Start p2pme host --workspace PATH and keep it running. Use the same --state-dir on every command.";

export interface ControlRequest {
  id: string;
  op: string;
  args: Record<string, unknown>;
}
export interface ControlResponse {
  id: string;
  ok: true;
  result: Record<string, unknown>;
}

export async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      "Control directory must be private and owned by the current user",
    );
}
export async function controlRequest(
  socketPath: string,
  request: ControlRequest,
  timeoutMs = 60000,
): Promise<ControlResponse> {
  await inspectControlSocket(socketPath);
  const frame = JSON.stringify(request) + "\n";
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES)
    throw new Error("Control request exceeds limit");
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(
      () => finish(new Error("Local request timed out")),
      timeoutMs,
    );
    const finish = (error?: Error, response?: ControlResponse) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    socket.once("connect", () => socket.write(frame));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        new Error(
          error.code === "ECONNREFUSED" || error.code === "ENOENT"
            ? HOST_UNAVAILABLE_MESSAGE
            : "Local host connection failed",
        ),
      ),
    );
    socket.once("close", () => finish(new Error("Local host disconnected")));
    socket.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_FRAME_BYTES)
        return finish(new Error("Control response exceeds limit"));
      if (!bytes.includes(10)) return;
      try {
        finish(undefined, parseResponse(bytes.toString("utf8"), request.id));
      } catch {
        finish(new Error("Local host rejected the request"));
      }
    });
  });
}
async function inspectControlSocket(socketPath: string): Promise<void> {
  try {
    await assertPrivateDirectory(dirname(socketPath));
    const info = await lstat(socketPath);
    if (
      !info.isSocket() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error(
        "Control socket must be private and owned by the current user",
      );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new Error(HOST_UNAVAILABLE_MESSAGE, { cause: error });
    throw error;
  }
}
function parseResponse(frame: string, requestId: string): ControlResponse {
  const value = JSON.parse(frame) as Record<string, unknown>;
  if (
    !isId(value.id) ||
    value.id !== requestId ||
    value.ok !== true ||
    !value.result ||
    typeof value.result !== "object"
  )
    throw new Error("Invalid control response");
  return value as unknown as ControlResponse;
}
