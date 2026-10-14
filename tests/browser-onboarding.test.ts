import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

type ReadyWindow = Window & { qa?: { wasmReady: boolean } };

async function preview() {
  const source = `
    import {ready} from '@serenity-kit/opaque';
    import {createBrowserApp} from './web/browser-app.ts';
    import {consumePairingLink,watchPairingLinks} from './web/pairing-link.ts';
    import {createSurfaceMount} from './web/surface.tsx';
    import {demoSurface} from './web/demo.ts';
    const grant={hostId:'651f06dd-8e07-4c3e-acd4-1ac5db41b49a',grantId:'af0fe33e-d3af-40ab-9b29-f6b722562f09',roomId:'c5bf44c5-3e6d-40f9-8476-6a668d136903',secret:'a'.repeat(43),label:'My browser',expiresAt:'2099-01-01T00:00:00Z'};
    const invitation={version:1,roomId:grant.roomId,secret:grant.secret,label:'Host offer',expiresAt:'2020-01-01T00:00:00Z'};
    const joined=[];let accept;
    const decode=encoded=>{
      if(location.hash)throw Error('Fragment was not removed');
      if(encoded!=='valid')throw Error('Invalid test link');
      return invitation;
    };
    const link=consumePairingLink(location,history,decode);
    const app=createBrowserApp(document,{
      join:(input,label)=>{joined.push({input,label,hash:location.hash});return{completion:new Promise(r=>accept=r),close:async()=>{}};},
      connect:async()=>({hostId:grant.hostId,hostEpoch:crypto.randomUUID(),close:async()=>{},request:async op=>op==='profiles.list'?{profiles:[{id:'my-context',provider:'custom-agent'}]}:{sessions:[]}}),
      copy:async()=>{},storage:localStorage
    },link);
    watchPairingLinks(window,decode,link=>app.openPairingLink(link));

    window.qa={joined,accept:()=>accept(grant),disconnect:()=>app.disconnect(),wasmReady:false};
    await ready;window.qa.wasmReady=true;
  `;
  const bundled = await build({
    stdin: { contents: source, resolveDir: process.cwd() },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
  });
  const html = await readFile("public/live/index.html", "utf8");
  const css = await readFile("public/styles.css", "utf8");
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname === "/app.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundled.outputFiles[0]!.text);
    } else if (url.pathname === "/styles.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(css);
    } else if (url.pathname === "/favicon.svg") {
      response.setHeader("Content-Type", "image/svg+xml");
      response.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(html);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

it("runs host setup, QR removal, explicit remember and local controls under the app CSP", async () => {
  const app = await preview();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
      });
      const page = await context.newPage();
      const errors: string[] = [];
      const external: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.route("**/*", (route) => {
        if (route.request().url().startsWith(app.url)) return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      await page.goto(app.url + "/#app");
      await page.waitForFunction(() => (window as ReadyWindow).qa?.wasmReady);
      expect(await page.evaluate("window.qa.joined")).toEqual([]);
      expect(await page.locator("#agent-prompt").isVisible()).toBe(true);
      expect(await page.locator("#create-session-panel").isVisible()).toBe(
        false,
      );
      const policy = await page
        .locator('meta[http-equiv="Content-Security-Policy"]')
        .getAttribute("content");
      expect(policy).toContain("'wasm-unsafe-eval'");
      expect(policy).not.toContain("'unsafe-eval'");
      await page.goto(app.url + "/#pair=%broken");
      await page.waitForFunction(() => (window as ReadyWindow).qa?.wasmReady);
      await page.waitForFunction(() => location.hash === "");
      expect(new URL(page.url()).hash).toBe("");
      expect(await page.evaluate("window.qa.joined")).toEqual([]);
      expect(await page.locator("#app-feedback").innerText()).toContain(
        "invalid",
      );
      await page.goto(app.url + "/#pair=valid");
      await page.waitForFunction(() => (window as ReadyWindow).qa?.wasmReady);
      await page.waitForFunction(() => location.hash === "");
      expect(new URL(page.url()).hash).toBe("");
      expect(await page.evaluate("window.qa.joined.length")).toBe(1);
      expect(await page.evaluate("window.qa.joined[0].hash")).toBe("");
      expect(await page.locator("#remember-connected-host").isVisible()).toBe(
        false,
      );
      await page.evaluate("window.qa.accept()");
      await page
        .locator("#remember-connected-host")
        .waitFor({ state: "visible" });
      expect(await page.evaluate("localStorage.length")).toBe(0);
      await page.locator("#remember-connected-host").click();
      expect(
        await page.evaluate("localStorage.getItem('p2pme.hosts.v1')"),
      ).toContain("grantId");
      await page.evaluate("window.qa.disconnect()");
      expect(await page.locator("#remember-connected-host").isVisible()).toBe(
        false,
      );
      expect(await page.locator("#create-session-panel").isVisible()).toBe(
        false,
      );
      expect(await page.evaluate("document.documentElement.scrollWidth")).toBe(
        width,
      );
      expect(errors).toEqual([]);
      expect(external).toEqual([]);
      await context.close();
    }
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(app.url);
    expect(await page.locator("#agent-prompt").isVisible()).toBe(true);
    expect(await page.locator("#create-session-panel").isVisible()).toBe(false);
    await context.close();
  } finally {
    await browser.close();
    await app.close();
  }
}, 30000);
