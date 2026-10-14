# Host-first device setup

## Intent

The user gives a local coding agent one setup instruction. The agent registers the selected session and returns a short code, a connection link, and a QR code. The browser accepts the code or opens the QR link. After pairing, it lists sessions and contexts from the authenticated host. No application backend is operated.

Keep the separate grants for chat, session creation, configuration, delegation, and UI actions. Do not infer or replace the current provider session. Keep the existing host identity and remembered device grants.

## Approval decision

Glen explicitly chose: “Code or QR completes pairing — the invitation authorizes one device with the stated access.” Creating the local invitation preauthorizes its first authenticated recipient for the displayed profiles and scopes. The new flow has no second terminal prompt. Keep the old approval behavior only for the legacy browser-first command. The library authorization callback prepares the preauthorized grant and rechecks expiry and daemon state.

## Browser flow

1. Show an instruction that the user can copy to the local agent: read the host guide and run the p2pme skill for this session.
2. Show one pairing-code input and a Connect button. Device name and Remember host remain available. Do not create a browser invitation.
3. Accept a code such as `7K3M2Q-9RX4TW6P`. This is an example, not a live invitation. Normalize ASCII case and the display separator. Reject invalid lengths and characters before network access.
4. A QR link carries the existing strong invitation in `#pair=...`. Parse it and remove the fragment with `history.replaceState` before any connection attempt. The fragment never enters a query or server path. Apply this to initial navigation and `hashchange`. If a host is connected or a connection is pending, scrub the new fragment and ask the user to disconnect before opening that link again. Do not retain that unused secret. Leave ordinary page anchors unchanged.
5. A valid QR link starts pairing. Ordinary page loads do not discover peers or connect automatically. Malformed links show a fixed error and do not start discovery. The host enforces expiry; browser clock differences do not reject an otherwise valid link.
6. Show progress and failure states. Never retry a failed or uncertain pairing automatically.
7. After a verified grant arrives, connect to the permanent host room and load its sessions and contexts. Save access only when Remember host is selected. After a QR connection, offer an explicit Remember host action once the permanent host welcome is verified.
8. Cancellation and host replacement discard old callbacks and secrets. A remembered host requires no new pairing code while its grant remains valid.

## Authentication and discovery

The typed code contains a public locator of six characters and an independent secret of eight characters. Use the alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Generate each character from five random bits. The locator has 30 bits; the secret has 40 bits. The locator contributes no authentication entropy.

Accept exactly 14 characters, or 15 characters with one hyphen after character six. Trim outer ASCII whitespace and convert ASCII lowercase to uppercase. Reject internal whitespace, other separators, and all characters outside the alphabet. Do not map ambiguous characters. The canonical OPAQUE password is the eight uppercase secret characters, without a separator.

Use shared functions for all derivations. `encode(parts)` is UTF-8 of `JSON.stringify(parts)`. `room(parts)` is the first 16 bytes of SHA-256 of `encode(parts)`, with UUID version 4 and RFC variant bits set, formatted as lowercase UUID. This function creates public identifiers, not encryption keys. The bootstrap room is `room(["p2pme/code-bootstrap/2", locator])`. Its public password is unpadded base64url of SHA-256 of UTF-8 `p2pme/code-bootstrap/2`. Do not derive its room or signaling password from the secret. Current Trystero signaling provides an offline verifier for a low-entropy password, so direct short-password signaling is rejected.

Pin `@serenity-kit/opaque` 1.1.0. Await `ready` before use. The host creates a fresh server setup and performs both registration roles locally for each offer. Set `userIdentifier` to the attempt UUID. Keep the setup, password, and registration record only in the pending offer. Discard `exportKey`. No registration endpoint or account service exists.

