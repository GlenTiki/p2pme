import { beforeAll, afterAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { staticPreview } from "./browser-static-fixture.js";

let app: Awaited<ReturnType<typeof staticPreview>>;
let browser: Browser;
beforeAll(async () => {
  app = await staticPreview();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await app?.close();
});

it("copies the visible host instruction with click, Enter and Space under its CSP", async () => {
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.addInitScript(() => {
    Object.assign(window, { connections: 0, violations: 0 });
    for (const name of ["WebSocket", "RTCPeerConnection"] as const) {
      Object.defineProperty(window, name, {
        value: new Proxy(window[name], {
          construct() {
            Object.assign(window, { connections: 1 });
            throw Error("Unexpected connection");
          },
        }),
      });
    }
    document.addEventListener("securitypolicyviolation", () =>
      Object.assign(window, { violations: 1 }),
    );
  });
  for (const activation of ["click", "Enter", "Space"]) {
    await page.goto(app.url + "/host/");
    await page.locator("#copy-host-instruction").waitFor({ state: "visible" });
    expect(await page.locator("#host-copy-status").textContent()).toBe("");
    await page.evaluate(() =>
      navigator.clipboard.writeText("p2pme-test-reset"),
    );
    const button = page.locator("#copy-host-instruction");
    if (activation === "click") await button.click();
    else {
      await button.focus();
      await button.press(activation);
    }
    await page
      .locator("#host-copy-status")
      .filter({ hasText: "Instruction copied." })
      .waitFor();
    expect(
      await page.evaluate(
        async () =>
          (await navigator.clipboard.readText()) ===
          (document.getElementById("host-instruction") as HTMLTextAreaElement)
            .value,
      ),
    ).toBe(true);
  }
  expect(await page.evaluate("window.connections")).toBe(0);
  expect(await page.evaluate("window.violations")).toBe(0);
  expect(failures).toEqual([]);
  expect(
    requests.every((request) => {
      const url = new URL(request);
      return (
        url.origin === app.url &&
        ["/host/", "/host.js", "/styles.css", "/favicon.svg"].includes(
          url.pathname,
        )
      );
    }),
  ).toBe(true);
  const policy = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  expect(policy).toContain("connect-src 'none'");
  expect(policy).not.toContain("wasm");
  expect(await page.locator('script[type="module"]').getAttribute("src")).toBe(
    "/host.js?v=host-setup-1",
  );
  const bundle = await fetch(app.url + "/host.js?v=host-setup-1");
  expect(bundle.status).toBe(200);
  expect((await bundle.text()).length).toBeLessThan(3000);
  await context.close();
});

it.each(["denied", "unavailable", "synchronous"])(
  "selects the instruction when clipboard access is %s",
  async (mode) => {
    const context = await browser.newContext();
    await context.addInitScript((mode) => {
      Object.defineProperty(navigator, "clipboard", {
        value:
          mode === "unavailable"
            ? undefined
            : {
                writeText() {
                  if (mode === "synchronous")
                    throw Error("private clipboard error");
                  return Promise.reject(Error("private clipboard error"));
                },
              },
      });
    }, mode);
    const page = await context.newPage();
    await page.goto(app.url + "/host/");
    await page.locator("#copy-host-instruction").click();
    await page
      .locator("#host-copy-status")
      .filter({ hasText: "Copy failed. Copy the selected text manually." })
      .waitFor();
    expect(
      await page.evaluate(() => {
        const field = document.getElementById(
          "host-instruction",
        ) as HTMLTextAreaElement;
        return (
          document.activeElement === field &&
          field.selectionStart === 0 &&
          field.selectionEnd === field.value.length
        );
      }),
    ).toBe(true);
    expect(await page.locator("#host-copy-status").textContent()).not.toContain(
      "private",
    );
    await context.close();
  },
);

it("shows success only after the clipboard write completes", async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText() {
          return new Promise<void>((resolve) =>
            Object.assign(window, { finishCopy: resolve }),
          );
        },
      },
    });
  });
  const page = await context.newPage();
  await page.goto(app.url + "/host/");
  await page.locator("#copy-host-instruction").click();
  expect(await page.locator("#host-copy-status").textContent()).toBe("");
  await page.evaluate("window.finishCopy()");
  await page
    .locator("#host-copy-status")
    .filter({ hasText: "Instruction copied." })
    .waitFor();
  await context.close();
});

it("keeps the full instruction available before manual steps at phone and desktop widths", async () => {
  for (const width of [320, 390, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 950 },
    });
    const page = await context.newPage();
    await page.goto(app.url + "/host/");
    const field = page.locator("#host-instruction");
    expect(await field.getAttribute("readonly")).not.toBeNull();
    expect(await field.inputValue()).toContain(
      "Do not create another agent session.",
    );
    expect(
      await page.evaluate(() =>
        Boolean(
          document
            .getElementById("host-instruction")!
            .compareDocumentPosition(document.getElementById("install")!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ),
    ).toBe(true);
    expect(await page.evaluate("document.documentElement.scrollWidth")).toBe(
      width,
    );
    expect(
      (await page.locator("#copy-host-instruction").boundingBox())!.height,
    ).toBeGreaterThanOrEqual(44);
    await context.close();
  }
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(app.url + "/host/");
  expect(await page.locator("#host-instruction").isVisible()).toBe(true);
  expect(await page.locator("#copy-host-instruction").isVisible()).toBe(false);
  expect(
    await page
      .getByText("You can also select and copy the instruction manually.")
      .isVisible(),
  ).toBe(true);
  await context.close();
});
