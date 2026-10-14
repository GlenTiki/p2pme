import { expect, it, vi } from "vitest";
import type { MessageAction, Room } from "trystero";
import { openRtcChannel, type RtcRoomConfig } from "../src/rtc-channel.js";
import { createInvitation } from "../src/rtc-identity.js";

it.each([0, -1, 1.5, 32769, NaN, Infinity])(
  "rejects frame limit %s before joining",
  (maxFrameBytes) => {
    const join = vi.fn();
    expect(() =>
      openRtcChannel(
        {
          credentials: createInvitation("Host"),
          maxFrameBytes,
          hello: {},
          acceptHello: () => {},
        },
        { join },
      ),
    ).toThrow("limit");
    expect(join).not.toHaveBeenCalled();
  },
);
it("enforces UTF-8 action byte limits for sends, admission and parsed frames", async () => {
  const received: string[] = [];
  const errors: Error[] = [];
  let config!: RtcRoomConfig;
  const action: MessageAction<string> = {
    send: vi.fn(async () => {}),
    onMessage: null,
    onReceive: null,
    onReceiveProgress: null,
  };
  const room = {
    makeAction: () => action,
    leave: async () => {},
    onPeerJoin: null,
    onPeerLeave: null,
  } as unknown as Room;
  const channel = openRtcChannel(
    {
      credentials: createInvitation("Host"),
      maxFrameBytes: 4,
      hello: {},
      acceptHello: () => {},
      onFrame: (frame) => {
        received.push(frame);
      },
      onError: (error) => errors.push(error),
    },
    {
      join: (value) => {
        config = value;
        return room;
      },
    },
  );
  try {
    expect(config.maxReceiveBytes).toBe(4);
    room.onPeerJoin?.("peer");
    await channel.send('"é"');
    await expect(channel.send('"éé"')).rejects.toThrow("size");
    expect(
      action.onReceive?.({
        peerId: "peer",
        kind: "message",
        byteLength: 6,
        signal: new AbortController().signal,
      }),
    ).toBe(false);
    await action.onMessage?.('"éé"', { peerId: "peer" });
    expect(received).toEqual([]);
    expect(errors).toHaveLength(1);
  } finally {
    await channel.close();
  }
});
