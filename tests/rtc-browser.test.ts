import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createWsRelayServer } from "@trystero-p2p/ws-relay/server";
import { joinRoom } from "@trystero-p2p/ws-relay";
import { RTCPeerConnection } from "werift";
import { expect, it } from "vitest";
import { openRtcChannel } from "../src/rtc-channel.js";
import { randomSecret } from "../src/rtc-identity.js";

it("connects Chromium and Node with admission, targeted messages, reconnect and revocation", async () => {
  const relay = createWsRelayServer({ port: 0, host: "127.0.0.1" });
  await relay.ready;
  const address = relay.address();
  if (!address || typeof address === "string")
    throw Error("Missing relay port");
  const identity = {
    hostId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
  };
  const credentials = { roomId: crypto.randomUUID(), secret: randomSecret() };
  const network = {
    relayUrls: [`ws://127.0.0.1:${address.port}`],
    iceServers: [],
  };
  const nodeNetwork = {
    ...network,
    join: joinRoom,
    rtcPolyfill:
      RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
  };
  let epoch = crypto.randomUUID();
  let received = 0;
  const openHost = () =>
    openRtcChannel(
      {
        credentials,
        hello: { version: 1, role: "host", ...identity, hostEpoch: epoch },
        acceptHello: (hello) => {
          expect(hello).toEqual({ version: 1, role: "client", ...identity });
        },
        onFrame: async (frame) => {
          received++;
          await host.send(JSON.stringify({ echo: JSON.parse(frame) }));
        },
      },
      nodeNetwork,
    );
  let host = openHost();
  const browserSource = `
    import {openRtcChannel} from './src/rtc-channel.ts';
    import {validateWelcome} from './src/rtc-identity.ts';
    import {joinRoom} from '@trystero-p2p/ws-relay';
    window.framesReceived=[];window.connected=false;window.errors=[];
    window.start=()=>{window.channel=openRtcChannel({credentials:{...${JSON.stringify(credentials)},...(location.hash==='#wrong'?{secret:${JSON.stringify(randomSecret())}}:{})},hello:{version:1,role:'client',...${JSON.stringify(identity)}},
      acceptHello:value=>{window.epoch=validateWelcome(value,${JSON.stringify(identity)});},
      onConnect:()=>{window.connected=true;},onDisconnect:()=>{window.connected=false;},
      onFrame:frame=>window.framesReceived.push(JSON.parse(frame)),onError:error=>{window.errors.push(error.message);window.channel.close();window.connected=false;}
    },{...${JSON.stringify(network)},join:(...args)=>{window.rawRoom=joinRoom(...args);return window.rawRoom;}});};window.start();`;
  const bundled = await build({
    stdin: { contents: browserSource, resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
  });
  const script = bundled.outputFiles[0]?.text;
  if (!script) throw Error("No browser bundle");
  const server = createServer((request, response) => {
    response.setHeader(
      "Content-Type",
      request.url === "/app.js" ? "application/javascript" : "text/html",
    );
    response.end(
      request.url === "/app.js"
        ? script
        : '<script type="module" src="/app.js"></script>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverAddress = server.address();
  if (!serverAddress || typeof serverAddress === "string")
    throw Error("Missing HTTP port");
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${serverAddress.port}`);
    await page.waitForFunction("window.connected");
    await page.evaluate("window.channel.send(JSON.stringify({text:'hello'}))");
    await page.waitForFunction("window.framesReceived.length===1");
    expect(await page.evaluate("window.framesReceived[0]")).toEqual({
      echo: { text: "hello" },
    });
    expect(received).toBe(1);
    const wrong = await browser.newPage();
    await wrong.goto(`http://127.0.0.1:${serverAddress.port}/#wrong`);
    await wrong.waitForFunction("window.channel !== undefined");
    expect(await wrong.evaluate("window.connected")).toBe(false);
    expect(await page.evaluate("window.connected")).toBe(true);
    expect(received).toBe(1);
    const second = await browser.newPage();
    await second.goto(`http://127.0.0.1:${serverAddress.port}`);
    await second.waitForFunction("window.errors.length>0");
    expect(await page.evaluate("window.connected")).toBe(true);
    await page.evaluate(
      "window.channel.send(JSON.stringify({text:'still connected'}))",
    );
    await page.waitForFunction("window.framesReceived.length===2");
    expect(received).toBe(2);
    expect(await wrong.evaluate("window.connected")).toBe(false);
    expect(await wrong.evaluate("window.framesReceived.length")).toBe(0);
    await wrong.close();
    await second.close();
    await expect(
      page.evaluate(
        "window.channel.send(JSON.stringify({text:'x'.repeat(33000)}))",
      ),
    ).rejects.toThrow();
    expect(received).toBe(2);
    await host.close();
    await page.waitForFunction("!window.connected");
    epoch = crypto.randomUUID();
    host = openHost();
    await page.evaluate("window.channel.close().then(()=>window.start())");
    await page.waitForFunction("window.connected");
    expect(await page.evaluate("window.epoch")).toBe(epoch);
    expect(received).toBe(2);
    await page.evaluate(
      "window.rawRoom.makeAction('p2pme').send(JSON.stringify({text:'x'.repeat(40000)})).catch(()=>{})",
    );
    await page.evaluate(
      "window.channel.send(JSON.stringify({text:'after rejected frame'}))",
    );
    await page.waitForFunction("window.framesReceived.length===3");
    expect(received).toBe(3);
    await host.close();
    await page.waitForFunction("!window.connected");
    await expect(page.evaluate("window.channel.send('{}')")).rejects.toThrow();
  } finally {
    await browser.close();
    await host.close();
    await relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 60000);
