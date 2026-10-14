import { staticPreview } from "./browser-static-fixture.js";
import {
  localNostrRelay,
  routeProductionDiscovery,
} from "./browser-relay-fixture.js";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium, type BrowserContext, type Page } from "playwright";
import { createWsRelayServer } from "@trystero-p2p/ws-relay/server";
import { joinRoom } from "@trystero-p2p/ws-relay";
import { RTCPeerConnection } from "werift";
import { expect, it } from "vitest";
import { createHost, type SessionAdapter } from "../src/host.js";
import { openHostStore } from "../src/host-store.js";
import { offerHostPairing } from "../src/host-pairing.js";
import { serveHostConnection } from "../src/host-connection.js";
import { createHostInvitationUrl, randomSecret } from "../src/rtc-identity.js";
import type { RtcChannel } from "../src/rtc-channel.js";
import { demoSurface } from "../web/demo.js";

async function serveApp(
  network: { relayUrls: string[]; iceServers: never[] },
  production = false,
) {
  if (production) return staticPreview();
  const source = `
    import {createBrowserApp} from './web/browser-app.ts';
    import {joinHostPairing} from './src/host-pairing.ts';
    import {connectHost} from './src/host-client.ts';
    import {joinRoom} from '@trystero-p2p/ws-relay';
    const network={...${JSON.stringify(network)},join:joinRoom};
    window.app=createBrowserApp(document,{
      join:(input,label)=>joinHostPairing(input,label,{network}),
      connect:(grant,options)=>connectHost(grant,{...options,network}),
      copy:async()=>{},storage:localStorage
    });`;
  const bundled = await build({
    stdin: { contents: source, resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
  });
  const script = bundled.outputFiles[0]!.text;
  const html = (await readFile("public/live/index.html", "utf8")).replace(
    "connect-src 'self'",
    `connect-src 'self' ${network.relayUrls[0]}`,
  );
  const css = await readFile("public/styles.css", "utf8");
  const server = createServer((request, response) => {
    if (new URL(request.url!, "http://localhost").pathname === "/app.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end(script);
    } else if (
      new URL(request.url!, "http://localhost").pathname === "/styles.css"
    ) {
      response.setHeader("Content-Type", "text/css");
      response.end(css);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(html);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No HTTP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function relayFixture(production: boolean) {
  const nostr = production ? await localNostrRelay() : undefined;
  const relay = createWsRelayServer({ port: 0, host: "127.0.0.1" });
  await relay.ready;
  const address = relay.address();
  if (!address || typeof address === "string") throw Error("No relay port");
  const network = {
    relayUrls: [nostr?.url ?? `ws://127.0.0.1:${address.port}`],
    iceServers: [] as never[],
  };
  const native = {
    ...network,
    ...(!production ? { join: joinRoom } : {}),
    rtcPolyfill:
      RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
  };
  return {
    network,
    native,
    configure: async (context: BrowserContext) => {
      if (nostr) await routeProductionDiscovery(context, nostr.url);
    },
    close: async () => {
      await relay.close();
      await nostr?.close();
    },
  };
}

async function enterInvitation(
  mode: string,
  page: Page,
  appUrl: string,
  offer: Awaited<ReturnType<typeof offerHostPairing>>,
) {
  if (mode === "qr" || mode === "root-qr") {
    expect(await (await fetch(appUrl + "/")).text()).toContain(
      'id="hero-title"',
    );
    expect((await fetch(appUrl + "/missing-route/")).status).toBe(404);
    await page.goto("about:blank");
    const base = appUrl + (mode === "qr" ? "/live/" : "/");
    const discovered: string[] = [];
    page.on("websocket", () => discovered.push(new URL(page.url()).pathname));
    await page.goto(createHostInvitationUrl(offer.invitation, base));
    await page.waitForURL(appUrl + "/live/");
    await page
      .locator("#remember-connected-host")
      .waitFor({ state: "visible" });
    expect(new URL(page.url()).hash).toBe("");
    expect(discovered).not.toContain("/");
    expect(await page.locator("#local-demo").count()).toBe(0);
    await page.locator("#remember-connected-host").click();
  } else {
    await page.locator("#pairing-code").fill(offer.code);
    await page.locator("#connect-host").click();
  }
}

it.each(["injected", "code", "qr", "root-qr"])(
  "pairs the browser UI and delivers messages and surface actions (%s)",
  async (mode) => {
    const production = mode !== "injected";
    const relay = await relayFixture(production);
    const { network, native } = relay;
    const directory = await mkdtemp(join(tmpdir(), "p2pme-browser-flow-"));
    const store = await openHostStore(directory);
    let permanent: RtcChannel | undefined;
    const host = await createHost({
      store,
      profiles: [
        {
          id: "test",
          provider: "test",
          models: ["local"],
          defaultModelId: "local",
        },
      ],
      emit: async (_grantId, event) => {
        await permanent?.send(JSON.stringify(event));
      },
    });
    const submitted: string[] = [];
    const adapter: SessionAdapter = {
      submit: async (input, emit) => {
        submitted.push(input.text);
        await emit({ type: "completed", text: "Action received" });
      },
      configure: async () => {},
      detach: async () => {},
    };
    const session = await host.attach({
      profileId: "test",
      providerSessionId: "synthetic",
      label: "Browser test session",
      adapter,
    });
    const grant = {
      hostId: host.hostId,
      grantId: crypto.randomUUID(),
      roomId: crypto.randomUUID(),
      secret: randomSecret(),
      label: "Browser test",
      expiresAt: new Date(Date.now() + 3600000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
    };
    const app = await serveApp(network, production);
    const browser = await chromium.launch({
      headless: true,
      args: production ? [] : ["--disable-features=WebRtcHideLocalIpsWithMdns"],
    });
    let offer: Awaited<ReturnType<typeof offerHostPairing>> | undefined;
    try {
      const context = await browser.newContext();
      await relay.configure(context);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.url + "/live/");
      if (!production)
        await page.waitForFunction(() => Object.hasOwn(window, "app"));
      await page.locator("#device-label").fill("Test browser");
      await page.locator("#remember-host").check();
      offer = await offerHostPairing({
        label: "Browser test host",
        network: native,
        authorize: async (label) => {
          grant.label = label;
          return {
            record: grant,
            persist: (beginCommit) =>
              store.update((state) => {
                beginCommit();
                state.grants.push({
                  id: grant.grantId,
                  deviceId: crypto.randomUUID(),
                  principal: "human-device",
                  label: grant.label,
                  roomId: grant.roomId,
                  roomSecret: grant.secret,
                  createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
                  expiresAt: grant.expiresAt,
                  revokedAt: null,
                  scopes: ["sessions:list", "sessions:chat", "ui:action"],
                  sessionAccess: [session.id],
                  profileIds: ["test"],
                });
              }),
            activate: async () => {
              permanent = serveHostConnection(grant, {
                network: native,
                hostEpoch: host.hostEpoch,
                active: () => store.healthy,
                dispatch: (frame) =>
                  host.dispatch(grant.grantId, JSON.parse(frame)),
              });
            },
          };
        },
      });
      await enterInvitation(mode, page, app.url, offer);
      await offer.completion;
      await offer.close();
      await page
        .getByRole("button", {
          name: "Browser test session · test",
          exact: true,
        })
        .click();
      await page
        .locator("#selected-session")
        .filter({ hasText: "Browser test session" })
        .waitFor();
      await page.locator("#message-input").fill("A synthetic live message");
      await page.locator("#send-message").click();
      await page
        .locator("#messages")
        .getByText("Action received", { exact: true })
        .waitFor();
      expect(submitted.shift()).toBe("A synthetic live message");
      await host.publishSurface(session.id, demoSurface);
      const surface = page.locator("#session-surface");
      await surface
        .getByLabel("Task", { exact: true })
        .fill("Review the peer boundary");
      await surface.getByLabel("Show a task note").check();
      expect(
        await surface.getByRole("heading", { name: "Task note" }).isVisible(),
      ).toBe(true);
      await surface.getByRole("button", { name: "Try a local action" }).click();
      await expect
        .poll(
          () =>
            page
              .locator("#messages")
              .getByText("Action received", { exact: true })
              .count(),
          { timeout: 30000 },
        )
        .toBe(2);
      await expect.poll(() => submitted.length).toBe(1);
      expect(JSON.parse(submitted[0]!)).toMatchObject({
        type: "ui.action",
        sessionId: session.id,
        surfaceId: demoSurface.surfaceId,
        revision: 1,
        actionId: "submit-task",
        values: { task: "Review the peer boundary", details: true },
      });
      expect(
        await page.evaluate("localStorage.getItem('p2pme.hosts.v1')"),
      ).toContain(grant.hostId);
      if (production) {
        await page.locator("#disconnect-host").click();
        await page.goto(app.url + "/");
        expect(
          await page.evaluate("localStorage.getItem('p2pme.hosts.v1')"),
        ).toContain(grant.hostId);
        await page.goto(app.url + "/live/");
        await page
          .locator("#host-list")
          .getByRole("button", { name: "Connect", exact: true })
          .click();
        await page
          .locator("#session-list")
          .getByRole("button", {
            name: "Browser test session · test",
            exact: true,
          })
          .waitFor({ state: "visible" });
      }
      expect(errors).toEqual([]);
      if (!production) await page.evaluate("window.app.dispose()");
    } finally {
      await offer?.close();
      await browser.close();
      await permanent?.close();
      await host.close();
      await relay.close();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);
