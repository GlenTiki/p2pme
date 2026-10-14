import type { Envelope } from "./protocol.js";
import type {
  HostRequest,
  HostResponse,
  SessionInfo,
  SessionMetadata,
} from "./host-protocol.js";
import type { HostStore } from "./host-store.js";

export interface AdapterEvent {
  type: "delta" | "completed";
  text: string;
}
export interface SessionAdapter {
  submit(
    input: {
      id: string;
      text: string;
      kind: "chat" | "task" | "ui-action";
      principal: "human-device" | "agent";
      signal: AbortSignal;
    },
    emit: (event: AdapterEvent) => Promise<void>,
  ): Promise<void>;
  configure(input: { modelId: string }): Promise<void>;
  detach(): Promise<void>;
}
export interface LocalProfile {
  id: string;
  provider: string;
  models: string[];
  defaultModelId: string;
  create?: () => Promise<{
    providerSessionId: string;
    adapter: SessionAdapter;
  }>;
}
export interface HostLog {
  append(value: unknown): Promise<void>;
  close(): Promise<void>;
}
export type LogFactory = (
  sessionId: string,
  direction: "ingress" | "egress",
) => Promise<HostLog>;
export interface HostOptions {
  store: HostStore;
  profiles: LocalProfile[];
  logFactory?: LogFactory;
  now?: () => number;
  emit?: (grantId: string, event: Envelope) => Promise<void>;
  onRevoke?: (grantId: string) => Promise<void>;
}
export interface Attachment {
  profileId: string;
  providerSessionId: string;
  label: string;
  adapter: SessionAdapter;
}
export interface HostController {
  readonly hostId: string;
  readonly hostEpoch: string;
  attach(attachment: Attachment): Promise<SessionInfo>;
  publishSurface(sessionId: string, input: unknown): Promise<void>;
  sessions(): SessionInfo[];
  detach(sessionId: string, adapter: SessionAdapter): Promise<void>;
  dispatch(grantId: string, request: unknown): Promise<HostResponse>;
  revokeGrant(grantId: string): Promise<void>;
  close(): Promise<void>;
}
export interface ActiveSession {
  metadata: SessionMetadata;
  adapter: SessionAdapter;
}
export interface LogPair {
  ingress: HostLog;
  egress: HostLog;
}
export type SessionRequest = Exclude<
  HostRequest,
  { op: "sessions.list" | "sessions.create" | "profiles.list" }
>;
