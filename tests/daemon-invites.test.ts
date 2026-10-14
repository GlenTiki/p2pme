import { expect, it } from "vitest";
import {
  DaemonControl,
  type ControlOptions,
  type DaemonTransport,
} from "../src/daemon-control.js";
import { createHost } from "../src/host.js";
import { hostStateSchema, type HostState } from "../src/host-protocol.js";
import {
  createInvitation,
  encodeInvitation,
  type ConnectionRecord,
} from "../src/rtc-identity.js";
import type {
  HostOffer,
  HostOfferOptions,
  HostGrantPreparation,
} from "../src/host-pairing.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fakeOffer(options: HostOfferOptions) {
  const invitation = createInvitation(options.label);
  const completion = deferred<ConnectionRecord>();
  void completion.promise.catch(() => {});
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, options.signal!]);
  let state: HostOffer["state"] = "pending";
  let committed = false;
  let closes = 0;
  const offer: HostOffer & { url: string } = {
    invitation,
    code: "7K3M2Q-9RX4TW6P",
    url: "https://p2pme.glentiki.dev/#pair=private",
    completion: completion.promise,
    get state() {
      return state;
    },
    async cancel() {
      if (committed) return "too-late";
      state = "closed";
      abort.abort();
      completion.reject(new Error("cancelled"));
      return "cancelled";
    },
    async close() {
      closes++;
      if (committed) await completion.promise.catch(() => {});
      else await offer.cancel();
    },
  };
  return {
    offer,
    signal,
    closes: () => closes,
    committed: () => committed,
    claim: async (label = "Phone") => {
      state = "claimed";
      return options.authorize(label, signal, {
        attemptId: invitation.roomId,
        expiresAt: invitation.expiresAt,
      });
    },
    finish: async (prepared: HostGrantPreparation) => {
      try {
        await prepared.persist(() => {
          signal.throwIfAborted();
          committed = true;
          state = "committing";
        });
        await prepared.activate();
        state = "complete";
        completion.resolve(prepared.record);
      } catch (error) {
        state = "closed";
        completion.reject(error);
        throw error;
      }
    },
  };
}
async function fixture() {
  let state: HostState = {
    version: 1,
    hostId: crypto.randomUUID(),
    sessions: [],
    grants: [],
  };
  let healthy = true;
  const order: string[] = [];
  const hooks = {
    beforeChange: async () => {},
    afterChange: async () => {},
    consume: async () => {},
    corrupt: false,
  };
  const store = {
    hostId: state.hostId,
    get healthy() {
      return healthy;
    },
    snapshot: () => structuredClone(state),
    close: async () => {},
    update: async (change: (value: HostState) => void) => {
      await hooks.beforeChange();
      const next = structuredClone(state);
      if (hooks.corrupt) (next as unknown as { version: number }).version = 2;
      change(next);
      hostStateSchema.parse(next);
      await hooks.afterChange();
      state = next;
      order.push("persist");
    },
  };
  const profiles = [
    {
      id: "codex",
      provider: "codex",
      models: [],
      defaultModelId: "provider-default",
    },
  ];
  const host = await createHost({ store, profiles });
  const offers: ReturnType<typeof fakeOffer>[] = [];
  const transport: DaemonTransport = {
    pair: async () => {
      order.push("legacy");
    },
    offer: async (options) => {
      const offer = fakeOffer(options);
      offers.push(offer);
      return offer.offer;
    },
    serve: () => {
      order.push("serve");
      return { connected: true, send: async () => {}, close: async () => {} };
    },
  };
  const options: ControlOptions = {
    host,
    store,
    profiles,
    transport,
    rooms: new Map(),
    policy: {
      workspace: "/workspace",
      consume: async () => {
        order.push("consume");
        await hooks.consume();
      },
    },
    attachCodex: async () => {
      throw new Error("unused");
    },
    confirm: async () => {
      order.push("confirm");
      return true;
    },
  };
  const control = new DaemonControl(options);
  const request = (
    op: string,
    args: Record<string, unknown> = {},
    signal = new AbortController().signal,
  ) => control.handle({ id: crypto.randomUUID(), op, args }, signal);
  const invite = (signal?: AbortSignal) =>
    request(
      "invite",
      {
        principal: "human-device",
        scopes: ["sessions:list", "sessions:chat"],
        profileIds: ["codex"],
      },
      signal,
    );
  return {
    control,
    options,
    request,
    invite,
    offers,
    order,
    store,
    hooks,
    profiles,
    healthy: (value: boolean) => {
      healthy = value;
    },
  };
}
it("keeps an offer after the command disconnects and hides its secrets in status", async () => {
  const f = await fixture();
  const socket = new AbortController();
  const result = await f.invite(socket.signal);
  socket.abort();
  expect(result).toMatchObject({
    code: "7K3M2Q-9RX4TW6P",
    url: "https://p2pme.glentiki.dev/#pair=private",
  });
  expect(f.offers[0]!.signal.aborted).toBe(false);
  const status = JSON.stringify(await f.request("status"));
  expect(status).toContain(f.offers[0]!.offer.invitation.roomId);
  expect(status).not.toMatch(/7K3M2Q|private|secret|roomId|roomSecret/);
  await f.control.close();
});
it("claims immutable local access once and never asks for terminal approval", async () => {
  const f = await fixture();
  const scopes = ["sessions:list", "tasks:delegate"];
  await f.request("invite", {
    principal: "agent",
    scopes,
    profileIds: ["codex"],
  });
  scopes.push("sessions:create");
  const offer = f.offers[0]!;
  const prepared = await offer.claim();
  await expect(offer.claim()).rejects.toThrow();
  await offer.finish(prepared);
  expect(f.order).toEqual(["consume", "persist", "serve"]);
  expect(f.store.snapshot().grants[0]).toMatchObject({
    principal: "agent",
    scopes: ["sessions:list", "tasks:delegate"],
    profileIds: ["codex"],
    label: "Phone",
  });
  await f.control.close();
});
it("requires exact cancellation and excludes both new and legacy concurrent pairing", async () => {
  const f = await fixture();
  await f.invite();
  await expect(f.invite()).rejects.toThrow();
  await expect(f.request("pair", {})).rejects.toThrow();
  await expect(
    f.request("cancel-invite", { attemptId: crypto.randomUUID() }),
  ).rejects.toThrow();
  expect(f.offers[0]!.signal.aborted).toBe(false);
  expect(
    await f.request("cancel-invite", {
      attemptId: f.offers[0]!.offer.invitation.roomId,
    }),
  ).toMatchObject({ status: "cancelled" });
  await f.invite();
  expect(f.offers).toHaveLength(2);
  await f.control.close();
});
it.each(["profiles", "capacity", "health", "shutdown", "expiry"])(
  "rechecks %s before policy consumption",
  async (kind) => {
    const f = await fixture();
    await f.invite();
    if (kind === "profiles") f.profiles.splice(0);
    if (kind === "health") f.healthy(false);
    if (kind === "shutdown") f.control.stop();
    if (kind === "expiry")
      f.offers[0]!.offer.invitation.expiresAt = "2020-01-01T00:00:00Z";
    if (kind === "capacity")
      await f.store.update((s) => {
        s.grants = Array.from({ length: 32 }, () => ({
          id: crypto.randomUUID(),
          deviceId: crypto.randomUUID(),
          principal: "human-device",
          label: "phone",
          roomId: crypto.randomUUID(),
          roomSecret: "a".repeat(43),
          createdAt: "2026-10-14T00:00:00Z",
          expiresAt: "2027-10-14T00:00:00Z",
          revokedAt: null,
          scopes: ["sessions:list"],
          sessionAccess: "registered",
          profileIds: ["codex"],
        }));
      });
    await expect(f.offers[0]!.claim()).rejects.toThrow();
    expect(f.order).not.toContain("consume");
    await f.control.close();
  },
);
it("does not write a grant when cancelled while persistence waits in the store queue", async () => {
  const f = await fixture();
  await f.invite();
  const offer = f.offers[0]!;
  const prepared = await offer.claim();
  const held = deferred<void>();
  let waiting = false;
  f.hooks.beforeChange = async () => {
    waiting = true;
    await held.promise;
  };
  const write = offer.finish(prepared);
  const rejected = expect(write).rejects.toThrow();
  await expect.poll(() => waiting).toBe(true);
  expect(
    await f.request("cancel-invite", {
      attemptId: offer.offer.invitation.roomId,
    }),
  ).toMatchObject({ status: "cancelled" });
  held.resolve();
  await rejected;
  expect(offer.committed()).toBe(false);
  expect(f.store.snapshot().grants).toEqual([]);
  await f.control.close();
});
it("validates the cloned state before the irreversible commit hook", async () => {
  const f = await fixture();
  await f.invite();
  const offer = f.offers[0]!;
  const prepared = await offer.claim();
  f.hooks.corrupt = true;
  await expect(offer.finish(prepared)).rejects.toThrow();
  expect(offer.committed()).toBe(false);
  expect(await offer.offer.cancel()).toBe("cancelled");
  await f.control.close();
});
it("reports too-late after commit starts and shutdown drains the write without activation", async () => {
  const f = await fixture();
  await f.invite();
  const offer = f.offers[0]!;
  const prepared = await offer.claim();
  const held = deferred<void>();
  f.hooks.afterChange = () => held.promise;
  const write = offer.finish(prepared);
  await expect.poll(offer.committed).toBe(true);
  expect(
    await f.request("cancel-invite", {
      attemptId: offer.offer.invitation.roomId,
    }),
  ).toMatchObject({ status: "too-late" });
  expect(offer.signal.aborted).toBe(false);
  let closed = false;
  const shutdown = f.control.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  held.resolve();
  await write;
  await shutdown;
  expect(f.store.snapshot().grants).toHaveLength(1);
  expect(f.order).not.toContain("serve");
});
it("stops a late authorization result after cancellation", async () => {
  const f = await fixture();
  await f.invite();
  const held = deferred<void>();
  f.hooks.consume = () => held.promise;
  const claim = f.offers[0]!.claim();
  const rejected = expect(claim).rejects.toThrow();
  await expect.poll(() => f.order.includes("consume")).toBe(true);
  await f.request("cancel-invite", {
    attemptId: f.offers[0]!.offer.invitation.roomId,
  });
  held.resolve();
  await rejected;
  expect(f.store.snapshot().grants).toEqual([]);
  await f.control.close();
});

