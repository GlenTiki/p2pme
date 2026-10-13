import { isId } from "./protocol.js";

export interface RoomCredentials {
  roomId: string;
  secret: string;
}
export interface PairingInvitation extends RoomCredentials {
  version: 1;
  label: string;
  expiresAt: string;
}
export interface ConnectionRecord extends RoomCredentials {
  hostId: string;
  grantId: string;
  label: string;
  expiresAt: string;
}
export type JsonObject = Record<string, unknown>;

export function record(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as JsonObject;
}
export function exact(value: JsonObject, keys: string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Unexpected fields");
}
export function randomSecret(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export function credentials(value: JsonObject): void {
  if (
    !isId(value.roomId) ||
    typeof value.secret !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.secret)
  )
    throw new Error("Invalid room credentials");
}
function details(value: JsonObject): void {
  if (
    typeof value.label !== "string" ||
    value.label.length < 1 ||
    value.label.length > 100 ||
    value.label.normalize("NFC") !== value.label ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cn}]/u.test(value.label)
  )
    throw new Error("Invalid device label");
  if (
    typeof value.expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.expiresAt) ||
    !Number.isFinite(Date.parse(value.expiresAt))
  )
    throw new Error("Invalid expiry");
}
export function createInvitation(
  label: string,
  now = Date.now(),
): PairingInvitation {
  const invitation = {
    version: 1 as const,
    roomId: crypto.randomUUID(),
    secret: randomSecret(),
    label: label.normalize("NFC"),
    expiresAt: new Date(now + 600000).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  details(invitation);
  return invitation;
}
export function encodeInvitation(invitation: PairingInvitation): string {
  return btoa(
    String.fromCharCode(
      ...new TextEncoder().encode(JSON.stringify(invitation)),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export function decodeInvitation(
  encoded: string,
  now = Date.now(),
): PairingInvitation {
  if (encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded))
    throw new Error("Invalid invitation");
  const value = record(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(
          atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
          (c) => c.charCodeAt(0),
        ),
      ),
    ),
  );
  exact(value, ["version", "roomId", "secret", "label", "expiresAt"]);
  credentials(value);
  details(value);
  if (value.version !== 1) throw new Error("Unsupported invitation version");
  const deadline = Date.parse(value.expiresAt as string);
  if (deadline <= now || deadline > now + 600000)
    throw new Error("Invitation has expired or its deadline is invalid");
  return value as unknown as PairingInvitation;
}
export function connectionRecord(input: unknown): ConnectionRecord {
  const value = record(input);
  exact(value, ["hostId", "grantId", "roomId", "secret", "label", "expiresAt"]);
  credentials(value);
  details(value);
  if (!isId(value.hostId) || !isId(value.grantId))
    throw new Error("Invalid host or grant ID");
  if (Date.parse(value.expiresAt as string) <= Date.now())
    throw new Error("Grant has expired");
  return value as unknown as ConnectionRecord;
}
export function reservePeer() {
  let owner: string | null = null;
  return {
    claim(peerId: string) {
      if (owner !== null && owner !== peerId)
        throw new Error("This device is already connected");
      owner = peerId;
    },
    owns(peerId: string) {
      return owner === peerId;
    },
    release(peerId: string) {
      if (owner === peerId) owner = null;
    },
  };
}
export function validateWelcome(
  input: unknown,
  approved: { hostId: string; grantId: string },
): string {
  const value = record(input);
  exact(value, ["version", "role", "hostId", "grantId", "hostEpoch"]);
  if (
    value.version !== 1 ||
    value.role !== "host" ||
    value.hostId !== approved.hostId ||
    value.grantId !== approved.grantId ||
    !isId(value.hostEpoch)
  )
    throw new Error("Host identity did not match the approved connection");
  return value.hostEpoch;
}
