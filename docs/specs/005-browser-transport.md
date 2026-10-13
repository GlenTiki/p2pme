# Static browser transport and local host

Use Trystero 0.26.0 with werift 0.25.0 on Node and native browser WebRTC. Both packages use the same protocol. GitHub Pages serves static files. There is no p2pme cloud API or operated rendezvous server. Public Nostr relays carry encrypted discovery offers. Google and Cloudflare STUN servers assist connections. Relay operators see connection metadata. Direct connections may fail on restrictive networks; users can supply their own TURN configuration. No audio/video feature is implied.

The transport starts only on explicit Connect or local host start. No discovery on landing-page load. Use random 256-bit room passwords, never a public ID or human PIN as a password. maxReceiveBytes is 32768. onReceive rejects other message kinds and frames above this size. Never enable media handlers.

A browser creates a versioned base64url invitation containing random roomId, secret, expiresAt and label. Invitation expires after 10 minutes. The host rejects malformed, expired or excessively future deadlines; expiresAt must be at most ten minutes after the host current time. Acknowledgement must finish before this fixed deadline. The browser displays it for copy; it is not a URL, query, log, analytics event or HTTP request. Local CLI reads the invitation through stdin, displays label and exact grant scope, and asks a human on /dev/tty to approve. No --yes or agent-issued approve command. Test code injects an approval callback instead of a TTY. Same-UID processes remain trusted; TTY is an interaction boundary, not cryptographic human attestation.

After approval the host joins that temporary room and prepares a new per-device grant containing hostId, grantId, roomId, 256-bit secret, label and expiry. Provisional credentials exist only in memory, and their permanent room stays closed. Browser receives them, sends an acknowledgement containing pairing ID and grant ID, then awaits acknowledgement transmission before leaving. Host accepts the acknowledgement before the fixed invitation deadline, persists the active grant atomically, and only then opens its permanent room. Browser remembers credentials only after a validated permanent-room welcome. On pre-acknowledgement timeout, connection loss, rejection or extra-peer abort, discard provisional credentials; they were never authorised or persisted. A crash before acknowledgement leaves no grant to activate on restart. A crash after durable activation leaves the acknowledged device able to reconnect. Persist failure keeps the permanent room closed. A copied invitation permits connection attempts but cannot bypass local human approval.

For permanent rooms, onPeerHandshake exchanges protocol version, hostId and grantId and validates the local record before actions are exposed. Password possession authenticates that device grant, not a named human. Host sends current hostEpoch in its welcome. Browser requests use hostEpoch and hostId. Dispatcher receives authenticated grantId from transport closure, never wire identity. It rejects repeated request UUIDs within the host epoch, with a 2048-request cap per grant. A daemon start creates a new epoch. Host responses are targeted to one peer. No room-wide broadcast of session output. Reserve one pending-or-active peer slot synchronously before any asynchronous handshake work. Release it only for that same peer on rejection or disconnect. One active browser peer per device room; a second concurrent peer is refused instead of kicking out an existing peer. The client validates welcome hostId, grantId and canonical UUID hostEpoch before any request. Bind the epoch to the current connection. Drop delayed messages from old connections. Reconnect discards unsent requests from the old epoch; it does not retry uncertain requests or rewrite their epochs. Reconnect cannot extend grant expiry.

Browser stores grant credentials only when Remember host is enabled. Browser Forget removes them locally; host Revoke invalidates in memory, persists revocation and closes room/channel. Grant credential reuse after revocation fails. Host restart joins only active grants. Browser reconnect is an explicit button; no unattended page-load network requests. Credentials are browser storage secrets readable by this origin; no claims of hardware-backed or zero-knowledge storage.

SDK connectHost() uses the same protocol for native agent clients. Local grant creation chooses principal agent plus explicit capabilities and approved profiles. No remote API can create or widen grants. Hypercore records accepted requests and outgoing results at dispatcher boundary. Historical records never cause command execution.

