# Codex proxy WebSocket frames

## Intent and evidence

Glen could not connect his current Codex session through p2pme. A real initialize-only probe on installed Codex 0.162.1 timed out when the current adapter sent JSON lines through `codex app-server proxy`. At 2026-10-14T10:58:29Z, an otherwise equivalent probe completed initialization when it used HTTP WebSocket upgrade and JSON text frames. No thread was read, resumed or messaged in that probe.

The proxy forwards raw bytes to the running Unix control socket. The official protocol requires WebSocket framing there. Managed `app-server --stdio` uses JSON lines. The current adapter treats both as JSON lines, which is a reproducible attachment defect. This fix does not prove that every part of Glen's phone setup works.

## Minimal change and justification

1. Add a `JsonTransport` for `codex app-server proxy`, using the existing `ws` dependency over `Duplex.from` on the child pipes. This supplies the required HTTP upgrade and text frames without socket discovery or a new listener.
2. Use it only in `attachCodex`. Keep managed Codex and Claude transports on their existing JSON-line path. Preserve explicit injected transports and process spawners for tests.
3. Wait for the WebSocket open event before sending RPC data. Reject initialization on upgrade failure, timeout or child exit. Use a bounded handshake timeout and retain the RPC deadline. Reject pending sends on close.
4. Accept only JSON objects in text frames. Each RPC message is one text message without a trailing newline. Bound incoming and outgoing payloads to the existing one-MiB provider limit. Reject binary, malformed and oversized frames. Set `maxPayload` before reassembly. Disable redirects and compression. Use a fixed dummy WebSocket URL, no Origin header, and no user-supplied host or path. Drain child stderr without exposing it. This keeps current transport validation at the new seam.
5. Propagate a fixed failure to transport subscribers. Close the WebSocket and proxy child on detach or error; bound termination of an unresponsive child. Make close idempotent. Do not stop the running Codex daemon or change its settings.

The provider permission policy, exact thread ID, expected workspace, running-thread requirement, and `excludeTurns` resume remain unchanged. No provider message or tool action is part of verification. Do not silently start a replacement session.

## Acceptance criteria

1. A failing test demonstrates that plain JSON lines cannot complete a local WebSocket HTTP upgrade fixture through proxy pipes.
2. The corrected attached adapter passes initialize, exact thread read and exact resume through that fixture. The test validates framing rather than substituting an in-memory JSON transport.
3. Tests cover delayed open, child startup failure, invalid/binary/oversized frames, rejected upgrade or timeout, outgoing bound, and deterministic cleanup.
4. Existing managed Codex and Claude adapter tests remain unchanged and pass.
5. A real check can read only the supplied Codex thread metadata through the installed proxy. Use `includeTurns: false`. Record identity match, runtime status and workspace match without history or private content. If running and matched, and no approval or waiting flag is present, an attachment check can resume with `excludeTurns: true` and immediately detach; it sends no prompt. Otherwise skip the resume check.
6. Claude accepts the specification and final diff. All project quality gates pass before commit. The transport fix ships with the unreleased 0.2.0 host package and the matching live UI after the PR checkpoint.

## Out of scope

No TCP listener, new network service, direct socket-path discovery, transcript scan, provider approval change, model call, automatic replacement or edits to Codex configuration. The proxy's own socket selection remains the source of truth.

## Source

[Official Codex app-server protocol](https://learn.chatgpt.com/docs/app-server#protocol) distinguishes stdio JSON lines from Unix-socket WebSocket frames. Installed `codex app-server proxy --help` describes a raw byte proxy.

## Review record

2026-10-14T11:02:48Z — Claude (`claude-sonnet-5-5`) accepted the specification. Clarifications require pre-buffer payload limits, fixed URL and headers, drained stderr, no history reads, and no probe attachment during a pending approval. Code review remains required.

At 2026-10-14T10:59:54Z, the corrected WebSocket probe read only the supplied thread metadata. Its identity and workspace matched, but status was `notLoaded`. No resume or turn was sent. Glen was asked whether the session is open. The transport fix and this runtime state are separate findings.

Glen confirmed that he closed the session. Do not resume it for verification. The next device check needs a session that Glen opens and selects.

2026-10-14T11:12:14Z — Claude (`claude-sonnet-5-5`) returned SHIP with no blockers for snapshot `81adf0cd32d5d1a957acca1fd029485d1765d69700f02f1560be9e1104bf3678`. The review checked framing, resource ownership, failure races, payload limits, fixed errors and proxy-only cleanup. All 58 focused tests passed. The implementation owns its handshake timer because the WebSocket library’s timer requires TCP socket methods. It omits the HTTP agent option so Node uses the provided pipes. At 2026-10-14T11:08:33Z, the implemented transport initialized against installed Codex using its exact fixed URL. That check read no thread and sent no resume or turn. Criterion 5’s resume check is skipped because Glen closed the session. A real session and phone check remains outstanding.

2026-10-14T11:13:07Z — An offline schema check on installed Codex 0.162.1 found `ThreadResumeParams.excludeTurns` in both default and experimental schemas. The default schema requires only `threadId`. Its SHA256 is `948779cace55dda4384689a1627cd6675aa4782744bb5820cca16bfc0118586c`. This resolves the reviewer’s question about schema availability; it does not establish runtime resume success.
