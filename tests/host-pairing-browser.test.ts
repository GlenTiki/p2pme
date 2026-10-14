import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createWsRelayServer } from "@trystero-p2p/ws-relay/server";
import { joinRoom } from "@trystero-p2p/ws-relay";
import { RTCPeerConnection } from "werift";
import { expect, it } from "vitest";
import { offerHostPairing } from "../src/host-pairing.js";
import { randomSecret } from "../src/rtc-identity.js";
import type { RtcNetwork } from "../src/rtc-channel.js";

async function environment() {
  const relay = createWsRelayServer({ port: 0, host: "127.0.0.1" });
  await relay.ready;
  const address = relay.address();
  if (!address || typeof address === "string") throw Error("No relay port");
  const network = {
    relayUrls: [`ws://127.0.0.1:${address.port}`],
    iceServers: [],
  };
  const source = `import{joinHostPairing}from'./src/host-pairing.js';import{openRtcChannel}from'./src/rtc-channel.js';import{joinRoom}from'@trystero-p2p/ws-relay';window.ready=true;window.events=[];window.start=input=>{window.outcome=null;window.attempt=joinHostPairing(input,'Phone',{network:{...${JSON.stringify(network)},join:joinRoom},channelFactory:(options,network)=>{const raw=openRtcChannel({...options,onConnect:()=>{window.events.push(options.hello.role+':connected');options.onConnect?.();},onFrame:async frame=>{window.events.push(options.hello.role+':'+JSON.parse(frame).type);await options.onFrame?.(frame);}},network);return {...raw,close:()=>{window.events.push(options.hello.role+':closed');return raw.close();}};}});window.attempt.completion.then(async value=>{await window.attempt.close();window.outcome={ok:true,label:value.label};},error=>window.outcome={ok:false,error:String(error)});};`;
  const bundled = await build({
    stdin: { contents: source, resolveDir: process.cwd() },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
  });
  const server = createServer((req, res) => {
    res.setHeader(
      "Content-Type",
      req.url === "/app.js" ? "application/javascript" : "text/html",
    );
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ${network.relayUrls[0]}; base-uri 'none'`,
    );
    res.end(
      req.url === "/app.js"
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
  const nodeNetwork: RtcNetwork = {
    ...network,
    join: joinRoom,
    rtcPolyfill:
      RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
  };
  return {
    browser,
    url: `http://127.0.0.1:${http.port}`,
    network: nodeNetwork,
    async close() {
      await browser.close();
      await relay.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
it("pairs Node and Chromium by code and QR under WASM CSP with isolated bootstrap close", async () => {
  const env = await environment();
  try {
    for (const mode of ["code", "qr"]) {
      const operations: string[] = [];
      const offer = await offerHostPairing({
        label: "Local host",
        network: env.network,
        authorize: async (label) => ({
          record: {
            hostId: crypto.randomUUID(),
            grantId: crypto.randomUUID(),
            roomId: crypto.randomUUID(),
            secret: randomSecret(),
            label,
            expiresAt: new Date(Date.now() + 86400000)
              .toISOString()
              .replace(/\.\d{3}Z$/, "Z"),
          },
          persist: async (begin) => {
            begin();
            operations.push("persist");
          },
          activate: async () => {
            operations.push("activate");
          },
        }),
      });
      const page = await env.browser.newPage();
      try {
        await page.goto(env.url);
        await page.waitForFunction(
          () => (window as unknown as { ready: boolean }).ready,
        );
        await page.evaluate(
          (input) =>
            (window as unknown as { start(input: unknown): void }).start(input),
          mode === "code" ? offer.code : offer.invitation,
        );
        await page.waitForFunction(
          () => (window as unknown as { outcome: unknown }).outcome !== null,
          {},
          { timeout: 30000 },
        );
        expect(
          await page.evaluate(
            () => (window as unknown as { outcome: unknown }).outcome,
          ),
        ).toEqual({ ok: true, label: "Phone" });
        await offer.completion;
        expect(operations).toEqual(["persist", "activate"]);
        if (mode === "code") {
          const events = await page.evaluate(
            () => (window as unknown as { events: string[] }).events,
          );
          expect(events).toContain("code-client:closed");
          expect(events.indexOf("code-client:closed")).toBeLessThan(
            events.indexOf("offer-client:grant"),
          );
        }
      } finally {
        await page.close();
        await offer.close();
      }
    }
  } finally {
    await env.close();
  }
}, 60000);
it("keeps the QR path working after the browser uses a wrong code secret", async () => {
  const env = await environment();
  let calls = 0;
  const offer = await offerHostPairing({
    label: "Local host",
    network: env.network,
    authorize: async (label) => {
      calls++;
      return {
        record: {
          hostId: crypto.randomUUID(),
          grantId: crypto.randomUUID(),
          roomId: crypto.randomUUID(),
          secret: randomSecret(),
          label,
          expiresAt: new Date(Date.now() + 86400000)
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z"),
        },
        persist: async (begin) => begin(),
        activate: async () => {},
      };
    },
  });
  try {
    const page = await env.browser.newPage();
    await page.goto(env.url);
    await page.waitForFunction(
      () => (window as unknown as { ready: boolean }).ready,
    );
    const wrong =
      offer.code.slice(0, -1) + (offer.code.endsWith("0") ? "1" : "0");
    await page.evaluate(
      (input) =>
        (window as unknown as { start(input: unknown): void }).start(input),
      wrong,
    );
    await page.waitForFunction(
      () => (window as unknown as { outcome: unknown }).outcome !== null,
      {},
      { timeout: 30000 },
    );
    expect(
      await page.evaluate(
        () => (window as unknown as { outcome: { ok: boolean } }).outcome.ok,
      ),
    ).toBe(false);
    expect(offer.state).toBe("pending");
    expect(calls).toBe(0);
    await page.evaluate(() =>
      (
        window as unknown as { attempt: { close(): Promise<void> } }
      ).attempt.close(),
    );
    await page.evaluate(
      (input) =>
        (window as unknown as { start(input: unknown): void }).start(input),
      offer.invitation,
    );
    await page.waitForFunction(
      () => (window as unknown as { outcome: unknown }).outcome !== null,
      {},
      { timeout: 30000 },
    );
    expect(
      await page.evaluate(
        () => (window as unknown as { outcome: { ok: boolean } }).outcome.ok,
      ),
    ).toBe(true);
    await offer.completion;
    expect(calls).toBe(1);
  } finally {
    await offer.close();
    await env.close();
  }
}, 60000);
it.each([-86400000, 86400000])(
  "pairs by code when only the browser clock differs by %s milliseconds",
  async (clockOffset) => {
    const env = await environment();
    const offer = await offerHostPairing({
      label: "Local host",
      network: env.network,
      authorize: async (label) => ({
        record: {
          hostId: crypto.randomUUID(),
          grantId: crypto.randomUUID(),
          roomId: crypto.randomUUID(),
          secret: randomSecret(),
          label,
          expiresAt: new Date(Date.now() + 30 * 86400000)
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z"),
        },
        persist: async (begin) => begin(),
        activate: async () => {},
      }),
    });
    try {
      const page = await env.browser.newPage();
      await page.addInitScript((offset) => {
        const now = Date.now.bind(Date);
        Date.now = () => now() + offset;
      }, clockOffset);
      await page.goto(env.url);
      await page.waitForFunction(
        () => (window as unknown as { ready: boolean }).ready,
      );
      const hostBefore = Date.now();
      const browserNow = await page.evaluate(() => Date.now());
      const hostAfter = Date.now();
      expect(browserNow).toBeGreaterThanOrEqual(hostBefore + clockOffset);
      expect(browserNow).toBeLessThanOrEqual(hostAfter + clockOffset);
      await page.evaluate(
        (input) =>
          (window as unknown as { start(input: unknown): void }).start(input),
        offer.code,
      );
      await page.waitForFunction(
        () => (window as unknown as { outcome: unknown }).outcome !== null,
        {},
        { timeout: 30000 },
      );
      expect(
        await page.evaluate(
          () => (window as unknown as { outcome: unknown }).outcome,
        ),
      ).toEqual({ ok: true, label: "Phone" });
      await expect(offer.completion).resolves.toMatchObject({ label: "Phone" });
    } finally {
      await offer.close();
      await env.close();
    }
  },
  60000,
);
