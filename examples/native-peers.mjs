import { setTimeout } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import process from "node:process";
import createTestnet from "hyperdht/testnet.js";
import Hyperswarm from "hyperswarm";
import {
  connectAgentPeer,
  createEnvelope,
  createNoiseKeyPair,
  createSessionLog,
} from "@glentiki/p2pme/node";

const network = await createTestnet(3);
const logs = [];
const peers = [];

async function readEntry(log, index) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const entry = await log.get(index);
    if (entry) return entry;
    await setTimeout(25);
  }
  throw new Error("Local peer did not replicate the entry");
}

try {
  const sessionId = randomUUID();
  const first = await createSessionLog({ sessionId });
  logs.push(first);
  const second = await createSessionLog({ sessionId });
  logs.push(second);
  const firstKey = createNoiseKeyPair();
  const secondKey = createNoiseKeyPair();
  const swarmFactory = (options) =>
    new Hyperswarm({ ...options, dht: network.createNode() });
  const firstPeer = await connectAgentPeer({
    localKeyPair: firstKey,
    outgoing: first,
    remote: {
      sessionId,
      noiseKey: secondKey.publicKey,
      logKey: second.publicKey,
    },
    swarmFactory,
  });
  peers.push(firstPeer);
  const secondPeer = await connectAgentPeer({
    localKeyPair: secondKey,
    outgoing: second,
    remote: {
      sessionId,
      noiseKey: firstKey.publicKey,
      logKey: first.publicKey,
    },
    swarmFactory,
  });
  peers.push(secondPeer);
  const command = createEnvelope(sessionId, "chat.send", {
    text: "Hello, peer",
  });
  await first.append(command);
  const received = await readEntry(secondPeer.incoming, 0);
  process.stdout.write(`${JSON.stringify(received)}\n`);
  await second.append(
    createEnvelope(
      sessionId,
      "chat.completed",
      { text: "Hello back" },
      received.id,
    ),
  );
  process.stdout.write(
    `${JSON.stringify(await readEntry(firstPeer.incoming, 0))}\n`,
  );
} finally {
  await Promise.all(peers.map((peer) => peer.disconnect()));
  await Promise.all(logs.map((log) => log.close()));
  await network.destroy();
}
