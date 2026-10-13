import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createManagedClaude,
  spawnJsonProcess,
  type JsonObject,
  type ProcessSpawner,
} from "../src/adapters.js";

function fakeProcess() {
  const events = new EventEmitter();
  const signals: unknown[] = [];
  const child = Object.assign(events, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      child.signalCode = signal;
      queueMicrotask(() => child.emit("close", null, signal));
      return true;
    },
  });
  const calls: unknown[] = [];
  const spawn: ProcessSpawner = (...args) => {
    calls.push(args);
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { child, signals, calls, spawn };
}

describe("provider process transport", () => {
  it("enforces the frame limit per line rather than per chunk", async () => {
    const process = fakeProcess();
    const transport = spawnJsonProcess(
      "codex",
      ["app-server", "proxy"],
      undefined,
      process.spawn,
    );
    const messages: JsonObject[] = [];
    transport.subscribe((value) => messages.push(value));
    process.child.stdout.write(
      JSON.stringify({ text: "x".repeat(1024 * 1024 - 20) }) +
        "\n" +
        JSON.stringify({ other: "y".repeat(100) }) +
        "\n",
    );
    expect(messages).toHaveLength(2);
    expect(process.signals).toEqual([]);
    await transport.close();
  });

  it("handles stderr failure without an unhandled stream error", async () => {
    const process = fakeProcess();
    const transport = spawnJsonProcess(
      "codex",
      ["app-server", "proxy"],
      undefined,
      process.spawn,
    );
    const failures: Error[] = [];
    transport.onClose((error) => failures.push(error));
    process.child.stderr.emit("error", new Error("pipe failed"));
    expect(failures).toHaveLength(1);
    await transport.close();
  });

  it("rejects a pending managed turn when the process fails", async () => {
    const process = fakeProcess();
    const managed = createManagedClaude({ cwd: "/tmp", spawn: process.spawn });
    const pending = managed.adapter.submit(
      {
        id: crypto.randomUUID(),
        text: "hello",
        kind: "chat",
        principal: "human-device",
        signal: new AbortController().signal,
      },
      async () => {},
    );
    process.child.emit("error", new Error("spawn failed"));
    await expect(pending).rejects.toThrow();
    expect(process.signals).toEqual(["SIGTERM"]);
  });
  it("uses explicit Claude arguments and keeps prompts out of argv", async () => {
    const process = fakeProcess();
    const managed = createManagedClaude({
      cwd: "/tmp/approved",
      modelId: "approved-model",
      spawn: process.spawn,
    });
    expect(process.calls).toEqual([
      [
        "claude",
        [
          "--print",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--replay-user-messages",
          "--session-id",
          managed.providerSessionId,
          "--permission-prompts",
          "none",
          "--permission-mode",
          "default",
          "--model",
          "approved-model",
        ],
        "/tmp/approved",
      ],
    ]);
    await managed.adapter.detach();
    expect(process.signals).toEqual(["SIGTERM"]);
  });

  it("reassembles split UTF-8 and combined JSON frames", async () => {
    const process = fakeProcess();
    const transport = spawnJsonProcess(
      "codex",
      ["app-server", "proxy"],
      undefined,
      process.spawn,
    );
    const messages: JsonObject[] = [];
    transport.subscribe((value) => messages.push(value));
    const encoded = Buffer.from('{"text":"€"}\n{"next":true}\n');
    process.child.stdout.write(encoded.subarray(0, 10));
    process.child.stdout.write(encoded.subarray(10));
    expect(messages).toEqual([{ text: "€" }, { next: true }]);
    await transport.close();
  });

  it.each(["{invalid}\n", "x".repeat(1024 * 1024 + 1)])(
    "closes malformed or oversized output",
    async (payload) => {
      const process = fakeProcess();
      const transport = spawnJsonProcess(
        "codex",
        ["app-server", "proxy"],
        undefined,
        process.spawn,
      );
      const failures: Error[] = [];
      transport.onClose((error) => failures.push(error));
      process.child.stdout.write(payload);
      expect(failures).toHaveLength(1);
      expect(process.signals).toEqual(["SIGTERM"]);
      await expect(transport.send({ hello: true })).rejects.toThrow();
      await transport.close();
    },
  );

  it("rejects invalid local options before spawning", () => {
    const process = fakeProcess();
    expect(() =>
      createManagedClaude({ cwd: "relative", spawn: process.spawn }),
    ).toThrow();
    expect(() =>
      createManagedClaude({
        cwd: "/tmp",
        modelId: "model\n--flag",
        spawn: process.spawn,
      }),
    ).toThrow();
    expect(process.calls).toEqual([]);
  });
});
