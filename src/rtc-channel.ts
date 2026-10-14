import {
  joinRoom,
  type JoinRoom,
  type JoinRoomConfig,
  type Room,
} from "trystero";
import { MAX_FRAME_BYTES } from "./protocol.js";
import {
  credentials,
  record,
  reservePeer,
  type RoomCredentials,
} from "./rtc-identity.js";

export type RtcRoomConfig = JoinRoomConfig & {
  relayConfig: { urls: string[] };
};
export interface RtcNetwork {
  join?: JoinRoom<RtcRoomConfig>;
  rtcPolyfill?: typeof RTCPeerConnection;
  relayUrls?: string[];
  iceServers?: RTCIceServer[];
}
export interface ChannelOptions {
  credentials: RoomCredentials;
  maxFrameBytes?: number;
  hello: Record<string, string | number>;
  acceptHello(value: unknown): void;
  onConnect?(): void;
  onDisconnect?(): void;
  onFrame?(frame: string): void | Promise<void>;
  onError?(error: Error): void;
  onPeerError?(error: Error, peerId: string): void;
}
export interface RtcChannel {
  send(frame: string): Promise<void>;
  close(): Promise<void>;
  readonly connected: boolean;
}
function config(
  options: ChannelOptions,
  network: RtcNetwork,
  limit: number,
): RtcRoomConfig {
  credentials({ ...options.credentials });
  return {
    appId: "p2pme/1",
    password: options.credentials.secret,
    maxReceiveBytes: limit,
    relayConfig: {
      urls: network.relayUrls ?? ["wss://nos.lol", "wss://relay.damus.io"],
    },
    rtcConfig: {
      iceServers: network.iceServers ?? [
        { urls: "stun:stun.cloudflare.com:3478" },
        { urls: "stun:stun.l.google.com:19302" },
      ],
    },
    ...(network.rtcPolyfill === undefined
      ? {}
      : { rtcPolyfill: network.rtcPolyfill }),
  };
}
export function openRtcChannel(
  options: ChannelOptions,
  network: RtcNetwork = {},
): RtcChannel {
  const limit = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FRAME_BYTES)
    throw new Error("Invalid frame limit");
  const slot = reservePeer();
  let active: string | null = null;
  let closed = false;
  let closing: Promise<void> | null = null;
  const error = (value: unknown) =>
    options.onError?.(
      value instanceof Error ? value : new Error("Connection failed"),
    );
  const room = (network.join ?? joinRoom)(
    config(options, network, limit),
    options.credentials.roomId,
    {
      handshakeTimeoutMs: 10000,
      onPeerHandshake: async (peerId, send, receive) => {
        slot.claim(peerId);
        try {
          if (closed) throw new Error("Connection is closed");
          await send(JSON.stringify(options.hello));
          const remote = await receive();
          if (typeof remote.data !== "string" || remote.data.length > 1024)
            throw new Error("Invalid handshake");
          options.acceptHello(record(JSON.parse(remote.data)));
          if (closed) throw new Error("Connection is closed");
        } catch (cause) {
          slot.release(peerId);
          throw cause;
        }
      },
      onJoinError: (details) => {
        const incumbent = slot.owns(details.peerId);
        slot.release(details.peerId);
        const cause = new Error(details.error);
        if (incumbent) error(cause);
        else options.onPeerError?.(cause, details.peerId);
      },
    },
  );
  const action = room.makeAction<string>("p2pme");
  action.onReceive = (context) =>
    context.byteLength <= limit && context.kind === "message";
  action.onMessage = async (frame, context) => {
    if (closed || context.peerId !== active) return;
    try {
      checkFrame(frame, limit);
      await options.onFrame?.(frame);
    } catch (cause) {
      error(cause);
    }
  };
  room.onPeerJoin = (peerId) => {
    if (closed || active !== null) return;
    active = peerId;
    options.onConnect?.();
  };
  room.onPeerLeave = (peerId) => {
    slot.release(peerId);
    if (active === peerId) {
      active = null;
      options.onDisconnect?.();
    }
  };
  return {
    get connected() {
      return active !== null && !closed;
    },
    async send(frame) {
      checkFrame(frame, limit);
      if (closed || active === null) throw new Error("Peer is not connected");
      await action.send(frame, { target: active });
    },
    close() {
      if (closing) return closing;
      closed = true;
      active = null;
      clearHandlers(room);
      action.onMessage = null;
      closing = room.leave();
      return closing;
    },
  };
}
function clearHandlers(room: Room): void {
  room.onPeerJoin = null;
  room.onPeerLeave = null;
}
function checkFrame(frame: unknown, limit: number): asserts frame is string {
  if (
    typeof frame !== "string" ||
    new TextEncoder().encode(frame).length > limit
  )
    throw new Error("Invalid frame size");
  JSON.parse(frame);
}
