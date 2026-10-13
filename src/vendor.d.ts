declare module "hypercore" {
  import { EventEmitter } from "node:events";
  import type { Duplex } from "node:stream";
  export default class Hypercore extends EventEmitter {
    constructor(
      storage: string,
      key: Uint8Array,
      options: { valueEncoding: "utf-8"; allowFork?: boolean },
    );
    constructor(
      storage: string,
      options: { valueEncoding: "utf-8"; allowFork?: boolean },
    );
    readonly key: Buffer;
    readonly length: number;
    readonly byteLength: number;
    readonly fork: number;
    readonly writable: boolean;
    ready(): Promise<void>;
    append(value: string | string[]): Promise<void>;
    get(index: number, options?: { wait?: boolean }): Promise<string | null>;
    truncate(length: number): Promise<void>;
    replicate(stream: boolean | Duplex): Duplex;
    download(range: { start: number; end: number; linear?: boolean }): {
      destroy(): void;
    };
    close(): Promise<void>;
  }
}

declare module "hyperdht" {
  export default class DHT {
    static keyPair(): { publicKey: Buffer; secretKey: Buffer };
  }
}

declare module "hyperdht/testnet.js" {
  import DHT from "hyperdht";
  export default function createTestnet(size?: number): Promise<{
    bootstrap: { host: string; port: number }[];
    createNode(): DHT;
    destroy(): Promise<void>;
  }>;
}

declare module "hyperswarm" {
  import DHT from "hyperdht";
  import { EventEmitter } from "node:events";
  export default class Hyperswarm extends EventEmitter {
    constructor(options: {
      keyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
      maxPeers: number;
      firewall: (key: Uint8Array) => boolean;
      bootstrap?: { host: string; port: number }[];
      dht?: DHT;
    });
    listen(): Promise<void>;
    joinPeer(key: Uint8Array): void;
    destroy(): Promise<void>;
  }
}
