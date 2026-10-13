# Hypercore foundation

## Intent

The Node library uses Hypercore 11 for signed message logs. Hyperswarm connects native agent peers. A separate WebRTC adapter connects a browser to its approved local host. The browser does not run Hypercore or join the DHT.

A peer key proves possession of a peer identity. It does not establish human authority. Consumers must approve the remote Noise key, log key and session ID before they connect.

## Log contract

`createSessionLog({sessionId, key?})` creates a private temporary directory. Without `key`, the log has one local writer. With `key`, it can replicate and read that writer's entries. The API exposes `publicKey`, `length`, `append`, `get`, `replicate` and `close`.

Reads use `core.get(index, {wait: false})`. Missing blocks return `null`. Bounded background downloads fetch entries. Append validates the envelope and session before storage. The writer rejects repeated message IDs. Readers validate replicated entries before use.

Logs set `allowFork: false`. A nonzero fork counter or truncate event fails the log and closes its streams. A real replication test verifies that a signed replacement cannot change an accepted entry.

Each log permits 2,048 entries. Each serialized envelope has a 32 KiB UTF-8 limit. Chat text has a separate 8 KiB limit. Replicas reject indexes above 2,047. They close streams when metadata exceeds 2,048 entries or 64 MiB. Oversized, wrong-session and duplicate-ID entries fail validation. A repeated read of an accepted index does not count as a new command.

## Native peer contract

`connectAgentPeer` requires the local Noise key pair and an approved remote descriptor. The descriptor pins the remote Noise public key, Hypercore public key and session ID.

The library creates Hyperswarm only when the consumer calls this method. It sets `maxPeers: 1`. Its firewall rejects other Noise keys. It also checks the connected socket's key. Both peers listen before they call `joinPeer`.

The accepted stream replicates only the selected outgoing and incoming cores. It never replicates a whole Corestore. Disconnect destroys the active streams and swarm, then closes the incoming core. The caller retains ownership of its outgoing log.

Tests and the native example use a local DHT. Normal native connections use Hyperswarm's public bootstrap nodes. Consumers can supply bootstrap nodes for a private network. A public topic is not a credential.

## Storage and host integration

Close shuts each core before it removes that core's temporary directory. A crash can leave temporary data on disk. Deletion is not secure erasure. Logs are not a transcript archive. This release does not restore them or replay commands after restart.

Signing keys remain local. Noise encrypts native peer traffic. The package does not claim encrypted storage at rest.

The host appends an accepted command to its ingress core before it invokes the provider adapter. It appends provider output to its egress core before delivery. A failed append suppresses the corresponding invocation or output. The gateway signs its receipt of a browser request. The browser does not sign a Hypercore block.

The [host specification](004-host.md) defines grants and dispatch. The [browser transport specification](005-browser-transport.md) defines device authentication. Native peer descriptors and browser device grants are separate access mechanisms.

## Acceptance criteria

1. Protocol tests reject malformed data, wrong sessions, unsupported versions, repeated IDs and oversized UTF-8 frames.
2. Real Hypercore instances replicate an entry. A replica cannot append without the signing key.
3. Unrelated writers cannot populate the pinned replica. Writer truncation cannot replace an accepted entry.
4. Native peer tests verify explicit network opt-in, key checks, selected-core replication and cleanup.
5. A local example exchanges synthetic messages without a model account.
6. Types, lint, complexity, formatting and applicable tests pass.

## Sources

- [Hypercore](https://github.com/holepunchto/hypercore)
- [Hypercore storage](https://github.com/holepunchto/hypercore-storage)
- [Hyperswarm](https://github.com/holepunchto/hyperswarm)

## Review record

The foundation is implemented. Claude `claude-sonnet-5-5` accepted the corrected foundation and host bundle with digest `b13a6d2cd27bdeaacc20bea8e2a812ceb0bd5eef1d398b409b69ab0cdc70b3b9`. The [host review record](004-host.md#review-record) describes its scope. This documentation revision removes obsolete deployment decisions and requires the final integration review.
