# Agent controls in the browser

## Intent

Glen requested agent-generated controls that change the rendered view and send typed actions to the selected session. This slice adds a bounded JSON surface and a React island to the existing public app. A separate local demo shows the same renderer without a host connection.

## Contract

`parseSurface` accepts a JSON object with `surfaceId`, positive integer `revision`, and `spec`. `surfaceId` is a UUIDv4, as required by the host protocol. The spec contains `root`, `state.form` and a flat `elements` map. The browser and Node exports share this validator.

The catalog contains Stack, Card, Text, TextInput, Select, Slider, Checkbox and Button. Inputs bind to declared scalar values under `/form/<key>`. Text may read those values. Elements may use one equality visibility condition. Only a Button press can emit `sendSessionAction`. The action names a safe action ID. A renderer-owned callback supplies the selected session ID, surface ID, revision and current form values. The spec cannot select a session or host.

Each surface is at most 32 KiB of UTF-8 JSON. It contains at most 64 elements, eight tree levels, 32 form values and 32 options per Select. Labels and text have explicit limits. State keys use a closed identifier pattern. Prototype property names are forbidden. Every child exists, has one parent and is reachable from the root. Leaves cannot have children.

Validation rejects unknown fields, code, URLs, raw HTML, arbitrary style properties, watchers, repeats, nested expressions, custom functions, automatic actions and action chains. React renders text as text. The app supplies fixed CSS classes and semantic controls. Credentials and connection state never enter the renderer state. Catalog validation follows the strict application validator.

`createSurfaceMount(element)` returns `mountSurface(sessionId, surface, onAction)` and `clearSurface()`. Each accepted replacement creates fresh local state. Rejected replacements leave the existing surface intact. A cleared or replaced surface cannot send a delayed action. The callback must recheck host authorization and revision at its transport boundary. There is no automatic request retry. A pending action disables buttons and reports completion or failure through app-owned status text.

The renderer can display a lower revision when its caller supplies it. The host surface registry owns revision authority and must reject actions for a stale revision.

The local demo uses a separate mount. It reports only the local callback result and states that no agent is connected. Input changes must update a text preview and a conditional section. No network request runs from the renderer or demo.

## Acceptance criteria

1. Tests reject malicious properties, unknown components, invalid paths, cycles, shared or missing children, unreachable nodes, excessive depth and oversized input.
2. Input changes update the view. Mount, state changes and replacement send no action. A user button click emits one typed action with current values.
3. Tests cover callback failure, pending state, replacement and clear. Old controls cannot send actions.
4. The public app retains host, session and chat hooks. The local demo has an explicit label and uses the existing paper and green design.
5. Strict TypeScript, ESLint complexity at most ten, Prettier, unit tests and production builds pass.

## Out of scope

Transport, provider processes, arbitrary generated applications, JSON patches, remote permission approval and host credentials belong to separate slices. The host must register surfaces before it accepts their actions.

## Review record

The parent accepted this bounded catalog design for implementation after this agent's official-source API research. Claude Sonnet 5.5 (`claude-sonnet-5-5`) reviewed the complete surface and browser sources on 2026-10-13T18:23:31Z. The reviewed bundle has SHA-256 `686928bce79247996aff6cd2b78fd44e5ba5840fe4669f2d51c86ac497400892`. Verdict: ACCEPT, with no blockers. The reviewer inspected source only. The implementer ran the gates below.

The implementation uses exact versions of json-render 0.21.0 and React 19.3.0. Tests cover strict validation and actual DOM controls through jsdom. A local Chromium check verified action output at 1440, 390 and 320 pixels without page errors or horizontal overflow. The full test suite passed outside the sandbox because the existing local DHT test requires UDP sockets. TypeScript, ESLint, Prettier and both production builds passed. Screenshots remain local test artifacts.

The library exports `surfaceSchema` for schema introspection and `parseSurface` for full validation. Consumers must use `parseSurface` on received surfaces; it also checks tree integrity and form references. `validateSurfaceValues` checks values again before an action callback runs. The transport layer must check the registered action ID and revision before it dispatches the action.

The first review required rejection of all prototype property names and separate storage validation for expired grants. Both fixes have regression tests. The second review accepted those fixes. Host surface delivery and revision authority remain outside this review.
