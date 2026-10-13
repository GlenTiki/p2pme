# Browser host connection

## Intent

The public app pairs a browser with a local host. It retains a host only when the user chooses Remember host. A visitor selects a registered session before a message or UI action can run. The browser uses the reviewed Trystero transport through injected client interfaces.

## Flow

1. The visitor enters a device label and selects Create invitation. This is the first network action.
2. The app displays the invitation and a copyable agent prompt. The prompt directs the agent to the host guide. The human runs `p2pme pair` and approves the device locally.
3. The app waits for pairing, then connects to the permanent host room. It stores the grant only after the client validates the welcome and Remember host is selected.
4. The app lists authorized registered sessions. Offline sessions remain visible and cannot accept a message.
5. The visitor selects a session. Chat output comes only from correlated host events. Delegation and session creation use their explicit protocol operations. Scope errors remain visible.
6. A returning visitor selects Connect beside a remembered host. Page load never starts a connection. Forget removes local credentials. Host revocation remains a separate local command.

## Boundaries

Stored grants remain readable by this origin. The app states this beside Remember host. It stores no transcript. Storage failures must leave the live connection usable and report that the host was not saved. Invalid storage must produce a recoverable empty state without a network request. The browser limits its saved list to 32 grants.

Expired grants remain listed with Connect disabled and Forget available. The app validates stored structure separately from live expiry. It reads the current stored grant again on Connect, so another tab's Forget action takes effect. Delegation resets on each send or session selection. Session creation permits one pending request. Refresh rechecks the selected session's online state.

Each connection attempt has a generation. Cancel, disconnect and replacement invalidate pending callbacks and surfaces. A late connection closes without changing the current UI or saving credentials. The app never retries a request automatically. A failed request may have run; error text from the client explains that condition.

Cancel also aborts the pending host connection through `ClientOptions.signal`. It stops discovery before the handshake timeout. The generation changes before abort callbacks can run.

`mountApprovedSurface(sessionId, surface)` accepts a surface only for the current selected session and sends typed `ui.action` requests through that same client. This export is an integration hook; this slice does not receive host surfaces. The host must register the surface before it accepts actions. The local demo stays separate.

## Acceptance criteria

1. Tests prove no connection on load, including valid saved state.
2. Tests cover invalid saved state, storage failure, explicit connect, cancellation and late completion.
3. Tests prove that remembered grants are written only after a successful welcome and only with consent.
4. Tests exercise session selection, actual streamed text, chat and delegation routes, creation errors and surface session isolation.
5. Copy actions report success and failure. Controls remain disabled until their required state exists.
6. Static builds and browser layouts remain usable. No server, provider process or secret is added to the public assets.

## Review record

Claude Sonnet 5.5 (`claude-sonnet-5-5`) reviewed the complete surface and browser sources on 2026-10-13T18:23:31Z. The reviewed bundle has SHA-256 `686928bce79247996aff6cd2b78fd44e5ba5840fe4669f2d51c86ac497400892`. Verdict: ACCEPT, with no blockers. The reviewer inspected source only. RTC internals and host revision authority have separate reviews.

The first review required separate storage validation for expired grants and complete prototype-key rejection in surfaces. Both fixes have regression tests. The second review accepted them. The implementer ran 108 tests, strict TypeScript, ESLint, scoped Prettier and both builds. Chromium checks passed at 1440, 390 and 320 pixels with no page-load network requests, errors or horizontal overflow.

The review left these non-blocking follow-ups: disable saved-host Connect buttons while busy; use fixed storage error text; order overlapping refresh responses; clear old messages on disconnect and invitation text after success; reset delegation when a selected session goes offline; test successful clipboard copy; and improve recovery text for corrupt saved state. Surface delivery remains an explicit integration task.
