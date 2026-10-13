import { describe, expect, it } from "vitest";
import {
  loadHosts,
  saveHost,
  forgetHost,
  type HostStorage,
} from "../web/saved-hosts.js";

export const savedHost = {
  hostId: "651f06dd-8e07-4c3e-acd4-1ac5db41b49a",
  grantId: "af0fe33e-d3af-40ab-9b29-f6b722562f09",
  roomId: "c5bf44c5-3e6d-40f9-8476-6a668d136903",
  secret: "a".repeat(43),
  label: "My phone",
  expiresAt: "2099-01-01T00:00:00Z",
};
function storage(initial: string | null = null): HostStorage {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    removeItem: () => {
      value = null;
    },
  };
}
describe("remembered host credentials", () => {
  it("loads an empty list without a record", () => {
    expect(loadHosts(storage())).toEqual([]);
  });
  it.each(["invalid", "{}", '[{"secret":"private"}]'])(
    "rejects invalid stored data without clearing it",
    (value) => {
      const store = storage(value);
      expect(() => loadHosts(store)).toThrow();
      expect(store.getItem("p2pme.hosts.v1")).toBe(value);
    },
  );
  it("saves a validated grant, replaces the same host, and forgets only that host", () => {
    const store = storage();
    saveHost(store, savedHost);
    saveHost(store, { ...savedHost, label: "New label" });
    expect(loadHosts(store)).toHaveLength(1);
    expect(loadHosts(store)[0]?.label).toBe("New label");
    forgetHost(store, savedHost.hostId);
    expect(loadHosts(store)).toEqual([]);
  });
  it("propagates storage failures", () => {
    const store = storage();
    store.setItem = () => {
      throw new Error("Storage unavailable");
    };
    expect(() => saveHost(store, savedHost)).toThrow("Storage unavailable");
  });
  it("keeps expired grants removable without hiding valid hosts", () => {
    const expired = {
      ...savedHost,
      hostId: "04f05499-0529-48bb-afba-4b007332661b",
      expiresAt: "2020-01-01T00:00:00Z",
    };
    const store = storage(JSON.stringify([expired, savedHost]));
    expect(loadHosts(store)).toHaveLength(2);
    saveHost(store, { ...savedHost, label: "Updated" });
    forgetHost(store, expired.hostId);
    expect(loadHosts(store)).toEqual([{ ...savedHost, label: "Updated" }]);
  });
});
