import type { HostResponse } from "./host-protocol.js";
import {
  openRtcChannel,
  type RtcChannel,
  type RtcNetwork,
} from "./rtc-channel.js";
import {
  connectionRecord,
  exact,
  record,
  type ConnectionRecord,
} from "./rtc-identity.js";
import type { ChannelFactory } from "./pairing.js";

export interface HostConnectionOptions {
  hostEpoch: string;
  active(): boolean;
  dispatch(frame: string): Promise<HostResponse>;
  network?: RtcNetwork;
  channelFactory?: ChannelFactory;
  onError?(error: Error): void;
}
export function serveHostConnection(
  approved: ConnectionRecord,
  options: HostConnectionOptions,
): RtcChannel {
  connectionRecord(approved);
  const enabled = () =>
    options.active() && Date.now() < Date.parse(approved.expiresAt);
  const channel = (options.channelFactory ?? openRtcChannel)(
    {
      credentials: approved,
      hello: {
        version: 1,
        role: "host",
        hostId: approved.hostId,
        grantId: approved.grantId,
        hostEpoch: options.hostEpoch,
      },
      acceptHello: (value) => {
        if (!enabled()) throw new Error("Device grant is inactive");
        validateClient(value, approved);
      },
      onFrame: async (frame) => {
        if (!enabled()) return close();
        const response = await options.dispatch(frame);
        if (!enabled()) return close();
        await channel.send(JSON.stringify(response));
      },
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    },
    options.network,
  );
  const cancelExpiry = scheduleExpiry(Date.parse(approved.expiresAt), () => {
    void channel.close();
  });
  function close() {
    cancelExpiry();
    return channel.close();
  }
  return {
    get connected() {
      return channel.connected;
    },
    async send(frame) {
      if (!enabled()) {
        await close();
        throw new Error("Device grant is inactive");
      }
      await channel.send(frame);
    },
    close,
  };
}
function validateClient(input: unknown, approved: ConnectionRecord): void {
  const value = record(input);
  exact(value, ["version", "role", "hostId", "grantId"]);
  if (
    value.version !== 1 ||
    value.role !== "client" ||
    value.hostId !== approved.hostId ||
    value.grantId !== approved.grantId
  )
    throw new Error("Device identity did not match its grant");
}
function scheduleExpiry(deadline: number, close: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  function schedule() {
    const delay = Math.max(0, deadline - Date.now());
    timer = setTimeout(
      () => {
        if (Date.now() >= deadline) close();
        else schedule();
      },
      Math.min(delay, 2147483647),
    );
    timer.unref?.();
  }
  schedule();
  return () => clearTimeout(timer);
}
