import {
  openRtcChannel,
  type ChannelOptions,
  type RtcChannel,
  type RtcNetwork,
} from "./rtc-channel.js";
import {
  connectionRecord,
  createInvitation,
  decodeInvitation,
  encodeInvitation,
  exact,
  record,
  type ConnectionRecord,
  type PairingInvitation,
} from "./rtc-identity.js";

export type ChannelFactory = (
  options: ChannelOptions,
  network?: RtcNetwork,
) => RtcChannel;
interface PairOptions {
  network?: RtcNetwork;
  channelFactory?: ChannelFactory;
}
export interface PairingAttempt {
  invitation: PairingInvitation;
  completion: Promise<ConnectionRecord>;
  close(): Promise<void>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function checkHello(input: unknown, role: string, roomId: string): void {
  const value = record(input);
  exact(value, ["version", "role", "roomId"]);
  if (value.version !== 1 || value.role !== role || value.roomId !== roomId)
    throw new Error("Unexpected pairing peer");
}
export function beginPairing(
  label: string,
  options: PairOptions = {},
): PairingAttempt {
  const invitation = createInvitation(label);
  const pending = deferred<ConnectionRecord>();
  let received = false;
  const channel = (options.channelFactory ?? openRtcChannel)(
    {
      credentials: invitation,
      hello: { version: 1, role: "pair-client", roomId: invitation.roomId },
      acceptHello: (value) => checkHello(value, "pair-host", invitation.roomId),
      onFrame: async (frame) => {
        if (received) return;
        try {
          const value = record(JSON.parse(frame));
          exact(value, ["type", "value"]);
          if (value.type !== "grant")
            throw new Error("Expected a device grant");
          const grant = connectionRecord(value.value);
          received = true;
          await channel.send(
            JSON.stringify({
              type: "ack",
              roomId: invitation.roomId,
              grantId: grant.grantId,
            }),
          );
          pending.resolve(grant);
        } catch (error) {
          pending.reject(error);
        }
      },
      onDisconnect: () =>
        pending.reject(new Error("Pairing peer disconnected")),
      onError: pending.reject,
      onPeerError: pending.reject,
    },
    options.network,
  );
  const timer = setTimeout(
    () => {
      pending.reject(new Error("Pairing invitation expired"));
      void channel.close();
    },
    Date.parse(invitation.expiresAt) - Date.now(),
  );
  return {
    invitation,
    completion: pending.promise,
    async close() {
      clearTimeout(timer);
      pending.reject(new Error("Pairing cancelled"));
      await channel.close();
    },
  };
}
export interface PairHostOptions extends PairOptions {
  signal?: AbortSignal;
  persist(): Promise<void>;
  activate(): Promise<void>;
}
export async function approvePairing(
  invitation: PairingInvitation,
  grant: ConnectionRecord,
  options: PairHostOptions,
): Promise<void> {
  assertNotCancelled(options.signal);
  decodeInvitation(encodeInvitation(invitation));
  connectionRecord(grant);
  const ack = deferred<void>();
  const cancel = () => ack.reject(new Error("Pairing cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  const channel = (options.channelFactory ?? openRtcChannel)(
    {
      credentials: invitation,
      hello: { version: 1, role: "pair-host", roomId: invitation.roomId },
      acceptHello: (value) =>
        checkHello(value, "pair-client", invitation.roomId),
      onConnect: () => {
        void channel
          .send(JSON.stringify({ type: "grant", value: grant }))
          .catch(ack.reject);
      },
      onFrame: (frame) => {
        try {
          checkAck(frame, invitation, grant);
          ack.resolve();
        } catch (error) {
          ack.reject(error);
        }
      },
      onDisconnect: () => {
        ack.reject(new Error("Pairing disconnected before acknowledgement"));
        void channel.close();
      },
      onError: ack.reject,
      onPeerError: ack.reject,
    },
    options.network,
  );
  const timer = setTimeout(
    () => ack.reject(new Error("Pairing invitation expired")),
    Date.parse(invitation.expiresAt) - Date.now(),
  );
  try {
    await ack.promise;
    clearTimeout(timer);
    assertNotCancelled(options.signal);
    options.signal?.removeEventListener("abort", cancel);
    await options.persist();
    await options.activate();
    const cleanup = setTimeout(() => {
      void channel.close();
    }, 10000);
    cleanup.unref?.();
  } catch (error) {
    await channel.close();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    clearTimeout(timer);
  }
}
function checkAck(
  frame: string,
  invitation: PairingInvitation,
  grant: ConnectionRecord,
): void {
  const value = record(JSON.parse(frame));
  exact(value, ["type", "roomId", "grantId"]);
  if (
    value.type !== "ack" ||
    value.roomId !== invitation.roomId ||
    value.grantId !== grant.grantId ||
    Date.now() >= Date.parse(invitation.expiresAt)
  )
    throw new Error("Invalid pairing acknowledgement");
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Pairing cancelled");
}
