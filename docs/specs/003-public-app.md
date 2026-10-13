# Public app and host setup

Glen requested a personal promotion project. The app links to [his website](https://glentiki.dev) and the public source repository. The intended domain is `p2pme.glentiki.dev`.

## Routes and behaviour

`/` serves the browser app and project introduction. A new visitor can connect to a host or open the host setup guide. A returning visitor sees their remembered hosts. A connected host supplies its registered sessions. The visitor selects a session before they send a message.

`/host` serves the agent setup guide and versioned skill instructions. Local setup creates a stable host ID. `/p2pme` registers a Claude Code or Codex session with that host. Each session has a separate session ID. The guide explains Claude's channel registration and restart requirement. It must not claim universal hot attachment.

The browser retains a host connection only after the user approves that option. Host approval does not publish unrelated local session history. The host exposes sessions registered through p2pme. Device revocation and session removal remain distinct actions.

The app includes an About Glen section with direct website and repository links. Copy states what the project does. It uses short sentences, active voice and consistent terms. It contains no invented adoption figures, testimonials, credentials or unsupported security claims.

## Visual direction

Use a light paper background, dark ink, a restrained green accent and clear monospace labels for IDs. Give the project introduction and the working app equal attention. Use a simple node diagram to explain the host and browser relationship. Keep the interface usable on a phone.

## Acceptance criteria

1. Navigation reaches the app, host guide, About Glen, website and repository.
2. The app has real host, session and message states. Empty states explain the next action. No fake response is presented as a live agent.
3. Copy controls report failure as well as success. Form controls have labels. Status changes use accessible announcements.
4. The mobile layout has no horizontal overflow. Keyboard users can reach and identify every action.
5. Host and session IDs remain distinct in the UI and protocol. A session is selected before a prompt can be sent.
6. The final cost explanation matches the chosen deployment. The automatic rendezvous decision remains pending, so this slice may prepare static presentation only.

## Review record

The user directly specified the routes, persistent host relation, session picker, personal branding and website link. Static presentation can proceed while the hosted rendezvous choice remains open. Final functional integration requires the host protocol specification and independent review.
