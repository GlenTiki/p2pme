# Host session contexts

## Intent

The browser offers session creation only after it connects to a host. The host supplies the available session contexts. A context is a local host profile. Its create function controls the provider and workspace. The browser must not invent providers or select arbitrary local paths.

## Contract

Add `profiles.list` to the authenticated host protocol. It requires `sessions:create`. The result contains `profiles`, with at most 32 entries. Each entry contains `id` and `provider`. Return only profiles in the device grant that have a local create function. Do not return local paths, model configuration, or adapter internals. Existing creation checks remain authoritative.

Handle discovery after grant, epoch, scope, and replay checks, before the host operation lock and log. Match the existing `ui.get` read path. Add the operation to `authorizeTarget` and exclude it from the session-target request type. Discovery consumes one replay-budget slot, as other requests do.

Use the distinct profile IDs from the grant, in grant order. Resolve each ID with the same first-match lookup as session creation. Exclude missing profiles, profiles without a create function, and descriptors that fail the shared strict schema. The descriptor schema accepts only `id` and `provider`, each a string of 1–100 characters. The grant bounds the result to 32 distinct entries. Do not change local configuration validation.

The browser requests profiles after the connection succeeds. The creation section stays hidden and its controls stay disabled until a valid nonempty response arrives. The select contains only host-supplied profiles. Use the profile ID and provider as the visible context label. Clear the previous selection, session name, and profiles on disconnect. A late response from a previous connection cannot restore them. The Refresh button reruns both session and profile discovery as one cycle. Capture the current profile selection, then clear the accepted choices at the start of that cycle. Use the existing connection generation and refresh sequence for both reads. Only the latest cycle may publish results or errors. A selected profile survives a refresh only if the host still returns it. This deliberately discards an older profile response when a newer refresh starts.

Once a create request has been sent, a refresh does not undo it or resend it. The pending-request guard remains active until completion. A removed profile cannot be used for a later submit. Close the expanded form on disconnect. The existing hidden attribute must remain effective under the stylesheet.

Catch discovery rejection inside the discovery method; do not propagate it into connection establishment or session refresh. An `ok:false` host reply rejects only its request in `HostClient.request`; it does not disconnect the transport. If discovery fails, the creation section remains unavailable and a status explains that session creation is unavailable. Session lists and chat remain usable. This includes an old host that does not support the new request, and a grant without session creation permission. Never substitute Codex or Claude defaults. Validate the whole response before rendering entries as text. Reject unknown response fields, unknown entry fields, duplicate IDs, malformed entries, or more than 32 entries. Any invalid entry rejects the whole response. Accept arbitrary valid host provider names; there is no provider allowlist in the browser. A submitted profile must still be in the latest accepted list.

## Acceptance criteria

1. The initial HTML has no provider options and hides the creation section before JavaScript starts.
2. Pairing, connection setup, and profile discovery do not expose session creation.
3. A connected host with approved profiles supplies all creation choices. A host with no choices leaves creation unavailable.
4. Disconnect clears the form. Delayed discovery cannot populate another connection or reverse a newer refresh.
5. Responses with unknown fields, duplicate IDs, oversized lists, or malformed profiles cannot enable creation. Discovery failure does not disable existing session chat.
6. The host excludes unapproved and non-creatable profiles and enforces the creation scope for discovery.
7. Regression tests fail before the implementation. All repository gates pass afterward. An independent Claude review accepts the final diff.

## Minimal change and rejected alternatives

The static form must hide until host data arrives; disabling only its submit button leaves unsupported choices visible. The host needs a discovery operation because session metadata cannot describe profiles with no existing sessions. A separate operation preserves the released client's strict `sessions.list` response parser. Host filtering and strict browser parsing prevent unapproved or malformed contexts from entering the selector. Connection and refresh tokens prevent stale responses from restoring old contexts.

Do not add profiles to the existing session-list response. Do not derive profiles from saved browser grants, existing sessions, or a fixed provider list. Do not change grant semantics, workspace policy, provider behavior, or host persistence.

## Scope and release

This change covers host profile discovery and the browser creation form. It does not add new provider profiles or multi-workspace selection. Publish the updated host library before the browser deployment. Existing installed hosts need that library before they can advertise contexts. Old hosts still support session lists and chat. Their browser shows the creation-unavailable status.

## Review record

The first Claude review requested explicit dispatch, validation, failure isolation, and refresh behavior. The revised contract addresses those points. It uses one refresh token for the entire refresh cycle; separate tokens would allow an obsolete cycle to restore choices. A pending create request is not cancelled by profile discovery because it may already have executed. Claude Sonnet 5.5 (`claude-sonnet-5-5`) accepted the revised specification on 2026-10-14T08:25:19Z. Review packet SHA-256: `eb7cc2b4082c93e5a149d6c0545384ba2a2155e9dca0ea6bfa50768865fd4d51`. The reviewer inspected source and did not execute tests.

Claude Sonnet 5.5 (`claude-sonnet-5-5`) accepted the corrected implementation on 2026-10-14T08:37:35Z. Verdict: SHIP. Reviewed source digest: `a4a7c61db524cbc54e16579cf4b023bc92abe44f83a80494c8e16b12467dca84`. Hash order: `src/host-protocol.ts`, `src/host-types.ts`, `src/host.ts`, `src/host-client.ts`, `web/browser-app.ts`, `web/browser-view.ts`, `public/index.html`, `public/styles.css`, `tests/browser-app.test.ts`, `tests/host.test.ts`. Hash each UTF-8 path, NUL, exact bytes, and NUL. The review record is outside the digest.

The reviewer inspected source only. It required the failed-refresh status fix and evidence that hidden controls remain hidden under the stylesheet. Both findings were resolved. Browser QA also found long-context clipping; the select now fits its panel. Regression tests first reproduced both the original behavior and the failed-refresh status. All 314 tests and the clean package test passed. Types, lint, formatting, and builds passed. Chromium checked desktop and phone layouts, including JavaScript disabled, pending discovery, custom contexts, failures, and disconnect. No public discovery ran during QA.

Claude Sonnet 5.5 accepted the 0.1.1 package metadata and installation text on 2026-10-14T08:41:00Z. Release review packet SHA-256: `9d9b846b37e64da536b34d15904f8ad33e2a562bdd3d7771163030cbaa739728`. Publish the tagged host package after PR checks pass and before the merge deploys Pages. No dependency or package script changed.
