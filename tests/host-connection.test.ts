import { expect, it, vi } from "vitest";
import { serveHostConnection } from "../src/host-connection.js";
import { randomSecret } from "../src/rtc-identity.js";
import type { ChannelOptions } from "../src/rtc-channel.js";
import type { HostResponse } from "../src/host-protocol.js";
function fixture() {
  const grant = {
    hostId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
    roomId: crypto.randomUUID(),
    secret: randomSecret(),
    label: "Host",
    expiresAt: new Date(Date.now() + 60000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
  };
  let options!: ChannelOptions;
  let closes = 0;
  const sent: string[] = [];
  return {
    grant,
    sent,
    get closes() {
      return closes;
    },
    get options() {
      return options;
    },
    factory: (value: ChannelOptions) => {
      options = value;
      return {
        connected: true,
        async send(frame: string) {
          sent.push(frame);
        },
        async close() {
          closes++;
        },
      };
    },
  };
}
it("suppresses a result when a grant is revoked during dispatch", async () => {
  const f = fixture();
  let active = true;
  let finish!: (value: HostResponse) => void;
  const pending = new Promise<HostResponse>((resolve) => {
    finish = resolve;
  });
  const channel = serveHostConnection(f.grant, {
    hostEpoch: crypto.randomUUID(),
    active: () => active,
    dispatch: () => pending,
    channelFactory: f.factory,
  });
  const frame = f.options.onFrame?.("{}");
  active = false;
  finish({
    version: 1,
    id: crypto.randomUUID(),
    hostId: f.grant.hostId,
    hostEpoch: crypto.randomUUID(),
    replyTo: crypto.randomUUID(),
    ok: true,
    result: {},
  });
  await frame;
  expect(f.sent).toEqual([]);
  expect(f.closes).toBeGreaterThan(0);
  await channel.close();
});
it("closes an idle connection when its grant expires", async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    const channel = serveHostConnection(f.grant, {
      hostEpoch: crypto.randomUUID(),
      active: () => true,
      dispatch: async () => {
        throw Error("unused");
      },
      channelFactory: f.factory,
    });
    await vi.advanceTimersByTimeAsync(60001);
    expect(f.closes).toBe(1);
    await channel.close();
  } finally {
    vi.useRealTimers();
  }
});
