import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { Duplex, PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { attachCodex } from "../src/adapters/codex.js";
import { spawnCodexProxy } from "../src/adapters/proxy.js";
import { spawnJsonProcess } from "../src/adapters/transport.js";
import type { ProcessSpawner, JsonObject } from "../src/adapters/transport.js";

function proxyFixture(
  options: {
    delay?: number;
    reject?: boolean;
    silent?: boolean;
    stubborn?: boolean;
  } = {},
) {
  const signals: NodeJS.Signals[] = [];
  const calls: unknown[] = [];
  const frames: JsonObject[] = [];
  const requestHeaders: Record<string, unknown>[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let peer: WebSocket | undefined;
  let upgrades = 0;
  let parseErrors = 0;
  let upgradeTimer: ReturnType<typeof setTimeout> | undefined;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      if (options.stubborn && signal !== "SIGKILL") return true;
      child.signalCode = signal;
      queueMicrotask(() => {
        remote.destroy();
        child.stdout.end();
        child.stderr.end();
        child.emit("close", null, signal);
      });
      return true;
    },
  });
  const remote = Duplex.from({ readable: child.stdin, writable: child.stdout });
  remote.on("error", () => {});
  server.on("clientError", () => {
    parseErrors++;
    if (signals.length) return;
    child.exitCode = 1;
    queueMicrotask(() => child.emit("close", 1, null));
  });
  server.on("upgrade", (request, socket, head) => {
    requestHeaders.push(request.headers);
    if (options.silent) return;
    if (options.reject) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upgrade = () =>
      wss.handleUpgrade(request, socket, head, (socket) => {
        upgrades++;
        peer = socket;
        socket.on("error", () => {});
        socket.on("message", (bytes, binary) => {
          expect(binary).toBe(false);
          expect(bytes.toString().endsWith("\n")).toBe(false);
          const value = JSON.parse(bytes.toString()) as JsonObject;
          frames.push(value);
          const thread = {
            id: "synthetic-thread",
            cwd: "/tmp",
            status: { type: "idle" },
          };
          const result = value.method === "initialize" ? {} : { thread };
          if (value.id !== undefined)
            socket.send(JSON.stringify({ id: value.id, result }));
        });
      });
    if (options.delay) upgradeTimer = setTimeout(upgrade, options.delay);
    else upgrade();
  });
  const spawn: ProcessSpawner = (...args) => {
    calls.push(args);
    queueMicrotask(() => server.emit("connection", remote));
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return {
    spawn,
    child,
    calls,
    frames,
    signals,
    requestHeaders,
    pauseInput: () => remote.pause(),
    peer: () => peer,
    upgrades: () => upgrades,
    parseErrors: () => parseErrors,
    async close() {
      clearTimeout(upgradeTimer);
      peer?.terminate();
      remote.destroy();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.close();
    },
  };
}

