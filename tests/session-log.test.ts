import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Hypercore from "hypercore";
import { createSessionLog, type SessionLog } from "../src/session-log.js";

const sessionId = "b6e16b67-466c-4852-a94c-8dc00c2e8c42";
const message = {
  version: 1 as const,
  id: "b1c63e59-9fd0-42a6-8a49-247a2ef2b947",
  sessionId,
  type: "chat.send" as const,
  sentAt: "2026-10-13T17:00:00Z",
  payload: { text: "A signed message" },
};
const logs: SessionLog[] = [];

afterEach(async () => {
  await Promise.all(logs.splice(0).map((log) => log.close()));
});

async function openLog(key?: Uint8Array) {
  const log = await createSessionLog({ sessionId, ...(key ? { key } : {}) });
  logs.push(log);
  return log;
}

describe("signed session logs", () => {
  it("appends a validated envelope and exposes its writer public key", async () => {
    const log = await openLog();
    expect(log.publicKey).toHaveLength(32);
    await log.append(message);
    expect(log.length).toBe(1);
    expect(await log.get(0)).toEqual(message);
  });

  it("refuses malformed, cross-session and replayed commands before append", async () => {
    const log = await openLog();
    await expect(log.append({ ...message, version: 2 })).rejects.toThrow();
    await expect(
      log.append({ ...message, sessionId: crypto.randomUUID() }),
    ).rejects.toThrow();
    await log.append(message);
    await expect(log.append(message)).rejects.toThrow();
    expect(log.length).toBe(1);
  });

  it("replicates signed envelopes to a reader pinned to the writer key", async () => {
    const writer = await openLog();
    const reader = await openLog(writer.publicKey);
    await writer.append(message);
    const outgoing = writer.replicate(true);
    const incoming = reader.replicate(false);
    outgoing.pipe(incoming).pipe(outgoing);
    try {
      await expect.poll(() => reader.length).toBe(1);
      expect(await reader.get(0)).toEqual(message);
    } finally {
      outgoing.destroy();
      incoming.destroy();
    }
  });

  it("cannot forge an append with only the writer public key", async () => {
    const writer = await openLog();
    const reader = await openLog(writer.publicKey);
    await expect(reader.append(message)).rejects.toThrow();
    expect(reader.length).toBe(0);
  });

  it("keeps a different writer's log out of the pinned session", async () => {
    const approved = await openLog();
    const stranger = await openLog();
    const reader = await openLog(approved.publicKey);
    await stranger.append(message);
    const outgoing = stranger.replicate(true);
    const incoming = reader.replicate(false);
    outgoing.pipe(incoming).pipe(outgoing);
    try {
      expect(await reader.get(0)).toBeNull();
      expect(reader.publicKey).toEqual(approved.publicKey);
      expect(reader.length).toBe(0);
    } finally {
      outgoing.destroy();
      incoming.destroy();
    }
  });

  it("permits repeat reads without treating them as command replay", async () => {
    const log = await openLog();
    await log.append(message);
    expect(await log.get(0)).toEqual(message);
    expect(await log.get(0)).toEqual(message);
  });

  it("rejects entries above the session bound", async () => {
    const log = await openLog();
    await expect(log.get(2048)).rejects.toThrow();
    await expect(log.get(-1)).rejects.toThrow();
    for (let index = 0; index < 2048; index++) {
      await log.append({ ...message, id: crypto.randomUUID() });
    }
    await expect(
      log.append({ ...message, id: crypto.randomUUID() }),
    ).rejects.toThrow();
    expect(log.length).toBe(2048);
  }, 20000);
});

describe("untrusted signed log input", () => {
  async function withRawWriter(
    run: (writer: Hypercore, reader: SessionLog) => Promise<void>,
  ) {
    const directory = await mkdtemp(join(tmpdir(), "p2pme-test-"));
    const writer = new Hypercore(directory, { valueEncoding: "utf-8" });
    await writer.ready();
    const reader = await openLog(writer.key);
    const outgoing = writer.replicate(true);
    const incoming = reader.replicate(false);
    outgoing.on("error", () => {});
    outgoing.pipe(incoming).pipe(outgoing);
    try {
      await run(writer, reader);
    } finally {
      outgoing.destroy();
      incoming.destroy();
      await writer.close();
      await rm(directory, { recursive: true });
    }
  }

  it("keeps the accepted entry after a writer-signed truncation and replacement", async () => {
    await withRawWriter(async (writer, reader) => {
      await writer.append(JSON.stringify(message));
      await expect.poll(() => reader.get(0)).toEqual(message);
      await writer.truncate(0);
      await writer.append(
        JSON.stringify({ ...message, payload: { text: "replacement" } }),
      );
      expect(writer.fork).toBeGreaterThan(0);
      for (let index = 0; index < 5; index++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        expect(await reader.get(0)).toEqual(message);
      }
    });
  });

  it.each([
    { ...message, sessionId: crypto.randomUUID() },
    { ...message, type: "shell.run" },
    { ...message, payload: { text: "x".repeat(32768) } },
  ])("closes replication on invalid signed content", async (invalid) => {
    await withRawWriter(async (writer, reader) => {
      await writer.append(JSON.stringify(invalid));
      await expect
        .poll(() =>
          reader.get(0).then(
            () => false,
            () => true,
          ),
        )
        .toBe(true);
    });
  });

  it("rejects a duplicate ID at another replicated index", async () => {
    await withRawWriter(async (writer, reader) => {
      await writer.append(JSON.stringify(message));
      await expect.poll(() => reader.get(0)).toEqual(message);
      await writer.append(JSON.stringify(message));
      await expect
        .poll(() =>
          reader.get(1).then(
            () => false,
            () => true,
          ),
        )
        .toBe(true);
    });
  });

  it("rejects metadata beyond the entry cap", async () => {
    await withRawWriter(async (writer, reader) => {
      await writer.append(
        Array.from({ length: 2049 }, () => JSON.stringify(message)),
      );
      await expect
        .poll(() =>
          reader.get(0).then(
            () => false,
            () => true,
          ),
        )
        .toBe(true);
    });
  });
});
