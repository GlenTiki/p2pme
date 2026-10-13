import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { record, type JsonObject } from "./adapters/transport.js";

export class ChannelWire {
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private receive: ((frame: JsonObject) => void) | null = null;
  private closed = false;
  private readonly closers = new Set<() => void>();
  private readonly frames: JsonObject[] = [];
  private readonly data = (chunk: Buffer) => this.read(chunk);
  constructor(readonly socket: Socket) {
    socket.on("data", this.data);
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
  }
  onFrame(receive: (frame: JsonObject) => void): void {
    this.receive = receive;
    for (const frame of this.frames.splice(0)) this.deliver(frame);
  }
  next(): Promise<JsonObject> {
    if (this.closed) return Promise.reject(new Error("Channel closed"));
    return new Promise((resolve, reject) => {
      const closed = () => reject(new Error("Channel closed"));
      this.closers.add(closed);
      this.onFrame((frame) => {
        this.receive = null;
        this.closers.delete(closed);
        resolve(frame);
      });
    });
  }
  onClose(close: () => void): void {
    this.closers.add(close);
    if (this.closed) close();
  }
  release(): void {
    this.socket.off("data", this.data);
    this.receive = null;
  }
  async send(frame: JsonObject): Promise<void> {
    const text = JSON.stringify(frame) + "\n";
    if (this.closed || Buffer.byteLength(text) > 65536)
      throw new Error("Channel frame unavailable");
    await new Promise<void>((resolve, reject) => {
      this.socket.write(text, (error) => (error ? reject(error) : resolve()));
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.release();
    this.socket.destroy();
    for (const close of this.closers) close();
    this.closers.clear();
  }
  private read(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    try {
      this.lines();
      if (Buffer.byteLength(this.buffer) > 65536) this.close();
    } catch {
      this.close();
    }
  }
  private lines(): void {
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > 65535) throw new Error("Frame exceeded");
      const value: unknown = JSON.parse(line);
      if (record(value) !== value) throw new Error("Invalid frame");
      this.deliver(value as JsonObject);
    }
  }
  private deliver(value: JsonObject): void {
    if (this.receive) this.receive(value);
    else {
      if (this.frames.length >= 4) throw new Error("Frame queue exceeded");
      this.frames.push(value);
    }
  }
}
