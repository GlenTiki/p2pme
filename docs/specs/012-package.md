# Installable package and build contract

## Intent

Ship one versioned tarball with the Node library, browser transport, protocol validation, setup skill and CLI. A clean consumer must use the tarball without source-tree links. This slice does not publish a release or change hosting settings.

## Build contract

The package exports `.`, `./node` and `./browser` with explicit declaration files. The Node entry exposes local host, log, provider and transport APIs. The browser entry exposes pairing and host connection APIs without Node-only imports. The `p2pme` binary points to a Node ESM bundle of `src/cli.ts` with its shebang intact. Runtime dependencies stay external in Node bundles; browser bundles contain their dependencies.

A build clears old SDK output, emits declarations and bundles the four entry points. The web build bundles the app and copies the packaged skill with Node filesystem APIs. `npm pack` runs the build through `prepack`. The release workflow checks the tag version and uploads the checked tarball; it does not publish to npm.

Keep exact direct dependency versions. The repository lockfile fixes development resolution; tarball consumers resolve transitive dependency ranges. Use zod 4.6.7 with json-render 0.21.0 and React 19.3.0. Remove unused Wrangler and Cloudflare type dependencies. The public site remains a static artifact.

## Verification

A package smoke test creates a temporary consumer and installs the local tarball and fetches its dependencies from the public npm registry. It verifies the installed package is a real directory, imports each documented entry, checks declarations through TypeScript and executes the installed binary's `--help`. It verifies the packaged skill and license, and runs a real local session-log operation. It bundles a consumer that imports the browser entry and runs it in Chromium without a Node runtime. The test does not start a host, authenticate a provider or send a model prompt.

The normal unit suite excludes this install test. `npm run check` runs the install test after the build. The install uses a temporary npm cache and explicit public registry. Temporary consumers are removed when the test ends. Test failures retain the command error output.

## Acceptance criteria

1. A failing smoke test demonstrates missing browser exports or CLI artifacts before the package changes.
2. The complete clean-install test passes without source symlinks or developer-installed provider tools.
3. Types, lint, formatting, unit tests, browser tests and builds pass on the integrated source revision.
4. Package contents include the intended declarations, bundles, skill, README and license. They exclude project state and credentials.
5. An independent Claude review inspects the package metadata, build scripts, tests and release workflow before release.

## Review record

The parent requested this packaging contract. Claude Sonnet 5.5 (`claude-sonnet-5-5`) accepted the implementation in two independent source reviews. The first review input has SHA-256 `a3c9a73d466845ea039a1aa5cb0c117a4323ddfebdb92277384bafbb73c6fe0f`. The final follow-up input has SHA-256 `a86259389f19c88bf05414882593c613bb97f3396235ab378ef7950f494989d0`. Both verdicts were ACCEPT. The reviewer did not execute the checks.

The follow-up confirmed strict consumer declarations, browser cleanup, web-only development dependencies, accurate dependency documentation and package-safe README links. The implementer ran the clean install test and normal `npm pack` with its build hook. The normal pack completed without recursion. The tested local tarball has SHA-256 `530bdf43b7eaf764607f938e76d6b793be3577f07c55b2b7b69501b761b5042a`. Source review hashes identify review inputs, not release artifacts.

The package worktree uses copied host, transport and CLI inputs for integration checks. Their owners commit and review those files separately. The final release must pass the same checks on the canonical combined revision.

At `2026-10-13T19:04:59Z`, `npm run check` passed in the package worktree: types, lint, formatting, 214 unit and browser tests, both builds, and one clean-install package test. The RTC admission test includes the separately owned correction `5b5f81a`. A later pending-handshake runtime fix remains outside this package slice and requires the final combined check.
