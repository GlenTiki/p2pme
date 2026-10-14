import { HOST_UNAVAILABLE_MESSAGE } from "./local-client.js";

const startupMessages = new Set([
  HOST_UNAVAILABLE_MESSAGE,
  "Invalid QR image path. Use a new file in an existing private directory with an absolute path.",
  "QR image could not be written. Use the printed code or connection link.",
  "Host workspace identity changed; use a separate state directory",
  "Missing workspace policy; use a separate state directory",
  "Invalid daemon policy file",
  "Invalid workspace",
  "Host state must be a regular file",
  "Host state path must be a directory",
  "The local host requires macOS or Linux",
  "Use absolute workspace and state paths",
  "Control socket path is too long",
  "Control directory must be private and owned by the current user",
  "Control socket must be private and owned by the current user",
]);

export function cliErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (
      error.message ===
        "Host store is already open; inspect host.lock before manual recovery" ||
      (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    )
      return "Host state is already in use or was left after an unclean exit. Confirm all host processes that use this state directory have stopped before you manually remove stale host.lock and control.sock files. Keep host.json and daemon.json.";
    if (startupMessages.has(error.message)) return error.message;
  }
  return "p2pme command failed. Check the command and host terminal; run p2pme --help.";
}
