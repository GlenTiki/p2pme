import { exact, record, type RoomCredentials } from "./rtc-identity.js";

export interface CodeParts {
  locator: string;
  password: string;
}
export interface CodeContext {
  locator: string;
  attemptId: string;
  expiresAt: string;
}
export function parseCode(input: string): CodeParts {
  const code = input
    .replace(/^[\t\n\r\f\v ]+|[\t\n\r\f\v ]+$/g, "")
    .replace(/[a-z]/g, (letter) => letter.toUpperCase());
  if (
    !/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{6}-?[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/.test(
      code,
    )
  )
    throw new Error("Invalid pairing code");
  const canonical = code.replace("-", "");
  return { locator: canonical.slice(0, 6), password: canonical.slice(6) };
}
export function generateCode(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const characters = Array.from(
    crypto.getRandomValues(new Uint8Array(14)),
    (value) => alphabet[value & 31],
  ).join("");
  return `${characters.slice(0, 6)}-${characters.slice(6)}`;
}
export function encodeParts(parts: string[]): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(parts));
}
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
async function room(parts: string[]): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encodeParts(parts)),
  ).slice(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function bootstrapCredentials(
  locator: string,
): Promise<RoomCredentials> {
  return {
    roomId: await room(["p2pme/code-bootstrap/2", locator]),
    secret: base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode("p2pme/code-bootstrap/2"),
        ),
      ),
    ),
  };
}
export function identifiers(context: CodeContext): {
  client: string;
  server: string;
} {
  const fields = [context.locator, context.attemptId, context.expiresAt];
  return {
    client: JSON.stringify(["p2pme/code-client/2", ...fields]),
    server: JSON.stringify(["p2pme/code-host/2", ...fields]),
  };
}
export async function grantCredentials(
  context: CodeContext,
  sessionKey: string,
): Promise<RoomCredentials> {
  const raw = Uint8Array.from(
    atob(sessionKey.replaceAll("-", "+").replaceAll("_", "/")),
    (value) => value.charCodeAt(0),
  );
  if (raw.length !== 64) throw new Error("Invalid session key");
  const key = await crypto.subtle.importKey("raw", raw, "HKDF", false, [
    "deriveBits",
  ]);
  const derived = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(context.attemptId),
      info: encodeParts([
        "p2pme/host-grant/2",
        context.locator,
        context.attemptId,
        context.expiresAt,
      ]),
    },
    key,
    256,
  );
  return {
    roomId: await room([
      "p2pme/host-grant/2",
      context.locator,
      context.attemptId,
    ]),
    secret: base64url(new Uint8Array(derived)),
  };
}
export function privateHello(
  role: "offer-host" | "offer-client",
  roomId: string,
) {
  return { version: 2, role, roomId };
}
export function checkPrivateHello(
  value: unknown,
  role: string,
  roomId: string,
): void {
  const input = record(value);
  exact(input, ["version", "role", "roomId"]);
  if (input.version !== 2 || input.role !== role || input.roomId !== roomId)
    throw new Error("Unexpected pairing peer");
}
export function checkCodeClient(
  value: unknown,
  roomId: string,
  locator: string,
): void {
  const input = record(value);
  exact(input, ["version", "role", "roomId", "locator"]);
  if (
    input.version !== 2 ||
    input.role !== "code-client" ||
    input.roomId !== roomId ||
    input.locator !== locator
  )
    throw new Error("Unexpected code peer");
}
export function checkCodeHost(
  value: unknown,
  roomId: string,
  locator: string,
): CodeContext {
  const input = record(value);
  exact(input, [
    "version",
    "role",
    "roomId",
    "locator",
    "attemptId",
    "expiresAt",
  ]);
  if (
    input.version !== 2 ||
    input.role !== "code-host" ||
    input.roomId !== roomId ||
    input.locator !== locator
  )
    throw new Error("Unexpected code peer");
  if (
    typeof input.attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.attemptId,
    )
  )
    throw new Error("Invalid attempt");
  checkTimestamp(input.expiresAt);
  return { locator, attemptId: input.attemptId, expiresAt: input.expiresAt };
}
export function checkTimestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("Invalid expiry");
  if (new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z") !== value)
    throw new Error("Invalid expiry");
}
export function readFrame(frame: string): Record<string, unknown> {
  return record(JSON.parse(frame));
}
export function readKe(frame: string, expected: string): string {
  if (new TextEncoder().encode(frame).length > 2048)
    throw new Error("Invalid code frame");
  const input = readFrame(frame);
  exact(input, ["type", "value"]);
  if (
    input.type !== expected ||
    typeof input.value !== "string" ||
    !/^[\x20-\x7e]{1,1536}$/.test(input.value)
  )
    throw new Error("Unexpected code phase");
  return input.value;
}

export function normalizePairingCode(input: string): string {
  const { locator, password } = parseCode(input);
  return `${locator}-${password}`;
}
