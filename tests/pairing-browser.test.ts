import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createWsRelayServer } from "@trystero-p2p/ws-relay/server";
import { joinRoom } from "@trystero-p2p/ws-relay";
import { RTCPeerConnection } from "werift";
import { expect, it } from "vitest";
import { approvePairing } from "../src/pairing.js";
import { serveHostConnection } from "../src/host-connection.js";
import { randomSecret, decodeInvitation } from "../src/rtc-identity.js";
import { parseHostRequest } from "../src/host-protocol.js";
import type { RtcChannel } from "../src/rtc-channel.js";

it("pairs a real browser then uses only the acknowledged permanent grant", async () => {
  const relay = createWsRelayServer({ port: 0, host: "127.0.0.1" });
  await relay.ready;
  const address = relay.address();
  if (!address || typeof address === "string") throw Error("No relay port");
  const network = {
    relayUrls: [`ws://127.0.0.1:${address.port}`],
    iceServers: [],
  };
  const native = {
    ...network,
    join: joinRoom,
    rtcPolyfill:
      RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
  };
  const grant = {
    hostId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
    roomId: crypto.randomUUID(),
    secret: randomSecret(),
    label: "Test host",
    expiresAt: new Date(Date.now() + 3600000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
  };
  const hostEpoch = crypto.randomUUID();
  const source = `
    import {beginPairing} from './src/pairing.ts';
    import {connectHost} from './src/host-client.ts';
    import {encodeInvitation} from './src/rtc-identity.ts';
    import {joinRoom} from '@trystero-p2p/ws-relay';
    const network={...${JSON.stringify(network)},join:joinRoom};
    window.attempt=beginPairing('Test browser',{network});
    window.invitation=encodeInvitation(window.attempt.invitation);
    window.result=window.attempt.completion.then(async grant=>{
      window.client=await connectHost(grant,{network});
      await window.attempt.close();
      return window.client.request('sessions.list',{});
    });`;
  const bundled = await build({
    stdin: { contents: source, resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
  });
  const server = createServer((request, response) => {
    response.setHeader(
      "Content-Type",
      request.url === "/app.js" ? "application/javascript" : "text/html",
    );
    response.end(
      request.url === "/app.js"
        ? bundled.outputFiles[0]!.text
        : '<script type="module" src="/app.js"></script>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const http = server.address();
  if (!http || typeof http === "string") throw Error("No HTTP port");
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
  });
  let permanent: RtcChannel | undefined;
  let persisted = false;
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${http.port}`);
    await page.waitForFunction("window.invitation !== undefined");
    const code = await page.evaluate("window.invitation");
    if (typeof code !== "string") throw Error("No invitation");
    const invitation = decodeInvitation(code);
    await approvePairing(invitation, grant, {
      network: native,
      persist: async () => {
        persisted = true;
      },
      activate: async () => {
        expect(persisted).toBe(true);
        permanent = serveHostConnection(grant, {
          network: native,
          hostEpoch,
          active: () => persisted,
          dispatch: async (frame) => {
            const request = parseHostRequest(frame);
            return {
              version: 1,
              id: crypto.randomUUID(),
              hostId: grant.hostId,
              hostEpoch,
              replyTo: request.id,
              ok: true,
              result: { sessions: [] },
            };
          },
        });
      },
    });
    expect(await page.evaluate("window.result")).toEqual({ sessions: [] });
    expect(await page.evaluate("window.client.hostEpoch")).toBe(hostEpoch);
    await page.evaluate("window.client.close()");
  } finally {
    await browser.close();
    await permanent?.close();
    await relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 60000);
