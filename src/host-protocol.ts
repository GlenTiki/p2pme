import { z } from "zod";
import { isId, MAX_FRAME_BYTES } from "./protocol.js";

export const scopes = [
  "sessions:list",
  "sessions:chat",
  "sessions:create",
  "sessions:configure",
  "tasks:delegate",
  "ui:action",
] as const;
export type Scope = (typeof scopes)[number];
const id = z.string().refine(isId, "Expected a canonical UUID");
const label = z.string().min(1).max(100);
const timestamp = z.iso.datetime({ precision: 0 });
const text = z
  .string()
  .min(1)
  .refine((value) => new TextEncoder().encode(value).length <= 8192);
const values = z
  .record(
    z.string().max(100),
    z.union([z.string().max(8192), z.number().finite(), z.boolean(), z.null()]),
  )
  .refine((value) => Object.keys(value).length <= 64);
const requestBase = { version: z.literal(1), id, hostId: id, hostEpoch: id };
const sessionText = z.strictObject({ sessionId: id, text });

export const hostRequestSchema = z.discriminatedUnion("op", [
  z.strictObject({
    ...requestBase,
    op: z.literal("sessions.list"),
    args: z.strictObject({}),
  }),
  z.strictObject({
    ...requestBase,
    op: z.literal("sessions.chat"),
    args: sessionText,
  }),
  z.strictObject({
    ...requestBase,
    op: z.literal("tasks.delegate"),
    args: sessionText,
  }),
  z.strictObject({
    ...requestBase,
    op: z.literal("sessions.create"),
    args: z.strictObject({ profileId: label, label }),
  }),
  z.strictObject({
    ...requestBase,
    op: z.literal("sessions.configure"),
    args: z.strictObject({
      sessionId: id,
      patch: z
        .strictObject({ label: label.optional(), modelId: label.optional() })
        .refine((patch) => Object.keys(patch).length > 0),
    }),
  }),
  z.strictObject({
    ...requestBase,
    op: z.literal("ui.action"),
    args: z.strictObject({
      sessionId: id,
      surfaceId: id,
      revision: z.number().int().nonnegative(),
      actionId: label,
      values,
    }),
  }),
]);
export type HostRequest = z.infer<typeof hostRequestSchema>;

export const grantSchema = z.strictObject({
  id,
  deviceId: id,
  principal: z.enum(["human-device", "agent"]),
  label,
  roomId: id,
  roomSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  createdAt: timestamp,
  expiresAt: timestamp,
  revokedAt: timestamp.nullable(),
  scopes: z.array(z.enum(scopes)).max(scopes.length),
  sessionAccess: z.union([z.literal("registered"), z.array(id).max(32)]),
  profileIds: z.array(label).max(32),
});
export type Grant = z.infer<typeof grantSchema>;
export const sessionMetadataSchema = z.strictObject({
  id,
  provider: label,
  providerSessionId: z.string().min(1).max(200),
  profileId: label,
  label,
  modelId: label,
  createdAt: timestamp,
});
export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;
export type SessionInfo = SessionMetadata & { online: boolean };
export const hostStateSchema = z.strictObject({
  version: z.literal(1),
  hostId: id,
  grants: z.array(grantSchema).max(32),
  sessions: z.array(sessionMetadataSchema).max(32),
});
export type HostState = z.infer<typeof hostStateSchema>;
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type HostResponse = {
  version: 1;
  id: string;
  hostId: string;
  hostEpoch: string;
  replyTo: string;
} & (
  | { ok: true; result: Record<string, JsonValue> }
  | { ok: false; error: { code: string; message: string } }
);

export function parseHostRequest(value: unknown): HostRequest {
  const frame = typeof value === "string" ? value : JSON.stringify(value);
  if (
    frame === undefined ||
    new TextEncoder().encode(frame).length > MAX_FRAME_BYTES
  )
    throw new Error("Invalid host frame size");
  return hostRequestSchema.parse(JSON.parse(frame));
}
