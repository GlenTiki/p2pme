import { record, type JsonObject, type JsonTransport } from "./transport.js";

export class JsonRpc {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: JsonObject) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(readonly transport: JsonTransport) {
    transport.subscribe((value) => this.receive(value));
    transport.onClose((error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }
  async request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.pending.size >= 16) throw new Error("Too many provider requests");
    const id = ++this.nextId;
    const response = new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Provider request timed out"));
      }, 30000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      void this.transport
        .send({ id, method, params })
        .catch(() => this.reject(id));
    } catch {
      this.reject(id);
    }
    return response;
  }
  private reject(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(new Error("Provider RPC failed"));
  }
  private receive(value: JsonObject): void {
    if (typeof value.method === "string" || typeof value.id !== "number")
      return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    if (value.error !== undefined) {
      this.reject(value.id);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(value.id);
    pending.resolve(record(value.result));
  }
  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "p2pme", title: "p2pme", version: "0.1.0" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    await this.transport.send({ method: "initialized" });
  }
}
