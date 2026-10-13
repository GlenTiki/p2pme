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

An invitation is a bearer secret. Anyone with a copied invitation can race the intended browser during pairing. The terminal prompt approves the displayed label and scopes. It does not prove a person's identity. Keep invitations private and create a fresh one if exposure is possible. The app can include the invitation in a copied agent setup prompt. Pasting that prompt into an agent sends the invitation to its model provider and can retain it in the conversation.

A remembered grant contains permanent room credentials until expiry or revocation. Scripts on the app's origin can read browser storage. Forget removes the local copy; `p2pme revoke GRANT_ID` revokes the grant at the host. Do not share browser profiles that hold device access.

Public rendezvous and STUN providers can observe connection metadata. The app does not contact them on page load. A connection request or host recovery of an active grant starts discovery. Provider accounts, workspace permissions and local processes remain outside p2pme's device boundary.
