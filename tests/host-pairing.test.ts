import { afterEach, expect, it, vi } from "vitest";
import { offerHostPairing, joinHostPairing } from "../src/host-pairing.js";
import {
  decodeHostInvitation,
  createHostInvitationUrl,
  validateLabel,
  createInvitation,
  encodeInvitation,
  randomSecret,
  type ConnectionRecord,
} from "../src/rtc-identity.js";
import * as opaque from "@serenity-kit/opaque";
import {
  identifiers,
  checkCodeHost,
  grantCredentials,
} from "../src/host-pairing-protocol.js";
import { parseCode } from "../src/host-pairing-protocol.js";
import type { ChannelOptions, RtcChannel } from "../src/rtc-channel.js";
import type { HostGrantPreparation } from "../src/host-pairing-types.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.useRealTimers();
});
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}
function setup(prepare?: (record: ConnectionRecord) => HostGrantPreparation) {
  const channels: {
    options: ChannelOptions;
    sent: unknown[];
    closed: boolean;
    channel: RtcChannel;
  }[] = [];
  const operations: string[] = [];
  const authorize = vi.fn(async (label: string) => {
    const record: ConnectionRecord = {
      hostId: crypto.randomUUID(),
      grantId: crypto.randomUUID(),
      roomId: crypto.randomUUID(),
      secret: randomSecret(),
      label,
      expiresAt: new Date(Date.now() + 86400000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
    };
    return (
      prepare?.(record) ?? {
        record,
        persist: async (beginCommit: () => void) => {
          beginCommit();
          operations.push("persist");
        },
        activate: async () => {
          operations.push("activate");
        },
      }
    );
  });
  const factory = (options: ChannelOptions): RtcChannel => {
    const item = {
      options,
      sent: [] as unknown[],
      closed: false,
      channel: null as unknown as RtcChannel,
    };
    item.channel = {
      connected: true,
      send: async (frame) => {
        item.sent.push(JSON.parse(frame));
      },
      close: async () => {
        item.closed = true;
      },
    };
    channels.push(item);
    return item.channel;
  };
  return {
    channels,
    operations,
    authorize,
    factory,
    async offer() {
      const offer = await offerHostPairing({
        label: "My host",
        authorize,
        channelFactory: factory,
      });
      cleanups.push(() => offer.close());
      return offer;
    },
    qr() {
      const path = channels.find((c) => c.options.hello.role === "offer-host");
      if (!path) throw Error("No QR room");
      return path;
    },
    code() {
      const path = channels.find((c) => c.options.hello.role === "code-host");
      if (!path) throw Error("No code room");
      return path;
    },
  };
}
async function claim(f: ReturnType<typeof setup>) {
  const qr = f.qr();
  qr.options.onConnect?.();
  await qr.options.onFrame?.(JSON.stringify({ type: "claim", label: "Phone" }));
  return qr;
}
async function acknowledge(qr: ReturnType<ReturnType<typeof setup>["qr"]>) {
  const frame = qr.sent[0] as { value: ConnectionRecord };
  await qr.options.onFrame?.(
    JSON.stringify({
      type: "ack",
      roomId: qr.options.credentials.roomId,
      grantId: frame.value.grantId,
    }),
  );
}
it("decodes host invitations independent of browser clock and validates host URLs", () => {
  const invitation = createInvitation("Host");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2090-01-01"));
  expect(decodeHostInvitation(encodeInvitation(invitation))).toEqual(
    invitation,
  );
  expect(createHostInvitationUrl(invitation)).toContain(
    "https://p2pme.glentiki.dev/live/#pair=",
  );
  for (const base of [
    "http://evil.example",
    "https://user:password@example.com",
    "https://example.com/?x=1",
    "https://example.com/#x",
  ])
    expect(() => createHostInvitationUrl(invitation, base)).toThrow();
  expect(
    createHostInvitationUrl(invitation, "http://127.0.0.1:3000/"),
  ).toContain("#pair=");
  expect(() => validateLabel("\u001b[2J")).toThrow();
});
it("normalizes only the accepted code alphabet and separators", () => {
  expect(parseCode(" \tabcdef-ghjkmnpq\r\n")).toEqual({
    locator: "ABCDEF",
    password: "GHJKMNPQ",
  });
  for (const code of [
    "ABCDEF G HJKMNPQ",
    "ABCDEF-IOULMNPQ",
    "ABCDEF--GHJKMNPQ",
    "ABCDEF-GHJKMNPQx",
    "\u00a0ABCDEF-GHJKMNPQ",
  ])
    expect(() => parseCode(code)).toThrow();
});
it("commits a QR grant only after exact acknowledgement", async () => {
  const f = setup();
  const offer = await f.offer();
  const qr = await claim(f);
  expect(f.authorize).toHaveBeenCalledTimes(1);
  expect(f.operations).toEqual([]);
  expect(offer.state).toBe("claimed");
  expect(f.code().closed).toBe(true);
  await acknowledge(qr);
  await expect(offer.completion).resolves.toMatchObject({ label: "Phone" });
  expect(f.operations).toEqual(["persist", "activate"]);
  expect(offer.state).toBe("complete");
});
it("keeps QR usable after an invalid code phase", async () => {
  const f = setup();
  const offer = await f.offer();
  const code = f.code();
  code.options.onConnect?.();
  await code.options.onFrame?.('{"type":"ke3","value":"forged"}');
  expect(code.closed).toBe(true);
  expect(offer.state).toBe("pending");
  const qr = await claim(f);
  await acknowledge(qr);
  await expect(offer.completion).resolves.toMatchObject({ label: "Phone" });
});
it("rejects both failed paths without an unobserved completion", async () => {
  const f = setup();
  const offer = await f.offer();
  f.code().options.onDisconnect?.();
  f.qr().options.onDisconnect?.();
  await expect(offer.completion).rejects.toThrow();
  expect(offer.state).toBe("closed");
});
it("ignores refused extra peers while a legitimate QR claim is pending", async () => {
  const f = setup();
  const offer = await f.offer();
  f.qr().options.onPeerError?.(new Error("contender"), "stranger");
  const qr = await claim(f);
  await acknowledge(qr);
  await expect(offer.completion).resolves.toBeDefined();
});
it("cancellation during authorization prevents sending or persisting a grant", async () => {
  const wait = pending<void>();
  const f = setup();
  const original = f.authorize.getMockImplementation()!;
  f.authorize.mockImplementation(async (label) => {
    await wait.promise;
    return original(label);
  });
  const offer = await f.offer();
  const delivery = claim(f);
  expect(offer.state).toBe("claimed");
  expect(await offer.cancel()).toBe("cancelled");
  wait.resolve();
  await delivery;
  await expect(offer.completion).rejects.toThrow();
  expect(f.qr().sent).toEqual([]);
  expect(f.operations).toEqual([]);
});
it("cancellation in a queued persistence mutation blocks beginCommit", async () => {
  const gate = pending<void>();
  let began = false;
  const f = setup((record) => ({
    record,
    persist: async (begin) => {
      await gate.promise;
      begin();
      began = true;
    },
    activate: async () => {
      throw Error("must not activate");
    },
  }));
  const offer = await f.offer();
  const qr = await claim(f);
  const ack = acknowledge(qr);
  expect(await offer.cancel()).toBe("cancelled");
  gate.resolve();
  await ack;
  expect(began).toBe(false);
  await expect(offer.completion).rejects.toThrow();
});
it("returns too-late after commit begins and close waits for persistence", async () => {
  const gate = pending<void>();
  let activated = false;
  const f = setup((record) => ({
    record,
    persist: async (begin) => {
      begin();
      await gate.promise;
    },
    activate: async () => {
      activated = true;
    },
  }));
  const offer = await f.offer();
  const qr = await claim(f);
  const ack = acknowledge(qr);
  await vi.waitFor(() => expect(offer.state).toBe("committing"));
  let closed = false;
  const closing = offer.close().then(() => (closed = true));
  expect(await offer.cancel()).toBe("too-late");
  expect(closed).toBe(false);
  gate.resolve();
  await ack;
  await closing;
  await offer.completion;
  expect(activated).toBe(true);
});
it("keeps the commit latch after an uncertain write failure", async () => {
  const f = setup((record) => ({
    record,
    persist: async (begin) => {
      begin();
      throw Error("write uncertain");
    },
    activate: async () => {
      throw Error("must not activate");
    },
  }));
  const offer = await f.offer();
  await acknowledge(await claim(f));
  await expect(offer.completion).rejects.toThrow("uncertain");
  expect(await offer.cancel()).toBe("too-late");
});
it("requires persist to call the commit hook once", async () => {
  const f = setup((record) => ({
    record,
    persist: async () => {},
    activate: async () => {
      throw Error("must not activate");
    },
  }));
  const offer = await f.offer();
  await acknowledge(await claim(f));
  await expect(offer.completion).rejects.toThrow();
  expect(await offer.cancel()).toBe("cancelled");
});
it("validates joining inputs before it creates a channel", () => {
  const factory = vi.fn();
  expect(() =>
    joinHostPairing("bad", "Phone", { channelFactory: factory }),
  ).toThrow();
  expect(() =>
    joinHostPairing(createInvitation("Host"), "\u0000", {
      channelFactory: factory,
    }),
  ).toThrow();
  expect(factory).not.toHaveBeenCalled();
});
it.each(["claim", "ack"])(
  "rejects a malformed %s and never persists",
  async (phase) => {
    const f = setup();
    const offer = await f.offer();
    if (phase === "ack") await claim(f);
    await f
      .qr()
      .options.onFrame?.(
        JSON.stringify({ type: phase, label: "Phone", extra: true }),
      );
    if (phase === "claim") f.code().options.onDisconnect?.();
    await expect(offer.completion).rejects.toThrow();
    expect(f.operations).toEqual([]);
  },
);
it("rejects a duplicate claim without a second authorization", async () => {
  const f = setup();
  const offer = await f.offer();
  await claim(f);
  await f.qr().options.onFrame?.('{"type":"claim","label":"Other"}');
  await expect(offer.completion).rejects.toThrow();
  expect(f.authorize).toHaveBeenCalledTimes(1);
  expect(f.operations).toEqual([]);
});
it("bounds an idle code peer without closing QR", async () => {
  const f = setup();
  const offer = await f.offer();
  vi.useFakeTimers();
  f.code().options.onConnect?.();
  await vi.advanceTimersByTimeAsync(30001);
  expect(f.code().closed).toBe(true);
  expect(f.qr().closed).toBe(false);
  expect(offer.state).toBe("pending");
  vi.useRealTimers();
});
it("bounds an idle QR peer without closing code", async () => {
  const f = setup();
  const offer = await f.offer();
  vi.useFakeTimers();
  f.qr().options.onConnect?.();
  await vi.advanceTimersByTimeAsync(30001);
  expect(f.qr().closed).toBe(true);
  expect(f.code().closed).toBe(false);
  expect(offer.state).toBe("pending");
  vi.useRealTimers();
});
it("rejects expiry when a queued mutation tries to begin commit", async () => {
  const gate = pending<void>();
  let wrote = false;
  const f = setup((record) => ({
    record,
    persist: async (begin) => {
      await gate.promise;
      begin();
      wrote = true;
    },
    activate: async () => {},
  }));
  const offer = await f.offer();
  const ack = acknowledge(await claim(f));
  await Promise.resolve();
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(offer.invitation.expiresAt) + 1);
  gate.resolve();
  await ack;
  await expect(offer.completion).rejects.toThrow("expired");
  expect(wrote).toBe(false);
  vi.useRealTimers();
});
it("does not undo a commit after the offer deadline", async () => {
  const gate = pending<void>();
  const f = setup((record) => ({
    record,
    persist: async (begin) => {
      begin();
      await gate.promise;
    },
    activate: async () => {},
  }));
  const offer = await f.offer();
  const ack = acknowledge(await claim(f));
  await vi.waitFor(() => expect(offer.state).toBe("committing"));
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(offer.invitation.expiresAt) + 1);
  gate.resolve();
  await ack;
  await expect(offer.completion).resolves.toBeDefined();
  vi.useRealTimers();
});
it("rejects a second commit hook even when the callback catches its exception", async () => {
  let activated = false;
  const f = setup((record) => ({
    record,
    persist: async (begin) => {
      begin();
      expect(begin).toThrow("already called");
    },
    activate: async () => {
      activated = true;
    },
  }));
  const offer = await f.offer();
  await acknowledge(await claim(f));
  await expect(offer.completion).rejects.toThrow("exactly once");
  expect(activated).toBe(false);
  expect(await offer.cancel()).toBe("too-late");
});
it("leaves schema rejection before the commit hook cancellable", async () => {
  const f = setup((record) => ({
    record,
    persist: async () => {
      throw Error("schema");
    },
    activate: async () => {},
  }));
  const offer = await f.offer();
  await acknowledge(await claim(f));
  await expect(offer.completion).rejects.toThrow("schema");
  expect(await offer.cancel()).toBe("cancelled");
});
it("observes a rejected completion even when the caller ignores it", async () => {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    const f = setup();
    const offer = await f.offer();
    await offer.cancel();
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});
it("does not accept Unicode characters through case folding", () => {
  for (const code of ["ABCDEſ-GHJKMNPQ", "ＡBCDEF-GHJKMNPQ"])
    expect(() => parseCode(code)).toThrow();
});
async function codeExchange(
  f: ReturnType<typeof setup>,
  offer: Awaited<ReturnType<typeof f.offer>>,
) {
  const path = f.code();
  path.options.onConnect?.();
  const { locator, password } = parseCode(offer.code);
  const context = checkCodeHost(
    path.options.hello,
    path.options.credentials.roomId,
    locator,
  );
  const login = opaque.client.startLogin({ password });
  await path.options.onFrame?.(
    JSON.stringify({ type: "ke1", value: login.startLoginRequest }),
  );
  const response = path.sent[0] as { value: string };
  const finished = opaque.client.finishLogin({
    ...login,
    loginResponse: response.value,
    password,
    identifiers: identifiers(context),
  });
  if (!finished) throw Error("Login failed");
  return { path, finished, context };
}
it("allows exactly one winner when code and QR claims race", async () => {
  const f = setup();
  const offer = await f.offer();
  const exchange = await codeExchange(f, offer);
  await exchange.path.options.onFrame?.(
    JSON.stringify({
      type: "ke3",
      value: exchange.finished.finishLoginRequest,
    }),
  );
  const credential = await grantCredentials(
    exchange.context,
    exchange.finished.sessionKey,
  );
  const privateCode = f.channels.find(
    (c) => c.options.credentials.roomId === credential.roomId,
  )!;
  expect(privateCode.options.credentials.secret).toBe(credential.secret);
  const qr = f.qr();
  await Promise.all([
    qr.options.onFrame?.('{"type":"claim","label":"Phone"}'),
    privateCode.options.onFrame?.('{"type":"claim","label":"Other"}'),
  ]);
  expect(f.authorize).toHaveBeenCalledTimes(1);
  expect(f.authorize).toHaveBeenCalledWith("Phone", expect.any(AbortSignal), {
    attemptId: offer.invitation.roomId,
    expiresAt: offer.invitation.expiresAt,
  });
  await acknowledge(qr);
  await offer.completion;
  expect(f.operations).toEqual(["persist", "activate"]);
  expect(
    exchange.path.sent.map((value) => (value as { type: string }).type),
  ).toEqual(["ke2"]);
});
it("does not process a repeated KE3 or start another private room", async () => {
  const f = setup();
  const offer = await f.offer();
  const { path, finished } = await codeExchange(f, offer);
  const frame = JSON.stringify({
    type: "ke3",
    value: finished.finishLoginRequest,
  });
  await path.options.onFrame?.(frame);
  const count = f.channels.length;
  await path.options.onFrame?.(frame);
  expect(f.channels.length).toBe(count);
  expect(f.authorize).not.toHaveBeenCalled();
});
it("rejects a duplicate KE1 and leaves QR available", async () => {
  const f = setup();
  const offer = await f.offer();
  const { path } = await codeExchange(f, offer);
  await path.options.onFrame?.('{"type":"ke1","value":"duplicate"}');
  expect(path.closed).toBe(true);
  expect(f.qr().closed).toBe(false);
  expect(offer.state).toBe("pending");
});
it.each(["forged", "oversized", "unknown-field"])(
  "rejects %s KE3 and leaves QR available",
  async (mode) => {
    const f = setup();
    const offer = await f.offer();
    const { path, finished } = await codeExchange(f, offer);
    const frame: Record<string, string> = {
      type: "ke3",
      value:
        mode === "oversized" ? "x".repeat(1600) : finished.finishLoginRequest,
    };
    if (mode === "forged") frame.value = "A".repeat(86);
    if (mode === "unknown-field") frame.extra = "x";
    await path.options.onFrame?.(JSON.stringify(frame));
    expect(path.closed).toBe(true);
    expect(f.qr().closed).toBe(false);
    expect(offer.state).toBe("pending");
  },
);
it("normalizes a device label and rejects a grant for a different label", async () => {
  const f = setup();
  const invitation = createInvitation("Host");
  const join = joinHostPairing(invitation, "Cafe\u0301", {
    channelFactory: f.factory,
  });
  cleanups.push(() => join.close());
  const channel = f.channels[0]!;
  channel.options.onConnect?.();
  await Promise.resolve();
  expect(channel.sent[0]).toEqual({ type: "claim", label: "Café" });
  const prepared = await f.authorize("Other");
  await channel.options.onFrame?.(
    JSON.stringify({ type: "grant", value: prepared.record }),
  );
  await expect(join.completion).rejects.toThrow("label");
  expect(channel.sent).toHaveLength(1);
});
it("a closed join ignores a late grant instead of acknowledging it", async () => {
  const f = setup();
  const join = joinHostPairing(createInvitation("Host"), "Phone", {
    channelFactory: f.factory,
  });
  cleanups.push(() => join.close());
  const channel = f.channels[0]!;
  channel.options.onConnect?.();
  await join.close();
  const prepared = await f.authorize("Phone");
  await channel.options.onFrame?.(
    JSON.stringify({ type: "grant", value: prepared.record }),
  );
  await expect(join.completion).rejects.toThrow("cancelled");
  expect(channel.sent).toHaveLength(1);
});
it("close waits for asynchronous channel cleanup", async () => {
  const f = setup();
  const offer = await f.offer();
  const gate = pending<void>();
  f.qr().channel.close = () => gate.promise;
  let done = false;
  const closing = offer.close().then(() => (done = true));
  await Promise.resolve();
  expect(done).toBe(false);
  gate.resolve();
  await closing;
  expect(done).toBe(true);
});
it("preserves class-backed preparation methods and their receiver", async () => {
  const calls: string[] = [];
  class Preparation implements HostGrantPreparation {
    constructor(
      readonly record: ConnectionRecord,
      private readonly operations: string[],
    ) {}
    async persist(begin: () => void) {
      begin();
      this.operations.push("persist");
    }
    async activate() {
      this.operations.push("activate");
    }
  }
  const f = setup((record) => new Preparation(record, calls));
  const offer = await f.offer();
  await acknowledge(await claim(f));
  await expect(offer.completion).resolves.toBeDefined();
  expect(calls).toEqual(["persist", "activate"]);
});
it.each([
  "2026-02-30T12:00:00Z",
  "2026-02-29T12:00:00Z",
  "2026-04-31T12:00:00Z",
  "2026-01-01T24:00:00Z",
])("rejects a normalized impossible invitation timestamp %s", (expiresAt) => {
  const invitation = { ...createInvitation("Host"), expiresAt };
  expect(() => decodeHostInvitation(encodeInvitation(invitation))).toThrow(
    "Invalid expiry",
  );
});
it.each(["2000-01-01T00:00:00Z", "2090-01-01T00:00:00Z"])(
  "accepts a valid leap-day invitation with browser clock %s",
  (clock) => {
    const invitation = {
      ...createInvitation("Host"),
      expiresAt: "2028-02-29T12:00:00Z",
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date(clock));
    expect(decodeHostInvitation(encodeInvitation(invitation))).toEqual(
      invitation,
    );
  },
);
it("marks code handoff failed when private channel creation throws after bootstrap close", async () => {
  const f = setup();
  let qrRoom: string | null = null;
  let failedOpens = 0;
  const offer = await offerHostPairing({
    label: "Host",
    authorize: f.authorize,
    channelFactory: (options) => {
      if (options.hello.role === "offer-host") {
        if (qrRoom !== null) {
          failedOpens++;
          throw new Error("Private room failed");
        }
        qrRoom = options.credentials.roomId;
      }
      return f.factory(options);
    },
  });
  cleanups.push(() => offer.close());
  const { path, finished } = await codeExchange(f, offer);
  await path.options.onFrame?.(
    JSON.stringify({ type: "ke3", value: finished.finishLoginRequest }),
  );
  expect(failedOpens).toBe(1);
  expect(path.closed).toBe(true);
  expect(f.qr().closed).toBe(false);
  expect(offer.state).toBe("pending");
  f.qr().options.onDisconnect?.();
  expect(offer.state).toBe("closed");
  await expect(offer.completion).rejects.toThrow();
});
it("rejects concurrent valid KE3 reuse before the bootstrap wire closes", async () => {
  const f = setup();
  const offer = await f.offer();
  const { path, finished } = await codeExchange(f, offer);
  const frame = JSON.stringify({
    type: "ke3",
    value: finished.finishLoginRequest,
  });
  expect(path.closed).toBe(false);
  await Promise.all([
    path.options.onFrame?.(frame),
    path.options.onFrame?.(frame),
  ]);
  expect(path.closed).toBe(true);
  expect(
    f.channels.filter((channel) => channel.options.hello.role === "offer-host"),
  ).toHaveLength(1);
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.qr().closed).toBe(false);
  expect(offer.state).toBe("pending");
});
async function clientExchange(
  host: ReturnType<typeof setup>,
  offer: Awaited<ReturnType<typeof host.offer>>,
  changedHello: Record<string, string | number> = {},
) {
  const client = setup();
  const join = joinHostPairing(offer.code, "Phone", {
    channelFactory: client.factory,
  });
  cleanups.push(() => join.close());
  await vi.waitFor(() => expect(client.channels).toHaveLength(1));
  const wire = client.channels[0]!;
  const hostWire = host.code();
  wire.options.acceptHello({ ...hostWire.options.hello, ...changedHello });
  hostWire.options.acceptHello(wire.options.hello);
  hostWire.options.onConnect?.();
  wire.options.onConnect?.();
  await hostWire.options.onFrame?.(JSON.stringify(wire.sent[0]));
  return { client, join, wire, ke2: JSON.stringify(hostWire.sent[0]) };
}
it("rejects concurrent KE2 reuse during client handoff without a second KE3", async () => {
  const host = setup();
  const offer = await host.offer();
  const { client, join, wire, ke2 } = await clientExchange(host, offer);
  expect(wire.closed).toBe(false);
  await Promise.all([wire.options.onFrame?.(ke2), wire.options.onFrame?.(ke2)]);
  await expect(join.completion).rejects.toThrow("Unexpected code phase");
  expect(wire.sent.map((frame) => (frame as { type: string }).type)).toEqual([
    "ke1",
    "ke3",
  ]);
  expect(
    client.channels.filter(
      (channel) => channel.options.hello.role === "offer-client",
    ),
  ).toHaveLength(0);
  expect(host.authorize).not.toHaveBeenCalled();
});
it.each(["expiresAt", "attemptId"])(
  "rejects host %s changed outside the OPAQUE context",
  async (field) => {
    const host = setup();
    const offer = await host.offer();
    const changed =
      field === "attemptId"
        ? crypto.randomUUID()
        : new Date(Date.parse(offer.invitation.expiresAt) + 1000)
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z");
    const { client, join, wire, ke2 } = await clientExchange(host, offer, {
      [field]: changed,
    });
    await wire.options.onFrame?.(ke2);
    await expect(join.completion).rejects.toThrow("authentication failed");
    expect(wire.sent.map((frame) => (frame as { type: string }).type)).toEqual([
      "ke1",
    ]);
    expect(client.channels).toHaveLength(1);
    expect(host.authorize).not.toHaveBeenCalled();
  },
);
it("rejects a code-client hello with another locator", async () => {
  const host = setup();
  const offer = await host.offer();
  const { locator } = parseCode(offer.code);
  expect(() =>
    host.code().options.acceptHello({
      version: 2,
      role: "code-client",
      roomId: host.code().options.credentials.roomId,
      locator: locator === "000000" ? "111111" : "000000",
    }),
  ).toThrow("Unexpected code peer");
  expect(host.authorize).not.toHaveBeenCalled();
  expect(host.qr().closed).toBe(false);
});
