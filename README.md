# p2pme

**Connect agents. Control the work.**

A Hypercore library for local agent sessions. A browser app for people.

p2pme connects approved native peers through signed message logs. Its local host exposes selected agent sessions to an approved browser. Agents can supply bounded reactive controls. People can send messages, submit those controls and delegate tasks within the host's grant.

[Open live sessions](https://p2pme.glentiki.dev/live/) · [Set up a host](https://p2pme.glentiki.dev/host/) · [Meet Glen Keane](https://glentiki.dev)

This is an early personal project by Glen Keane. Glen builds developer tools and agent integrations. The chat app demonstrates the library. The library also supports agent-to-agent workflows.

## Install

Use Node.js 22 or later. The local host supports macOS and Linux. Install and authenticate the provider CLI you intend to use.

Install the package from a GitHub release tarball. Run this command after `v0.2.0` appears in [GitHub releases](https://github.com/GlenTiki/p2pme/releases):

```sh
npm install --global https://github.com/GlenTiki/p2pme/releases/download/v0.2.0/glentiki-p2pme-0.2.0.tgz
```

After an upgrade, restart the local host and register the selected sessions again. Existing device grants remain in the host state.

For a library dependency, omit `--global`. The package name is `@glentiki/p2pme`. This project does not require an npm registry login.

To build from source:

```sh
git clone https://github.com/GlenTiki/p2pme.git
cd p2pme
npm ci
npx playwright install chromium
npm run check
npm link
```

## Connect a phone

1. Give your local agent this instruction: “Read https://p2pme.glentiki.dev/host/ and use p2pme to connect this session to my phone.”
2. The agent prepares the host, registers the selected session, and returns a code, link, and QR image.
3. Scan the displayed image, open its connection link, or enter the code at [p2pme.glentiki.dev/live](https://p2pme.glentiki.dev/live/).
4. Select a session from the connected host.

For manual setup, start `p2pme host --workspace /absolute/path/to/project`. Register an existing supported session or create one with `p2pme start codex` or `p2pme start claude`. Run `p2pme status` to confirm that the selected session is online. Run `p2pme invite --profiles codex` in another terminal. Use `--profiles claude` for Claude or `--profiles codex,claude` for both. Keep the host process alive.

For a QR image that an agent can display, create a private temporary directory and a new file:

```sh
qr_dir="$(mktemp -d)"
p2pme invite --profiles codex --qr-file "$qr_dir/phone.png"
```

Show the PNG in your agent's image viewer. Keep the connection link and code available as alternatives. The PNG contains device access; remove it after connection or expiry. The command refuses existing files and non-private directories. It generates the image locally.

Creating an invitation authorizes one device for the displayed access. The code or QR link completes pairing without another terminal prompt. Invitations expire after ten minutes. A failed code attempt leaves the QR link available. Request a new invitation explicitly if needed.

The browser offers session creation only after the connected host supplies approved contexts. This requires the `sessions:create` grant. Context discovery is available from host version 0.1.1; code and QR setup requires version 0.2.0. The same grant permits context discovery. Older hosts still support session lists and chat.

The default grant permits session lists and chat. It expires after 30 days. It covers sessions registered on that host, including sessions registered later. The local invitation command shows the exact access. Extra scopes require your instruction.

Select **Remember host** during setup or after the verified connection to store this device's access in the browser. Later visits require an explicit **Connect**. **Forget** removes the browser copy. Run `p2pme revoke GRANT_ID` to revoke access at the host. `p2pme status` lists grant IDs without secrets.

The default state directory is `~/.p2pme`. Each command accepts `--state-dir /absolute/path` for a separate host. Keep that directory private. Stop a foreground host with Ctrl-C. An agent can also use its managed background job.

A crash or forced termination can leave `host.lock` and `control.sock` in the state directory. The host refuses automatic removal because another process could still own them.

1. Confirm that every host process that uses that state directory has stopped.
2. Remove only `host.lock` and `control.sock` from that directory.
3. Start the host again with the same workspace and state directory.

Keep `host.json` and `daemon.json`; they hold the identity, grants and workspace policy. A changed workspace identity needs a separate state directory and new device access.

## Use your current agent session

A skill guides setup. It does not inject messages into arbitrary processes. Automated tests use simulated providers; live CLI compatibility remains [an explicit verification task](https://github.com/GlenTiki/p2pme/issues/2).

The app shows replies to remote requests. It does not mirror unrelated local turns or prior transcript history. [Transcript observation](https://github.com/GlenTiki/p2pme/issues/1) is a separate read capability. Provider APIs deliver remote input; editing a transcript file is not a supported write path.

For an existing Codex thread, run `p2pme register codex THREAD_ID`. Supply the exact thread ID from the supported session interface. An attachment failure remains an error. The command does not silently replace the session.

For Claude Code, prepare the native Channel bridge with the exact session ID:

```sh
p2pme claude-setup CLAUDE_SESSION_ID --output-dir /absolute/new-directory
```

The command writes separate MCP and hook settings files. It prints a `claude --resume` command with those files and the development channel flag. Exit the selected Claude process first. Run the printed command from the host-approved workspace and accept the native channel and MCP prompts. Do not run two copies of the same session. The hook must confirm the expected session before the host exposes it. A received session-end or mismatch hook invalidates the registration. Create a new setup after a session switch. This command does not edit your existing settings or launch Claude. Native Channels remain experimental. If a lifecycle hook fails or times out, an old channel can persist until its socket closes. `p2pme start claude` creates a separate managed session with a fixed process identity.

The package contains [the p2pme skill](skills/p2pme/SKILL.md). Copy its folder into the project where you want to use it:

```sh
mkdir -p .agents/skills
cp -R "$(npm root --global)/@glentiki/p2pme/skills/p2pme" .agents/skills/p2pme
```

Codex loads `.agents/skills/p2pme/SKILL.md`. Invoke `$p2pme` or select the skill in its skill menu. Claude Code loads `.claude/skills/p2pme/SKILL.md`; use the same copy command with `.claude/skills`, then invoke `/p2pme`. These paths follow the [Codex skill guide](https://learn.chatgpt.com/docs/build-skills) and [Claude Code skill guide](https://code.claude.com/docs/en/skills). The site also serves [plain agent instructions](https://p2pme.glentiki.dev/skill.md).

## Create, delegate and submit controls

A local user can select extra scopes when they create an invitation:

```sh
p2pme invite --scopes sessions:list,sessions:chat,sessions:create,tasks:delegate,ui:action --profiles codex,claude
```

Review the displayed access before sharing the code or link. Browser controls do not grant their own permissions. A missing scope produces a visible error.

The host fixes each provider profile's workspace and permission policy. Remote callers cannot change executable paths, arguments or environment variables. The initial profiles use `provider-default` as metadata and retain the provider's configured model. Their remote model allowlists are empty. The browser's **Delegate task** option applies to one message and then resets.

An agent can publish a surface with `p2pme ui publish SESSION_ID FILE`. The JSON file names a UUIDv4 surface ID, a positive revision and a bounded component tree. The browser fetches the selected session's surface and accepts later updates from that host. A button sends `sessionId`, `surfaceId`, `revision`, `actionId` and current form values. The host checks the registered surface and grant before dispatch.

The catalog contains Stack, Card, Text, TextInput, Select, Slider, Checkbox and Button. State changes can update text and show a conditional section. Surfaces cannot run JavaScript, fetch URLs, inject HTML or send automatic actions. See the [surface contract](https://github.com/GlenTiki/p2pme/blob/main/docs/specs/006-agent-ui.md). The site's local demo uses the same renderer and never contacts an agent.

## Use the library

The root entry exports protocol and surface validation. `@glentiki/p2pme/node` adds logs, native peers, local hosts and provider adapters. `@glentiki/p2pme/browser` exports browser pairing and host connection APIs. Each entry includes TypeScript declarations. Browser bundles include their dependencies; Node bundles use installed dependencies. Handle validation errors at each boundary instead of comparing validator error classes across entry points.

```js
import { randomUUID } from "node:crypto";
import { createEnvelope, createSessionLog } from "@glentiki/p2pme/node";

const sessionId = randomUUID();
const log = await createSessionLog({ sessionId });
try {
  await log.append(
    createEnvelope(sessionId, "chat.send", { text: "Hello, peer" }),
  );
  console.log(await log.get(0));
} finally {
  await log.close();
}
```

`offerHostPairing` creates a host invitation. `joinHostPairing` accepts its code or decoded QR invitation. The host supplies the authorization and persistence callbacks; browser input cannot select its own grant. See the [host invitation contract](docs/specs/015-host-first-pairing.md) for the public types, cancellation boundary, and authentication protocol. Legacy `beginPairing` and `approvePairing` remain available.

`connectAgentPeer` takes a local Noise key pair, an outgoing log and an approved remote descriptor. The descriptor contains the session ID, Noise public key and log public key. Exchange it through a trusted channel. Native peers reject other Noise keys and verify signed log entries.

Run `npm run example:native` from a source checkout for a complete two-peer exchange. The example uses a local test DHT and synthetic messages.

## Architecture and limits

| Part                  | Role                                                          |
| --------------------- | ------------------------------------------------------------- |
| Hypercore             | Signed, bounded, single-writer session logs                   |
| Hyperswarm            | Approved native agent peer connections                        |
| Local host            | Session registry, provider adapters, grants and action checks |
| Trystero and WebRTC   | Browser-to-host peer connection                               |
| React and json-render | Fixed component catalog for agent controls                    |
| Static site           | App, project information and agent instructions               |

The browser does not run Hyperswarm. The host bridges browser requests into the selected local adapter. Browser device grants and native Noise peer descriptors are separate access mechanisms.

Messages are at most 8 KiB. Surfaces are at most 24 KiB. Protocol frames are at most 32 KiB, including the surface envelope. A session log permits 2,048 entries. The host bounds its session and device lists. A host restart creates a new epoch; the client does not retry pending actions automatically. A timed-out action may have run. Session-list requests stop after 30 seconds and can be refreshed. Other host requests and the native Claude reply wait end after five minutes. A timeout or cancel stops the wait; Claude can still act on a delivered notification.

When a log fills or fails, the host rejects further operations that use it. Restart the host to open fresh logs. The last request may already have reached the provider; inspect the session before you retry.

Session logs use temporary local directories and remove them on clean close. They are not a transcript archive. The host persists its identity, session metadata and grants. A host restart does not automatically attach old provider sessions. Register or start the required session again.

The local daemon uses a private Unix socket. Local processes under your user account remain trusted. Remote text stays subject to the provider's tool and file permissions. Chat and task grants can invoke that session's existing tools and return local file content. Pair only devices that you trust to submit prompts to that workspace.

## Privacy and cost

The static app has no account system, analytics, external fonts or hosted chat backend. Ordinary page loads do not join a peer network. **Connect** and a valid QR invitation link start discovery. A host restart restores its active approved peer rooms.

Public Nostr relays at `nos.lol` and `relay.damus.io` carry discovery offers. The code bootstrap uses public room credentials and OPAQUE password authentication. Grant exchange uses a separate room with a strong secret. QR invitations use a random 256-bit secret. Google and Cloudflare STUN servers help establish connections. These services can observe connection metadata. Peer traffic uses WebRTC transport encryption. An invitation and a stored device grant contain access secrets; do not publish them. The generic setup instruction contains no invitation. An invitation returned in an agent conversation can reach its model provider.

`p2pme cancel-invite ATTEMPT_ID` cancels a pending invitation. Once the grant commit starts, it returns `too-late`; use the grant revocation command to remove access. The legacy `pair` command and its terminal approval remain available for existing integrations.

A remembered grant is readable by scripts on the site's origin. The browser stores no transcript in local storage. Browser extensions and other software on the device remain outside this boundary. Model providers receive the prompts and context their local adapters submit under your existing account.

Static files can use GitHub Pages or Cloudflare Pages without an operated application server. Hosting plans, domains, model usage and relay services have their own limits and costs. Restrictive networks can prevent direct WebRTC connections. An operator-supplied TURN relay can add cost. The app makes no universal connection or zero-cost guarantee.

## Develop and publish

`npm run check` runs types, lint, format checks, tests, production builds and a clean package installation. Peer tests use local sockets. The package smoke test installs a local tarball and fetches dependencies from the public npm registry. Direct dependencies use exact versions; tarball consumers resolve transitive ranges. Run `npm run build` before a standalone `npm run test:package`. It imports the installed entries, runs CLI help and checks a browser bundle in Chromium. `npm run build` writes the library to `dist/` and the static site to `public/`. The build copies the packaged skill to `public/skill.md`. `npm pack` builds fresh artifacts through `prepack`.

To opt into the local pre-commit check, run `git config --local core.hooksPath .githooks`. Installation never changes that setting. Read [CONTRIBUTING.md](https://github.com/GlenTiki/p2pme/blob/main/CONTRIBUTING.md), [SECURITY.md](https://github.com/GlenTiki/p2pme/blob/main/SECURITY.md) and the [code of conduct](https://github.com/GlenTiki/p2pme/blob/main/CODE_OF_CONDUCT.md).

GitHub Actions checks pull requests. The Pages workflow builds and uploads only `public/` on `main`, then deploys through the `github-pages` environment. Enable GitHub Pages with Actions as its source. Configure `p2pme.glentiki.dev` as a custom domain and verify DNS before advertising the site. A project URL under `/p2pme/` needs a base-path change because this app uses root-relative links. Cloudflare Pages can use the same build command and output directory.

A `v0.2.0` tag must match package version `0.2.0`. The release workflow runs all checks, packs the package and attaches its tarball to the GitHub release. It does not publish to npm. See [CHANGELOG.md](https://github.com/GlenTiki/p2pme/blob/main/CHANGELOG.md) for release changes.

MIT © Glen Keane. [More projects and contact](https://glentiki.dev).
