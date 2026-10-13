import DHT from "hyperdht";
import Hyperswarm from "hyperswarm";
import type { Duplex } from "node:stream";
import { createSessionLog, type SessionLog } from "./session-log.js";

export interface NoiseKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface PeerDescriptor {
  sessionId: string;
  noiseKey: Uint8Array;
  logKey: Uint8Array;
}

export interface PeerSocket extends Duplex {
  remotePublicKey: Uint8Array;
}

export interface SwarmOptions {
  keyPair: NoiseKeyPair;
  maxPeers: number;
  firewall: (key: Uint8Array) => boolean;
  bootstrap?: { host: string; port: number }[];
}

export interface PeerSwarm {
  on(event: "connection", handler: (socket: PeerSocket) => void): this;
  on(event: "error", handler: (error: Error) => void): this;
  listen(): Promise<void>;
  joinPeer(key: Uint8Array): void;
  destroy(): Promise<void>;
}

export interface AgentPeerOptions {
  localKeyPair: NoiseKeyPair;
  outgoing: SessionLog;
  remote: PeerDescriptor;
  bootstrap?: { host: string; port: number }[];
  swarmFactory?: (options: SwarmOptions) => PeerSwarm;
  onError?: (error: Error) => void;
}

export interface AgentPeer {
  incoming: SessionLog;
  disconnect(): Promise<void>;
}

export function createNoiseKeyPair(): NoiseKeyPair {
  return DHT.keyPair();
}

function validateOptions(options: AgentPeerOptions): void {
  if (options.outgoing.sessionId !== options.remote.sessionId)
    throw new Error("Peer session mismatch");
  for (const key of [
    options.localKeyPair.publicKey,
    options.remote.noiseKey,
    options.remote.logKey,
  ]) {
    if (key.length !== 32) throw new Error("Invalid peer public key");
  }
  if (options.localKeyPair.secretKey.length !== 64)
    throw new Error("Invalid local Noise secret key");
}

export async function connectAgentPeer(
  options: AgentPeerOptions,
): Promise<AgentPeer> {
  validateOptions(options);
  const approved = Buffer.from(options.remote.noiseKey);
  const incoming = await createSessionLog({
    sessionId: options.remote.sessionId,
    key: options.remote.logKey,
  });
  const factory =
    options.swarmFactory ?? ((config: SwarmOptions) => new Hyperswarm(config));
  const config: SwarmOptions = {
    keyPair: {
      publicKey: Buffer.from(options.localKeyPair.publicKey),
      secretKey: Buffer.from(options.localKeyPair.secretKey),
    },
    maxPeers: 1,
    firewall: (key) => !approved.equals(key),
    ...(options.bootstrap === undefined
      ? {}
      : { bootstrap: options.bootstrap }),
  };
  let swarm: PeerSwarm;
  try {
    swarm = factory(config);
  } catch (error) {
    await incoming.close();
    throw error;
  }
  const streams = new Set<PeerSocket>();
  let closing: Promise<void> | null = null;
  const peer = {
    incoming,
    disconnect(): Promise<void> {
      closing ??= disconnect(swarm, streams, incoming);
      return closing;
    },
  };
  swarm.on("error", (error) => options.onError?.(error));
  swarm.on("connection", (socket) => {
    if (closing || !approved.equals(socket.remotePublicKey)) {
      socket.destroy();
      return;
    }
    attach(socket, streams, options.outgoing, incoming, options.onError);
  });
  try {
    await swarm.listen();
    swarm.joinPeer(approved);
    return peer;
  } catch (error) {
    await peer.disconnect();
    throw error;
  }
}

function attach(
  socket: PeerSocket,
  streams: Set<PeerSocket>,
  outgoing: SessionLog,
  incoming: SessionLog,
  onError?: (error: Error) => void,
): void {
  streams.add(socket);
  socket.on("error", (error: Error) => onError?.(error));
  socket.once("close", () => streams.delete(socket));
  try {
    outgoing.replicate(socket);
    incoming.replicate(socket);
  } catch (error) {
    socket.destroy();
    onError?.(
      error instanceof Error ? error : new Error("Peer replication failed"),
    );
  }
}

async function disconnect(
  swarm: PeerSwarm,
  streams: Set<PeerSocket>,
  incoming: SessionLog,
): Promise<void> {
  for (const stream of streams) stream.destroy();
  try {
    await swarm.destroy();
  } finally {
    await incoming.close();
  }
}
