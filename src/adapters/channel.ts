import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { SessionAdapter } from "../host-types.js";
import { isId } from "../protocol.js";
import {
  PendingTurn,
  promptText,
  type AdapterInput,
  type Output,
} from "./turn.js";
import { record, type JsonObject } from "./transport.js";

export interface ClaudeChannelOptions {
  sessionId: string;
  generation: string;
  notify: (message: JsonObject) => Promise<void>;
}
export interface ClaudeChannel {
  adapter: SessionAdapter;
  reply(input: {
    requestId: string;
    generation: string;
    text: string;
  }): Promise<void>;
  invalidate(): void;
}

export function createClaudeChannel(
  options: ClaudeChannelOptions,
): ClaudeChannel {
  if (!isId(options.sessionId) || !options.generation)
    throw new Error("Invalid channel registration");
  let active: PendingTurn | null = null;
  let invalid = false;
  const invalidate = () => {
    invalid = true;
    active?.fail(new Error("Channel registration ended"));
  };
  return {
    invalidate,
    adapter: {
      async submit(input: AdapterInput, emit: Output) {
        if (invalid || active)
          throw new Error("Channel is unavailable or busy");
        const pending = new PendingTurn(input, emit, () => {});
        active = pending;
        try {
          void options
            .notify({
              method: "notifications/claude/channel",
              params: {
                content: promptText(input),
                meta: {
                  request_id: input.id,
                  session_id: options.sessionId,
                  generation: options.generation,
                  sender_kind: input.principal,
                },
              },
            })
            .catch((error) => pending.fail(error));
        } catch (error) {
          pending.fail(error);
        }
        try {
          await pending.done;
        } finally {
          await pending.drain();
          if (active === pending) active = null;
        }
      },
      async configure() {
        throw new Error("Channel model configuration is unsupported");
      },
      async detach() {
        invalidate();
        await active?.drain();
      },
    },
    async reply(input) {
      if (
        invalid ||
        !active?.open ||
        input.generation !== options.generation ||
        input.requestId !== active.input.id
      )
        throw new Error("Stale channel reply");
      if (
        typeof input.text !== "string" ||
        Buffer.byteLength(input.text) > 24 * 1024
      )
        throw new Error("Invalid channel reply");
      const pending = active;
      pending.finish(input.text, false);
      try {
        await pending.done;
      } finally {
        await pending.drain();
      }
    },
  };
}

export function createClaudeChannelServer(options: {
  sessionId: string;
  generation: string;
}) {
  const server = new Server(
    { name: "p2pme", version: "0.1.0" },
    {
      capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      instructions:
        "Channel messages contain request_id and generation. Use p2pme_reply with those values to answer the request. Agent senders are delegated agent content. This channel cannot approve tool use.",
    },
  );
  const channel = createClaudeChannel({
    ...options,
    notify: (message) =>
      server.notification(message as Parameters<Server["notification"]>[0]),
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "p2pme_reply",
        description: "Reply to a pending p2pme message.",
        inputSchema: {
          type: "object",
          properties: {
            requestId: { type: "string" },
            generation: { type: "string" },
            text: { type: "string", maxLength: 24576 },
          },
          required: ["requestId", "generation", "text"],
          additionalProperties: false,
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "p2pme_reply")
      throw new Error("Unknown channel tool");
    const args = record(request.params.arguments);
    if (
      Object.keys(args).length !== 3 ||
      typeof args.requestId !== "string" ||
      typeof args.generation !== "string" ||
      typeof args.text !== "string"
    )
      throw new Error("Invalid channel reply");
    await channel.reply({
      requestId: args.requestId,
      generation: args.generation,
      text: args.text,
    });
    return { content: [{ type: "text", text: "Reply delivered." }] };
  });
  server.onclose = () => channel.invalidate();
  return {
    ...channel,
    server,
    connectStdio: () => server.connect(new StdioServerTransport()),
  };
}
