import { openRtcChannel } from "../src/rtc-channel.js";
import { describe, expect, it } from "vitest";
import {
  createInvitation,
  decodeInvitation,
  encodeInvitation,
  reservePeer,
  validateWelcome,
} from "../src/rtc-identity.js";

const now = Date.parse("2026-10-13T18:00:00Z");
describe("pairing invitations", () => {
  it("round trips random credentials without a server", () => {
    const invitation = createInvitation("My phone", now);
    expect(decodeInvitation(encodeInvitation(invitation), now)).toEqual(
      invitation,
    );
    expect(invitation.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createInvitation("My phone", now).secret).not.toBe(
      invitation.secret,
    );
  });
  it("rejects expired, excessively future, malformed and extra fields", () => {
    const invitation = createInvitation("My phone", now);
    expect(() =>
      decodeInvitation(encodeInvitation(invitation), now + 600001),
    ).toThrow();
    expect(() =>
      decodeInvitation(encodeInvitation(invitation), now - 1000),
    ).toThrow();
    expect(() => decodeInvitation("invalid", now)).toThrow();
    expect(() =>
      decodeInvitation(
        encodeInvitation({ ...invitation, extra: true } as typeof invitation),
        now,
      ),
    ).toThrow();
  });
});
describe("single device admission", () => {
  it("reserves before asynchronous work and releases only the owner", () => {
    const slot = reservePeer();
    slot.claim("a");
    expect(() => slot.claim("b")).toThrow();
    slot.release("b");
    expect(() => slot.claim("b")).toThrow();
    slot.release("a");
    expect(() => slot.claim("b")).not.toThrow();
  });
  it("pins the approved host and grant while accepting a fresh epoch", () => {
    const hostId = crypto.randomUUID(),
      grantId = crypto.randomUUID();
    const welcome = {
      version: 1,
      role: "host",
      hostId,
      grantId,
      hostEpoch: crypto.randomUUID(),
    };
    expect(validateWelcome(welcome, { hostId, grantId })).toBe(
      welcome.hostEpoch,
    );
    expect(() =>
      validateWelcome(
        { ...welcome, hostId: crypto.randomUUID() },
        { hostId, grantId },
      ),
    ).toThrow();
    expect(() =>
      validateWelcome({ ...welcome, hostEpoch: "bad" }, { hostId, grantId }),
    ).toThrow();
    expect(() =>
      validateWelcome(
        { ...welcome, grantId: crypto.randomUUID() },
        { hostId, grantId },
      ),
    ).toThrow();
  });
});

it("rejects terminal control and bidi labels before approval", () => {
  for (const label of ["phone\x1b[2K", "phone\nApproved", "phone\u202e"]) {
    expect(() => createInvitation(label)).toThrow();
  }
});

it("keeps an incumbent handshake alive when a second peer is refused", async () => {
  let callbacks:
    | NonNullable<
        Parameters<
          NonNullable<import("../src/rtc-channel.js").RtcNetwork["join"]>
        >[2]
      >
    | undefined;
  const fatal: Error[] = [];
  const advisory: string[] = [];
  let receive!: (value: { data: string }) => void;
  const pending = new Promise<{ data: string }>((resolve) => {
    receive = resolve;
  });
  const channel = openRtcChannel(
    {
      credentials: createInvitation("Test"),
      hello: { role: "host" },
      acceptHello: () => {},
      onError: (error) => fatal.push(error),
      onPeerError: (_, peer) => advisory.push(peer),
    },
    {
      join: (_config, _room, options) => {
        callbacks = options;
        return {
          makeAction: () => ({ send: async () => {} }),
          leave: async () => {},
        } as unknown as import("trystero").Room;
      },
    },
  );
  const first = callbacks!.onPeerHandshake!(
    "first",
    async () => {},
    async () => pending,
    false,
  );
  await expect(
    callbacks!.onPeerHandshake!(
      "second",
      async () => {},
      async () => ({ data: "{}" }),
      false,
    ),
  ).rejects.toThrow();
  callbacks!.onJoinError!({
    peerId: "second",
    error: "already connected",
    appId: "p2pme/1",
    roomId: "test",
  });
  expect(fatal).toEqual([]);
  expect(advisory).toEqual(["second"]);
  receive({ data: "{}" });
  await first;
  await channel.close();
});
