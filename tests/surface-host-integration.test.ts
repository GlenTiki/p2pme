import { expect, it } from "vitest";
import { createHost } from "../src/host.js";
import {
  type HostState,
  type HostRequest,
  scopes,
} from "../src/host-protocol.js";
import type { Envelope } from "../src/protocol.js";

async function fixture(
  beforeAppend?: (event: Envelope) => Promise<void>,
  emitReply = false,
) {
  const state: HostState = {
    version: 1,
    hostId: crypto.randomUUID(),
    sessions: [],
    grants: [
      {
        id: crypto.randomUUID(),
        deviceId: crypto.randomUUID(),
        principal: "human-device",
        label: "Phone",
        roomId: crypto.randomUUID(),
        roomSecret: "a".repeat(43),
        createdAt: "2026-10-13T00:00:00Z",
        expiresAt: "2027-10-13T00:00:00Z",
        revokedAt: null,
        scopes: [...scopes],
        sessionAccess: "registered",
        profileIds: ["test"],
      },
    ],
  };
  const events: Envelope[] = [],
    inputs: string[] = [],
    kinds: string[] = [],
    logs: Envelope[] = [];
  const host = await createHost({
    store: {
      hostId: state.hostId,
      healthy: true,
      close: async () => {},
      snapshot: () => structuredClone(state),
      update: async (change) => {
        change(state);
      },
    },
    profiles: [
      {
        id: "test",
        provider: "test",
        models: ["default"],
        defaultModelId: "default",
      },
    ],
    logFactory: async () => ({
      append: async (value) => {
        logs.push(value as Envelope);
        await beforeAppend?.(value as Envelope);
      },
      close: async () => {},
    }),
    emit: async (_grant, event) => {
      events.push(event);
    },
  });
  const session = await host.attach({
    profileId: "test",
    providerSessionId: "test",
    label: "Test",
    adapter: {
      submit: async (input, emit) => {
        inputs.push(input.text);
        kinds.push(input.kind);
        if (emitReply)
          await emit({ type: "completed", text: "done" }).catch(() => {});
      },
      configure: async () => {},
      detach: async () => {},
    },
  });
  const surface = {
    surfaceId: crypto.randomUUID(),
    revision: 1,
    spec: {
      root: "button",
      state: { form: { name: "Glen" } },
      elements: {
        button: {
          type: "Button",
          props: { label: "Send" },
          children: [],
          on: {
            press: {
              action: "sendSessionAction",
              params: { actionId: "send" },
            },
          },
        },
      },
    },
  };
  const request = (op: HostRequest["op"], args: unknown) => ({
    version: 1,
    id: crypto.randomUUID(),
    hostId: host.hostId,
    hostEpoch: host.hostEpoch,
    op,
    args,
  });
  return {
    state,
    host,
    session,
    surface,
    request,
    events,
    inputs,
    logs,
    kinds,
  };
}
it("publishes a logged surface and routes an authorised action once", async () => {
  const f = await fixture();
  try {
    await f.host.publishSurface(f.session.id, f.surface);
    expect(f.events[0]?.type).toBe("ui.render");
    expect(f.logs[0]).toEqual(f.events[0]);
    const view = await f.host.dispatch(
      f.state.grants[0]!.id,
      f.request("ui.get", { sessionId: f.session.id }),
    );
    expect(view.ok && view.result.surface).toEqual(f.surface);
    const action = {
      sessionId: f.session.id,
      surfaceId: f.surface.surfaceId,
      revision: 1,
      actionId: "send",
      values: { name: "Glen" },
    };
    const request = f.request("ui.action", action);
    expect((await f.host.dispatch(f.state.grants[0]!.id, request)).ok).toBe(
      true,
    );
    expect(JSON.parse(f.inputs[0]!)).toEqual({ type: "ui.action", ...action });
    expect(f.kinds).toEqual(["ui-action"]);
    expect((await f.host.dispatch(f.state.grants[0]!.id, request)).ok).toBe(
      false,
    );
    expect(f.inputs).toHaveLength(1);
  } finally {
    await f.host.close();
  }
});
it("requires separate action authority and keeps surfaces away from other sessions", async () => {
  const f = await fixture();
  try {
    f.state.grants[0]!.sessionAccess = [];
    await f.host.publishSurface(f.session.id, f.surface);
    expect(f.events).toHaveLength(0);
    expect(
      (
        await f.host.dispatch(
          f.state.grants[0]!.id,
          f.request("ui.get", { sessionId: f.session.id }),
        )
      ).ok,
    ).toBe(false);
    f.state.grants[0]!.sessionAccess = "registered";
    f.state.grants[0]!.scopes = ["sessions:list"];
    expect(
      (
        await f.host.dispatch(
          f.state.grants[0]!.id,
          f.request("ui.action", {
            sessionId: f.session.id,
            surfaceId: f.surface.surfaceId,
            revision: 1,
            actionId: "send",
            values: { name: "Glen" },
          }),
        )
      ).ok,
    ).toBe(false);
    expect(f.inputs).toHaveLength(0);
  } finally {
    await f.host.close();
  }
});