The public host hello has exactly `{version:2, role:"code-host", roomId, locator, attemptId, expiresAt}`. The client hello has exactly `{version:2, role:"code-client", roomId, locator}`. Check each role, room, and locator. The attempt ID must be a canonical UUID v4. The expiry must be a valid UTC timestamp with seconds and a `Z` suffix. Both sides use identifiers `{client, server}`. Their values are JSON strings of `["p2pme/code-client/2", locator, attemptId, expiresAt]` and `["p2pme/code-host/2", locator, attemptId, expiresAt]` respectively.

The browser uses the advertised expiry as authenticated context, not as its local deadline. The host is the sole expiry authority. A separate decoder validates host-issued QR invitations without a browser-clock comparison. Keep the legacy decoder's default deadline checks. The browser uses a ten-minute elapsed timeout to bound its resources. Tests use browser clocks ahead of and behind the host.

The bootstrap frame limit is 2048 UTF-8 bytes. Add an optional `maxFrameBytes` channel setting, bounded by the existing 32 KiB maximum. Apply it to receive admission, frame parsing, and sends. The bootstrap carries exactly three frame types: `{type:"ke1", value:string}`, `{type:"ke2", value:string}`, and `{type:"ke3", value:string}`. Each value is at most 1536 ASCII characters. Validate exact fields and phase before calling OPAQUE. The channel carries no device label, workspace, grant, session list, or command.

The client calls `startLogin`, sends KE1, and processes KE2 with `finishLogin`. An undefined result or exception means authentication failure. The host calls `startLogin` once for KE1 and consumes its saved state before `finishLogin` processes KE3. Treat an exception or absent result as failure. Never reuse a server login state. Reject KE3 before KE1, duplicate KE1, and repeated KE3. The wrapper enforces single use even if the library accepts repeated state.

After OPAQUE verifies the peer, derive a 32-byte key from the 64-byte session key with WebCrypto HKDF-SHA-256. The salt is UTF-8 of the attempt UUID. The info is `encode(["p2pme/host-grant/2", locator, attemptId, expiresAt])`. Encode the key as unpadded base64url. The private room is `room(["p2pme/host-grant/2", locator, attemptId])`. The client sends KE3 before it opens that room. The host closes its bootstrap channel after KE3 verifies, then opens the private room. That intentional close does not fail the code path. The client keeps bootstrap open until the host disconnects or the private host hello completes. After sending KE3, the client treats bootstrap disconnect as expected and waits at most 30 seconds for the private host hello. Before that point, disconnect fails authentication. Test that closing bootstrap does not disconnect an already joined private room. Do not send grant data on the bootstrap channel.

The QR path uses the existing random 256-bit invitation secret directly. It does not require OPAQUE. `invitation.label` and `HostOfferOptions.label` name the host offer. They are untrusted display text in the browser. Both private paths use exact hellos `{version:2, role:"offer-host"|"offer-client", roomId}`. These roles cannot match the legacy browser-first protocol.

The first private client frame is exactly `{type:"claim", label}`. The client NFC-normalizes and validates the device label before network access. Export the existing label validator. The host validates the claim again. It sends no grant before a valid claim. The grant label comes only from that claim, and the client verifies the returned label. The private grant and acknowledgement frames retain the existing shapes. Reject out-of-phase, duplicate, oversized, or malformed frames.

## Peer admission and failure scope

Each room admits one peer through the existing owned reservation. Keep the ten-second handshake timeout. Trystero internally allows handshake payloads up to 65,536 bytes; application validation rejects hello strings over 1024 characters after receipt. Do not claim that the 2048-byte action limit reduces handshake allocations. Refused extra peers cannot cancel the incumbent. Each accepted bootstrap peer has 30 seconds from `onConnect` to complete the exchange. Each private peer has 30 seconds from `onConnect` to send its claim. These deadlines use elapsed time, independently of the offer deadline.

Use one exchange per code path. An admitted peer's timeout, disconnect, malformed frame, or failed authentication closes the whole code path. It never closes the QR path or rejects the offer completion. A new code requires an explicit replacement invitation. This bounds online guesses to one per offer but permits denial of service against the public code path. The UI reports that the user can use the QR link or request a new code. No claim of availability against a public-room attacker is made.

