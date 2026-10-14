import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import {
  startDaemon,
  type Daemon,
  type DaemonTransport,
  type DaemonOptions,
} from "../src/daemon.js";
import { controlRequest } from "../src/local-client.js";
import { createInvitation, encodeInvitation } from "../src/rtc-identity.js";
import { DaemonControl } from "../src/daemon-control.js";
import type { HostStore } from "../src/host-store.js";
import type { SessionAdapter } from "../src/host-types.js";

const daemons: Daemon[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const adapter: SessionAdapter = {
  async submit() {},
  async configure() {},
  async detach() {},
};
async function fixture(approve = true) {
  const directory = await mkdtemp(join(tmpdir(), "p2pme-daemon-"));
  directories.push(directory);
  const order: string[] = [];
  const transport: DaemonTransport = {
    async pair(_invitation, _record, options) {
      order.push("ack");
      await options.persist();
      order.push("persisted");
      await options.activate();
    },
    serve() {
      order.push("serve");
      return {
        connected: true,
        async send() {},
        async close() {
          order.push("close");
        },
      };
    },
  };
  const options: DaemonOptions = {
    stateDir: join(directory, "state"),
    workspace: directory,
    profiles: [
      {
        id: "fake",
        provider: "fake",
        models: ["small"],
        defaultModelId: "small",
        async create() {
          order.push("create");
          return { providerSessionId: "created", adapter };
        },
      },
    ],
    attachCodex: async () => adapter,
    transport,
    confirm: async (approval) => {
      expect(approval.profileIds).toEqual(["fake"]);
      order.push("confirm");
      return approve;
    },
  };
  const daemon = await startDaemon(options);
  daemons.push(daemon);
  const request = (op: string, args: Record<string, unknown> = {}) =>
    controlRequest(daemon.socketPath, { id: crypto.randomUUID(), op, args });
  const pair = () =>
    request("pair", {
      invitation: encodeInvitation(createInvitation("phone")),
      principal: "human-device",
      scopes: ["sessions:list", "sessions:chat"],
      profileIds: ["fake"],
    });
  return { directory, daemon, request, pair, order, transport, options };
}

describe("private local daemon", () => {
  it("refuses to replace a missing workspace policy when grants remain", async () => {
    const f = await fixture();
    await f.pair();
    await f.daemon.close();
    await unlink(join(f.directory, "state", "daemon.json"));
    await expect(
      startDaemon({ ...f.options, workspace: tmpdir() }),
    ).rejects.toThrow("state directory");
  });
  it("rejects a revoke for an unknown grant", async () => {
    const f = await fixture();
    await expect(
      f.request("revoke", { grantId: crypto.randomUUID() }),
    ).rejects.toThrow();
  });
  it("detaches a created adapter when its local requester disconnects", async () => {
    const f = await fixture();
    let entered = false;
    let detached = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.options.profiles[0]!.create = async () => {
      entered = true;
      await gate;
      return {
        providerSessionId: "late",
        adapter: {
          ...adapter,
          detach: async () => {
            detached = true;
          },
        },
      };
    };
    const socket = createConnection(f.daemon.socketPath);
    socket.on("error", () => {});
    socket.write(
      JSON.stringify({
        id: crypto.randomUUID(),
        op: "start",
        args: { profileId: "fake" },
      }) + "\n",
    );
    await expect.poll(() => entered).toBe(true);
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await expect.poll(() => detached).toBe(true);
    expect(f.daemon.host.sessions()).toEqual([]);
  });
  it("restores approved grants after a clean restart with sessions offline", async () => {
    const f = await fixture();
    await f.pair();
    await f.request("start", { profileId: "fake" });
    await f.daemon.close();
    const restored = await startDaemon(f.options);
    daemons.push(restored);
    expect(restored.host.hostId).toBe(f.daemon.host.hostId);
    expect(restored.host.sessions()[0]!.online).toBe(false);
    expect(f.order.filter((item) => item === "serve")).toHaveLength(2);
  });
  it("cancels pending pairing on local disconnect and bounds concurrent pair requests", async () => {
    const f = await fixture();
    let entered = false;
    let cancelled = false;
    f.transport.pair = async (_invitation, _grant, callbacks) => {
      entered = true;
      await new Promise<void>((_resolve, reject) =>
        callbacks.signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(new Error("cancelled"));
          },
          { once: true },
        ),
      );
    };
    const socket = createConnection(f.daemon.socketPath);
    socket.on("error", () => {});
    socket.write(
      JSON.stringify({
        id: crypto.randomUUID(),
        op: "pair",
        args: {
          invitation: encodeInvitation(createInvitation("phone")),
          principal: "human-device",
          scopes: ["sessions:list"],
          profileIds: ["fake"],
        },
      }) + "\n",
    );
    await expect.poll(() => entered).toBe(true);
    await expect(f.pair()).rejects.toThrow();
    socket.destroy();
    await expect.poll(() => cancelled).toBe(true);
    expect(f.daemon.store.snapshot().grants).toEqual([]);
  });
  it("does not commit an aborted grant queued behind an earlier store write", async () => {
    const f = await fixture();
    let queued = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store: HostStore = {
      hostId: f.daemon.store.hostId,
      healthy: true,
      snapshot: () => f.daemon.store.snapshot(),
      close: async () => {},
      update: async (change) => {
        queued = true;
        await gate;
        await f.daemon.store.update(change);
      },
    };
    const control = new DaemonControl({
      ...f.options,
      host: f.daemon.host,
      store,
      rooms: new Map(),
      policy: { workspace: f.directory, consume: async () => {} },
    });
    const abort = new AbortController();
    const request = control.handle(
      {
        id: crypto.randomUUID(),
        op: "pair",
        args: {
          invitation: encodeInvitation(createInvitation("phone")),
          principal: "human-device",
          scopes: ["sessions:list"],
          profileIds: ["fake"],
        },
      },
      abort.signal,
    );
    const rejected = expect(request).rejects.toThrow();
    await expect.poll(() => queued).toBe(true);
    abort.abort();
    release();
    await rejected;
    expect(f.daemon.store.snapshot().grants).toEqual([]);
    expect(f.order).not.toContain("serve");
  });
  it("does not activate a committed grant after daemon shutdown", async () => {
    const f = await fixture();
    let committed = false;
    let activated = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.transport.pair = async (_invitation, _grant, callbacks) => {
      await callbacks.persist();
      committed = true;
      await gate;
      await callbacks.activate();
      activated = true;
    };
    const request = f.pair();
    const rejected = expect(request).rejects.toThrow();
    await expect.poll(() => committed).toBe(true);
    await f.daemon.close();
    await rejected;
    release();
    await expect.poll(() => activated).toBe(true);
    expect(f.order).not.toContain("serve");
  });
  it("closes oversized local frames without dispatch", async () => {
    const f = await fixture();
    const socket = createConnection(f.daemon.socketPath);
    socket.on("error", () => {});
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    socket.write("x".repeat(32769));
    await closed;
    expect(f.order).toEqual([]);
  });
  it("binds a private socket and returns status without capabilities", async () => {
    const f = await fixture();
    expect((await stat(f.daemon.socketPath)).mode & 0o777).toBe(0o600);
    const status = await f.request("status");
    expect(status.ok).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/roomId|secret|roomSecret/);
    await expect(f.request("status", { unexpected: true })).rejects.toThrow();
  });
  it("requires daemon approval before pairing and persists after acknowledgement", async () => {
    const f = await fixture();
    expect((await f.pair()).ok).toBe(true);
    expect(f.order).toEqual(["confirm", "ack", "persisted", "serve"]);
    expect(f.daemon.store.snapshot().grants).toHaveLength(1);
    expect(JSON.stringify(await f.request("status"))).not.toContain(
      f.daemon.store.snapshot().grants[0]!.roomSecret,
    );
  });
  it("rejects pairing without approval and without explicit profiles", async () => {
    const f = await fixture(false);
    await expect(f.pair()).rejects.toThrow();
    expect(f.daemon.store.snapshot().grants).toEqual([]);
    expect(f.order).toEqual(["confirm"]);
    await expect(
      f.request("pair", {
        invitation: encodeInvitation(createInvitation("phone")),
        principal: "agent",
        scopes: ["sessions:list"],
        profileIds: [],
      }),
    ).rejects.toThrow();
  });
  it("revokes and closes a paired room", async () => {
    const f = await fixture();
    await f.pair();
    const grant = f.daemon.store.snapshot().grants[0]!;
    await f.request("revoke", { grantId: grant.id });
    expect(f.order).toContain("close");
    expect(f.daemon.store.snapshot().grants[0]!.revokedAt).not.toBeNull();
  });
  it("rejects reuse of an invitation even after revocation", async () => {
    const f = await fixture();
    const args = {
      invitation: encodeInvitation(createInvitation("phone")),
      principal: "human-device",
      scopes: ["sessions:list"],
      profileIds: ["fake"],
    };
    await f.request("pair", args);
    await f.request("revoke", {
      grantId: f.daemon.store.snapshot().grants[0]!.id,
    });
    await expect(f.request("pair", args)).rejects.toThrow();
    expect(f.daemon.store.snapshot().grants).toHaveLength(1);
  });
  it("keeps grants bound to the initial workspace", async () => {
    const f = await fixture();
    await f.daemon.close();
    await expect(
      startDaemon({
        stateDir: join(f.directory, "state"),
        workspace: tmpdir(),
        profiles: [],
        attachCodex: async () => adapter,
        transport: f.transport,
        confirm: async () => true,
      }),
    ).rejects.toThrow("workspace");
  });
  it("starts only the explicitly selected local provider without a prompt", async () => {
    const f = await fixture();
    const response = await f.request("start", { profileId: "fake" });
    expect(response.ok).toBe(true);
    expect(f.order).toEqual(["create"]);
    expect(f.daemon.host.sessions()[0]!.online).toBe(true);
    await expect(
      f.request("start", { profileId: "unapproved" }),
    ).rejects.toThrow();
  });
});

