# Persistent host and scoped session dispatcher

Status: accepted and implemented. This slice builds on [the signed log foundation](002-hypercore.md) and [the public app](003-public-app.md). It does not add a transport, CLI, provider process or browser renderer.

## Identity and authority

The host has a persistent UUID. Each daemon start creates a fresh `hostEpoch` UUID. A session keeps its UUID through a persisted `(provider, providerSessionId)` mapping. All sessions start offline. Only an explicit local attachment makes one available. The host does not discover other sessions or restore transcript logs.

A trusted transport calls `dispatch(grantId, request)`. The grant ID comes from its authenticated connection closure. Wire fields cannot choose a grant. A room secret authenticates possession of an approved device capability; it does not prove human authorship. An agent grant remains agent content. Profiles contain local provider and workspace choices. Remote requests can select approved profile and model IDs; they cannot supply commands, paths or permission modes.

## Local state

`openHostStore(directory)` loads or creates `host.json` in a mode-0700 directory. The mode-0600 file contains the host ID, approved grants and registered session metadata. Writes use a new mode-0600 file and atomic rename. Invalid persisted data fails closed. Mutations are serialised. An exclusive mode-0600 `host.lock` gives one store instance ownership until `close()`. A second opener fails closed. A stale lock needs manual recovery after the operator confirms its process has stopped. Each replacement file and its directory are synced before success. A maximum of 32 grants and 32 registered sessions bounds this state. Failed durable writes stop remote dispatch for that running host.

A grant contains `id`, `deviceId`, `principal` (`human-device` or `agent`), `label`, `roomId`, `roomSecret`, `createdAt`, `expiresAt`, `revokedAt`, `scopes`, `sessionAccess` (`registered` or an explicit UUID list), and `profileIds`. Timestamps use UTC seconds and `Z`; `revokedAt` can be null. Room secrets use 256-bit base64url values. All grant management is local. Revocation blocks memory access first, then persists the change, then closes the transport through an injected callback. A persistence failure still closes the connection and makes the host reject all requests.

Profiles are injected at daemon startup. A profile supplies a stable ID, provider, allowed model IDs, a default model ID and an adapter factory. Workspace and host permissions stay in this local factory closure. The store persists profile IDs, not executable configuration. The CLI can inspect the store and add grants through local methods. The remote protocol has no grant-management operation.

## Request and response contract

A request has exactly `version: 1`, `id`, `hostId`, `hostEpoch`, `op` and `args`. All IDs are UUIDs. Frames have a 32 KiB UTF-8 limit. Unknown fields fail validation. Request IDs are remembered per grant for the current epoch, with a 2,048-request cap. A duplicate ID is rejected and never runs again. Restart changes the epoch and invalidates old commands. No persisted log is replayed into execution.

| Operation            | Arguments                                            | Required scope       |
| -------------------- | ---------------------------------------------------- | -------------------- |
| `sessions.list`      | `{}`                                                 | `sessions:list`      |
| `sessions.chat`      | `{sessionId, text}`                                  | `sessions:chat`      |
| `sessions.create`    | `{profileId, label}`                                 | `sessions:create`    |
| `sessions.configure` | `{sessionId, patch: {label?, modelId?}}`             | `sessions:configure` |
| `tasks.delegate`     | `{sessionId, text}`                                  | `tasks:delegate`     |
| `ui.action`          | `{sessionId, surfaceId, revision, actionId, values}` | `ui:action`          |

Text has an 8 KiB UTF-8 limit. Labels have at most 100 characters. Model and profile IDs have at most 100 characters. Configure requires at least one field and rejects unknown fields. UI values are a bounded JSON object. The [surface registry](008-host-surfaces.md) validates each UI action before adapter submission.

Responses contain `version`, `id`, `hostId`, `hostEpoch`, `replyTo`, `ok` and either `result` or `{code, message}` in `error`. They use the same 32 KiB frame bound. A list returns only registered sessions visible under both the grant's session access and profile IDs. It includes an `online` field. A create returns the registered session. A configure returns its updated metadata. Text turns return a completed receipt; adapter events carry correlated delta/completed envelopes through an injected output callback.

## Dispatcher and adapters

`createHost({store, profiles, logFactory?, onRevoke?})` creates the epoch, ephemeral control logs and an empty attachment registry. A local `attach` registers the provider session mapping and an adapter. Attachments serialize identity lookup and reserve the session through persistence and replacement. Every rejected attachment detaches its incoming adapter. `sessions()` returns local session status. `detach(sessionId, adapter)` checks the current adapter identity, marks the session offline, aborts its active request and detaches it without deleting the stable mapping. The factory can also create a session through an approved profile. Session creation is serialised. A provider ID already registered in that provider is rejected; creation cannot acquire access to an existing session. If a grant has an explicit session list, successful creation adds the new session to that list in the same durable state update. A late create result after revocation is detached and does not become remotely available.

