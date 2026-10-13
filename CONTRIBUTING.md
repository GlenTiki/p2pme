# Contribute to p2pme

Small fixes and clear bug reports are welcome. Open an issue before you change the protocol, consent flow or public API.

## Set up the project

1. Install Node.js 22 or later.
2. Clone the repository.
3. Run `npm ci`.
4. Run `npx playwright install chromium`.
5. Run `npm run check`.

## Submit a change

1. Create a branch for one concern.
2. Add a test that fails for the reported problem.
3. Make the smallest change that passes the test.
4. Run `npm run check`.
5. Update the affected documentation.
6. Open a pull request.

State what changes and why. Link the related issue. Explain any change to the protocol or data exposure. Do not include credentials, invitation codes, transcripts or employer data.

Use short sentences and active voice in documentation. Use one term for each concept. Do not hard-wrap prose. The formatter controls code layout.

Tests use injected collaborators. Do not replace another module's internal functions at runtime. Network tests use local peers and synthetic messages.

The project uses the MIT licence. Contributions use the same licence. No contributor agreement is required.

## Local hook

Run `git config --local core.hooksPath .githooks` to enable the pre-commit check. The hook runs `npm run check`. The package does not change Git configuration during installation.

The browser test uses Chromium, a loopback WebSocket relay and a local synthetic adapter. It makes no model request. Test runners need local TCP and UDP sockets.
