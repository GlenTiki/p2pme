# Provider adapters

This slice implements the provider boundary for the host dispatcher. It adds Codex live attachment and managed creation, Claude managed creation, and a Claude MCP channel. The CLI installs and connects these adapters in a later slice.

## Contract

Adapters implement `SessionAdapter`. Constructors accept an injected JSON transport for tests. Production factories spawn the installed provider CLI with an argument array and no shell. Local profiles supply workspace, model and permission choices. Remote prompts travel through stdin. The adapters never accept remote process arguments, grant changes or tool approvals.

Each adapter permits one pending request. Output contains assistant text only. Reasoning, tools, subagent content and unrelated sessions stay local. Each output callback completes before submission completes, including after abort or failure. Provider frames are limited to 1 MiB. Codex pre-response notifications have a 256 KiB and 256-event limit. Each response has a 24 KiB JSON-encoded text limit. Small deltas coalesce until 512 bytes or 50 milliseconds for the first 32 emitted deltas. Later deltas flush at the byte threshold or completion. A response can emit at most 128 deltas. Process errors reject pending work. A detached adapter refuses later work. Abort closes a process adapter and stops its output. The host must attach or create it again. Channel abort ends only the pending request. Completed tool effects cannot be undone. Agent-origin prompts carry an explicit delegated-content label. The host controls request deadlines through AbortSignal. A provider that never completes occupies its slot until that signal or detach.

## Codex

Live attachment spawns `codex app-server proxy`, initializes the RPC connection, reads the selected running thread and resumes it without configuration overrides. A `notLoaded` thread is rejected. `turn/start` submits text with `clientUserMessageId`. This method can join an active turn. The adapter exposes live conversation semantics, not atomic idle-only execution. It waits for the matching user-message marker and returned turn ID before forwarding subsequent text deltas. It never forwards a completed item's full text, which can contain a prefix from earlier local work.

Attached sessions retain their provider configuration. Model configuration is unsupported. Attachment does not answer approval requests and does not interrupt a shared turn on abort. Closing the proxy does not terminate the shared provider session. Local approval routing across app-server clients needs a live integration check before claiming transparent approval behavior.

Managed creation spawns `codex app-server --stdio` and starts a thread from a local profile. The default sandbox is read-only and the default approval policy is untrusted. Both fields are sent explicitly. A local profile can select workspace-write and a supported approval policy. The model is optional. An omitted model preserves the provider configuration. An empty local model list disables remote model changes. Allowed profile model changes apply to the next submitted turn. Omitting a later model does not reset a previous change. Managed approval requests receive denial; unsupported server requests receive an RPC error. No adapter response grants tool access. Detach closes the owned process. The host records commands and results through its existing Hypercore boundary.

## Claude managed sessions

Creation spawns `claude --print --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --session-id UUID --permission-prompts none --permission-mode default`. The local profile supplies the workspace and optional model. Stdin remains open between turns. Each request writes a user JSON message. The adapter waits for the matching replayed user UUID before it forwards text. Session IDs are checked. Result messages end requests, not the process. A provider error or output failure closes the managed process before another request can start. Model changes are unsupported in this slice.

The provider's local permission rules and hooks still apply. `--permission-prompts none` denies unresolved requests, but does not remove existing allows. The adapter does not add bypass flags or permissions. Inference uses the user's existing provider account and can incur its normal charges. Tests do not run inference.

## Claude channel

The channel factory receives a fixed conversation registration generation and an injected notifier. It sends `notifications/claude/channel` with the request ID, session ID and sender kind. The reply tool accepts a bounded reply only for that pending request and generation. Notifications alone do not prove that Claude processed a prompt. The channel advertises `claude/channel`, but never `claude/channel/permission`.

The MCP setup uses stdio and the installed MCP SDK. The CLI must register the server and launch or resume Claude with its development-channel flag. Native user consent remains required. The CLI must install SessionStart and SessionEnd tracking and call `invalidate` when the conversation changes. A stale generation cannot submit or reply. SessionEnd cleanup cannot block a switch when the hook fails or times out. This adapter cannot independently observe that failure; managed sessions give a fixed process identity. No universal hot-attach or fail-closed hook guarantee is claimed.

## Acceptance

Tests cover exact process arguments, initialization, live thread checks, multi-turn managed input, correlation, ignored sensitive output, bounded frames, denied approvals, abort, detach, stale generations and callback ordering. Tests use injected transports and executable-free fake children. Static analysis, complexity, formatting, tests and SDK build pass. An independent Claude review receives only this project's specification, source and tests after user authorization.

## Sources

- [Codex app server](https://learn.chatgpt.com/docs/app-server)
- [Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Claude unattended permissions](https://code.claude.com/docs/en/headless#turn-off-permission-prompts-in-unattended-runs)
- [Claude channels](https://code.claude.com/docs/en/channels-reference)
- [Claude lifecycle hooks](https://code.claude.com/docs/en/hooks#sessionend)

## Review record

Claude `claude-sonnet-5-5` reviewed bundle `3b443c09b42f7d52a2b8e887de90dd15a7295d19f6310b107df839bb3ac57b71` and requested changes. Its blocking findings concerned callback drain on failure and inherited Codex permissions. The implementation now drains callbacks and sends explicit sandbox and approval defaults. It also labels channel agent content, handles collaborator and stderr failures, bounds and coalesces deltas, verifies resumed thread identity, accepts provider-owned thread IDs, and checks frame limits per line. Regression tests cover these changes. Claude `claude-sonnet-5-5` reviewed corrected bundle `485288ae0883a8bfa00f8c0c5436e93a4039f2c62adf8ce7168e1ee5daaf9a00` and confirmed both original blockers were resolved. It identified one new functional blocker: timer-driven small deltas could exhaust the event budget. The timer now stops after 32 emitted deltas, while byte-triggered and final flushes continue. A fake-timer regression covers a sustained stream. Claude `claude-sonnet-5-5` returned SHIP for bundle `962bd405f3bd0ef9cb0cbf1816e37218bea0d14b8a2b7f6dcb28d8278362ef6f`. It found no remaining blockers. Static review did not execute the tests or verify installed provider field names. The optional Codex model adjustment received SHIP for bundle `471d00048c80949f3d882806a4cf20f80e831c1fc329a6abc1911f3b5c549a70`. The final code revision extracted the same local validation into a helper to meet the complexity gate. Claude `claude-sonnet-5-5` returned SHIP for final bundle `a46bf49f7cfc70a21891352af303c95810363c2be313fb9fbd66a30f37c3e110`. The reviewer inspected pasted source, specification and tests; it did not independently verify the bundle digest. Local typecheck, lint, formatting, 84 tests and SDK build passed. Live provider inference and cross-client approval routing remain untested.