Adapters implement `submit({id, text, kind, principal, signal}, emit)`, `configure({modelId})` and `detach()`. `kind` distinguishes chat from a delegated task. `principal` preserves the local grant's human-device or agent designation. A completed output must correlate to the submitted request. Adapter events have bounded text. A configured model must belong to the local profile. Labels are host metadata. A failed configure does not publish changed metadata. If the provider changed but the store write failed, remote dispatch stops; the host does not claim a rollback of an external provider state.

Each session permits one active operation. A second chat, task or configure returns `busy`. No hidden queue retries a command. The dispatcher checks the grant, epoch, scope, session access and online attachment before side effects. It appends a validated command to the appropriate ingress Hypercore before invoking an adapter. It checks revocation again after append. It appends each result to the egress Hypercore before output. If append fails, the corresponding invocation or output does not occur. Output and final receipts check the current grant again. Revoke aborts active operations and suppresses late output. The host rejects expiry in the same way before dispatch and output.

Control operations use ephemeral logs bound to the epoch. Session operations use ephemeral logs bound to that session ID. Local log failures do not create a successful receipt. A rejected output also fails the turn when an adapter catches that rejection. An output checks its active request again after append, so a late append cannot emit into a later turn. Provider failures become bounded error receipts. A request is consumed once it passes authority checks; failures are not automatically retried. The caller may choose a new request ID after it inspects the error. The default log implementation retains the 2,048-entry limit from the foundation spec.

Each log factory returns fresh, empty logs. The host counts pending appends against each log's 2,048-entry limit. Before an operation, it requires one ingress slot and reserves one egress slot for the final receipt. Chat, task and UI action requests also require one output slot immediately before provider invocation. Concurrent publications cannot use the reserved receipt slot. Arbitrary adapters can still exceed the remaining output capacity during a turn.

Any append failure or capacity refusal makes that log pair unavailable until host restart and aborts its active operation. Later operations on the pair return `log_unavailable` before any provider invocation. Reattachment does not reset this state. The host does not rotate or discard logs. An interrupted request may already have run in the provider. The caller must inspect the session before any retry; cancellation cannot reverse provider actions.

## Acceptance criteria

1. Tests reject missing scope, a wrong host or epoch, cross-session access, an unregistered or offline session, revocation, expiry and replay.
2. Tests prove that a busy session does not start a second operation and that delegation needs its own grant.
3. Tests prove that ingress append precedes provider invocation and egress append precedes every output. An append failure suppresses the corresponding side effect.
4. Create uses only a local approved profile. Configure validates model IDs. Failures do not publish successful metadata changes.
5. Persistent IDs, grants and mappings survive reopen. Sessions remain offline until local attachment. State files have the specified modes and malformed state fails closed.
6. Adapter tests use injected fakes. No tests launch a real agent or connect to a public network.
7. Strict types, complexity at most 10, formatting and the full applicable test suite pass.

## Out of scope

This slice excludes transport authentication, pairing UI, provider subprocesses, tool approval RPC, agent discovery, billing, a reactive renderer and remote grant edits. The next UI slice must validate a closed catalog of Text, Stack, Card, TextInput, Select, Slider, Checkbox and Button. It must bound depth and node count and reject code, watchers and unknown components before a surface can accept an action.

## Review record

Glen approved project-only Claude review. Claude `claude-sonnet-5-5` reviewed revision digest `372736d7a70c9ef084ab35ad0cf99e39584183eb505e1525fa5ff8a733bd20a4` and requested changes. Tests reproduced four findings: provider identity collision during create, swallowed output failure, rejected attachment cleanup, and concurrent store ownership. The implementation corrects these findings. A local independent review also identified attachment reservation, shutdown and stale output races; regression tests cover each.

Claude `claude-sonnet-5-5` accepted corrected revision digest `b13a6d2cd27bdeaacc20bea8e2a812ceb0bd5eef1d398b409b69ab0cdc70b3b9` with no blockers. The reviewed bundle contains specs 002/004, complete source and tests, package declarations, and TypeScript configuration. The final correction also rejects an attach/create mapping race inside the store transaction and drains every submitted output before the final receipt. The reviewer inspected supplied source; local checks execute separately.

Claude `claude-sonnet-5-5` accepted the capacity correction at digest `593c914fc2f3af391dbbeec4c1f15c80aa9e915e08b85c2d925f2eec3060de45`. The reviewed bundle contains the host, log guard, dependencies, tests, specs 004/008 and the diff from `bad5f6e`. Tests first reproduced repeated provider invocation after exhaustion and after a surface append failure. The correction reserves receipt capacity, counts pending writes and makes any failed pair unavailable until restart. All 281 tests, the isolated package smoke test, types, lint, formatting and builds pass. The reviewer inspected source and did not execute tests.