it("serializes policy writes after a cancelled claim and waits for them during shutdown", async () => {
  const f = await fixture();
  await f.invite();
  const held = deferred<void>();
  let calls = 0;
  f.hooks.consume = async () => {
    calls++;
    if (calls === 1) await held.promise;
  };
  const first = f.offers[0]!.claim();
  const rejected = expect(first).rejects.toThrow();
  await expect.poll(() => calls).toBe(1);
  await f.request("cancel-invite", {
    attemptId: f.offers[0]!.offer.invitation.roomId,
  });
  await f.invite();
  const second = f.offers[1]!.claim();
  const secondRejected = expect(second).rejects.toThrow();
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toBe(1);
  let closed = false;
  const closing = f.control.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  held.resolve();
  await rejected;
  await secondRejected;
  await closing;
  expect(calls).toBe(1);
  expect(f.store.snapshot().grants).toEqual([]);
});

it("does not consume or create a grant when policy persistence fails", async () => {
  const f = await fixture();
  f.hooks.consume = async () => {
    throw new Error("policy write failed");
  };
  await f.invite();
  await expect(f.offers[0]!.claim()).rejects.toThrow("policy write failed");
  await expect(f.offers[0]!.claim()).rejects.toThrow("already claimed");
  expect(f.order).toEqual(["consume"]);
  expect(f.store.snapshot().grants).toEqual([]);
  await f.control.close();
});
it("does not activate a grant when its committed store write fails", async () => {
  const f = await fixture();
  await f.invite();
  const offer = f.offers[0]!;
  const prepared = await offer.claim();
  f.hooks.afterChange = async () => {
    throw new Error("write failed");
  };
  await expect(offer.finish(prepared)).rejects.toThrow("write failed");
  expect(offer.committed()).toBe(true);
  expect(await offer.offer.cancel()).toBe("too-late");
  expect(f.order).not.toContain("serve");
  await f.control.close();
});
it("keeps legacy terminal approval mutually exclusive with a new invitation", async () => {
  const f = await fixture();
  const approved = deferred<boolean>();
  let waiting = false;
  f.options.confirm = async () => {
    waiting = true;
    return approved.promise;
  };
  const legacy = f.request("pair", {
    invitation: encodeInvitation(createInvitation("Phone")),
    principal: "human-device",
    scopes: ["sessions:list"],
    profileIds: ["codex"],
  });
  await expect.poll(() => waiting).toBe(true);
  await expect(f.invite()).rejects.toThrow("already pending");
  approved.resolve(true);
  await legacy;
  await f.invite();
  await f.control.close();
});
it("closes an offer whose creation finishes after shutdown starts", async () => {
  const f = await fixture();
  const held = deferred<void>();
  let called = false;
  f.options.transport.offer = async (options) => {
    called = true;
    await held.promise;
    const offer = fakeOffer(options);
    f.offers.push(offer);
    return offer.offer;
  };
  const invite = f.invite();
  const rejected = expect(invite).rejects.toThrow();
  await expect.poll(() => called).toBe(true);
  let closed = false;
  const shutdown = f.control.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  held.resolve();
  await rejected;
  await shutdown;
  expect(f.offers[0]!.closes()).toBeGreaterThan(0);
  expect(f.offers[0]!.signal.aborted).toBe(true);
  expect(f.store.snapshot().grants).toEqual([]);
});
it("keeps legacy transport implementations valid when host offers are unsupported", async () => {
  const f = await fixture();
  delete f.options.transport.offer;
  await expect(f.invite()).rejects.toThrow("unavailable");
  await f.request("pair", {
    invitation: encodeInvitation(createInvitation("Phone")),
    principal: "human-device",
    scopes: ["sessions:list"],
    profileIds: ["codex"],
  });
  expect(f.order).toEqual(["confirm", "consume", "legacy"]);
  await f.control.close();
});