The single-peer channel is sufficient because there is no retry or second admitted exchange on a code path. Per-peer multiplexing and a drop API are out of scope. Preserve ownership checks for refused handshakes. The private QR path has a separate timeout and requires the strong secret. Failure of that path before a claim leaves the code path available. If both paths fail, reject and close the offer. Once any valid claim wins, failure is offer-wide and cannot reopen authorization.

## Attempt and grant lifecycle

An offer expires after ten minutes. The daemon holds at most one pending offer across the new and legacy flows. Each offer has one atomic claim. The first authenticated browser that supplies its device label claims it before authorization starts. A competing code or QR connection cannot trigger another authorization or grant.

Locator collisions must fail authentication rather than pair another host. Cancellation, expiry, and daemon shutdown close every pending channel and invalidate the offer. Path failures follow the isolation rules above. A valid claim synchronously marks the offer claimed and closes competing paths before awaiting authorization. Deadline checks cover authorization and the start of the durable grant commit.

Grant delivery retains the acknowledgement boundary. The host supplies a fresh permanent grant only through the authenticated channel. The browser acknowledges its exact room and grant IDs. Only then can the host commit the grant. A late authorization result cannot revive an expired offer. Failure after a send may be uncertain; never retry automatically.

Define one irreversible commit point. `persist(beginCommit)` invokes `beginCommit()` as the last synchronous action in the queued store mutation, after all checks and the change to its cloned state. The wrapper validates that clone with `hostStateSchema` immediately before `beginCommit`; a schema rejection must not latch commit-started. `beginCommit()` checks cancellation and expiry, then atomically changes the offer to `committing`. An exception discards the cloned mutation before the writer runs. Persistence must invoke the callback exactly once before it writes; returning without it is an error.

`cancel()` atomically returns `cancelled` before this point, or `too-late` once commit starts. A successful cancellation guarantees that this offer cannot write a grant. A too-late cancellation does not abort the commit. Retain the commit-started latch even if the write fails: a filesystem error can follow a successful rename. Report such failure as uncertain, not cancelled. The caller can revoke a committed grant through the existing grant command.

After commit starts, offer expiry cannot undo the grant. Activation requires successful persistence, a healthy store, a valid grant, and a running daemon. Shutdown marks the daemon stopped, closes offer channels, and awaits the commit. It does not activate a room during shutdown. A successfully committed grant can be restored on restart. `close()` releases channels and waits for any commit; it never claims to revoke a grant. The completion rejects on persistence failure, and no room activates in that case.

## Library boundary

Add a new module rather than changing the meaning of `beginPairing` or `approvePairing`. Keep those exports for existing integrations.

The proposed shared interfaces are:

```ts
interface HostOffer {
  invitation: PairingInvitation;
  code: string;
  completion: Promise<ConnectionRecord>;
  readonly state: "pending" | "claimed" | "committing" | "complete" | "closed";
  cancel(): Promise<"cancelled" | "too-late">;
  close(): Promise<void>;
}
interface HostGrantPreparation {
  record: ConnectionRecord;
  persist(beginCommit: () => void): Promise<void>;
  activate(): Promise<void>;
}
interface HostJoinOptions {
  signal?: AbortSignal;
  network?: RtcNetwork;
  channelFactory?: ChannelFactory;
}
interface HostOfferOptions {
  label: string;
  authorize(
    label: string,
    signal: AbortSignal,
    attempt: Readonly<{ attemptId: string; expiresAt: string }>,
  ): Promise<HostGrantPreparation>;
  signal?: AbortSignal;
  network?: RtcNetwork;
  channelFactory?: ChannelFactory;
}
function offerHostPairing(options: HostOfferOptions): Promise<HostOffer>;
function joinHostPairing(
  input: string | PairingInvitation,
  label: string,
  options?: HostJoinOptions,
): { completion: Promise<ConnectionRecord>; close(): Promise<void> };
```

