import type { SessionAdapter } from "../host-types.js";
import { JsonRpc } from "./rpc.js";
import { spawnCodexProxy } from "./proxy.js";
import {
  PendingTurn,
  promptText,
  type AdapterInput,
  type Output,
} from "./turn.js";
import {
  localDirectory,
  localString,
  record,
  spawnJsonProcess,
  type JsonObject,
  type JsonTransport,
  type ProcessSpawner,
} from "./transport.js";

interface ActiveTurn {
  pending: PendingTurn;
  turnId: string | null;
  marker: string | null;
  events: JsonObject[];
  bytes: number;
}
export interface CodexAttachOptions {
  threadId: string;
  expectedCwd?: string;
  transport?: JsonTransport;
  spawn?: ProcessSpawner;
}
export interface CodexCreateOptions {
  cwd: string;
  modelId?: string;
  models: string[];
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write";
  transport?: JsonTransport;
  spawn?: ProcessSpawner;
}

function providerId(value: unknown): string {
  if (typeof value !== "string" || value.length > 200)
    throw new Error("Invalid Codex thread ID");
  return localString(value);
}

class CodexAdapter implements SessionAdapter {
  private active: ActiveTurn | null = null;
  private closed = false;
  private nextModel: string | null = null;
  constructor(
    private readonly rpc: JsonRpc,
    private readonly threadId: string,
    private readonly managedModels: string[] | null,
  ) {
    rpc.transport.subscribe((value) => this.receive(value));
    rpc.transport.onClose((error) => {
      this.closed = true;
      this.active?.pending.fail(error);
    });
  }
  async submit(input: AdapterInput, emit: Output): Promise<void> {
    if (this.closed || this.active)
      throw new Error("Adapter is unavailable or busy");
    const pending = new PendingTurn(input, emit, () => {
      void this.detach();
    });
    const active: ActiveTurn = {
      pending,
      turnId: null,
      marker: null,
      events: [],
      bytes: 0,
    };
    this.active = active;
    const params: JsonObject = {
      threadId: this.threadId,
      clientUserMessageId: input.id,
      input: [{ type: "text", text: promptText(input), text_elements: [] }],
    };
    if (this.nextModel) params.model = this.nextModel;
    void this.rpc
      .request("turn/start", params)
      .then((result) => this.started(active, result))
      .catch((error) => pending.fail(error));
    try {
      await pending.done;
    } catch (error) {
      await this.detach();
      throw error;
    } finally {
      await pending.drain();
      if (this.active === active) this.active = null;
    }
  }
  private started(active: ActiveTurn, result: JsonObject): void {
    if (this.active !== active) return;
    const id = record(result.turn).id;
    if (typeof id !== "string") {
      active.pending.fail(new Error("Missing provider turn ID"));
      return;
    }
    active.turnId = id;
    for (const event of active.events) this.deliver(active, event);
    active.events = [];
    active.bytes = 0;
  }
  private receive(value: JsonObject): void {
    if (typeof value.method !== "string") return;
    if (value.id !== undefined) {
      this.serverRequest(value);
      return;
    }
    const active = this.active;
    const params = record(value.params);
    if (!active || params.threadId !== this.threadId) return;
    this.notification(active, value.method, params);
  }
  private notification(
    active: ActiveTurn,
    method: string,
    params: JsonObject,
  ): void {
    if (method === "item/started" || method === "item/completed") {
      this.mark(active, params);
      return;
    }
    if (!active.marker) return;
    if (method !== "item/agentMessage/delta" && method !== "turn/completed")
      return;
    const event = { ...params, method };
    if (active.turnId) {
      this.deliver(active, event);
      return;
    }
    active.bytes += Buffer.byteLength(JSON.stringify(event));
    if (active.bytes > 256 * 1024 || active.events.length >= 256) {
      active.pending.fail(new Error("Provider notification buffer exceeded"));
      return;
    }
    active.events.push(event);
  }
  private mark(active: ActiveTurn, params: JsonObject): void {
    const item = record(params.item);
    if (
      item.type === "userMessage" &&
      item.clientId === active.pending.input.id &&
      typeof params.turnId === "string"
    )
      active.marker = params.turnId;
  }
  private deliver(active: ActiveTurn, event: JsonObject): void {
    if (active.marker !== active.turnId) return;
    if (event.method === "item/agentMessage/delta") {
      if (event.turnId === active.turnId && typeof event.delta === "string")
        active.pending.delta(event.delta);
      return;
    }
    const turn = record(event.turn);
    if (turn.id !== active.turnId) return;
    if (turn.status === "completed") active.pending.finish();
    else active.pending.fail(new Error("Provider turn did not complete"));
  }
  private serverRequest(value: JsonObject): void {
    if (!this.managedModels) return;
    const responses: Record<string, JsonObject> = {
      "item/commandExecution/requestApproval": { decision: "decline" },
      "item/fileChange/requestApproval": { decision: "decline" },
      "item/permissions/requestApproval": { permissions: {}, scope: "turn" },
      "mcpServer/elicitation/request": {
        action: "decline",
        content: null,
        _meta: null,
      },
    };
    const method = String(value.method);
    const result = Object.hasOwn(responses, method)
      ? responses[method]
      : undefined;
    const response = result
      ? { id: value.id, result }
      : {
          id: value.id,
          error: { code: -32601, message: "Remote approval is unavailable" },
        };
    void this.rpc.transport.send(response).catch(() => {
      void this.detach();
    });
  }
  async configure(input: { modelId: string }): Promise<void> {
    if (!this.managedModels)
      throw new Error(
        "Model configuration is unsupported for attached sessions",
      );
    if (
      this.closed ||
      this.active ||
      !this.managedModels.includes(input.modelId)
    )
      throw new Error("Model configuration is unavailable");
    this.nextModel = input.modelId;
  }
  async detach(): Promise<void> {
    this.closed = true;
    this.active?.pending.fail(new Error("Adapter detached"));
    await this.rpc.transport.close();
    await this.active?.pending.drain();
  }
}