it("rechecks viewer revocation after the surface log write", async () => {
  const f = await fixture(async (event) => {
    if (event.type === "ui.render") await revoke();
  });
  const revoke: () => Promise<void> = () =>
    f.host.revokeGrant(f.state.grants[0]!.id);
  try {
    await f.host.publishSurface(f.session.id, f.surface);
    expect(f.events).toHaveLength(0);
    expect(f.logs.some((event) => event.type === "ui.render")).toBe(true);
  } finally {
    await f.host.close();
  }
});
it("clears the current surface when the local adapter is replaced", async () => {
  const f = await fixture();
  try {
    await f.host.publishSurface(f.session.id, f.surface);
    await f.host.attach({
      profileId: "test",
      providerSessionId: "test",
      label: "replacement",
      adapter: {
        submit: async () => {},
        configure: async () => {},
        detach: async () => {},
      },
    });
    const view = await f.host.dispatch(
      f.state.grants[0]!.id,
      f.request("ui.get", { sessionId: f.session.id }),
    );
    expect(view.ok && view.result.surface).toBeNull();
  } finally {
    await f.host.close();
  }
});

it("keeps action-shaped chat text distinct from a validated UI action", async () => {
  const f = await fixture();
  try {
    f.state.grants[0]!.scopes = ["sessions:chat"];
    const text = JSON.stringify({ type: "ui.action", actionId: "send" });
    const response = await f.host.dispatch(
      f.state.grants[0]!.id,
      f.request("sessions.chat", { sessionId: f.session.id, text }),
    );
    expect(response.ok).toBe(true);
    expect(f.kinds).toEqual(["chat"]);
    expect(f.inputs).toEqual([text]);
  } finally {
    await f.host.close();
  }
});

it("retains output failure for a UI action even when the adapter swallows it", async () => {
  const f = await fixture(async (event) => {
    if (event.type === "chat.completed") throw Error("disk failure");
  }, true);
  try {
    await f.host.publishSurface(f.session.id, f.surface);
    const response = await f.host.dispatch(
      f.state.grants[0]!.id,
      f.request("ui.action", {
        sessionId: f.session.id,
        surfaceId: f.surface.surfaceId,
        revision: 1,
        actionId: "send",
        values: { name: "Glen" },
      }),
    );
    expect(response.ok).toBe(false);
    expect(f.events.map((event) => event.type)).toEqual(["ui.render"]);
  } finally {
    await f.host.close();
  }
});
it("stops provider calls and publications after a surface log failure", async () => {
  let fail = true;
  const f = await fixture(async () => {
    if (fail) throw new Error("disk");
  });
  try {
    await expect(
      f.host.publishSurface(f.session.id, f.surface),
    ).rejects.toThrow();
    fail = false;
    const reply = await f.host.dispatch(
      f.state.grants[0]!.id,
      f.request("sessions.chat", { sessionId: f.session.id, text: "run" }),
    );
    expect(reply.ok).toBe(false);
    expect(!reply.ok && reply.error.code).toBe("log_unavailable");
    expect(f.inputs).toEqual([]);
    await expect(
      f.host.publishSurface(f.session.id, f.surface),
    ).rejects.toThrow("restart");
    expect(f.events).toEqual([]);
    expect(f.logs).toHaveLength(1);
  } finally {
    await f.host.close();
  }
});
