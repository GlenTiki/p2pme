import { expect, it, vi } from "vitest";
import { connectHost } from "../src/host-client.js";
import { randomSecret } from "../src/rtc-identity.js";
import type { ChannelOptions } from "../src/rtc-channel.js";

function fixture() {
  const record = {
    hostId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
    roomId: crypto.randomUUID(),
    secret: randomSecret(),
    label: "Host",
    expiresAt: new Date(Date.now() + 3600000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
  };
  let options!: ChannelOptions;
  const sent: string[] = [];
  const factory = (value: ChannelOptions) => {
    options = value;
    return {
      connected: true,
      async send(frame: string) {
        sent.push(frame);
      },
      async close() {},
    };
  };
  return {
    record,
    sent,
    factory,
    ready(epoch: string) {
      options.acceptHello({
        version: 1,
        role: "host",
        hostId: record.hostId,
        grantId: record.grantId,
        hostEpoch: epoch,
      });
      options.onConnect?.();
    },
    frame(value: unknown) {
      return options.onFrame?.(JSON.stringify(value));
    },
    disconnect() {
      options.onDisconnect?.();
    },
  };
}
it("binds requests to the validated epoch and correlates responses", async () => {
  const f = fixture(),
    epoch = crypto.randomUUID();
  const connection = connectHost(f.record, { channelFactory: f.factory });
  f.ready(epoch);
  const client = await connection;
  const pending = client.request("sessions.list", {});
  const request = JSON.parse(f.sent[0]!);
  expect(request.hostEpoch).toBe(epoch);
  await f.frame({
    version: 1,
    id: crypto.randomUUID(),
    hostId: f.record.hostId,
    hostEpoch: epoch,
    replyTo: request.id,
    ok: true,
    result: { sessions: [] },
  });
  expect(await pending).toEqual({ sessions: [] });
  await client.close();
});
it("rejects uncertain requests on disconnect and ignores delayed replies", async () => {
  const f = fixture(),
    epoch = crypto.randomUUID();
  const connection = connectHost(f.record, { channelFactory: f.factory });
  f.ready(epoch);
  const client = await connection;
  const pending = client.request("sessions.list", {});
  f.disconnect();
  await expect(pending).rejects.toThrow("disconnected");
  const request = JSON.parse(f.sent[0]!);
  await f.frame({
    version: 1,
    id: crypto.randomUUID(),
    hostId: f.record.hostId,
    hostEpoch: epoch,
    replyTo: request.id,
    ok: true,
    result: { sessions: [] },
  });
  await expect(client.request("sessions.list", {})).rejects.toThrow();
  expect(f.sent).toHaveLength(1);
});

it("closes a pending channel immediately on cancellation", async () => {
  const f = fixture();
  const abort = new AbortController();
  const close = vi.fn(async () => {});
  const connection = connectHost(f.record, {
    signal: abort.signal,
    channelFactory: (options) => ({ ...f.factory(options), close }),
  });
  abort.abort();
  await expect(connection).rejects.toThrow("cancelled");
  expect(close).toHaveBeenCalledOnce();
});
it("does not start discovery when already cancelled", async () => {
  const f = fixture();
  const factory = vi.fn(f.factory);
  const abort = new AbortController();
  abort.abort();
  await expect(
    connectHost(f.record, { signal: abort.signal, channelFactory: factory }),
  ).rejects.toThrow("cancelled");
  expect(factory).not.toHaveBeenCalled();
});
it("handles a synchronous factory error and closes the returned channel", async () => {
  const f = fixture();
  const close = vi.fn(async () => {});
  const connection = connectHost(f.record, {
    channelFactory: (options) => {
      options.onError?.(new Error("Cannot join"));
      return { ...f.factory(options), close };
    },
  });
  await expect(connection).rejects.toThrow("Cannot join");
  expect(close).toHaveBeenCalledOnce();
});
it("handles a synchronous welcome from a channel factory", async () => {
  const f = fixture();
  const epoch = crypto.randomUUID();
  const connection = connectHost(f.record, {
    channelFactory: (options) => {
      const channel = f.factory(options);
      f.ready(epoch);
      return channel;
    },
  });
  const client = await connection;
  expect(client.hostEpoch).toBe(epoch);
  await client.close();
});

it("times out a session list after 30 seconds while preserving the host connection", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const connection = connectHost(f.record, { channelFactory: f.factory });
  f.ready(crypto.randomUUID());
  const client = await connection;
  try {
    const settled: string[] = [];
    const pending = client
      .request("sessions.list", {})
      .catch((error: Error) => settled.push(error.message));
    await vi.advanceTimersByTimeAsync(29999);
    expect(settled).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual([
      "Request timed out. It may have run; it was not retried.",
    ]);
    await pending;
    const retry = client.request("sessions.list", {}).catch(() => {});
    expect(f.sent).toHaveLength(2);
    await client.close();
    await retry;
  } finally {
    await client.close();
    vi.useRealTimers();
  }
});
