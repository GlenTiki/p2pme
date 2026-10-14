import * as opaque from "@serenity-kit/opaque";
import {
  createInvitation,
  exact,
  validateLabel,
  type RoomCredentials,
} from "./rtc-identity.js";
import { OfferState, type PairPath } from "./host-pairing-state.js";
import { PairWire } from "./host-pairing-wire.js";
import {
  bootstrapCredentials,
  checkCodeClient,
  checkPrivateHello,
  generateCode,
  grantCredentials,
  identifiers,
  parseCode,
  privateHello,
  readFrame,
  readKe,
  type CodeContext,
} from "./host-pairing-protocol.js";
import type {
  HostGrantPreparation,
  HostOffer,
  HostOfferOptions,
} from "./host-pairing-types.js";

function hostPrivate(
  state: OfferState,
  name: PairPath,
  credentials: RoomCredentials,
): void {
  let phase: "claim" | "authorizing" | "ack" | "commit" = "claim";
  let preparation: HostGrantPreparation | null = null;
  const wire = new PairWire(
    {
      credentials,
      hello: privateHello("offer-host", credentials.roomId),
      acceptHello: (value) =>
        checkPrivateHello(value, "offer-client", credentials.roomId),
      onFrame: async (frame) => {
        const value = readFrame(frame);
        if (phase === "claim") {
          exact(value, ["type", "label"]);
          if (value.type !== "claim") throw new Error("Expected claim");
          validateLabel(value.label);
          phase = "authorizing";
          wire.clearDeadline();
          preparation = await state.claim(name, value.label);
          if (wire.closed) throw new Error("Pairing path closed");
          phase = "ack";
          await wire.send({ type: "grant", value: preparation.record });
          return;
        }
        if (phase !== "ack" || !preparation)
          throw new Error("Unexpected pairing phase");
        exact(value, ["type", "roomId", "grantId"]);
        if (
          value.type !== "ack" ||
          value.roomId !== credentials.roomId ||
          value.grantId !== preparation.record.grantId
        )
          throw new Error("Invalid pairing acknowledgement");
        phase = "commit";
        state.check();
        await state.persist(preparation);
      },
    },
    state.options,
    (error) => state.pathFailed(name, error),
  );
  state.add(name, wire);
}
async function hostCode(state: OfferState, code: string): Promise<void> {
  const { locator, password } = parseCode(code);
  const context = {
    locator,
    attemptId: state.invitation.roomId,
    expiresAt: state.invitation.expiresAt,
  };
  const credentials = await bootstrapCredentials(locator);
  const serverSetup = opaque.server.createSetup();
  const registration = opaque.client.startRegistration({ password });
  const response = opaque.server.createRegistrationResponse({
    serverSetup,
    userIdentifier: context.attemptId,
    registrationRequest: registration.registrationRequest,
  });
  const { registrationRecord } = opaque.client.finishRegistration({
    ...registration,
    ...response,
    password,
    identifiers: identifiers(context),
  });
  state.check();
  const exchange = new HostExchange(context, serverSetup, registrationRecord);
  const wire = new PairWire(
    {
      credentials,
      maxFrameBytes: 2048,
      hello: {
        version: 2,
        role: "code-host",
        roomId: credentials.roomId,
        ...context,
      },
      acceptHello: (value) =>
        checkCodeClient(value, credentials.roomId, locator),
      onFrame: async (frame) => {
        state.check();
        const key = await exchange.receive(frame, wire);
        if (key === null) return;
        const derived = await grantCredentials(context, key);
        if (!state.available("code")) return;
        await wire.close();
        try {
          if (state.available("code")) {
            state.check();
            hostPrivate(state, "code", derived);
          }
        } catch (error) {
          state.pathFailed("code", error);
        }
      },
    },
    state.options,
    (error) => state.pathFailed("code", error),
  );
  state.add("code", wire);
}
class HostExchange {
  private phase: "ke1" | "ke3" | "done" = "ke1";
  private loginState: string | null = null;
  constructor(
    private readonly context: CodeContext,
    private readonly setup: string,
    private readonly registration: string,
  ) {}
  async receive(frame: string, wire: PairWire): Promise<string | null> {
    if (this.phase === "ke1") {
      const request = readKe(frame, "ke1");
      this.phase = "ke3";
      const result = opaque.server.startLogin({
        serverSetup: this.setup,
        registrationRecord: this.registration,
        startLoginRequest: request,
        userIdentifier: this.context.attemptId,
        identifiers: identifiers(this.context),
      });
      this.loginState = result.serverLoginState;
      await wire.send({ type: "ke2", value: result.loginResponse });
      return null;
    }
    if (this.phase !== "ke3" || this.loginState === null)
      throw new Error("Unexpected code phase");
    const final = readKe(frame, "ke3");
    const serverLoginState = this.loginState;
    this.loginState = null;
    this.phase = "done";
    const result = opaque.server.finishLogin({
      serverLoginState,
      finishLoginRequest: final,
    });
    if (!result) throw new Error("Code authentication failed");
    return result.sessionKey;
  }
}
export async function offerHostPairing(
  options: HostOfferOptions,
): Promise<HostOffer> {
  options.signal?.throwIfAborted();
  const invitation = createInvitation(options.label);
  await opaque.ready;
  options.signal?.throwIfAborted();
  const state = new OfferState(invitation, options);
  const code = generateCode();
  try {
    hostPrivate(state, "qr", invitation);
    await hostCode(state, code);
    state.check();
  } catch (error) {
    state.fail(error);
    await state.close();
    throw error;
  }
  return {
    invitation: { ...invitation },
    code,
    completion: state.result.promise,
    get state() {
      return state.state;
    },
    cancel: () => state.cancel(),
    close: () => state.close(),
  };
}
