import { staticPreview } from "./browser-static-fixture.js";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("serves the minified live app as real static files without ordinary discovery", async () => {
  const app = await staticPreview();
  const browser = await chromium.launch();
  try {
    expect((await fetch(app.url + "/missing-route/")).status).toBe(404);
    for (const width of [320, 390, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: 950 },
      });
      await context.addInitScript(() => {
        const counts = { sockets: 0, peers: 0 };
        Object.assign(window, { networkCounts: counts });
        window.WebSocket = new Proxy(window.WebSocket, {
          construct(target, args) {
            counts.sockets++;
            return Reflect.construct(target, args);
          },
        });
        window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
          construct(target, args) {
            counts.peers++;
            return Reflect.construct(target, args);
          },
        });
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(app.url + "/");
      expect(await page.locator("#local-demo input").count()).toBeGreaterThan(
        0,
      );
      expect(await page.locator("#app").count()).toBe(0);
      expect(
        await page
          .getByRole("link", { name: "Live session", exact: true })
          .count(),
      ).toBeGreaterThan(0);
      expect(await page.evaluate("window.networkCounts")).toEqual({
        sockets: 0,
        peers: 0,
      });
      const homeAsset = await page
        .locator('script[type="module"]')
        .getAttribute("src");
      await page.goto(app.url + "/live");
      expect(new URL(page.url()).pathname).toBe("/live/");
      await page.locator("#pairing-code").waitFor();
      expect(await page.locator("#local-demo,.hero").count()).toBe(0);
      expect(await page.locator("#create-session-panel").isVisible()).toBe(
        false,
      );
      expect(
        await page.locator('script[type="module"]').getAttribute("src"),
      ).toBe(homeAsset);
      expect(homeAsset).toMatch(/app\.js\?v=0\.2\.0$/);
      expect(await page.evaluate("window.networkCounts")).toEqual({
        sockets: 0,
        peers: 0,
      });
      expect(await page.evaluate("document.documentElement.scrollWidth")).toBe(
        width,
      );
      await page.goto(app.url + "/#about");
      await page.evaluate(() => {
        location.hash = "app";
      });
      await page.waitForURL(app.url + "/live/");
      await page.goto(app.url + "/#pair=%broken");
      await page.waitForFunction(
        () => location.pathname === "/live/" && location.hash === "",
      );
      expect(await page.locator("#app-feedback").innerText()).toContain(
        "LINK_INVALID",
      );
      expect(await page.evaluate("window.networkCounts")).toEqual({
        sockets: 0,
        peers: 0,
      });
      expect(errors).toEqual([]);
      await context.close();
    }
  } finally {
    await browser.close();
    await app.close();
  }
}, 30000);
