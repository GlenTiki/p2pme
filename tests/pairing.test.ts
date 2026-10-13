import { expect, it } from "vitest";
import { approvePairing } from "../src/pairing.js";
import {
  createInvitation,
  randomSecret,
  type ConnectionRecord,
} from "../src/rtc-identity.js";
import type { ChannelOptions, RtcChannel } from "../src/rtc-channel.js";

function setup() {
  let options: ChannelOptions;
  const sent: string[] = [];
  const channel: RtcChannel = {
    connected: true,
    async send(frame) {
      sent.push(frame);
    },
    async close() {},
  };
  const invitation = createInvitation("Test phone");
  const grant: ConnectionRecord = {
    hostId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
    roomId: crypto.randomUUID(),
    secret: randomSecret(),
    label: "Test host",
    expiresAt: new Date(Date.now() + 3600000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
  };
  const operations: string[] = [];
  return {
    invitation,
    grant,
    sent,
    operations,
    factory: (value: ChannelOptions) => {
      options = value;
      return channel;
    },
    connect: () => options.onConnect?.(),
    frame: (value: unknown) => options.onFrame?.(JSON.stringify(value)),
    disconnect: () => options.onDisconnect?.(),
  };
}
it("persists only after acknowledgement and before activation", async () => {
  const f = setup();
  const pending = approvePairing(f.invitation, f.grant, {
    channelFactory: f.factory,
    persist: async () => {
      f.operations.push("persist");
    },
    activate: async () => {
      f.operations.push("activate");
    },
  });
  f.connect();
  await Promise.resolve();
  expect(f.operations).toEqual([]);
  await f.frame({
    type: "ack",
    roomId: f.invitation.roomId,
    grantId: f.grant.grantId,
  });
  await pending;
  expect(f.operations).toEqual(["persist", "activate"]);
});
it("leaves no persisted grant when acknowledgement is lost", async () => {
  const f = setup();
  const pending = approvePairing(f.invitation, f.grant, {
    channelFactory: f.factory,
    persist: async () => {
      f.operations.push("persist");
    },
    activate: async () => {
      f.operations.push("activate");
    },
  });
  f.connect();
  f.disconnect();
  await expect(pending).rejects.toThrow();
  expect(f.operations).toEqual([]);
});
it("does not activate a grant after a durable write failure", async () => {
  const f = setup();
  const pending = approvePairing(f.invitation, f.grant, {
    channelFactory: f.factory,
    persist: async () => {
      throw Error("disk failure");
    },
    activate: async () => {
      f.operations.push("activate");
    },
  });
  f.connect();
  await f.frame({
    type: "ack",
    roomId: f.invitation.roomId,
    grantId: f.grant.grantId,
  });
  await expect(pending).rejects.toThrow("disk failure");
  expect(f.operations).toEqual([]);
});
it("cancels pairing before acknowledgement without a durable grant", async () => {
  const f = setup();
  const abort = new AbortController();
  const pending = approvePairing(f.invitation, f.grant, {
    signal: abort.signal,
    channelFactory: f.factory,
    persist: async () => {
      f.operations.push("persist");
    },
    activate: async () => {
      f.operations.push("activate");
    },
  });
  f.connect();
  abort.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(f.operations).toEqual([]);
});
it("checks cancellation at acknowledgement before it commits the grant", async () => {
  const f = setup();
  const abort = new AbortController();
  const pending = approvePairing(f.invitation, f.grant, {
    signal: abort.signal,
    channelFactory: f.factory,
    persist: async () => {
      f.operations.push("persist");
    },
    activate: async () => {
      f.operations.push("activate");
    },
  });
  void f.frame({
    type: "ack",
    roomId: f.invitation.roomId,
    grantId: f.grant.grantId,
  });
  abort.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(f.operations).toEqual([]);
});
