import { openSync, closeSync } from "node:fs";
import { ReadStream, WriteStream, isatty } from "node:tty";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { Approval } from "./daemon-control.js";

export function terminalJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cn}]/gu,
    (character) =>
      character === "\n"
        ? character
        : character
            .split("")
            .map(
              (unit) =>
                `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
            )
            .join(""),
  );
}
export function approvalText(approval: Approval): string {
  return `Approve this device grant?\n${terminalJson(approval)}\nAccess includes current and future registered sessions in these profiles. Chat, UI actions and delegated tasks can use the provider's existing tools and return local file content. An agent label does not grant human authority.\nType approve to continue: `;
}
interface Terminal {
  input: Readable;
  output: Writable;
  close(): void | Promise<void>;
}
function terminalStream<T extends Readable | Writable>(
  mode: "r" | "w",
  create: (descriptor: number) => T,
) {
  const descriptor = openSync("/dev/tty", mode);
  try {
    if (!isatty(descriptor))
      throw new Error("A controlling terminal is required");
    const stream = create(descriptor);
    return {
      stream,
      async close() {
        await closeTerminalStream(stream);
        closeSync(descriptor);
      },
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}
function closeTerminalStream(stream: Readable | Writable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.closed) {
      resolve();
      return;
    }
    stream.once("close", resolve);
    stream.destroy();
  });
}
function openTerminal(): Terminal {
  const input = terminalStream("r", (descriptor) => new ReadStream(descriptor));
  try {
    const output = terminalStream(
      "w",
      (descriptor) => new WriteStream(descriptor),
    );
    return {
      input: input.stream,
      output: output.stream,
      async close() {
        await Promise.all([input.close(), output.close()]);
      },
    };
  } catch (error) {
    void input.close().catch(() => {});
    throw error;
  }
}
export function createTerminalApprover(
  terminal: () => Terminal = openTerminal,
) {
  let streams: Terminal | null = null;
  let closed = false;
  return {
    async confirm(approval: Approval, signal: AbortSignal) {
      if (closed)
        return Promise.reject(new Error("Terminal approval is closed"));
      streams ??= terminal();
      const current = streams;
      return confirmOnTerminal(approval, signal, () => ({
        ...current,
        close() {
          current.input.pause();
        },
      }));
    },
    async close() {
      if (closed) return;
      closed = true;
      await streams?.close();
    },
  };
}
async function confirmOnTerminal(
  approval: Approval,
  signal: AbortSignal,
  terminal: () => Terminal,
): Promise<boolean> {
  const streams = terminal();
  const prompt = createInterface({
    input: streams.input,
    output: streams.output,
    terminal: true,
  });
  try {
    return (
      (await prompt.question(approvalText(approval), { signal })) === "approve"
    );
  } finally {
    prompt.close();
    await streams.close();
  }
}
