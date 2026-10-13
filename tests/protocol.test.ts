import { describe, expect, it } from "vitest";
import { createReceiver, decodeEnvelope } from "../src/protocol.js";

const sessionId = "b6e16b67-466c-4852-a94c-8dc00c2e8c42";
const command = {
  version: 1,
  id: "b1c63e59-9fd0-42a6-8a49-247a2ef2b947",
  sessionId,
  type: "chat.send",
  sentAt: "2026-10-13T17:00:00Z",
  payload: { text: "Hello from my phone" },
};

describe("protocol boundary", () => {
  it("accepts a valid command without changing its content", () => {
    expect(decodeEnvelope(JSON.stringify(command), sessionId)).toEqual(command);
  });

  it.each([
    { version: 2 },
    { version: "1" },
    { type: "shell.run" },
    { id: "" },
    { id: "not-an-id" },
    { sessionId: "" },
    { sentAt: "2026-10-13" },
    { sentAt: "2026-10-13T17:00Z" },
    { sentAt: "2026-10-13T17:00:00+00:00" },
    { sentAt: "2026-02-30T17:00:00Z" },
    { payload: { text: 3 } },
    { payload: { text: "" } },
    { replyTo: "not-an-id" },
  ])("rejects malformed envelope fields: %j", (replacement) => {
    expect(() =>
      decodeEnvelope(JSON.stringify({ ...command, ...replacement }), sessionId),
    ).toThrow();
  });

  it.each(["{", "null", "[]", '"hello"'])(
    "rejects invalid JSON envelopes: %s",
    (frame) => {
      expect(() => decodeEnvelope(frame, sessionId)).toThrow();
    },
  );

  it("rejects a frame from another session", () => {
    expect(() =>
      decodeEnvelope(JSON.stringify(command), crypto.randomUUID()),
    ).toThrow();
  });

  it("enforces the chat input limit in UTF-8 bytes", () => {
    const encode = (text: string) =>
      JSON.stringify({ ...command, payload: { text } });
    expect(() =>
      decodeEnvelope(encode("é".repeat(4096)), sessionId),
    ).not.toThrow();
    expect(() => decodeEnvelope(encode("é".repeat(4097)), sessionId)).toThrow();
  });

  it("rejects frames over 32 KiB before parsing", () => {
    const frame = JSON.stringify({ ...command, padding: "x".repeat(32768) });
    expect(() => decodeEnvelope(frame, sessionId)).toThrow();
  });

  it.each([
    ["chat.delta", { text: "Hello" }],
    ["chat.completed", { text: "Hello" }],
    ["session.status", { state: "ready" }],
    ["session.disconnect", { reason: "revoked" }],
    ["error", { code: "busy", message: "Queue full" }],
  ])("accepts typed %s payloads", (type, payload) => {
    const envelope = { ...command, type, payload, replyTo: command.id };
    expect(decodeEnvelope(JSON.stringify(envelope), sessionId)).toEqual(
      envelope,
    );
  });

  it.each([
    "chat.delta",
    "chat.completed",
    "session.status",
    "session.disconnect",
    "error",
  ])("rejects a malformed %s payload", (type) => {
    const envelope = { ...command, type, payload: { unknown: true } };
    expect(() => decodeEnvelope(JSON.stringify(envelope), sessionId)).toThrow();
  });

  it("rejects duplicate command IDs for the live session", () => {
    const receiver = createReceiver(sessionId);
    const frame = JSON.stringify(command);
    expect(receiver.receive(frame)).toEqual(command);
    expect(() => receiver.receive(frame)).toThrow();
  });

  it("does not consume an ID when its frame fails validation", () => {
    const receiver = createReceiver(sessionId);
    expect(() =>
      receiver.receive(JSON.stringify({ ...command, version: 9 })),
    ).toThrow();
    expect(receiver.receive(JSON.stringify(command))).toEqual(command);
  });

  it("rejects a status array instead of coercing it to a state", () => {
    const envelope = {
      ...command,
      type: "session.status",
      payload: { state: ["ready"] },
    };
    expect(() => decodeEnvelope(JSON.stringify(envelope), sessionId)).toThrow();
  });
});
