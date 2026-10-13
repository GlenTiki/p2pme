import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHost,
  type HostController,
  type SessionAdapter,
} from "../src/host.js";
import { MAX_SESSION_ENTRIES } from "../src/protocol.js";
import { openHostStore } from "../src/host-store.js";
import { type Grant, type HostRequest, scopes } from "../src/host-protocol.js";

const directories: string[] = [];
const hosts: HostController[] = [];
const now = Date.parse("2026-10-13T17:00:00Z");

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup(
  overrides: Partial<SessionAdapter> = {},
  hooks: {
    beforeAppend?: (direction: string) => Promise<void>;
    beforeWrite?: () => Promise<void>;
    createFails?: boolean;
    createProviderSessionId?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "p2pme-host-test-"));
  directories.push(directory);
  const store = await openHostStore(
    directory,
    hooks.beforeWrite
      ? async (path, state) => {
          await hooks.beforeWrite!();
          await writeFile(join(path, "host.json"), JSON.stringify(state), {
            mode: 0o600,
          });
        }
      : undefined,
  );
  const grant: Grant = {
    id: crypto.randomUUID(),
    deviceId: crypto.randomUUID(),
    principal: "human-device",
    label: "Test phone",
    roomId: crypto.randomUUID(),
    roomSecret: "a".repeat(43),
    createdAt: "2026-10-13T16:00:00Z",
    expiresAt: "2026-10-13T18:00:00Z",
    revokedAt: null,
    scopes: [...scopes],
    sessionAccess: "registered",
    profileIds: ["test"],
  };
  await store.update((state) => {
    state.grants.push(grant);
  });
  const order: string[] = [];
  const adapter: SessionAdapter = {
    async submit(input, emit) {
      order.push("submit");
      await emit({ type: "completed", text: input.text });
    },
    async configure() {
      order.push("configure");
    },
    async detach() {
      order.push("detach");
    },
    ...overrides,
  };
  let failLog: string | null = null;
  const host = await createHost({
    store,
    now: () => now,
    profiles: [
      {
        id: "test",
        provider: "fake",
        models: ["small", "large"],
        defaultModelId: "small",
        async create() {
          order.push("create");
          if (hooks.createFails) throw new Error("Provider failed");
          return {
            providerSessionId:
              hooks.createProviderSessionId ?? crypto.randomUUID(),
            adapter,
          };
        },
      },
    ],
    logFactory: async (_sessionId, direction) => ({
      async append() {
        order.push(direction);
        await hooks.beforeAppend?.(direction);
        if (failLog === direction) throw new Error("Disk full");
      },
      async close() {},
    }),
    async emit(grantId) {
      expect(grantId).toBe(grant.id);
      order.push("emit");
    },
  });
  hosts.push(host);
  const session = await host.attach({
    profileId: "test",
    providerSessionId: "provider-session",
    label: "Test session",
    adapter,
  });
  const request = (op: HostRequest["op"], args: unknown = {}): unknown => ({
    version: 1,
    id: crypto.randomUUID(),
    hostId: host.hostId,
    hostEpoch: host.hostEpoch,
    op,
    args,
  });
  return {
    directory,
    store,
    host,
    session,
    grant,
    request,
    order,
    failLogs: (direction = "ingress") => {
      failLog = direction;
    },
  };
}

