import {
  connectionRecord,
  type ConnectionRecord,
} from "../src/rtc-identity.js";
import { z } from "zod";
import { isId } from "../src/protocol.js";

export type HostStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const key = "p2pme.hosts.v1";
const storedRecord = z.strictObject({
  hostId: z.string().refine(isId),
  grantId: z.string().refine(isId),
  roomId: z.string().refine(isId),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  label: z.string().min(1).max(100),
  expiresAt: z.iso.datetime({ precision: 0 }),
});

export function loadHosts(storage: HostStorage): ConnectionRecord[] {
  const raw = storage.getItem(key);
  if (raw === null) return [];
  if (raw.length > 32768) throw new Error("Saved host data exceeds its limit.");
  const records: unknown = JSON.parse(raw);
  if (!Array.isArray(records) || records.length > 32)
    throw new Error("Invalid saved host data.");
  return records.map((record) => storedRecord.parse(record));
}

export function saveHost(storage: HostStorage, record: ConnectionRecord) {
  const approved = connectionRecord(record);
  const records = loadHosts(storage).filter(
    (host) => host.hostId !== approved.hostId,
  );
  if (records.length >= 32)
    throw new Error("The browser already remembers 32 hosts.");
  storage.setItem(key, JSON.stringify([...records, approved]));
}

export function forgetHost(storage: HostStorage, hostId: string) {
  storage.setItem(
    key,
    JSON.stringify(loadHosts(storage).filter((host) => host.hostId !== hostId)),
  );
}

export function forgetAllHosts(storage: HostStorage) {
  storage.removeItem(key);
}
