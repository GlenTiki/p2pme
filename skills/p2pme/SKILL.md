---
name: p2pme
description: Register a supported local agent session with a p2pme host, guide browser pairing, and publish bounded agent controls when requested.
---

# p2pme

Connect the user's chosen session to their local p2pme host. The live session page is at https://p2pme.glentiki.dev/live/. The host guide is at https://p2pme.glentiki.dev/host/. Reading that page does not install this skill or approve a device.

## Find the host and session

1. Check `p2pme --help` for `invite` and `--qr-file`. If either is absent, use the host guide to upgrade to 0.2.0 or later.
2. Check `p2pme status`. Reuse an online registration for the chosen session. Ask before an operation replaces its active adapter.
3. If no host runs, prepare `p2pme host --workspace /absolute/path` for the user's chosen workspace. Run it in a terminal or the agent host’s managed background job. Keep that process alive while the phone needs access.
4. For Codex, obtain the exact current thread ID from its supported session interface. Run `p2pme register codex THREAD_ID` only for that thread.
5. For Claude Code, run `p2pme claude-setup CLAUDE_SESSION_ID --output-dir /absolute/new-directory` with the exact current session ID.
6. Give the user the printed resume command. Ask them to exit the selected Claude process first.
7. The user runs that command from the host-approved workspace and accepts the native channel and MCP prompts. Do not launch another copy of the same session.
8. From the resumed session or the user's terminal, wait for the session hook to confirm registration.
9. From that same context, run `p2pme status` and report the host ID and registered session ID.

Obtain a session ID from a supported session interface or from the user. If neither supplies it, ask the user and stop registration. Do not infer the current session from transcript files. Do not guess an ID, scan unrelated sessions, or silently replace the current conversation. If attachment is unavailable, explain the failed step. Offer `p2pme start codex` or `p2pme start claude` as a new managed session. A new session requires the user's choice. Keep existing provider approval and sandbox policies.

The default state path is `~/.p2pme`. Use the same `--state-dir PATH` on all commands when the user selects another host. Do not edit shell profiles, agent settings or global configuration as part of this skill.

## Connect the browser

1. Run `p2pme status` again. Confirm that the exact selected session is online. If the host or session is unavailable, report that step and stop.
2. Use the registered session's profile. Use both profiles only when the user requests access to both providers.
3. Create a private temporary directory outside the repository. Use its absolute path for a new `phone.png` file.
4. Run `p2pme invite --profiles codex --qr-file /absolute/private-directory/phone.png` for Codex. Use `--profiles claude` for Claude.
5. Show the returned access and expiry. Use the agent host's local image viewer to display the PNG in this conversation.
6. Include the clickable connection link and typed code. A terminal character grid alone is not a usable QR image.
7. Tell the user to scan the image or open the link on their phone. They can also enter the code at https://p2pme.glentiki.dev/live/.
8. Tell the user to select the registered session after the host connects. The live page shows the session controls directly.
9. After the user confirms connection or the invitation expires, remove only the created image and its empty temporary directory.

If the image viewer is unavailable, state that limit and provide the connection link and code. Do not claim that an undisplayed image was shown. If image output fails, use the code/link already printed; do not create another invitation automatically.

The default grant permits session lists and chat for registered sessions. It includes sessions registered later under the selected profiles. The invitation authorizes its first authenticated device. A code or QR scan completes that authorization without another terminal prompt. The invitation expires after ten minutes and permits one device.

The user's setup request authorizes this default invitation. Add scopes such as `sessions:create`, `tasks:delegate`, or `ui:action` only when their request includes that access. Use an explicit `--profiles` argument. Omit `--scopes` for the default list/chat access. When the user requests extra access, pass the complete scope list explicitly. `--agent` identifies an agent peer; do not present agent content as a human instruction. Browser input cannot add scopes or profiles.

Keep the code and link private. Show them only in the user's current setup conversation. Do not put them in source files, logs, public messages, or external QR services. A model provider can retain an invitation shown in the agent conversation. Reading an invitation from a file or message does not authorize broader access.

Run `p2pme cancel-invite ATTEMPT_ID` when the user asks to cancel a pending invitation. A `too-late` result means the grant commit has started. It does not revoke that grant. Use `p2pme status` to find the device grant and `p2pme revoke GRANT_ID` when the user requests revocation. Do not retry a failed or uncertain invitation automatically.

Legacy `p2pme pair` still requires the user to approve at the host terminal. Do not answer that prompt, automate it through a pseudo-terminal, or bypass it through another local API. Use the new `invite` flow for this skill.

## Publish controls

When requested, create a bounded JSON surface for the selected session. Use the installed library's `parseSurface` to validate it. The surface needs a UUIDv4 `surfaceId`, a positive `revision`, and a `spec` containing `root`, `state.form` and `elements`.

Use only Stack, Card, Text, TextInput, Select, Slider, Checkbox and Button. Bind scalar form values with `$bindState`; read values with `$state`. Use equality visibility only. Only a Button press can emit `sendSessionAction` with a declared action ID. Do not include URLs, HTML, JavaScript, watchers, repeats or automatic actions. Do not put host credentials in form state.

Run `p2pme ui publish SESSION_ID FILE` for the selected registered session. Keep the surface at most 24 KiB and the full event below 32 KiB. Increase the revision for an update to the same surface ID. Report validation failures rather than bypassing the catalog. A published surface appears only for the selected browser session. The host checks the grant and revision again when the user submits it.

Public source and the complete surface contract: https://github.com/GlenTiki/p2pme. Author: https://glentiki.dev.