describe("Codex proxy framing", () => {
  it("rejects plain JSON lines at the HTTP upgrade boundary", async () => {
    const fixture = proxyFixture();
    const transport = spawnJsonProcess(
      "codex",
      ["app-server", "proxy"],
      undefined,
      fixture.spawn,
    );
    const failed = new Promise<Error>((resolve) => transport.onClose(resolve));
    try {
      await transport.send({ id: 1, method: "initialize", params: {} });
      expect(await failed).toBeInstanceOf(Error);
      expect(fixture.parseErrors()).toBe(1);
      expect(fixture.upgrades()).toBe(0);
    } finally {
      await transport.close();
      await fixture.close();
    }
  });
  it("attaches through a real WebSocket upgrade without JSON lines", async () => {
    const fixture = proxyFixture();
    try {
      const adapter = await attachCodex({
        threadId: "synthetic-thread",
        expectedCwd: "/tmp",
        spawn: fixture.spawn,
      });
      expect(fixture.upgrades()).toBe(1);
      expect(fixture.parseErrors()).toBe(0);
      expect(fixture.calls).toEqual([
        ["codex", ["app-server", "proxy"], undefined],
      ]);
      expect(fixture.frames).toEqual([
        {
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "p2pme", title: "p2pme", version: "0.1.0" },
            capabilities: { experimentalApi: false, requestAttestation: false },
          },
        },
        { method: "initialized" },
        {
          id: 2,
          method: "thread/read",
          params: { threadId: "synthetic-thread", includeTurns: false },
        },
        {
          id: 3,
          method: "thread/resume",
          params: { threadId: "synthetic-thread", excludeTurns: true },
        },
      ]);
      expect(fixture.requestHeaders[0]).not.toHaveProperty("origin");
      expect(fixture.requestHeaders[0]).not.toHaveProperty(
        "sec-websocket-extensions",
      );
      await adapter.detach();
      expect(fixture.signals).toEqual(["SIGTERM"]);
    } finally {
      await fixture.close();
    }
  });
  it("waits for the upgrade before sending and drains stderr", async () => {
    const fixture = proxyFixture({ delay: 20 });
    const transport = spawnCodexProxy(fixture.spawn);
    try {
      const sent = transport.send({ method: "synthetic" });
      expect(fixture.frames).toEqual([]);
      fixture.child.stderr.write("private synthetic diagnostic");
      await sent;
      await new Promise((resolve) => setImmediate(resolve));
      expect(fixture.frames).toEqual([{ method: "synthetic" }]);
      expect(fixture.child.stderr.readableLength).toBe(0);
    } finally {
      await transport.close();
      await fixture.close();
    }
  });
  it.each([
    { name: "invalid JSON", payload: "{broken", binary: false },
    { name: "array", payload: "[]", binary: false },
    { name: "null", payload: "null", binary: false },
    { name: "scalar", payload: "17", binary: false },
    { name: "binary", payload: "{}", binary: true },
    { name: "oversized", payload: "x".repeat(1024 * 1024 + 1), binary: false },
  ])(
    "rejects $name frames and closes the child once",
    async ({ payload, binary }) => {
      const fixture = proxyFixture();
      const transport = spawnCodexProxy(fixture.spawn);
      const messages: JsonObject[] = [];
      const failures: Error[] = [];
      transport.subscribe((value) => messages.push(value));
      const failed = new Promise<Error>((resolve) =>
        transport.onClose((error) => {
          failures.push(error);
          resolve(error);
        }),
      );
      try {
        await transport.send({ method: "synthetic" });
        fixture.peer()!.send(payload, { binary });
        expect((await failed).message).not.toContain(payload);
        const closing = transport.close();
        expect(transport.close()).toBe(closing);
        await closing;
        expect(messages).toEqual([]);
        expect(failures).toHaveLength(1);
        expect(fixture.signals).toEqual(["SIGTERM"]);
        await expect(transport.send({ method: "later" })).rejects.toThrow();
      } finally {
        await transport.close();
        await fixture.close();
      }
    },
  );
  it("bounds combined fragmented messages before their final payload is delivered", async () => {
    const fixture = proxyFixture();
    const transport = spawnCodexProxy(fixture.spawn);
    const failed = new Promise<Error>((resolve) => transport.onClose(resolve));
    try {
      await transport.send({ method: "synthetic" });
      fixture.peer()!.send("x".repeat(600000), { fin: false });
      fixture.peer()!.send("x".repeat(600000), { fin: true });
      expect((await failed).message).toBe("Codex proxy connection failed");
    } finally {
      await transport.close();
      await fixture.close();
    }
  });
  it("rejects oversized outgoing messages without sending them", async () => {
    const fixture = proxyFixture();
    const transport = spawnCodexProxy(fixture.spawn);
    try {
      await expect(
        transport.send({ text: "x".repeat(1024 * 1024) }),
      ).rejects.toThrow("Provider request exceeds limit");
      expect(fixture.frames).toEqual([]);
    } finally {
      await transport.close();
      await fixture.close();
    }
  });
  it.each([{ reject: true }, { silent: true }])(
    "rejects failed or timed out upgrades %j",
    async (options) => {
      const fixture = proxyFixture(options);
      const transport = spawnCodexProxy(fixture.spawn, 30);
      try {
        await expect(transport.send({ method: "synthetic" })).rejects.toThrow(
          "Codex proxy connection failed",
        );
        expect(fixture.frames).toEqual([]);
      } finally {
        await transport.close();
        await fixture.close();
      }
    },
  );
  it("rejects a send waiting for upgrade when the process cannot start", async () => {
    const fixture = proxyFixture({ silent: true });
    const transport = spawnCodexProxy(fixture.spawn);
    try {
      const sent = transport.send({ method: "synthetic" });
      fixture.child.emit("error", new Error("private spawn detail"));
      await expect(sent).rejects.toThrow("Codex proxy process failed");
    } finally {
      await transport.close();
      await fixture.close();
    }
  });
  it("rejects pending open sends and bounds termination of an unresponsive proxy", async () => {
    const fixture = proxyFixture({ silent: true, stubborn: true });
    const transport = spawnCodexProxy(fixture.spawn, 10000, 20);
    const pending = transport.send({ method: "synthetic" });
    const rejection = expect(pending).rejects.toThrow(
      "Codex proxy transport closed",
    );
    try {
      await transport.close();
      await rejection;
      expect(fixture.signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      await transport.close();
      await fixture.close();
    }
  });
  it("rejects a buffered send when a connected proxy closes", async () => {
    const fixture = proxyFixture();
    const transport = spawnCodexProxy(fixture.spawn);
    try {
      await transport.send({ method: "synthetic" });
      fixture.pauseInput();
      await transport.send({ text: "x".repeat(900000) });
      let settled = false;
      const sent = transport.send({ text: "x".repeat(900000) });
      const outcome = sent.then(
        () => {
          settled = true;
          return "sent";
        },
        (error) => {
          settled = true;
          return (error as Error).message;
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      await transport.close();
      expect(await outcome).toBe("Codex proxy transport closed");
    } finally {
      await transport.close();
      await fixture.close();
    }
  });
  it.each(["stdin", "stdout", "stderr"] as const)(
    "closes safely after a %s pipe error",
    async (stream) => {
      const fixture = proxyFixture();
      const transport = spawnCodexProxy(fixture.spawn);
      const failed = new Promise<Error>((resolve) =>
        transport.onClose(resolve),
      );
      try {
        await transport.send({ method: "synthetic" });
        fixture.child[stream].emit("error", new Error("private diagnostic"));
        expect((await failed).message).not.toContain("private diagnostic");
        await transport.close();
        expect(fixture.signals).toEqual(["SIGTERM"]);
      } finally {
        await transport.close();
        await fixture.close();
      }
    },
  );
  it("delivers objects and removes unsubscribed listeners", async () => {
    const fixture = proxyFixture();
    const transport = spawnCodexProxy(fixture.spawn);
    const received: JsonObject[] = [];
    const unsubscribed: JsonObject[] = [];
    const removed = transport.subscribe((value) => unsubscribed.push(value));
    removed();
    const delivered = new Promise<void>((resolve) =>
      transport.subscribe((value) => {
        received.push(value);
        resolve();
      }),
    );
    try {
      await transport.send({ method: "synthetic" });
      fixture
        .peer()!
        .send(JSON.stringify({ unicode: "€", nested: { valid: true } }));
      await delivered;
      expect(received).toEqual([{ unicode: "€", nested: { valid: true } }]);
      expect(unsubscribed).toEqual([]);
    } finally {
      await transport.close();
      await fixture.close();
    }
  });
  it("returns the same shutdown promise when a close subscriber closes again", async () => {
    const fixture = proxyFixture();
    const transport = spawnCodexProxy(fixture.spawn);
    let nested: Promise<void> | undefined;
    transport.onClose(() => {
      nested = transport.close();
    });
    try {
      const closing = transport.close();
      expect(nested).toBe(closing);
      await closing;
    } finally {
      await transport.close();
      await fixture.close();
    }
  });
});
