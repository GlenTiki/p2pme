# Live session page and setup failures

## Intent

Glen reported that the public browser invitation did not connect after an agent followed the host guide. He requested a simple `/live` session page and Claude review of the fix. This change builds on the reviewed, unreleased host-first invitations in specification 015. Keep version 0.2.0 until release.

## Evidence and scope

The public site still serves 0.1.1. Its browser prompt asks an agent to pair a browser, but its skill requires the user to run the legacy pair command and approve a terminal prompt. The 0.2.0 invite flow already removes that mismatch. At 2026-10-14T10:40:53Z, the default local state directory had no control socket. The status command shows a generic error. This proves the default host is unavailable now; it does not prove why the earlier attempt failed. Glen confirmed Codex and reported that it failed to display an easily scanned QR code. He supplied the exact session ID in chat; do not include it in this public spec. Do not reuse or publish the supplied invitation.

The existing browser tests substitute a local WebSocket relay and disable Chromium mDNS privacy. A bounded synthetic smoke check will test the shipped default Nostr/STUN path with stock Chromium. A transport change requires a reproduced defect and a focused regression test. Record any external-network failure separately from a code defect.

## Changes and justification

1. Move the workspace into a static `public/live/index.html`. Keep the homepage's project information, demo, author and repository links. Make its primary action open `/live/`. This puts the live controls first on phones without adding a server.
2. Use the shared app bundle and root-relative assets. Preserve the CSP, no-network-on-normal-load rule, host-derived contexts and explicit remembered-host consent. Existing user grants continue to work.
3. Point new invitation URLs and setup instructions to `/live/`. Support old root QR links and `/#app` links through same-origin replacement. The browser must capture, then clear, a QR fragment before any decode or discovery. Do not put secrets in queries, logs or storage. A redirect can carry the original fragment only to the same-origin live page; clear it before starting any app work.
4. Put connection setup and saved-host controls in a compact section. Collapse setup after a verified connection. Keep status, host identity and Disconnect visible. Keep session selection, messages and approved agent controls directly accessible.
5. Distinguish invitation failure from failure to reach the paired host. Keep a verified connection when only session-list retrieval fails, and provide Refresh. Use fixed phase-specific text; do not expose raw transport errors or secrets. Keep stale-callback guards.
6. Report a missing default/custom control directory, missing socket or refused socket as a fixed actionable host-unavailable error. Preserve private ownership/mode checks and generic output for unknown failures. Do not start a host, remove locks, register a different session or retry automatically.
7. Update the skill and guide to check that the host remains online and the selected session is registered before creating an invitation. A provider attachment failure remains visible and must not produce a replacement session. Do not install a service or alter global settings.

## Acceptance criteria

1. A production-build browser test serves real static files and loads `/live/` without a fallback to the homepage. The route includes session controls and no marketing hero/demo. `/live` resolves to the directory route on the deployed site.
2. The homepage retains the author, repository, local demo and a visible Live session link. Root QR and old app links reach `/live/`; fragments clear before decode/discovery. Normal homepage/live visits contact no public relays.
3. Tests preserve code/QR setup, explicit host recall, hidden creation before approved contexts, messages and UI actions. A post-pair host failure is distinguishable from an invalid invitation. Failed session retrieval leaves the host connected and permits refresh.
4. Tests prove fixed host-unavailable errors for missing directory/socket and refused socket, without exposing paths or untrusted error messages. Permission errors remain errors and are not misreported as missing hosts.
5. Actual Chromium checks cover the built, minified app, normal browser settings and desktop/phone widths. No overflow at 320, 390 and 1440 pixels. Record the result of a bounded default-network synthetic peer check; do not claim a real phone/provider test.
6. All existing quality gates pass. Claude reviews the specification before implementation and the exact final diff before release. Publish the host package before deploying the matching UI after the PR checkpoint.

## Out of scope

No account, paid relay, new hosted backend, transcript observer, operating-system service, automatic process replacement or bypass of provider permissions. No raw third-party errors in the UI. Do not broaden the daemon protocol error taxonomy without evidence that the reported failure needs it.

## Open questions

