import * as opaque from "@serenity-kit/opaque";
import {
  connectionRecord,
  decodeHostInvitation,
  encodeInvitation,
  exact,
  validateLabel,
  type ConnectionRecord,
  type PairingInvitation,
  type RoomCredentials,
} from "./rtc-identity.js";
import { PairWire, observed } from "./host-pairing-wire.js";
import {
  bootstrapCredentials,
  checkCodeHost,
  checkPrivateHello,
  grantCredentials,
  identifiers,
  parseCode,
  privateHello,
  readFrame,
  readKe,
  type CodeContext,
  type CodeParts,
} from "./host-pairing-protocol.js";
import type { HostJoinAttempt, HostJoinOptions } from "./host-pairing-types.js";

class Joining {
  readonly result = observed<ConnectionRecord>();
  private readonly wires = new Set<PairWire>();
  private settled = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly aborted = () => this.fail(new Error("Pairing cancelled"));
  constructor(
    readonly label: string,
    readonly options: HostJoinOptions,
  ) {
    this.timer = setTimeout(
      () => this.fail(new Error("Pairing timed out")),
      600000,
    );
    options.signal?.addEventListener("abort", this.aborted, { once: true });
  }
  add(wire: PairWire): void {
    if (this.settled) void wire.close();
    else this.wires.add(wire);
  }
  check(): void {
    if (this.settled || this.options.signal?.aborted)
      throw new Error("Pairing cancelled");
  }
  finish(record: ConnectionRecord): void {
    if (this.settled) return;
    this.settled = true;
    this.clear();
    this.result.resolve(record);
  }
  fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.clear();
    this.result.reject(error);
    void this.release();
  }
  async close(): Promise<void> {
    this.fail(new Error("Pairing cancelled"));
    await this.release();
  }
  private clear(): void {
    clearTimeout(this.timer);
    this.options.signal?.removeEventListener("abort", this.aborted);
  }
  private async release(): Promise<void> {
    await Promise.all(Array.from(this.wires, (wire) => wire.close()));
  }
}
function clientPrivate(
  join: Joining,
  credentials: RoomCredentials,
  onHello: () => void = () => {},
): void {
  join.check();
  let phase: "connect" | "grant" | "done" = "connect";
  const wire = new PairWire(
    {
      credentials,
      hello: privateHello("offer-client", credentials.roomId),
      acceptHello: (value) => {
        checkPrivateHello(value, "offer-host", credentials.roomId);
        onHello();
      },
      onConnect: () => {
        phase = "grant";
        wire.clearDeadline();
        void wire
          .send({ type: "claim", label: join.label })
          .catch((error) => join.fail(error));
      },
      onFrame: async (frame) => {
        if (phase !== "grant") throw new Error("Unexpected grant phase");
        const value = readFrame(frame);
        exact(value, ["type", "value"]);
        if (value.type !== "grant") throw new Error("Expected a grant");
        const grant = connectionRecord(value.value);
        if (grant.label !== join.label)
          throw new Error("Grant label does not match claim");
        phase = "done";
        await wire.send({
          type: "ack",
          roomId: credentials.roomId,
          grantId: grant.grantId,
        });
        wire.deadline(10000);
        join.finish(grant);
      },
    },
    join.options,
    (error) => join.fail(error),
  );
  wire.deadline(30000);
  join.add(wire);
}
async function clientCode(join: Joining, code: CodeParts): Promise<void> {
  await opaque.ready;
  join.check();
  const credentials = await bootstrapCredentials(code.locator);
  join.check();
  let context: CodeContext | null = null;
  let state: string | null = null;
  let phase: "connect" | "ke2" | "handoff" = "connect";
  const wire = new PairWire(
    {
      credentials,
      maxFrameBytes: 2048,
      hello: {
        version: 2,
        role: "code-client",
        roomId: credentials.roomId,
        locator: code.locator,
      },
      acceptHello: (value) => {
        context = checkCodeHost(value, credentials.roomId, code.locator);
      },
      onConnect: () => {
        const login = opaque.client.startLogin({ password: code.password });
        state = login.clientLoginState;
        phase = "ke2";
        void wire
          .send({ type: "ke1", value: login.startLoginRequest })
          .catch((error) => join.fail(error));
      },
      onDisconnect: () => {
        if (phase !== "handoff")
          join.fail(new Error("Code authentication disconnected"));
        void wire.close();
      },
      onFrame: async (frame) => {
        if (phase !== "ke2" || !context || !state)
          throw new Error("Unexpected code phase");
        const loginResponse = readKe(frame, "ke2");
        const clientLoginState = state;
        state = null;
        const result = opaque.client.finishLogin({
          clientLoginState,
          loginResponse,
          password: code.password,
          identifiers: identifiers(context),
        });
        if (!result)
          throw new Error(
            "Code authentication failed; use the QR link or request a new code",
          );
        phase = "handoff";
        wire.clearDeadline();
        await wire.send({ type: "ke3", value: result.finishLoginRequest });
        const derived = await grantCredentials(context, result.sessionKey);
        join.check();
        clientPrivate(join, derived, () => {
          void wire.close();
        });
      },
    },
    join.options,
    (error) => join.fail(error),
  );
  join.add(wire);
}
export function joinHostPairing(
  input: string | PairingInvitation,
  label: string,
  options: HostJoinOptions = {},
): HostJoinAttempt {
  const normalized = label.normalize("NFC");
  validateLabel(normalized);
  options.signal?.throwIfAborted();
  const code = typeof input === "string" ? parseCode(input) : null;
  const invitation =
    typeof input === "string"
      ? null
      : decodeHostInvitation(encodeInvitation(input));
  const join = new Joining(normalized, options);
  try {
    if (code) void clientCode(join, code).catch((error) => join.fail(error));
    else if (invitation) clientPrivate(join, invitation);
  } catch (error) {
    join.fail(error);
  }
  return { completion: join.result.promise, close: () => join.close() };
}
