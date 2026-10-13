# Public app and host setup

## Intent

The app demonstrates p2pme and presents Glen's work. It links to [his website](https://glentiki.dev) and [the source repository](https://github.com/GlenTiki/p2pme). GitHub Pages serves the static build at `p2pme.glentiki.dev`.

## Routes and behaviour

`/` contains the project introduction, browser workspace, local surface demo and About Glen section. A visitor can create a device invitation or connect to a remembered host. A connected host lists sessions within the approved grant. The visitor selects a session before a message or action.

`/host/` contains local setup instructions. `/skill.md` serves the skill as text. The package contains the installable skill. Setup creates a stable host ID and distinct session IDs. Claude instructions state the Channel setup and resume requirement.

The browser remembers credentials only when the visitor selects that option. Later visits require explicit Connect. Forget removes the browser copy. Host revocation invalidates the grant. Neither action deletes an unrelated provider transcript.

The public demo uses the same bounded renderer as the connected app. It is labelled as a local demo. It does not contact a provider or simulate a successful host connection.

## Presentation

The interface uses a light paper background, dark text and green accents. IDs use a monospace font. A simple diagram explains the browser and host relationship. The project introduction and working app both remain visible on a phone.

Copy uses short active sentences and consistent terms. It contains no invented adoption figures, endorsements or security claims. No analytics, external fonts or peer discovery run on page load.

## Acceptance criteria

1. Navigation reaches the app, host guide, About Glen, website and repository.
2. Connection and session states reflect real host responses. Empty states explain the next action.
3. Copy controls report success and failure. Form controls have labels. Status changes use accessible announcements.
4. The phone layout has no horizontal overflow. Keyboard users can identify and reach each action.
5. Host and session IDs remain distinct. The selected session controls message and surface dispatch.
6. The cost explanation identifies static hosting, public discovery services and optional relay costs.
7. A real browser test covers pair, connect, select, surface update, input and typed action delivery.

## Review record

Glen specified the public routes, remembered host, session picker, personal branding and website link. The [browser client](007-browser-client.md) and [surface specification](006-agent-ui.md) record independent reviews of their implementation. This revision updates the original presentation brief to the selected transport and deployment. The release checks must also verify the deployed build.
