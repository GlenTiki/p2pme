// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserApp,
  type BrowserDependencies,
} from "../web/browser-app.js";
import type { JsonValue } from "../src/host-protocol.js";
import type { HostClient, ClientOptions } from "../src/host-client.js";
import type { ConnectionRecord } from "../src/rtc-identity.js";
import { createEnvelope } from "../src/protocol.js";
import { act } from "react";
import { demoSurface } from "../web/demo.js";

const host: ConnectionRecord = {
  hostId: "651f06dd-8e07-4c3e-acd4-1ac5db41b49a",
  grantId: "af0fe33e-d3af-40ab-9b29-f6b722562f09",
  roomId: "c5bf44c5-3e6d-40f9-8476-6a668d136903",
  secret: "a".repeat(43),
  label: "My phone",
  expiresAt: "2099-01-01T00:00:00Z",
};
const session = {
  id: "8e21fba8-f5bd-4d35-b744-3a44bc3a6898",
  provider: "codex",
  providerSessionId: "thread1",
  profileId: "codex",
  label: "Project",
  modelId: "default",
  createdAt: "2026-10-13T00:00:00Z",
  online: true,
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let app: ReturnType<typeof createBrowserApp>;
let options: ClientOptions | undefined;
let client: HostClient;
let deps: BrowserDependencies;
let acceptPair!: (value: ConnectionRecord) => void;
function el<T extends HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}
async function submit(id: string) {
  el(id).dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
  await tick();
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  options = undefined;
  document.body.innerHTML = readFileSync("public/index.html", "utf8");
  localStorage.clear();
  client = {
    hostId: host.hostId,
    hostEpoch: crypto.randomUUID(),
    request: vi.fn(async (op) =>
      op === "ui.get" ? { surface: null } : { sessions: [session] },
    ),
    close: vi.fn(async () => {}),
  };
  deps = {
    storage: localStorage,
    copy: vi.fn(async () => {}),
    connect: vi.fn(async (_record, callbacks) => {
      options = callbacks;
      return client;
    }),
    pair: vi.fn(() => ({
      invitation: {
        version: 1 as const,
        roomId: host.roomId,
        secret: host.secret,
        label: "Phone",
        expiresAt: "2099-01-01T00:00:00Z",
      },
      completion: new Promise<ConnectionRecord>((resolve) => {
        acceptPair = resolve;
      }),
      close: vi.fn(async () => {}),
    })),
  };
});
afterEach(async () => {
  await act(async () => {
    await app?.dispose();
  });
});
describe("browser connection controls", () => {
  it("loads selected agent controls and accepts newer live surfaces", async () => {
    client.request = vi.fn(async (op) =>
      op === "ui.get"
        ? { surface: JSON.parse(JSON.stringify(demoSurface)) as JsonValue }
        : { sessions: [session] },
    );
    app = createBrowserApp(document, deps);
    await submit("connect-form");
    acceptPair(host);
    await tick();
    await act(async () => {
      el("session-list").querySelector<HTMLButtonElement>("button")!.click();
      await tick();
    });
    expect(client.request).toHaveBeenCalledWith("ui.get", {
      sessionId: session.id,
    });
    expect(el("agent-controls").hidden).toBe(false);
    await act(async () => {
      options?.onEvent?.(
        createEnvelope(session.id, "ui.render", {
          surface: { ...demoSurface, revision: 2 },
        }),
      );
    });
    await act(async () => {
      el("session-surface").querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(client.request).toHaveBeenCalledWith(
      "ui.action",
      expect.objectContaining({ revision: 2 }),
    );
  });

  it("honors an unchecked Remember option while the welcome is pending", async () => {
    let connected!: (value: HostClient) => void;
    deps.connect = vi.fn(
      () =>
        new Promise<HostClient>((resolve) => {
          connected = resolve;
        }),
    );
    app = createBrowserApp(document, deps);
    el<HTMLInputElement>("remember-host").checked = true;
    await submit("connect-form");
    acceptPair(host);
    await tick();
    el<HTMLInputElement>("remember-host").checked = false;
    connected(client);
    await tick();
    expect(localStorage.getItem("p2pme.hosts.v1")).toBeNull();
  });

  it("ignores events and disconnect callbacks from a cancelled connection", async () => {
    app = createBrowserApp(document, deps);
    await submit("connect-form");
    acceptPair(host);
    await tick();
    const stale = options;
    await app.disconnect();
    const before = el("messages").textContent;
    stale?.onEvent?.(
      createEnvelope(
        session.id,
        "chat.completed",
        { text: "Stale output" },
        crypto.randomUUID(),
      ),
    );
    stale?.onDisconnect?.(new Error("Stale failure"));
    expect(el("messages").textContent).toBe(before);
    expect(el("app-feedback").textContent).not.toContain("Stale failure");
  });

  it("does not re-save a remembered host when Remember is checked", async () => {
    const setItem = vi.fn();
    deps.storage = {
      getItem: () => JSON.stringify([host]),
      setItem,
      removeItem: () => {},
    };
    app = createBrowserApp(document, deps);
    el<HTMLInputElement>("remember-host").checked = true;
    el("host-list").querySelector<HTMLButtonElement>("button")!.click();
    await tick();
    expect(setItem).not.toHaveBeenCalled();
  });
  it("leaves valid hosts available beside an expired grant", () => {
    localStorage.setItem(
      "p2pme.hosts.v1",
      JSON.stringify([
        {
          ...host,
          hostId: crypto.randomUUID(),
          expiresAt: "2020-01-01T00:00:00Z",
        },
        host,
      ]),
    );
    app = createBrowserApp(document, deps);
    const buttons =
      el("host-list").querySelectorAll<HTMLButtonElement>("button");
    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[2]?.disabled).toBe(false);
  });

  it("does not use credentials forgotten by another tab", async () => {
    localStorage.setItem("p2pme.hosts.v1", JSON.stringify([host]));
    app = createBrowserApp(document, deps);
    localStorage.removeItem("p2pme.hosts.v1");
    el("host-list").querySelector<HTMLButtonElement>("button")!.click();
    await tick();
    expect(deps.connect).not.toHaveBeenCalled();
    expect(el("app-feedback").textContent).toContain("forgotten");
  });

  it("refreshes session state and blocks a duplicate create", async () => {
    app = createBrowserApp(document, deps);
    await submit("connect-form");
    acceptPair(host);
    await tick();
    el("session-list").querySelector<HTMLButtonElement>("button")!.click();
    let created!: (value: { session: typeof session }) => void;
    client.request = vi.fn(async (op) =>
      op === "sessions.create"
        ? new Promise<{ session: typeof session }>((resolve) => {
            created = resolve;
          })
        : { sessions: [{ ...session, online: false }] },
    );
    el<HTMLInputElement>("session-label").value = "New session";
    await submit("create-session-form");
    await submit("create-session-form");
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(el<HTMLButtonElement>("create-session").disabled).toBe(true);
    created({ session });
    await tick();
    expect(el<HTMLButtonElement>("send-message").disabled).toBe(true);
    expect(el("app-feedback").textContent).toContain("Session created");
  });

  it("clears delegation and old surfaces when a new session is selected", async () => {
    const next = { ...session, id: crypto.randomUUID(), label: "Second" };
    client.request = vi.fn(async (op) =>
      op === "ui.get" ? { surface: null } : { sessions: [session, next] },
    );
    app = createBrowserApp(document, deps);
    await submit("connect-form");
    acceptPair(host);
    await tick();
    el("session-list").querySelector<HTMLButtonElement>("button")!.click();
    await act(async () => {
      app.mountApprovedSurface(session.id, demoSurface);
    });
    const oldButton =
      el("session-surface").querySelector<HTMLButtonElement>("button")!;
    el<HTMLInputElement>("delegate-task").checked = true;
    await act(async () => {
      el("session-list")
        .querySelectorAll<HTMLButtonElement>("button")[1]!
        .click();
    });
    expect(el<HTMLInputElement>("delegate-task").checked).toBe(false);
    await act(async () => {
      oldButton.click();
    });
    expect(client.request).toHaveBeenCalledTimes(3);
  });
  it("keeps a live connection when credential storage fails", async () => {
    deps.storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {},
    };
    app = createBrowserApp(document, deps);
    el<HTMLInputElement>("remember-host").checked = true;
    await submit("connect-form");
    acceptPair(host);
    await tick();
    expect(el("connection-status-text").textContent).toBe("Connected to host");
    expect(el("app-feedback").textContent).toContain("could not save");
    expect(el("session-list").textContent).toContain("Project");
  });

  it("isolates generated controls to the selected connected session", async () => {
    app = createBrowserApp(document, deps);
    expect(() => app.mountApprovedSurface(session.id, demoSurface)).toThrow();
    await submit("connect-form");
    acceptPair(host);
    await tick();
    el("session-list").querySelector<HTMLButtonElement>("button")!.click();
    expect(() =>
      app.mountApprovedSurface(crypto.randomUUID(), demoSurface),
    ).toThrow();
    await act(async () => {
      app.mountApprovedSurface(session.id, demoSurface);
    });
    await act(async () => {
      el("session-surface").querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(client.request).toHaveBeenCalledWith(
      "ui.action",
      expect.objectContaining({
        sessionId: session.id,
        surfaceId: demoSurface.surfaceId,
        revision: 1,
      }),
    );
    await act(async () => {
      await app.disconnect();
    });
    expect(el("session-surface").textContent).toBe("");
  });
  it("loads remembered hosts without network activity", () => {
    localStorage.setItem("p2pme.hosts.v1", JSON.stringify([host]));
    app = createBrowserApp(document, deps);
    expect(deps.connect).not.toHaveBeenCalled();
    expect(deps.pair).not.toHaveBeenCalled();
    expect(el("host-list").textContent).toContain("My phone");
    expect(el<HTMLButtonElement>("send-message").disabled).toBe(true);
  });
  it("clears invalid saved-host feedback after the browser forgets it", async () => {
    localStorage.setItem("p2pme.hosts.v1", "invalid");
    app = createBrowserApp(document, deps);
    expect(el("app-feedback").textContent).toContain(
      "Saved host data is invalid",
    );
    el<HTMLButtonElement>("forget-all-hosts").click();
    await tick();
    expect(localStorage.getItem("p2pme.hosts.v1")).toBeNull();
    expect(el("host-list").textContent).toContain("No saved hosts");
    expect(el("app-feedback").textContent).toBe("");
  });

  it("handles invalid saved data without a connection", () => {
    localStorage.setItem("p2pme.hosts.v1", "broken");
    app = createBrowserApp(document, deps);
    expect(el("app-feedback").textContent).toContain("Saved host data");
    expect(deps.connect).not.toHaveBeenCalled();
  });
  it("stores a paired grant only after welcome and explicit remember choice", async () => {
    let connected!: (value: HostClient) => void;
    deps.connect = vi.fn(
      () =>
        new Promise<HostClient>((resolve) => {
          connected = resolve;
        }),
    );
    app = createBrowserApp(document, deps);
    el<HTMLInputElement>("remember-host").checked = true;
    await submit("connect-form");
    acceptPair(host);
    await tick();
    expect(localStorage.getItem("p2pme.hosts.v1")).toBeNull();
    connected(client);
    await tick();
    expect(localStorage.getItem("p2pme.hosts.v1")).toContain(host.grantId);
    expect(el("session-list").textContent).toContain("Project");
  });
  it("does not remember a new connection by default", async () => {
    app = createBrowserApp(document, deps);
    await submit("connect-form");
    acceptPair(host);
    await tick();
    expect(localStorage.getItem("p2pme.hosts.v1")).toBeNull();
  });
  it("closes a late connection after cancellation", async () => {
    let connected!: (value: HostClient) => void;
    deps.connect = vi.fn((_record, callbacks) => {
      options = callbacks;
      return new Promise<HostClient>((resolve) => {
        connected = resolve;
      });
    });
    app = createBrowserApp(document, deps);
    await submit("connect-form");
    acceptPair(host);
    await tick();
    el<HTMLButtonElement>("disconnect-host").click();
    await tick();
    expect(options?.signal?.aborted).toBe(true);
    connected(client);
    await tick();
    expect(client.close).toHaveBeenCalled();
    expect(el<HTMLButtonElement>("send-message").disabled).toBe(true);
    expect(localStorage.getItem("p2pme.hosts.v1")).toBeNull();
  });
  it("requires selection, streams actual output, and routes delegation separately", async () => {
    localStorage.setItem("p2pme.hosts.v1", JSON.stringify([host]));
    app = createBrowserApp(document, deps);
    el("host-list").querySelector<HTMLButtonElement>("button")!.click();
    await tick();
    expect(el<HTMLButtonElement>("send-message").disabled).toBe(true);
    el("session-list").querySelector<HTMLButtonElement>("button")!.click();
    el<HTMLTextAreaElement>("message-input").value = "Hello";
    await submit("message-form");
    expect(client.request).toHaveBeenCalledWith("sessions.chat", {
      sessionId: session.id,
      text: "Hello",
    });
    options?.onEvent?.(
      createEnvelope(
        session.id,
        "chat.delta",
        { text: "Real " },
        crypto.randomUUID(),
      ),
    );
    const reply = crypto.randomUUID();
    options?.onEvent?.(
      createEnvelope(session.id, "chat.delta", { text: "partial" }, reply),
    );
    options?.onEvent?.(
      createEnvelope(
        session.id,
        "chat.completed",
        { text: "Actual answer" },
        reply,
      ),
    );
    expect(el("messages").textContent).toContain("Actual answer");
    el<HTMLInputElement>("delegate-task").checked = true;
    el<HTMLTextAreaElement>("message-input").value = "Inspect this";
    await submit("message-form");
    expect(client.request).toHaveBeenCalledWith("tasks.delegate", {
      sessionId: session.id,
      text: "Inspect this",
    });
  });
  it("reports copy failure and creation permission errors", async () => {
    deps.copy = vi.fn(async () => {
      throw new Error("denied");
    });
    app = createBrowserApp(document, deps);
    await submit("connect-form");
    el<HTMLButtonElement>("copy-invitation").click();
    await tick();
    expect(el("app-feedback").textContent).toContain("Copy failed");
    acceptPair(host);
    await tick();
    client.request = vi.fn(async () => {
      throw new Error("forbidden: Missing sessions:create scope");
    });
    el<HTMLInputElement>("session-label").value = "Test";
    await submit("create-session-form");
    expect(el("app-feedback").textContent).toContain("sessions:create");
  });
});