Transport accepts relay configuration only from local deployment/host config. Browser invitation cannot choose arbitrary host relay URLs. Tests inject the same local ws-relay strategy with no public STUN/DHT. Production defaults pin named Nostr providers from Trystero package and expose this in README. No server credentials in browser assets.

## Acceptance

1. Real Chromium and Node exchange messages through Trystero using local ws-relay with no public STUN.
2. Wrong room secret/admission data cannot reach dispatcher.
3. Pairing rejection and expiry issue no usable grant.
4. Reconnect selects remembered host and lists registered sessions.
5. Revocation disconnects transport and blocks all later operations.
6. Node SDK and browser use identical request/response schemas.
7. Oversized messages fail before dispatch; malformed messages do not crash daemon.
8. Static build contains no secrets, backend placeholder, or third-party script.

9. Tests cover acknowledgement loss, crash before acknowledgement, concurrent handshakes, changed restart epoch, delayed old-connection messages and excessive invitation expiry.

## Review record

A Codex peer accepted the design revision with SHA256 `192d05a1933c747fa34d2addc6f9652bef5d4402c0cd7f35aababe21cb846010`. The harness did not expose that reviewer's model identifier.

Claude Sonnet 5.5 accepted the transport snapshot with SHA256 `15213ba4d976583fa18b3e14130db5308d77e87a12aafb4a1a1e8f36f838ed5e`. The digest covers sorted paths and contents, with a NUL after each path and content. The snapshot contains this specification before this review record, all transport source and tests, protocol dependencies, and package.json. Claude inspected the supplied files; it did not execute tests. The implementer ran strict types, lint, and 19 transport tests, including two real Chromium and Node tests.

Earlier reviews found terminal control labels, a missing direct Zod dependency, and extra-peer failures that could disconnect an active or pending incumbent. Regression tests reproduce those failures. The accepted revision fixes them. AbortSignal also cancels discovery and pending requests. The caller must handle the pairing completion promise and close its temporary room after permanent connection.

The invitation is a bearer secret. A person who obtains it can race either peer within its lifetime. Local approval confirms the requested label and scope; it does not prove the human identity of the remote peer. Copy the invitation only to the intended local host.

The daemon, CLI, dispatcher, browser UI, and package exports require their own integration review. This transport verdict does not approve those separate components.

Host approval accepts an AbortSignal. Cancellation before the acknowledgement and durable commit stops the temporary room without a grant. The host checks cancellation again immediately before persistence. Once persistence starts, the acknowledged approval is committed. A later CLI disconnect does not undo that grant; the user can revoke it.

Claude Sonnet 5.5 accepted the final pairing cancellation source and tests with SHA256 `20ce5e36f77af85b9319c078713c958de1e514e2c1ad1bf480960cbb22281efe`. This digest uses src/pairing.ts followed by tests/pairing.test.ts, with each path and content followed by a NUL. Two regression tests cover cancellation before acknowledgement and after acknowledgement but before the durable commit.

A real Chromium and Node test exposed a pending connection slot leak. Trystero can suppress its join-error callback after a pending peer closes. It does not emit a leave event for that pending peer. The handshake now releases its own slot when send, receive or validation fails. A contender that fails to claim a slot cannot release the incumbent. Three regression tests failed before the correction and pass after it. Real tests also confirm that a valid peer can connect after an invalid hello or a disconnect before hello.

Claude `claude-sonnet-5-5` accepted the slot correction with digest `7283e2c721a62e603f2ccedc5a2c00921c4c16d7682773da579c907b2aede738`. The digest covers src/rtc-channel.ts, src/rtc-identity.ts and tests/rtc.test.ts in that order, with each path and content followed by a NUL. The reviewer inspected source and did not execute tests. A separate peer reproduced both failures and verified the correction with real endpoints. Failed pending peers can now report through the optional advisory callback; the host client also has a connection deadline.
