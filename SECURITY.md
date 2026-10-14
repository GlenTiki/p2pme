# Security policy

## Report a vulnerability

Use GitHub's private vulnerability report form under this repository's Security tab. Do not put a working exploit, credential or session transcript in a public issue.

If the private report form is unavailable, use the contact link on [Glen's website](https://glentiki.dev). State that you need a private security contact. Do not include the exploit in that first message.

Include the affected version, the expected result, the actual result and a minimal reproduction with synthetic data. State which endpoint or permission boundary is affected.

## Support

The maintainer reviews reports for the latest release. This personal project has no response-time guarantee. The release notes identify fixed vulnerabilities and affected versions.

## Scope

Pairing, message validation, peer identity, local session access and dependency vulnerabilities are in scope. Host agent permissions remain part of the selected host's security model.

A paired device can submit prompts to the selected local agent. Treat an invitation as a secret. Use synthetic data when you test the public example.

## Device access

A host invitation authorizes one device for the scopes and profiles selected locally. Anyone with its code or QR link can race the intended device. Its label does not prove a person's identity. Keep invitations private and cancel them if exposure is possible. A returned invitation can remain in the local agent conversation and reach its model provider. The generic setup instruction contains no invitation.

The short code uses a public locator and a separate 40-bit secret. OPAQUE authenticates that secret before the peers open a private grant room. The host permits one authentication exchange per code. A failed or idle code peer can disable that code path. The separate QR link remains available. QR links contain random 256-bit secrets. The application consumes authentication state once and admits one device across both paths.

Cancellation succeeds only before the durable grant commit starts. A `too-late` result does not revoke access. A failed write can be uncertain if the filesystem has already replaced the state file. Inspect the grant list and revoke unwanted access. Legacy browser-first pairing retains its separate terminal approval.

Any process with access to the private control socket can create an invitation and select available scopes and profiles. The skill guides agent behavior; it does not constrain a malicious local process. Provider tool and file permissions still apply.

The public code exchange reveals the QR room ID, but keeps its random secret private. The QR path survives code authentication failures. Floods against public discovery can still disrupt either path.

A remembered grant contains permanent room credentials until expiry or revocation. Scripts on the app's origin can read browser storage. Forget removes the local copy; `p2pme revoke GRANT_ID` revokes the grant at the host. Do not share browser profiles that hold device access.

Public rendezvous and STUN providers can observe connection metadata. An ordinary page load does not contact them. A connection request, valid QR link, local invitation, or host recovery of an active grant starts discovery. Provider accounts, workspace permissions and local processes remain outside p2pme's device boundary.

An invitation PNG contains the same secret as its QR link. `invite --qr-file` creates a new mode-0600 file in an existing private directory owned by the local user. It never overwrites an existing path. The skill removes its image after connection or expiry. Display the image only in the user’s setup conversation; do not commit or publish it.
