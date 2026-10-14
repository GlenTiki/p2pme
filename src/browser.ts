export { beginPairing, type PairingAttempt } from "./pairing.js";
export {
  createInvitation,
  encodeInvitation,
  decodeInvitation,
  connectionRecord,
  type ConnectionRecord,
} from "./rtc-identity.js";
export {
  connectHost,
  type HostClient,
  type ClientOptions,
} from "./host-client.js";
export {
  openRtcChannel,
  type RtcChannel,
  type RtcNetwork,
} from "./rtc-channel.js";

export * from "./host-pairing.js";
export {
  decodeHostInvitation,
  createHostInvitationUrl,
  validateLabel,
} from "./rtc-identity.js";
export type { PairingInvitation, RoomCredentials } from "./rtc-identity.js";

export type { ChannelFactory } from "./pairing.js";
export type { ChannelOptions } from "./rtc-channel.js";