describe("host dispatch", () => {
  it("logs a command before invocation and each result before output", async () => {
    const f = await setup();
    const response = await f.host.dispatch(
      f.grant.id,
      f.request("sessions.chat", { sessionId: f.session.id, text: "hello" }),
    );
    expect(response.ok).toBe(true);
    expect(f.order).toEqual(["ingress", "submit", "egress", "emit", "egress"]);
  });

  it.each([
    "scope",
    "session",
    "epoch",
    "host",
    "unregistered",
    "revoke",
    "expiry",
  ])("rejects %s violations before invocation", async (violation) => {
    const f = await setup();
    const request = f.request("sessions.chat", {
      sessionId: f.session.id,
      text: "hello",
    }) as Record<string, unknown>;
    if (violation === "scope")
      await f.store.update((state) => {
        state.grants[0]!.scopes = ["sessions:list"];
      });
    if (violation === "session")
      await f.store.update((state) => {
        state.grants[0]!.sessionAccess = [];
      });
    if (violation === "epoch") request.hostEpoch = crypto.randomUUID();
    if (violation === "host") request.hostId = crypto.randomUUID();
    if (violation === "unregistered")
      request.args = { sessionId: crypto.randomUUID(), text: "hello" };
    if (violation === "revoke") await f.host.revokeGrant(f.grant.id);
    if (violation === "expiry")
      await f.store.update((state) => {
        state.grants[0]!.expiresAt = "2026-10-13T16:30:00Z";
      });
    expect((await f.host.dispatch(f.grant.id, request)).ok).toBe(false);
    expect(f.order).not.toContain("submit");
  });

  it("requires a distinct scope for task delegation", async () => {
    const f = await setup();
    await f.store.update((state) => {
      state.grants[0]!.scopes = ["sessions:chat"];
    });
    expect(
      (
        await f.host.dispatch(
          f.grant.id,
          f.request("tasks.delegate", {
            sessionId: f.session.id,
            text: "task",
          }),
        )
      ).ok,
    ).toBe(false);
    expect(f.order).not.toContain("submit");
  });

  it("does not execute a replayed request", async () => {
    const f = await setup();
    const request = f.request("sessions.chat", {
      sessionId: f.session.id,
      text: "hello",
    });
    expect((await f.host.dispatch(f.grant.id, request)).ok).toBe(true);
    expect((await f.host.dispatch(f.grant.id, request)).ok).toBe(false);
    expect(f.order.filter((item) => item === "submit")).toHaveLength(1);
  });

  it("rejects a second operation while the adapter is busy", async () => {
    let finish: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const f = await setup({
      async submit() {
        await held;
      },
    });
    const first = f.host.dispatch(
      f.grant.id,
      f.request("sessions.chat", { sessionId: f.session.id, text: "one" }),
    );
    await expect.poll(() => f.order).toContain("ingress");
    const second = await f.host.dispatch(
      f.grant.id,
      f.request("sessions.chat", { sessionId: f.session.id, text: "two" }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("busy");
    finish();
    await first;
  });

  it("does not invoke an adapter when ingress append fails", async () => {
    const f = await setup();
    f.failLogs();
    expect(
      (
        await f.host.dispatch(
          f.grant.id,
          f.request("sessions.chat", {
            sessionId: f.session.id,
            text: "hello",
          }),
        )
      ).ok,
    ).toBe(false);
    expect(f.order).not.toContain("submit");
    expect(f.order).not.toContain("emit");
  });

  it("creates only from an approved profile and adds fixed-list access", async () => {
    const f = await setup();
    await f.store.update((state) => {
      state.grants[0]!.sessionAccess = [];
    });
    const denied = await f.host.dispatch(
      f.grant.id,
      f.request("sessions.create", { profileId: "arbitrary", label: "bad" }),
    );
    expect(denied.ok).toBe(false);
    const created = await f.host.dispatch(
      f.grant.id,
      f.request("sessions.create", { profileId: "test", label: "New" }),
    );
    expect(created.ok).toBe(true);
    expect(f.store.snapshot().grants[0]!.sessionAccess).toHaveLength(1);
    expect(f.order.filter((item) => item === "create")).toHaveLength(1);
  });

  it("leaves metadata unchanged when configure fails", async () => {
    const f = await setup({
      async configure() {
        throw new Error("Provider declined");
      },
    });
    const response = await f.host.dispatch(
      f.grant.id,
      f.request("sessions.configure", {
        sessionId: f.session.id,
        patch: { label: "changed", modelId: "large" },
      }),
    );
    expect(response.ok).toBe(false);
    expect(f.store.snapshot().sessions[0]!.label).toBe("Test session");
    expect(f.store.snapshot().sessions[0]!.modelId).toBe("small");
  });

  it("blocks late adapter output after revocation", async () => {
    let finish: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const f = await setup({
      async submit(_input, emit) {
        await held;
        await emit({ type: "completed", text: "late" });
      },
    });
    const response = f.host.dispatch(
      f.grant.id,
      f.request("sessions.chat", { sessionId: f.session.id, text: "hello" }),
    );
    await expect.poll(() => f.order).toContain("ingress");
    await f.host.revokeGrant(f.grant.id);
    finish();
    expect((await response).ok).toBe(false);
    expect(f.order).not.toContain("emit");
  });
});

describe("persistent host state", () => {
  it("keeps host and provider session IDs but starts offline with a fresh epoch", async () => {
    const f = await setup();
    await f.host.close();
    const store = await openHostStore(f.directory);
    const restarted = await createHost({ store, profiles: [], now: () => now });
    hosts.push(restarted);
    expect(restarted.hostId).toBe(f.host.hostId);
    expect(restarted.hostEpoch).not.toBe(f.host.hostEpoch);
    expect(store.snapshot().sessions[0]!.id).toBe(f.session.id);
    const response = await restarted.dispatch(f.grant.id, {
      version: 1,
      id: crypto.randomUUID(),
      hostId: restarted.hostId,
      hostEpoch: restarted.hostEpoch,
      op: "sessions.list",
      args: {},
    });
    expect(response.ok).toBe(true);
    if (response.ok)
      expect(response.result).toEqual({
        sessions: [{ ...store.snapshot().sessions[0], online: false }],
      });
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(f.directory, "host.json"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("fails closed on invalid stored state", async () => {
    const f = await setup();
    await f.host.close();
    const path = join(f.directory, "host.json");
    const saved = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(path, JSON.stringify({ ...saved, unexpected: true }));
    await expect(openHostStore(f.directory)).rejects.toThrow();
  });
});

describe("host failures and untrusted requests", () => {
  it.each([
    { op: "sessions.list", args: { hidden: true } },
    {
      op: "sessions.create",
      args: { profileId: "test", label: "new", cwd: "/tmp" },
    },
    {
      op: "sessions.configure",
      args: { sessionId: crypto.randomUUID(), patch: { command: "shell" } },
    },
  ])("rejects unknown request fields", async (fields) => {
    const f = await setup();
    const response = await f.host.dispatch(
      f.grant.id,
      f.request(fields.op as HostRequest["op"], fields.args),
    );
    expect(response.ok).toBe(false);
    expect(f.order).toEqual([]);
  });

  it("does not publish output when egress append fails", async () => {
    const f = await setup();
    f.failLogs("egress");
    const response = await f.host.dispatch(
      f.grant.id,
      f.request("sessions.chat", { sessionId: f.session.id, text: "hello" }),
    );
    expect(response.ok).toBe(false);
    expect(f.order).toContain("submit");
    expect(f.order).not.toContain("emit");
  });

  it("rechecks revocation after the ingress append", async () => {
    let revoke: () => Promise<void> = async () => {};
    const f = await setup(
      {},
      {
        beforeAppend: async (direction) => {
          if (direction === "ingress") await revoke();
        },
      },
    );
    revoke = () => f.host.revokeGrant(f.grant.id);
    const response = await f.host.dispatch(
      f.grant.id,
      f.request("sessions.chat", { sessionId: f.session.id, text: "hello" }),
    );
    expect(response.ok).toBe(false);
    expect(f.order).not.toContain("submit");
  });

  it("does not register a session when its provider fails to create it", async () => {
    const f = await setup({}, { createFails: true });
    const response = await f.host.dispatch(
      f.grant.id,
      f.request("sessions.create", { profileId: "test", label: "new" }),
    );
    expect(response.ok).toBe(false);
    expect(f.store.snapshot().sessions).toHaveLength(1);
    expect(f.order).toEqual(["ingress", "create", "egress"]);
  });

  it("rejects an unapproved model before provider configuration", async () => {
    const f = await setup();
    const response = await f.host.dispatch(
      f.grant.id,
      f.request("sessions.configure", {
        sessionId: f.session.id,
        patch: { modelId: "arbitrary" },
      }),
    );
    expect(response.ok).toBe(false);
    expect(f.order).not.toContain("configure");
  });

  it("rejects late output after its adapter turn ends", async () => {
    let emitLate: () => Promise<void> = async () => {};
    const f = await setup({
      async submit(_input, emit) {
        emitLate = () => emit({ type: "completed", text: "late" });
      },
    });
    const response = await f.host.dispatch(
      f.grant.id,
      f.request("sessions.chat", { sessionId: f.session.id, text: "hello" }),
    );
    expect(response.ok).toBe(true);
    await expect(emitLate()).rejects.toThrow("ended");
    expect(f.order).not.toContain("emit");
  });

  it("stops remote dispatch and closes the connection when revocation cannot persist", async () => {
    const f = await setup();
    await f.host.close();
    const store = await openHostStore(f.directory, async () => {
      throw new Error("Disk full");
    });
    const revoked: string[] = [];
    const host = await createHost({
      store,
      profiles: [],
      now: () => now,
      async onRevoke(id) {
        revoked.push(id);
      },
    });
    hosts.push(host);
    await expect(host.revokeGrant(f.grant.id)).rejects.toThrow("Disk full");
    expect(store.healthy).toBe(false);
    expect(revoked).toEqual([f.grant.id]);
    const request = {
      version: 1,
      id: crypto.randomUUID(),
      hostId: host.hostId,
      hostEpoch: host.hostEpoch,
      op: "sessions.list",
      args: {},
    };
    expect((await host.dispatch(f.grant.id, request)).ok).toBe(false);
  });
});

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function detachedAdapter(detached: string[], name: string): SessionAdapter {
  return {
    async submit() {},
    async configure() {},
    async detach() {
      detached.push(name);
    },
  };
}

describe("host lifecycle races", () => {
  it("reserves a session while its replacement waits for durable state", async () => {
    const write = deferred();
    let hold = false;
    let entered = false;
    const f = await setup(
      {},
      {
        beforeWrite: async () => {
          if (hold) {
            entered = true;
            await write.promise;
          }
        },
      },
    );
    hold = true;
    const detached: string[] = [];
    const replacement = f.host.attach({
      profileId: "test",
      providerSessionId: "provider-session",
      label: "replacement",
      adapter: detachedAdapter(detached, "replacement"),
    });
    await expect.poll(() => entered).toBe(true);
    const response = await f.host.dispatch(
      f.grant.id,
      f.request("sessions.chat", { sessionId: f.session.id, text: "racing" }),
    );
    write.resolve();
    await replacement;
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe("busy");
    expect(f.order).not.toContain("submit");
  });

  it("assigns one stable ID to concurrent first attachments of the same provider session", async () => {
    const write = deferred();
    let hold = false;
    let entered = false;
    const f = await setup(
      {},
      {
        beforeWrite: async () => {
          if (hold) {
            entered = true;
            await write.promise;
          }
        },
      },
    );
    const detached: string[] = [];
    hold = true;
    const first = f.host.attach({
      profileId: "test",
      providerSessionId: "new-provider-session",
      label: "first",
      adapter: detachedAdapter(detached, "first"),
    });
    await expect.poll(() => entered).toBe(true);
    const second = f.host.attach({
      profileId: "test",
      providerSessionId: "new-provider-session",
      label: "second",
      adapter: detachedAdapter(detached, "second"),
    });
    write.resolve();
    const attached = await Promise.all([first, second]);
    expect(attached[0]!.id).toBe(attached[1]!.id);
    expect(
      f.store
        .snapshot()
        .sessions.filter(
          (session) => session.providerSessionId === "new-provider-session",
        ),
    ).toHaveLength(1);
    expect(detached).toContain("first");
  });

  it("rejects attachment after close", async () => {
    const f = await setup();
    await f.host.close();
    const detached: string[] = [];
    await expect(
      f.host.attach({
        profileId: "test",
        providerSessionId: "after-close",
        label: "closed",
        adapter: detachedAdapter(detached, "closed"),
      }),
    ).rejects.toThrow("unavailable");
    expect(detached).toEqual(["closed"]);
  });

  it("cleans the incoming adapter when close occurs during attachment persistence", async () => {
    const write = deferred();
    let hold = false;
    let entered = false;
    const f = await setup(
      {},
      {
        beforeWrite: async () => {
          if (hold) {
            entered = true;
            await write.promise;
          }
        },
      },
    );
    const detached: string[] = [];
    hold = true;
    const attached = f.host.attach({
      profileId: "test",
      providerSessionId: "new-provider-session",
      label: "pending",
      adapter: detachedAdapter(detached, "pending"),
    });
    await expect.poll(() => entered).toBe(true);
    const closing = f.host.close();
    const rejected = expect(attached).rejects.toThrow("unavailable");
    write.resolve();
    await closing;
    await rejected;
    expect(detached).toContain("pending");
  });

  it("drains unawaited output before the final receipt", async () => {
    const append = deferred();
    const entered = deferred();
    let hold = false;
    const f = await setup(
      {
        async submit(_input, emit) {
          hold = true;
          void emit({ type: "completed", text: "pending" });
        },
      },
      {
        beforeAppend: async (direction) => {
          if (direction === "egress" && hold) {
            hold = false;
            entered.resolve();
            await append.promise;
          }
        },
      },
    );
    let finished = false;
    const first = f.host
      .dispatch(
        f.grant.id,
        f.request("sessions.chat", { sessionId: f.session.id, text: "first" }),
      )
      .then((result) => {
        finished = true;
        return result;
      });
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    append.resolve();
    expect((await first).ok).toBe(true);
    expect(f.order).toContain("emit");
  });

  it("fails a turn when unawaited output cannot be logged", async () => {
    const f = await setup({
      async submit(_input, emit) {
        void emit({ type: "completed", text: "pending" });
      },
    });
    f.failLogs("egress");
    const response = await f.host.dispatch(
      f.grant.id,
      f.request("sessions.chat", { sessionId: f.session.id, text: "hello" }),
    );
    expect(response.ok).toBe(false);
    expect(f.order).not.toContain("emit");
  });
});

describe("reviewed host authority failures", () => {
  it("permits provider defaults without approving model configuration", async () => {
    const f = await setup();
    await f.host.close();
    const store = await openHostStore(f.directory);
    const host = await createHost({
      store,
      now: () => now,
      profiles: [
        {
          id: "test",
          provider: "fake",
          models: [],
          defaultModelId: "provider-default",
        },
      ],
      logFactory: async () => ({ async append() {}, async close() {} }),
    });
    hosts.push(host);
    const adapter = detachedAdapter([], "default");
    await host.attach({
      profileId: "test",
      providerSessionId: "provider-session",
      label: "default",
      adapter,
    });
    const request = {
      version: 1,
      id: crypto.randomUUID(),
      hostId: host.hostId,
      hostEpoch: host.hostEpoch,
      op: "sessions.configure",
      args: { sessionId: f.session.id, patch: { modelId: "provider-default" } },
    };
    const response = await host.dispatch(f.grant.id, request);
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe("forbidden");
  });

  it("detaches only the current adapter and retains the offline mapping", async () => {
    const f = await setup();
    const detached: string[] = [];
    const oldAdapter = detachedAdapter(detached, "old");
    const current = detachedAdapter(detached, "current");
    await f.host.attach({
      profileId: "test",
      providerSessionId: "provider-session",
      label: "replacement",
      adapter: current,
    });
    await f.host.detach(f.session.id, oldAdapter);
    expect(f.host.sessions()[0]!.online).toBe(true);
    await f.host.detach(f.session.id, current);
    expect(f.host.sessions()[0]!.online).toBe(false);
    expect(detached).toEqual(["current"]);
    expect(f.store.snapshot().sessions[0]!.id).toBe(f.session.id);
  });
  it("rejects attachment computed before a competing create commits", async () => {
    const write = deferred();
    const entered = deferred();
    let hold = false;
    const f = await setup(
      {},
      {
        createProviderSessionId: "competing",
        beforeWrite: async () => {
          if (hold) {
            hold = false;
            entered.resolve();
            await write.promise;
          }
        },
      },
    );
    hold = true;
    const created = f.host.dispatch(
      f.grant.id,
      f.request("sessions.create", { profileId: "test", label: "created" }),
    );
    await entered.promise;
    const detached: string[] = [];
    const attached = f.host.attach({
      profileId: "test",
      providerSessionId: "competing",
      label: "attached",
      adapter: detachedAdapter(detached, "competing"),
    });
    const rejected = expect(attached).rejects.toThrow("registered");
    write.resolve();
    await created;
    await rejected;
    expect(
      f.store
        .snapshot()
        .sessions.filter(
          (session) => session.providerSessionId === "competing",
        ),
    ).toHaveLength(1);
    expect(detached).toEqual(["competing"]);
  });

  it("rejects a created provider ID that belongs to an existing session", async () => {
    const f = await setup({}, { createProviderSessionId: "provider-session" });
    await f.store.update((state) => {
      state.grants[0]!.sessionAccess = [];
    });
    const response = await f.host.dispatch(
      f.grant.id,
      f.request("sessions.create", { profileId: "test", label: "takeover" }),
    );
    expect(response.ok).toBe(false);
    expect(f.store.snapshot().sessions[0]!.label).toBe("Test session");
    expect(f.store.snapshot().grants[0]!.sessionAccess).toEqual([]);
  });

  it("returns failure when an adapter swallows its output rejection", async () => {
    const f = await setup({
      async submit(_input, emit) {
        await emit({ type: "completed", text: "x".repeat(32768) }).catch(
          () => {},
        );
      },
    });
    const response = await f.host.dispatch(
      f.grant.id,
      f.request("sessions.chat", { sessionId: f.session.id, text: "hello" }),
    );
    expect(response.ok).toBe(false);
    expect(f.order).not.toContain("emit");
  });

  it("detaches an incoming adapter when its profile is unavailable", async () => {
    const f = await setup();
    const detached: string[] = [];
    await expect(
      f.host.attach({
        profileId: "missing",
        providerSessionId: "new",
        label: "new",
        adapter: detachedAdapter(detached, "missing"),
      }),
    ).rejects.toThrow("unavailable");
    expect(detached).toEqual(["missing"]);
  });

  it("allows only one owner of a persistent host store", async () => {
    const f = await setup();
    await expect(openHostStore(f.directory)).rejects.toThrow("already open");
    await f.host.close();
    const reopened = await openHostStore(f.directory);
    expect(reopened.hostId).toBe(f.host.hostId);
    await reopened.close();
    await expect(f.store.update(() => {})).rejects.toThrow();
  });
});

describe("host log capacity", () => {
  it("refuses a new provider turn when only its receipt slot remains", async () => {
    let submissions = 0;
    const f = await setup({
      async submit(_input, emit) {
        submissions++;
        for (let index = 0; index < MAX_SESSION_ENTRIES - 2; index++)
          await emit({ type: "delta", text: "x" });
      },
    });
    const chat = () =>
      f.host.dispatch(
        f.grant.id,
        f.request("sessions.chat", { sessionId: f.session.id, text: "test" }),
      );
    expect((await chat()).ok).toBe(true);
    const ingress = f.order.filter((entry) => entry === "ingress").length;
    const response = await chat();
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("log_unavailable");
      expect(response.error.message).toContain("restart");
    }
    expect(submissions).toBe(1);
    expect(f.order.filter((entry) => entry === "ingress")).toHaveLength(
      ingress,
    );
  });

  it("aborts an overflowing turn and never invokes the provider on a later request", async () => {
    let submissions = 0;
    let signal!: AbortSignal;
    const f = await setup({
      async submit(input, emit) {
        submissions++;
        signal = input.signal;
        for (let index = 0; index < MAX_SESSION_ENTRIES; index++)
          await emit({ type: "delta", text: "x" });
      },
    });
    const chat = () =>
      f.host.dispatch(
        f.grant.id,
        f.request("sessions.chat", { sessionId: f.session.id, text: "test" }),
      );
    const first = await chat();
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.code).toBe("log_unavailable");
      expect(first.error.message).toContain("may have run");
    }
    expect(signal.aborted).toBe(true);
    const second = await chat();
    expect(second.ok).toBe(false);
    expect(submissions).toBe(1);
  });

  it.each(["ingress", "egress"])(
    "blocks later side effects after an %s append failure",
    async (direction) => {
      const f = await setup();
      f.failLogs(direction);
      const chat = () =>
        f.host.dispatch(
          f.grant.id,
          f.request("sessions.chat", { sessionId: f.session.id, text: "test" }),
        );
      expect((await chat()).ok).toBe(false);
      f.failLogs("none");
      const order = [...f.order];
      const response = await f.host.dispatch(
        f.grant.id,
        f.request("sessions.configure", {
          sessionId: f.session.id,
          patch: { modelId: "large" },
        }),
      );
      expect(response.ok).toBe(false);
      if (!response.ok) expect(response.error.code).toBe("log_unavailable");
      expect(f.order).toEqual(order);
    },
  );

  it("blocks creation after the epoch output log fails", async () => {
    const f = await setup();
    f.failLogs("egress");
    expect(
      (await f.host.dispatch(f.grant.id, f.request("sessions.list"))).ok,
    ).toBe(false);
    f.failLogs("none");
    const response = await f.host.dispatch(
      f.grant.id,
      f.request("sessions.create", { profileId: "test", label: "new" }),
    );
    expect(response.ok).toBe(false);
    expect(f.order).not.toContain("create");
  });
});
