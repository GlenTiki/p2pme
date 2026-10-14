# Changelog

## 0.2.0

- Create a local invitation with a code, connection link, and terminal QR code.
- Authorize one browser through that invitation, with the access selected locally.
- Authenticate typed codes with OPAQUE before a private grant exchange.
- Keep the QR path available if the public code path fails.
- Save a verified host from the browser after a QR connection.
- Preserve the legacy pairing API and its separate terminal approval.

## 0.1.1

- Hide session creation until the connected host supplies approved contexts.
- Add authenticated context discovery through `profiles.list`.
- Clear context choices on disconnect and reject stale discovery results.
- Keep sessions and chat available when a host cannot supply contexts.

## 0.1.0

- Add signed Hypercore session logs and approved Hyperswarm peers.
- Add a local host with explicit device grants and supported session adapters.
- Add a static browser app with persistent host access when the user chooses it.
- Add bounded reactive agent controls and typed actions.
- Add the p2pme setup skill, source examples and public project documentation.

The first package is distributed as a GitHub release tarball. This version is an early API and can change before 1.0.