it("owns invitations after their control socket closes and cancels them through a new socket", async () => {
  const f = await fixture();
  let closed = false;
  let rejected!: (error: Error) => void;
  const completion = new Promise<
    import("../src/rtc-identity.js").ConnectionRecord
  >((_resolve, reject) => {
    rejected = reject;
  });
  void completion.catch(() => {});
  f.transport.offer = async () => {
    const invitation = createInvitation("Host");
    return {
      invitation,
      code: "7K3M2Q-9RX4TW6P",
      url: "https://p2pme.glentiki.dev/#pair=private",
      completion,
      state: "pending",
      cancel: async () => {
        closed = true;
        rejected(new Error("cancelled"));
        return "cancelled";
      },
      close: async () => {
        closed = true;
        rejected(new Error("closed"));
      },
    };
  };
  const response = await f.request("invite", {
    principal: "human-device",
    scopes: ["sessions:list", "sessions:chat"],
    profileIds: ["fake"],
  });
  expect(response.result.code).toBe("7K3M2Q-9RX4TW6P");
  expect(closed).toBe(false);
  const status = await f.request("status");
  expect(status.result.invitation).toMatchObject({
    attemptId: response.result.attemptId,
  });
  expect(JSON.stringify(status)).not.toMatch(/7K3M2Q|#pair|roomSecret/);
  await expect(f.pair()).rejects.toThrow();
  const cancelled = await f.request("cancel-invite", {
    attemptId: response.result.attemptId,
  });
  expect(cancelled.result.status).toBe("cancelled");
  expect(closed).toBe(true);
  expect(f.order).not.toContain("confirm");
});
