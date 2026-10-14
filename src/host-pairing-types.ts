import type { ChannelFactory } from "./pairing.js";
import type { RtcNetwork } from "./rtc-channel.js";
import type { ConnectionRecord, PairingInvitation } from "./rtc-identity.js";

export interface HostJoinOptions {
  signal?: AbortSignal;
  network?: RtcNetwork;
  channelFactory?: ChannelFactory;
}
export interface HostJoinAttempt {
  completion: Promise<ConnectionRecord>;
  close(): Promise<void>;
}
export interface HostGrantPreparation {
  record: ConnectionRecord;
  persist(beginCommit: () => void): Promise<void>;
  activate(): Promise<void>;
}
export interface HostOfferOptions extends HostJoinOptions {
  label: string;
  authorize(
    label: string,
    signal: AbortSignal,
    attempt: Readonly<{ attemptId: string; expiresAt: string }>,
  ): Promise<HostGrantPreparation>;
}
export type HostOfferState =
  "pending" | "claimed" | "committing" | "complete" | "closed";
export interface HostOffer extends HostJoinAttempt {
  invitation: PairingInvitation;
  code: string;
  readonly state: HostOfferState;
  cancel(): Promise<"cancelled" | "too-late">;
}
