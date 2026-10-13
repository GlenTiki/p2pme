# Public project and distribution

## Intent

Publish p2pme as an installable library with a working personal chat example. Present Glen Keane as the author and link his website. Keep the public site static. Document the network and provider costs without a zero-cost guarantee.

## Scope

The README describes the library, host commands, supported provider paths, browser grants, generated surfaces, privacy and limits. The repository includes contribution, security and conduct policies. A packaged `skills/p2pme/SKILL.md` guides an agent through host and session setup. The site build copies that file to `/skill.md`. The skill cannot approve its own device, change provider settings or infer a current session ID.

CI runs the full check on pull requests and pushes. Actions use immutable commit references and read-only permissions by default. Pages uploads only `public/` after the check passes. A version tag runs the same check, verifies the package version, and attaches the package tarball to a GitHub release. It does not publish to npm. The release job has write permission only for repository content. Local hooks are opt-in and run the same check. Installation does not alter Git hooks or user configuration.

The browser fetches `ui.get` for the selected session and during explicit refresh. It handles authenticated `ui.render` events. It ignores results from a previous connection or selection, older revisions, and pending fetch results superseded by a live surface. An invalid surface preserves the current valid surface and shows a fixed local error. A null surface clears controls only if no newer result has arrived. Only a user button press sends `ui.action`.

## Acceptance criteria

1. Tests prove fetch, live delivery, stale-result rejection, session isolation and invalid-surface behavior.
2. Documented command names match the local CLI contract. Claude current-session and managed-session paths remain distinct.
3. The skill passes the skill validator. Its public copy equals its packaged source after the build.
4. CI, Pages and release workflows parse, pin every action and grant only the permissions each job needs.
5. The release tarball contains the library, CLI, skill, README and license. It contains no credentials or local transcripts.
6. A real Chromium test pairs over local WebRTC, fetches the selected session, receives a host surface and sends typed values to a synthetic adapter.
7. Types, lint, format, tests and both builds pass. An independent review inspects the intended-public files before release.

## Rejected alternatives

An npm release needs unverified registry credentials, so this release uses a GitHub tarball. Automatic hook installation changes contributor configuration, so the hook requires an explicit opt-in command. A server-rendered site adds an operated service, so the app uses static assets and browser peer transport.

## Review record

Design follows the parent's requested distribution and surface contracts.

On 2026-10-13T18:43:14Z, Claude Sonnet 5.5 (`claude-sonnet-5-5`) accepted this revision. Full source bundle `f0a25acffc88412ffa7208bbe5d714794825d682dc6c7a40ad796cf14301e76c` had no code or workflow blocker. It required clearer session identity, replacement consent, human-only pairing and packaged-skill instructions. The text follow-up bundle `f0581454281d50703284e066c6803f27f625b40503a36487e743284a331afb86` resolved both blockers. Verdict: ACCEPT. The reviewer inspected source and text; it did not run commands.

The implementer ran 119 tests, including a real Chromium-to-Node WebRTC flow through the host and surface registry. Strict TypeScript, ESLint, scoped Prettier and production builds passed. The skill validator passed. The generated public skill matched its packaged source. Workflow YAML and immutable Action references passed local checks. GitHub Actions and actual release deployment remain integration gates. The CLI and transport inputs have separate owners and reviews.
