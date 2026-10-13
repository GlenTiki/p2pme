import { createSurfaceMount } from "./surface.js";
import { demoSurface } from "./demo.js";
import { beginPairing } from "../src/pairing.js";
import { connectHost } from "../src/host-client.js";
import { createBrowserApp } from "./browser-app.js";

export { createSurfaceMount } from "./surface.js";

const browser = document.getElementById("app")
  ? createBrowserApp(document, {
      pair: beginPairing,
      connect: connectHost,
      copy: (text) => navigator.clipboard.writeText(text),
      storage: {
        getItem: (key) => localStorage.getItem(key),
        setItem: (key, value) => localStorage.setItem(key, value),
        removeItem: (key) => localStorage.removeItem(key),
      },
    })
  : undefined;

export function mountApprovedSurface(sessionId: string, surface: unknown) {
  if (!browser) throw new Error("The host app is not mounted.");
  browser.mountApprovedSurface(sessionId, surface);
}

const demo = document.getElementById("local-demo");
const result = document.getElementById("local-demo-result");
if (demo && result) {
  createSurfaceMount(demo).mountSurface(
    "651f06dd-8e07-4c3e-acd4-1ac5db41b49a",
    demoSurface,
    (action) => {
      result.textContent = JSON.stringify(action, null, 2);
    },
  );
}
