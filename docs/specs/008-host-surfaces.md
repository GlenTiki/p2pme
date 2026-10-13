# Session surfaces

A local agent can publish one current surface for a registered session. The host validates the bounded component catalog before it records or sends the surface. A surface contains data, not executable code. Each replacement has a greater revision. The host discards current surfaces at restart or adapter replacement. The publishSurface method is a local administrative API. Local callers and processes under the same user account remain trusted. Adapter replacement invalidates an in-flight publication but does not revoke local control of the daemon. The host does not give this controller to remote peers.

The host records each ui.render envelope in that session's Hypercore output log before it makes the surface current. Publication is serial per session. Failed writes preserve the previous surface. The host sends updates only to active grants with sessions:list and access to that session. The browser accepts ui.render from its authenticated host channel and renders it only for the selected session. The browser also requests ui.get when the user selects a session. This operation requires sessions:list and returns the current surface or null. An offline session returns an offline error. A read does not acquire the session execution lock or append a command record. It still consumes one bounded request ID.

A button sends ui.action with the session ID, surface ID, revision, action ID, and current form values. The host requires ui:action and access to that session. The registry rejects stale revisions, unknown actions, hidden buttons, altered fields, and invalid values. The host records each authorised request before registry validation. Rejected surface actions also remain in the audit log. The host submits a structured UI action message with the host-assigned ui-action kind to the session adapter. The adapter keeps the normal provider permission rules. No surface can grant tools or change host grants.

The host checks authorisation after each durable write and before output. Remote actions do not run on historical replay. An action that is accepted before a newer revision remains an accepted agent input. It does not automatically repeat.

## Acceptance

1. A failed output log write preserves the previous surface.
2. Concurrent publications retain revision order and reject stale replacements.
3. A client cannot act on another surface, revision, action, hidden button, or altered form schema.
4. A valid action reaches the selected adapter once through the normal host request path.
5. Session changes and disconnect remove the browser view. Adapter replacement invalidates old actions; the browser removes old controls on its next refresh. Revocation removes remote grant authority.
6. Real browser controls receive a host surface and return typed values over WebRTC.

Arbitrary HTML, scripts, remote component imports, and automatic form submission remain outside this release.

Each surface is limited to 24 KiB. The remaining frame space holds protocol metadata. Input components can change their bound form fields. Other fields retain their published values. Provider text labels identify UI actions but do not replace native tool permissions or prevent model prompt injection.

A local administrative caller can publish a new surface after an adapter replacement. That surface is not proof that the current adapter authored it. Visibility that depends on editable form state is a user interface rule, not an authority check. Host grants and native provider permissions remain the authority checks.

## Review record

Claude Sonnet 5.5 accepted the final integration snapshot with SHA256 `99cf908db43827bc306ebcab2de2284b894a0cca34711db044c8e02e0b380809`. The digest covers sorted file paths and contents, with a NUL after each path and content. The snapshot includes this specification before the review record, the surface registry and tests, the corrected host and protocol dependencies, and the browser render path. Claude inspected the source; it did not run tests. The implementer ran 12 surface tests, strict types, and lint.

Earlier findings required immutable fields without an input control, a distinct ui-action adapter kind, and an explicit local administrative trust boundary. The revision contains those changes. The final host integration uses the same output drain and error retention for chat, task and UI actions. A regression test proves that an adapter cannot hide a failed UI action output write.

The surface catalog and browser renderer have separate review evidence in specs 006 and 007. The browser test covers real Chromium, local relay discovery, approved pairing, a permanent connection, a published surface, and a typed action received by the host adapter.