Glen used Codex and could not get a usable QR image. The current default host is offline. The exact original failure remains unknown; neither fact establishes a defect in ICE or signaling.

## Review record

2026-10-14T10:51:04Z — Claude (`claude-sonnet-5-5`) accepted the revised specification. The first review required explicit compatibility, error phases, fragment order and verification boundaries. The revision resolves those points. Later code inspection corrected the session-list timeout premise; final code review must check that bounded adjustment. The QR file scope follows Glen’s clarification about Codex image display.

## Review clarifications

### Release compatibility

| Host  | Browser | Behaviour                                                                 |
| ----- | ------- | ------------------------------------------------------------------------- |
| 0.1.1 | 0.1.1   | Legacy browser invitation needs human terminal approval.                  |
| 0.2.0 | 0.1.1   | Legacy pairing remains available; new host QR links require the new page. |
| 0.1.1 | 0.2.0   | Saved grants can reconnect. A new invitation needs a host upgrade.        |
| 0.2.0 | 0.2.0   | Host-issued code, image QR and remembered grants use `/live/`.            |

Publish the package first, then merge and deploy the UI. This leaves an explicit release window where a new package's live link can return 404. Do not announce setup as ready until the deployed `/live` redirect and `/live/` page pass. A deployment failure keeps the release incomplete. The skill checks for the `invite` command in installed help before setup and directs an upgrade when absent. A browser cannot detect a host package version before a connection exists; do not claim otherwise. Do not add a version-negotiation protocol in this slice.

### Navigation and failure states

Use an external same-origin redirect module under the CSP. Before mounting the homepage demo or app, capture a bounded valid `#pair=` fragment into memory, clear the current URL with `history.replaceState`, then use same-origin `location.replace` to reach `/live/` with that fragment. The destination synchronously captures and clears the fragment before decoding and discovery. Invalid pairing fragments reach `/live/#pair` to show a fixed invalid-link error without carrying the supplied content. `/#app` reaches `/live/` without a fragment. Other marketing anchors remain on the homepage. Tests must prove the original fragment-bearing entry is replaced and no network starts at the root.

Use these observable phases and fixed text; do not infer an ICE or authentication diagnosis from one generic rejection:

- `LINK_INVALID`: “This connection link is invalid. Request a new link from your agent.”
- `PAIRING_FAILED`: “Pairing did not complete. Keep the host online. Try the QR link or ask your agent for a new invitation.”
- `HOST_UNREACHABLE`: “The device was paired, but the host connection failed. Keep the host online, then reconnect or ask for a new invitation.”
- `SESSIONS_UNAVAILABLE`: “Connected to the host, but sessions could not load. Select Refresh to try again.”

A verified host connection means `connectHost` resolved after it checked the permanent welcome against the grant. A failed code exchange is not retried automatically. The independent QR path can remain available before an offer is claimed. After claim, a failed connection can need a new invitation. Code inspection corrected the deadline premise: host connection has a 30-second deadline, but requests use five minutes. Set `sessions.list` to 30 seconds; preserve five minutes for other operations. Refresh disables while in flight and permits retry after failure. Old grants stored at the root use the same origin and storage key at `/live/`; test this transition.

### Local host errors

Classify missing directory/socket and a refused private socket inside `controlRequest`, which all local control commands use. Preserve existing lstat ownership/mode checks, including rejection of symlinks. Only ENOENT during those lstat calls, or ECONNREFUSED/ENOENT after validated socket lookup, becomes the fixed host-unavailable error. ENOTDIR, EACCES and EPERM remain errors. No daemon protocol change is needed. CLI errors exit 1; no JSON output mode exists.

### QR image output

Add `p2pme invite --profiles codex --qr-file /absolute/private-directory/phone.png`. Generate the PNG locally with the existing qrcode dependency. Require an existing private parent directory owned by the current user. Exclusively create a mode-0600 file, refuse an existing file or symlink, and reject invalid paths before minting an invitation. Keep the file handle open until the image is complete. The new file is sensitive and must not be put in the repository. On a failed control request, close and remove only the newly reserved empty file. If an image write fails after the invitation exists, report the failure and retain the printed code/link as the recovery path; do not silently mint another invitation. The ordinary code/link/terminal output remains available without this flag. Tests decode the produced synthetic PNG and compare its URL. Use a 768-pixel image, a four-module quiet zone, and black on white. Remove only the reserved inode after a failed image write, including a partial PNG.

