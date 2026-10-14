# Copy the setup instruction from the host guide

## Intent

Glen asked for the host page to provide the instruction from step 2 of the phone test checkpoint. Put that instruction on `/host/` so users can copy it into their current agent session. This is a site change. Keep the published library at 0.2.0.

## Changes and justification

1. Add a labelled, readonly instruction field near the top of `/host/`, before the manual setup steps. This removes the need to find the instruction in a chat or release note.
2. Add a Copy instruction button and an accessible status message. Hide the button until its handler attaches. Keep manual-copy guidance visible without JavaScript.
3. Add a small `web/host.ts` entry for the clipboard action. Build it as `public/host.js`. Preserve the existing `public/app.js` output. The host page does not need the app, React, WASM or transport dependencies.
4. Copy only after a user click or keyboard activation. Report success after the clipboard write resolves. On failure, focus and select the instruction text. Show a fixed manual-copy message without the raw error.
5. Add a host-page CSP that permits only its same-origin script, stylesheet and images. Block network connections with `connect-src 'none'`. Use an external script and a versioned asset URL.

The instruction reads:

> Read https://p2pme.glentiki.dev/host/. Install or upgrade p2pme as the guide describes. Refresh this project’s p2pme skill from the installed package. Connect this agent session to my phone. Keep the local host running. Show a QR image, a clickable connection link, and a pairing code. Show the access level and expiry. Do not create another agent session.

The prompt refers to the guide’s install command to avoid another package version string. It asks for the current session and the default invitation. It grants no extra scope and changes no provider consent step. Existing Claude setup instructions remain available.

## Acceptance criteria

1. A user can read and select the instruction without JavaScript. The new field appears before the install, register and pair sections.
2. The production host page copies the exact visible instruction after a click or keyboard activation. It shows success only after the write completes.
3. Denied or unavailable clipboard access selects the text and shows a fixed manual-copy message. The failure does not expose exception text.
4. The host page starts no WebSocket or peer connection. Its bundle contains only the clipboard behaviour. The CSP permits the copy script and blocks connections.
5. Browser tests load the actual minified static output. Tests cover clipboard success, failure, no JavaScript, keyboard access and layout at phone and desktop widths.
6. The setup consistency test checks the host prompt against the existing image-QR flow. The original app output and live route remain valid.
7. Claude reviews the specification and final diff. Local gates and executed GitHub checks pass before deployment. Verify the deployed host page, copied text and live page after merge.

## Out of scope

No host process, session registration, invitation, clipboard read, background copy, package release, permission change or automatic connection. Reading or copying the page does not set up a host. Correct the file-copy example in the guide and README as part of the skill refresh instruction. This resolves issue #8 without changing the published package.

## Review record

2026-10-14T12:13:20Z — Claude (`claude-sonnet-5-5`) accepted the revised specification. The first review required explicit CSP delivery, no dead control without JavaScript, human/agent context and correct upgrade-copy instructions. The clarifications resolve those points. Final code review remains required. Glen’s autonomous release instruction applies to this follow-up in the same p2pme work.

## Review clarifications

The CSP is a meta element immediately after the charset and before any resource reference. Use `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'`. The page has no inline scripts, inline styles or web fonts. Its favicon is a same-origin image. Test normal loads for CSP violations and unexpected requests.

Keep the button hidden until its click handler exists. Without JavaScript, the field and manual-copy guidance remain visible, with no dead control. Add this page text outside the field: “Copy this instruction into your agent. Agents: follow the numbered setup steps below.” Explain that the instruction asks the agent to install p2pme, update the project skill and connect the selected session.

The HTML textarea is the single source of the copied text. Copy its value byte for byte. Call the clipboard API directly from the user gesture, without an earlier await. Clear old status first. Show success only after resolution. Select the full field on failure, including `setSelectionRange` for mobile browsers. Test a denied write, an unavailable API and a synchronous failure. Keep raw errors out of the status. Use `role="status"`.

The guide pins the valid 0.2.0 release URL. Replace folder-copy wording with explicit `SKILL.md` destinations for Codex and Claude. Use `mkdir -p` for the destination directory and copy only the packaged file. Apply the same correction to the README example for issue #8. Existing provider consent and session rules remain unchanged.

Use `/host.js?v=host-setup-1`, a site revision separate from the package version. A content-hashed HTML rewrite is unnecessary for this new file; the explicit asset revision serves the cache purpose without a new template mechanism. Check that this URL serves the built host entry. Check a small bundle bound and that no transport connections start. Permit the favicon in the normal-load request list.

At 320, 390 and 1440 pixels, check horizontal overflow and that the prompt precedes the manual steps. Ensure the copy button has a 44-pixel target. Check Enter and Space activation. Compare copied text with the field value. Check that the complete instruction remains available on phones, including manual selection.

The consistency check covers the QR image, connection link, code, access level, expiry and instruction to retain the current session. The existing skill defines those behaviours. Do not publish a new package, bump its version or add a package changelog entry. The PR and deployed site record this change. Deployed verification checks the CSP, asset response, exact copied text and unchanged live route.

## Final review and checks

2026-10-14T12:21:44Z — Claude (`claude-sonnet-5-5`) reviewed the complete changed files and diff against base `e3358f6ad22c06dda5e738d26f50bae3ed4c50de`. The reviewed file manifest has SHA-256 `07a93ee6962e6b4b5bab0a72cf65ec3292c1887fd62419908ff1810b5bc85784`. Verdict: SHIP. The review found no blockers. It checked the clipboard gesture, fixed failure message, manual copy, hidden control, CSP, build entries and skill commands. The reviewer did not execute tests. Optional test-strength and future module-scope suggestions do not change the accepted behaviour. The browser test uses the actual stylesheet and confirms the touch target.

The new consistency test failed before implementation because the instruction field did not exist. All local gates now pass: types, lint, format, 477 tests, both builds and the package smoke test. Browser checks cover click, Enter, Space, denied and unavailable clipboard access, synchronous errors, deferred success, no JavaScript, request destinations and widths of 320, 390 and 1440 pixels. The phone screenshot shows the complete instruction and copy control at 390 pixels. The host script is 454 bytes. GitHub checks and deployed verification remain release gates.
