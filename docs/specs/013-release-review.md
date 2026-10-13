# Release integration review

Recorded at 2026-10-13T19:30:56Z.

## Scope and verdict

Claude `claude-sonnet-5-5` reviewed the combined project source and specifications. The first integration snapshot, `ba342acabbeec3cd2ac97e9d53c1857f65f77138df1619f9108ba182d7e087f4`, received request-changes for log exhaustion and crash recovery. The component specifications record earlier reviews.

The host now blocks later provider calls after a full or failed log. It reserves receipt capacity and returns a fixed recovery error. The CLI handles SIGHUP and displays selected fixed startup errors. Manual recovery preserves identity, grants and workspace policy. Regression tests reproduce both original failures.

Claude accepted the corrected integration snapshot `5860f76c37d6091f05b097039786224b3e240bf1040941bc7e141941149a109c` with no blockers. This review also covered the public HTML and build configuration omitted from the first snapshot.

A final text-only change updates the host guide for version 0.1.0 and states the live-provider verification limit. Claude accepted that exact delta. The resulting combined digest is `f536e617ec7207b6c73f6bb2f0dcb2c4e0d870fff3219945efa63a0313f9a25a`. A local comparison verified that only public/host/index.html changed after the accepted integration snapshot.

The [manifest](../reviews/v0.1.0.txt) lists the reviewed files. Its first line is the SHA-256 digest. For each subsequent path, hash the UTF-8 path, a NUL, the exact file bytes and another NUL. Process paths in manifest order. This review record and the manifest are outside that digest.

Each Claude review inspected supplied source only. The local builder computed the digests and executed the checks. Claude did not execute tests or independently recompute a digest.

## Executed checks

The corrected combined tree passed strict types, lint, complexity checks, formatting, 302 tests, both production builds and one clean-install package test. The package test covers installed exports, strict consumer declarations, CLI help, real Hypercore storage and a Chromium import. Browser tests use real WebRTC peers with a local relay and synthetic adapters.

Separate real-process tests verified terminal cancellation without descriptor growth, SIGHUP cleanup and refusal of a stale lock. Visual checks covered desktop and phone widths, copy controls, keyboard focus and local surface inputs. The full dependency audit reported no known vulnerabilities. A history scan found no private workspace paths, corporate domains or credential markers.

## Release conditions

The publisher must verify executed GitHub checks, the downloadable release tarball, the deployed routes and HTTPS before advertising the site. Local tests do not replace those deployment checks.

Live provider and physical-phone verification remains [issue #2](https://github.com/GlenTiki/p2pme/issues/2). Transcript observation remains [issue #1](https://github.com/GlenTiki/p2pme/issues/1). State reclamation and provider lifecycle improvements remain [issue #3](https://github.com/GlenTiki/p2pme/issues/3) and [issue #4](https://github.com/GlenTiki/p2pme/issues/4). These are explicit limits of the first release.