The skill uses a new private temporary directory for the image. It shows the PNG through the agent host's local image viewer, plus a clickable connection link and typed code. A terminal character grid alone does not meet this requirement. After the user confirms connection or expiry, remove only the created image and its empty temporary directory. The agent image viewer and physical scan remain unverified until the device check. It checks that the exact selected session is online before it issues the invitation. It never guesses a session ID or creates a replacement. The user has supplied the current Codex session ID separately for the subsequent device check.

### Verification boundaries

Add a consistency test for the browser setup prompt, guide and skill: the primary setup flow uses `invite`, image QR and `/live/`. Legacy `pair` may remain documented only as a separate compatibility path. Normal-load tests count WebSocket and RTCPeerConnection construction, including the homepage. Test the actual minified build through a static server that returns 404 for absent files. Use an app asset version query shared by both pages to avoid pairing a cached old script with new markup.

The smoke check used a 45-second browser outcome deadline and one attempt. Its host was a werift test peer, not the installed CLI. At 2026-10-14T10:42:42Z, a single synthetic same-machine Node22/werift-to-stock-Chromium check used the configured public Nostr/STUN defaults. It completed code authentication, grant creation, permanent connection and an empty session list. The check used fresh synthetic keys, no user invitation, provider session or personal data, and closed its resources. This diagnostic traffic is covered by Glen's direct request to investigate and fix the connection. A relay returned rate-limit notices; the other relay carried the successful exchange. The result is a pass for this topology, not proof of a phone connection or proof that Glen's original failure is fixed. Do not repeat public attempts to chase rate limits. Public-network checks are observational, not CI gates. Classify their result as pass, external-network failure or reproduced code defect. A final production-build test uses local relay fixtures and synthetic data.

After deployment, check `/live` on GitHub Pages itself. Local directory routing is not evidence for that redirect.

2026-10-14T11:07:05Z — Claude (`claude-sonnet-5-5`) returned SHIP for the 016 code snapshot `357a0e52584698a0fa928ed9f9f55859a9d17a09536811761d854031169f4a17`. This review covered the live page, fragment handling, fixed failure states, private PNG output, local control errors, instructions and tests. It found no blockers. It excluded the separate 017 transport fix and did not authorize a release. All 448 integrated checks passed, including the clean package check. The skill validator passed. A fresh skill walkthrough confirmed exact-session reuse, image display and the default grant without an extra approval prompt. This was a synthetic walkthrough, not a device test. A follow-up production QR-link test addresses the reviewer’s main test advice.

2026-10-14T11:12:14Z — Claude (`claude-sonnet-5-5`) returned SHIP with no blockers for the QR test follow-up snapshot `e0081ba22c704ba69e40e93901d52aea95e59a0b5190bb580fe67670aedb35b0`. Actual minified `/live/#pair` and root `/#pair` flows now use the real static routes and isolated build directories. Both cover the permanent host connection, session list, message, UI action and remembered-host reconnect. This resolves review advice about QR coverage, route fidelity and concurrent build writes. A later full run exposed a test assertion that read the session list before its reply arrived; the test now waits for the named session button. No product code changed after the first SHIP review.

2026-10-14T11:13:07Z — Claude (`claude-sonnet-5-5`) returned SHIP for the final test wait correction, `tests/browser-flow.test.ts` SHA256 `9e53a886f5316ef6c5144e64573c855f3ab5b7306b48e383a64de4af4d3acf64`. The wait requires the exact visible session button after reconnect. It does not retry the connection or suppress errors.

2026-10-14T11:13:33Z — The combined 016 and 017 tree passed typecheck, lint, formatting, 470 tests, production builds and the clean package test. Review manifest comparison confirms that production source matches the accepted snapshots. Later changes contain review records and the separately accepted test delta. GitHub checks, release and deployed `/live` verification remain pending the non-Mako PR checkpoint.