export async function attachCodex(
  options: CodexAttachOptions,
): Promise<SessionAdapter> {
  providerId(options.threadId);
  if (options.expectedCwd !== undefined) localDirectory(options.expectedCwd);
  const transport = options.transport ?? spawnCodexProxy(options.spawn);
  const rpc = new JsonRpc(transport);
  try {
    await rpc.initialize();
    const result = await rpc.request("thread/read", {
      threadId: options.threadId,
      includeTurns: false,
    });
    const thread = record(result.thread);
    if (options.expectedCwd !== undefined && thread.cwd !== options.expectedCwd)
      throw new Error("Codex workspace does not match local profile");
    if (
      thread.id !== options.threadId ||
      !["idle", "active"].includes(String(record(thread.status).type))
    )
      throw new Error("Codex thread is not running");
    const resumed = await rpc.request("thread/resume", {
      threadId: options.threadId,
      excludeTurns: true,
    });
    if (record(resumed.thread).id !== options.threadId)
      throw new Error("Resumed thread identity changed");
    return new CodexAdapter(rpc, options.threadId, null);
  } catch (error) {
    await transport.close();
    throw error;
  }
}

function validateProfile(options: CodexCreateOptions): void {
  localDirectory(options.cwd);
  if (
    options.sandbox !== undefined &&
    !["read-only", "workspace-write"].includes(options.sandbox)
  )
    throw new Error("Invalid local sandbox");
  if (
    options.approvalPolicy !== undefined &&
    !["untrusted", "on-failure", "on-request", "never"].includes(
      options.approvalPolicy,
    )
  )
    throw new Error("Invalid local approval policy");
  if (
    options.modelId !== undefined &&
    !options.models.includes(localString(options.modelId))
  )
    throw new Error("Model is outside the local profile");
}

export async function createManagedCodex(
  options: CodexCreateOptions,
): Promise<{ providerSessionId: string; adapter: SessionAdapter }> {
  validateProfile(options);
  const transport =
    options.transport ??
    spawnJsonProcess(
      "codex",
      ["app-server", "--stdio"],
      options.cwd,
      options.spawn,
    );
  const rpc = new JsonRpc(transport);
  try {
    await rpc.initialize();
    const params: JsonObject = {
      cwd: options.cwd,
      ephemeral: false,
    };
    if (options.modelId !== undefined) params.model = options.modelId;
    params.approvalPolicy = options.approvalPolicy ?? "untrusted";
    params.sandbox = options.sandbox ?? "read-only";
    const result = await rpc.request("thread/start", params);
    const threadId = providerId(record(result.thread).id);
    return {
      providerSessionId: threadId,
      adapter: new CodexAdapter(rpc, threadId, [...options.models]),
    };
  } catch (error) {
    await transport.close();
    throw error;
  }
}
