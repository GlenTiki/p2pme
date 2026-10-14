import {
  parseHostRequest,
  type HostRequest,
  type HostResponse,
  type JsonValue,
} from "./host-protocol.js";
import { decodeEnvelope, isId, type Envelope } from "./protocol.js";
import {
  openRtcChannel,
  type RtcNetwork,
  type RtcChannel,
} from "./rtc-channel.js";
import {
  connectionRecord,
  exact,
  record,
  validateWelcome,
  type ConnectionRecord,
} from "./rtc-identity.js";
import type { ChannelFactory } from "./pairing.js";

type Operation = HostRequest["op"];
type Arguments<Op extends Operation> = Extract<HostRequest, { op: Op }>["args"];
export interface HostClient {
  readonly hostId: string;
  readonly hostEpoch: string;
  request<Op extends Operation>(
    op: Op,
    args: Arguments<Op>,
  ): Promise<JsonValue>;
  close(): Promise<void>;
}
export interface ClientOptions {
  signal?: AbortSignal;
  network?: RtcNetwork;
  channelFactory?: ChannelFactory;
  onEvent?(event: Envelope): void;
  onDisconnect?(error: Error): void;
}
interface Pending {
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export function connectHost(
  approved: ConnectionRecord,
  options: ClientOptions = {},
): Promise<HostClient> {
  if (options.signal?.aborted)
    return Promise.reject(new Error("Connection cancelled"));
  connectionRecord(approved);
  let channel: RtcChannel | undefined;
  const pending = new Map<string, Pending>();
  let epoch: string | null = null;
  let closed = false;
  let resolveReady!: (client: HostClient) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<HostClient>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const fail = (error: Error) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    rejectReady(error);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
    options.signal?.removeEventListener("abort", cancel);
    void channel?.close();
    options.onDisconnect?.(error);
  };
  const client: HostClient = {
    hostId: approved.hostId,
    get hostEpoch() {
      if (epoch === null) throw new Error("Host is not connected");
      return epoch;
    },
    request(op, args) {
      if (closed || epoch === null)
        return Promise.reject(new Error("Host is not connected"));
      const request = parseHostRequest({
        version: 1,
        id: crypto.randomUUID(),
        hostId: approved.hostId,
        hostEpoch: epoch,
        op,
        args,
      });
      return sendRequest(
        JSON.stringify(request),
        request.id,
        pending,
        (frame) => channel!.send(frame),
        op === "sessions.list" ? 30000 : 300000,
      );
    },
    async close() {
      fail(new Error("Connection closed"));
      await channel?.close();
    },
  };
  const cancel = () => fail(new Error("Connection cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () => fail(new Error("Host connection timed out")),
    30000,
  );
  try {
    channel = (options.channelFactory ?? openRtcChannel)(
      {
        credentials: approved,
        hello: {
          version: 1,
          role: "client",
          hostId: approved.hostId,
          grantId: approved.grantId,
        },
        acceptHello: (value) => {
          epoch = validateWelcome(value, approved);
        },
        onConnect: () => {
          if (epoch === null) {
            fail(new Error("Missing host welcome"));
            return;
          }
          clearTimeout(timer);
          resolveReady(client);
        },
        onDisconnect: () =>
          fail(
            new Error(
              "Host disconnected. A pending request may have run; it was not retried.",
            ),
          ),
        onError: fail,
        onFrame: (frame) => {
          if (!closed)
            receive(frame, approved.hostId, epoch!, pending, options.onEvent);
        },
      },
      options.network,
    );

    if (closed) {
      clearTimeout(timer);
      void channel.close();
    }
  } catch (error) {
    fail(error instanceof Error ? error : new Error("Cannot open channel"));
  }
  return ready;
}
function sendRequest(
  frame: string,
  id: string,
  pending: Map<string, Pending>,
  send: (frame: string) => Promise<void>,
  timeoutMs: number,
): Promise<JsonValue> {
  if (pending.size >= 32)
    return Promise.reject(new Error("Too many pending requests"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error("Request timed out. It may have run; it was not retried."),
      );
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    void send(frame).catch((error: unknown) => {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    });
  });
}
function receive(
  frame: string,
  hostId: string,
  epoch: string,
  pending: Map<string, Pending>,
  onEvent: ClientOptions["onEvent"],
): void {
  const value = record(JSON.parse(frame));
  if (typeof value.type === "string" && isId(value.sessionId)) {
    const event = decodeEnvelope(frame, value.sessionId);
    if (
      event.type === "ui.render" ||
      (event.replyTo && pending.has(event.replyTo))
    )
      onEvent?.(event);
    return;
  }
  const response = validateResponse(value, hostId, epoch);
  const item = pending.get(response.replyTo);
  if (!item) return;
  clearTimeout(item.timer);
  pending.delete(response.replyTo);
  if (response.ok) item.resolve(response.result);
  else
    item.reject(new Error(`${response.error.code}: ${response.error.message}`));
}
function validateResponse(
  value: Record<string, unknown>,
  hostId: string,
  epoch: string,
): HostResponse {
  exact(value, [
    "version",
    "id",
    "hostId",
    "hostEpoch",
    "replyTo",
    "ok",
    value.ok === true ? "result" : "error",
  ]);
  if (
    value.version !== 1 ||
    !isId(value.id) ||
    !isId(value.replyTo) ||
    value.hostId !== hostId ||
    value.hostEpoch !== epoch
  )
    throw new Error("Invalid response identity");
  if (value.ok === true) record(value.result);
  else {
    if (value.ok !== false) throw new Error("Invalid response status");
    validateError(value.error);
  }
  return value as HostResponse;
}

function validateError(value: unknown): void {
  const error = record(value);
  exact(error, ["code", "message"]);
  if (typeof error.code !== "string" || typeof error.message !== "string")
    throw new Error("Invalid error response");
}