The string input is a typed code. Validate the structured QR invitation at runtime; the TypeScript type is not sufficient. Both clients validate the device label before network access. Export invitation URL helpers that use a supplied base URL, defaulting to the public app. Require HTTPS for a supplied base URL, except HTTP loopback for local development. Reject credentials, queries, and fragments on the base URL. Only a local authorization callback decides which scopes and profiles enter the grant. Internally observe completion rejection, even when callers do not await it. `close()` is idempotent and does not change an already resolved completion. State is diagnostic; only atomic `cancel()` decides whether cancellation succeeded. Export every type in the public signatures.

## Daemon and CLI

Add an `invite` operation with explicit profiles, scopes, and principal (`human-device` or `agent`). Freeze copies of these values for the offer. Add an optional `offer` method to `DaemonTransport` to preserve existing integrations. It returns the attempt ID, expiry, code, and URL immediately. The daemon owns the offer after the command exits; do not bind its lifetime to that control request socket. Daemon shutdown and an explicit cancellation operation close it. Status can expose the attempt ID, expiry, and state, but never its code, URL, secret, or registration data. An `invite` request fails while any offer remains pending, claimed, or committing. To replace a pending offer, explicitly cancel it by attempt ID, then request a new one. A too-late cancellation cannot make space for another offer until the first settles. Register `invite` and `cancel-invite` in both the control dispatcher and the socket operation list. Share pending state with legacy `pair`. Clear that state when the offer settles, not when the request returns. Serialize policy consumption across new and legacy attempts. Recheck cancellation inside that queue, and drain it on shutdown. A cancelled attempt can still have an earlier policy write in flight; a replacement cannot overlap that write. Await pending-offer cleanup on daemon shutdown.

At claim, recheck expiry, daemon shutdown, store health, profile existence, and the 32-grant cap. Consume the offer policy token before creating a grant. Obtain principal, scopes, and profiles only from the frozen local offer. Recheck cancellation and state inside the queued persistence mutation before `beginCommit`. Activation follows the commit rules above. `cancel-invite` requires the exact attempt ID, so a stale command cannot cancel a replacement. The local socket remains a same-user trust boundary: a process with socket access can create an invitation. Skill prose does not constrain a malicious local process.

The CLI prints the code, link, expiry, stated access, and a terminal QR code. QR generation is local. Do not use an image service or upload a code. A local QR artifact export is out of scope for this slice. The setup skill can invoke `invite`; it cannot grant access beyond the user's requested scope or impersonate approval for the legacy flow.

The skill reuses an existing host and selected session. It reports a provider attachment failure instead of creating a replacement. The agent shows the selected access with the invitation. The default is session lists and chat; additional scopes require the user’s instruction. The code or QR scan then completes pairing without another approval prompt. An agent can start the new host process in its managed background job because this flow does not require a controlling terminal. Do not install an operating-system service, edit shell profiles, or modify global agent settings.

## Packaging and public app

Add an explicit app CSP. The OPAQUE package embeds WASM. The browser CSP needs `wasm-unsafe-eval` in `script-src`; it does not need JavaScript `unsafe-eval`. The existing strict agent component catalog remains unchanged. Serve all code from the app origin. Publish the new host package before deploying the browser flow and setup guide. Preserve the older library exports and state format.

The dependency is MIT and has a published 2023 security review. The Node 22 server spike rejects malformed, forged, unrelated, and missing-state KE3 values with an exception. It accepts repeated valid serialized state, so the application phase guard is mandatory. Do not claim that review certifies version 1.1.0 or this composition. A local feasibility spike verified Node-to-Chromium key agreement, wrong-password rejection, identifier mismatch rejection, and the strict WASM CSP. The same spike passed on Node 22.13.1. CI already runs Node 22. Add protocol coverage to that gate. Chromium verifies the declared CSP. Test WebKit where available. A physical low-end phone measurement remains part of the existing device-validation issue; do not claim that hardware was tested. The 30-second peer deadline is a resource bound, not a claimed mobile performance measurement.

## Acceptance criteria

