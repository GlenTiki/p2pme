import { WebSocketServer, WebSocket } from "ws";
import type { BrowserContext } from "playwright";

type RelayEvent = { id: string; tags: string[][]; created_at: number };
type Filter = { "#x"?: string[]; since?: number };

export async function localNostrRelay() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const clients = new Map<WebSocket, Map<string, Filter>>();
  const events: RelayEvent[] = [];
  function send(
    socket: WebSocket,
    id: string,
    filter: Filter,
    event: RelayEvent,
  ) {
    if (event.created_at < (filter.since ?? 0)) return;
    if (
      event.tags.some(
        ([tag, topic]) => tag === "x" && filter["#x"]?.includes(topic!),
      )
    )
      socket.send(JSON.stringify(["EVENT", id, event]));
  }
  server.on("connection", (socket) => {
    const subscriptions = new Map<string, Filter>();
    clients.set(socket, subscriptions);
    socket.on("close", () => clients.delete(socket));
    socket.on("message", (data) => {
      const [type, value, filter] = JSON.parse(data.toString());
      if (type === "REQ") {
        subscriptions.set(value, filter);
        for (const event of events) send(socket, value, filter, event);
        socket.send(JSON.stringify(["EOSE", value]));
      } else if (type === "CLOSE") subscriptions.delete(value);
      else if (type === "EVENT") {
        events.push(value);
        if (events.length > 1000) events.shift();
        socket.send(JSON.stringify(["OK", value.id, true, ""]));
        for (const [client, subs] of clients) {
          for (const [id, subscription] of subs)
            send(client, id, subscription, value);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No relay port");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () => {
      for (const socket of server.clients) socket.terminate();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function routeProductionDiscovery(
  context: BrowserContext,
  relayUrl: string,
) {
  await context.routeWebSocket(
    /^wss:\/\/(nos\.lol|relay\.damus\.io)\/?$/,
    (route) => {
      const socket = new WebSocket(relayUrl);
      const pending: Array<string | Buffer> = [];
      socket.on("open", () => {
        for (const message of pending) socket.send(message);
      });
      route.onMessage((message) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(message);
        else pending.push(message);
      });
      socket.on("message", (data) => route.send(data.toString()));
      socket.on("error", () => route.close());
      route.onClose(() => socket.close());
    },
  );
  await context.addInitScript(() => {
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(target, args) {
        return Reflect.construct(target, [{ ...args[0], iceServers: [] }]);
      },
    });
  });
}
