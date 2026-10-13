import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import createTestnet from "hyperdht/testnet.js";
import Hyperswarm from "hyperswarm";
import {
  connectAgentPeer,
  createNoiseKeyPair,
  type AgentPeer,
  type PeerSocket,
  type SwarmOptions,
} from "../src/agent-peer.js";
import { createEnvelope } from "../src/protocol.js";
import { createSessionLog, type SessionLog } from "../src/session-log.js";

const sessionId = "b6e16b67-466c-4852-a94c-8dc00c2e8c42";
const logs: SessionLog[] = [];
const peers: AgentPeer[] = [];

afterEach(async () => {
  await Promise.all(peers.splice(0).map((peer) => peer.disconnect()));
  await Promise.all(logs.splice(0).map((log) => log.close()));
});

async function writer() {
  const log = await createSessionLog({ sessionId });
  logs.push(log);
  return log;
}

class FakeSwarm extends EventEmitter {
  readonly calls: string[] = [];
  joined: Uint8Array | null = null;
  async listen() {
    this.calls.push("listen");
  }
  joinPeer(key: Uint8Array) {
    this.calls.push("joinPeer");
    this.joined = key;
  }
  async destroy() {
    this.calls.push("destroy");
  }
}

describe("native peer boundary", () => {
  it("starts network only on connect, listens before dial, and pins the approved Noise identity", async () => {
    const outgoing = await writer();
    const remoteLog = await writer();
    const remote = createNoiseKeyPair();
    const local = createNoiseKeyPair();
    const swarm = new FakeSwarm();
    const created: SwarmOptions[] = [];
    expect(created).toHaveLength(0);
    const peer = await connectAgentPeer({
      localKeyPair: local,
      outgoing,
      remote: {
        sessionId,
        noiseKey: remote.publicKey,
        logKey: remoteLog.publicKey,
      },
      bootstrap: [],
      swarmFactory: (options) => {
        created.push(options);
        return swarm;
      },
    });
    peers.push(peer);
    expect(swarm.calls).toEqual(["listen", "joinPeer"]);
    expect(swarm.joined).toEqual(remote.publicKey);
    expect(created[0]?.maxPeers).toBe(1);
    expect(created[0]?.bootstrap).toEqual([]);
    expect(created[0]?.firewall(remote.publicKey)).toBe(false);
    expect(created[0]?.firewall(local.publicKey)).toBe(true);
    const intruder = Object.assign(new PassThrough(), {
      remotePublicKey: local.publicKey,
    });
    swarm.emit("connection", intruder);
    expect(intruder.destroyed).toBe(true);
    await peer.disconnect();
    expect(swarm.calls).toEqual(["listen", "joinPeer", "destroy"]);
    await expect(peer.incoming.get(0)).rejects.toThrow();
  });

  it("rejects a descriptor for another session before creating a swarm", async () => {
    const outgoing = await writer();
    const local = createNoiseKeyPair();
    await expect(
      connectAgentPeer({
        localKeyPair: local,
        outgoing,
        remote: {
          sessionId: crypto.randomUUID(),
          noiseKey: createNoiseKeyPair().publicKey,
          logKey: outgoing.publicKey,
        },
        swarmFactory: () => {
          throw new Error("Must not create network");
        },
      }),
    ).rejects.toThrow("session");
  });

  it("replicates both approved writer logs through a local-only DHT", async () => {
    const network = await createTestnet(3);
    try {
      const firstLog = await writer();
      const secondLog = await writer();
      const firstKey = createNoiseKeyPair();
      const secondKey = createNoiseKeyPair();
      const secondSockets: PeerSocket[] = [];
      const swarmFactory = (options: SwarmOptions) => {
        const swarm = new Hyperswarm({ ...options, dht: network.createNode() });
        if (
          Buffer.from(options.keyPair.publicKey).equals(secondKey.publicKey)
        ) {
          swarm.on("connection", (socket: PeerSocket) =>
            secondSockets.push(socket),
          );
        }
        return swarm;
      };
      const [first, second] = await Promise.all([
        connectAgentPeer({
          localKeyPair: firstKey,
          outgoing: firstLog,
          remote: {
            sessionId,
            noiseKey: secondKey.publicKey,
            logKey: secondLog.publicKey,
          },
          bootstrap: network.bootstrap,
          swarmFactory,
        }),
        connectAgentPeer({
          localKeyPair: secondKey,
          outgoing: secondLog,
          remote: {
            sessionId,
            noiseKey: firstKey.publicKey,
            logKey: firstLog.publicKey,
          },
          bootstrap: network.bootstrap,
          swarmFactory,
        }),
      ]);
      peers.push(first, second);
      expect(first.incoming.publicKey).toEqual(secondLog.publicKey);
      expect(second.incoming.publicKey).toEqual(firstLog.publicKey);
      const command = createEnvelope(sessionId, "chat.send", {
        text: "Local DHT request",
      });
      await firstLog.append(command);
      await expect
        .poll(() => second.incoming.get(0), { timeout: 15000 })
        .toEqual(command);
      const unregistered = await writer();
      await unregistered.append(
        createEnvelope(sessionId, "chat.send", {
          text: "Private unrelated core",
        }),
      );
      const unregisteredReader = await createSessionLog({
        sessionId,
        key: unregistered.publicKey,
      });
      logs.push(unregisteredReader);
      await expect
        .poll(() => secondSockets.filter((socket) => !socket.destroyed))
        .toHaveLength(1);
      unregisteredReader.replicate(
        secondSockets.find((socket) => !socket.destroyed)!,
      );
      const reply = createEnvelope(
        sessionId,
        "chat.completed",
        { text: "Signed reply" },
        command.id,
      );
      await secondLog.append(reply);
      await expect
        .poll(() => first.incoming.get(0), { timeout: 15000 })
        .toEqual(reply);
      expect(await unregisteredReader.get(0)).toBeNull();
      await Promise.all([first.disconnect(), second.disconnect()]);
    } finally {
      await network.destroy();
    }
  }, 30000);

  it("rejects an unapproved identity during a real Noise handshake", async () => {
    const network = await createTestnet(3);
    const intruderKey = createNoiseKeyPair();
    const hostKey = createNoiseKeyPair();
    const approvedKey = createNoiseKeyPair();
    const intruder = new Hyperswarm({
      keyPair: intruderKey,
      maxPeers: 1,
      firewall: () => false,
      dht: network.createNode(),
    });
    const checked: Uint8Array[] = [];
    const connected: PeerSocket[] = [];
    try {
      const outgoing = await writer();
      const remoteLog = await writer();
      const host = await connectAgentPeer({
        localKeyPair: hostKey,
        outgoing,
        remote: {
          sessionId,
          noiseKey: approvedKey.publicKey,
          logKey: remoteLog.publicKey,
        },
        swarmFactory: (options) => {
          const swarm = new Hyperswarm({
            ...options,
            dht: network.createNode(),
            firewall: (key) => {
              checked.push(key);
              return options.firewall(key);
            },
          });
          swarm.on("connection", (socket: PeerSocket) =>
            connected.push(socket),
          );
          return swarm;
        },
      });
      peers.push(host);
      await intruder.listen();
      intruder.joinPeer(hostKey.publicKey);
      await expect
        .poll(
          () =>
            checked.some((key) =>
              Buffer.from(key).equals(intruderKey.publicKey),
            ),
          { timeout: 15000 },
        )
        .toBe(true);
      expect(connected).toHaveLength(0);
      await host.disconnect();
    } finally {
      await intruder.destroy();
      await network.destroy();
    }
  }, 30000);
});