1. Tests demonstrate code and QR pairing through local signaling with no public relay use.
2. Tests reject a wrong secret, changed identifiers, malformed or repeated frames, expired offers, duplicate claims, and cancellation during authorization or queued persistence, and a too-late result after commit starts.
3. Tests cover QR/code races and prove only one grant becomes active.
4. Tests prove the bootstrap carries no grant or session metadata and that private grant traffic uses the derived strong key.
5. Tests prove that an agent can obtain an invitation without a browser-generated token or a blocking control socket.
6. Browser tests cover typed codes, QR fragment removal, no discovery on normal load, remembered hosts, mobile layout, context loading, and stale callbacks.
7. The minimum supported Node version can install and use the package. The browser builds WASM under the declared CSP without external requests.
8. Tests cover clock skew, idle peers, failure isolation, invalid claims, OPAQUE state reuse, and an unawaited completion. A schema failure before the commit hook remains cancellable. Bootstrap closure does not close a private room.
9. Independent Claude security review accepts the complete protocol, daemon policy, and UI diff before release.

## Sources

- OPAQUE API and package: https://github.com/serenity-kit/opaque
- Published review: https://7asecurity.com/reports/pentest-report-opaque.pdf
- OPAQUE standard: https://www.rfc-editor.org/rfc/rfc9807.html
- Established short-code model: https://github.com/magic-wormhole/magic-wormhole/blob/master/docs/attacks.rst
- Existing public signaling: https://trystero.dev/docs/signaling-strategies/

## Review record

2026-10-14T09:02:18Z — Claude (`claude-sonnet-5-5`) accepted the revised specification after two review rounds. The pre-implementation contract snapshot SHA-256 is `60ae759b0aec00a443e7d04c4aeb901b1c9a3449d8b3f3ca5c28a3408d242c94` (before later code-review clarifications). The preceding review used `claude-fable-5-1`. Resolutions define claim frames, host-authoritative expiry, one-use OPAQUE state, bounded peer admission, isolated QR failure, exact derivations, daemon lifetime, and the durable commit point. Code review remains required.

2026-10-14T09:10:48Z — The skill passed its structural validator and a synthetic Claude (`claude-sonnet-5-5`) forward-use check. Given one registered Codex thread, the agent selected `invite --profiles codex`, retained default chat/list access, reused the session, and left Claude access ungranted. Skill SHA-256: `b9f346587c08e1575adb086456e420c7dd0f571895fbc1928d962e0dd1b23b4d`. No provider command or public invitation ran in this check.

2026-10-14T09:30:32Z — Claude (`claude-sonnet-5-5`) reviewed implementation snapshot `4b193d2658adfeac349d70026b14209a317ad3ab26f749914328a6f087e4ce87`. Verdict: request changes for replay, identifier, and code-clock tests. The review reported no production exploit, race, or contract failure. Follow-up also covers canonical QR dates, post-handoff construction errors, and public channel types. QR auto-connect retains Glen’s explicit intent. Public discovery availability and the same-user socket trust boundary remain explicit limits.

2026-10-14T09:39:15Z — Claude (`claude-sonnet-5-5`) returned SHIP for implementation snapshot `6827cf63ceaed3c4c453c6800e0d1d85685db79e2dda8477db020901b648f54b`. The snapshot contains all changed source and tests, the specification, and relevant unchanged host, browser, and build context. The reviewer confirmed the replay, identifier, and browser-clock tests and accepted the handoff error fix, canonical date checks, and public type exports. The review was a static security and correctness review, not a cryptographic audit. Unchanged provider adapters and component internals were outside this follow-up. The only later change is this review record.

The final Node 22.13.1 gate passed 414 tests, strict type checks, lint, formatting, SDK and web builds, and a clean package install. Actual Chromium tests cover code pairing and browser clock offsets of one day. A separate production-build check loaded the minified app under its CSP at desktop and mobile widths. It found no console errors, overflow, or external requests on normal load. Physical phone and real-provider checks remain issue #2.
