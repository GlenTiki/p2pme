export const MAX_FRAME_BYTES = 32 * 1024;
export const MAX_CHAT_BYTES = 8 * 1024;
export const MAX_SESSION_ENTRIES = 2048;

export interface Payloads {
  "chat.send": { text: string };
  "chat.delta": { text: string };
  "chat.completed": { text: string };
  "session.status": { state: "ready" | "busy" | "disconnected" };
  "session.disconnect": { reason: string };
  error: { code: string; message: string };
  "host.request": {
    requestId: string;
    op: string;
    args: Record<string, unknown>;
  };
  "host.result": {
    requestId: string;
    ok: boolean;
    result: Record<string, unknown>;
  };
}

export type MessageType = keyof Payloads;
export type Envelope = {
  [Type in MessageType]: {
    version: 1;
    id: string;
    sessionId: string;
    type: Type;
    sentAt: string;
    replyTo?: string;
    payload: Payloads[Type];
  };
}[MessageType];

export function isId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

const payloadChecks: Record<
  MessageType,
  (payload: Record<string, unknown>) => boolean
> = {
  "chat.send": (p) =>
    string(p.text) &&
    p.text.length > 0 &&
    new TextEncoder().encode(p.text).length <= MAX_CHAT_BYTES,
  "chat.delta": (p) => string(p.text),
  "chat.completed": (p) => string(p.text),
  "session.status": (p) =>
    string(p.state) && ["ready", "busy", "disconnected"].includes(p.state),
  "session.disconnect": (p) => string(p.reason),
  error: (p) => string(p.code) && string(p.message),
  "host.request": (p) =>
    isId(p.requestId) && string(p.op) && jsonObject(p.args),
  "host.result": (p) =>
    isId(p.requestId) && typeof p.ok === "boolean" && jsonObject(p.result),
};

function jsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateHeader(
  value: Record<string, unknown>,
  sessionId: string,
): void {
  if (value.version !== 1) throw new Error("Unsupported protocol version");
  if (!isId(value.id) || !isId(value.sessionId))
    throw new Error("Invalid message or session ID");
  if (value.sessionId !== sessionId)
    throw new Error("Message belongs to a different session");
  if (value.replyTo !== undefined && !isId(value.replyTo))
    throw new Error("Invalid reply ID");
  if (!string(value.type) || !Object.hasOwn(payloadChecks, value.type))
    throw new Error("Unknown message type");
}

function validateTimestamp(value: unknown): void {
  if (!string(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new Error("Timestamp must be UTC with seconds and Z");
  }
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().replace(".000Z", "Z") !== value
  ) {
    throw new Error("Invalid timestamp");
  }
}

export function decodeEnvelope(frame: string, sessionId: string): Envelope {
  if (new TextEncoder().encode(frame).length > MAX_FRAME_BYTES)
    throw new Error("Frame exceeds 32 KiB");
  const value = object(JSON.parse(frame));
  validateHeader(value, sessionId);
  validateTimestamp(value.sentAt);
  const payload = object(value.payload);
  if (!payloadChecks[value.type as MessageType](payload))
    throw new Error("Invalid message payload");
  Object.freeze(payload);
  return Object.freeze(value) as unknown as Envelope;
}

export function createEnvelope<Type extends MessageType>(
  sessionId: string,
  type: Type,
  payload: Payloads[Type],
  replyTo?: string,
): Envelope {
  return decodeEnvelope(
    JSON.stringify({
      version: 1,
      id: crypto.randomUUID(),
      sessionId,
      type,
      sentAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      payload,
      ...(replyTo === undefined ? {} : { replyTo }),
    }),
    sessionId,
  );
}

export function createReceiver(sessionId: string) {
  const seen = new Set<string>();
  return {
    receive(frame: string): Envelope {
      const envelope = decodeEnvelope(frame, sessionId);
      if (seen.has(envelope.id)) throw new Error("Duplicate message ID");
      if (seen.size >= MAX_SESSION_ENTRIES)
        throw new Error("Session entry limit reached");
      seen.add(envelope.id);
      return envelope;
    },
  };
}
