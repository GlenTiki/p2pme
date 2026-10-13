import { expect, it } from "vitest";
import { createSurfaceRegistry } from "../src/host-surfaces.js";

function fixture() {
  return {
    surfaceId: crypto.randomUUID(),
    revision: 1,
    spec: {
      root: "root",
      state: { form: { text: "hello", enabled: true } },
      elements: {
        root: { type: "Stack", props: {}, children: ["input", "send"] },
        input: {
          type: "TextInput",
          props: { label: "Text", value: { $bindState: "/form/text" } },
          children: [],
        },
        send: {
          type: "Button",
          props: { label: "Send" },
          children: [],
          visible: { $state: "/form/enabled", eq: true },
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
}
it("publishes only after the output log accepts the surface", async () => {
  const registry = createSurfaceRegistry();
  const session = crypto.randomUUID();
  const surface = fixture();
  let release!: () => void;
  const write = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = registry.publish(session, surface, () => write);
  expect(registry.get(session)).toBeNull();
  release();
  await pending;
  expect(registry.get(session)).toEqual(surface);
  await expect(
    registry.publish(session, { ...surface, revision: 2 }, async () => {
      throw Error("disk");
    }),
  ).rejects.toThrow("disk");
  expect(registry.get(session)?.revision).toBe(1);
});
it("serialises publication and rejects stale revisions", async () => {
  const registry = createSurfaceRegistry(),
    session = crypto.randomUUID(),
    surface = fixture();
  const writes: number[] = [];
  const append = async () => {
    writes.push(1);
  };
  await Promise.all([
    registry.publish(session, surface, append),
    registry.publish(session, { ...surface, revision: 2 }, append),
  ]);
  await expect(registry.publish(session, surface, append)).rejects.toThrow(
    "revision",
  );
  expect(writes).toHaveLength(2);
  expect(registry.get(session)?.revision).toBe(2);
});
it("validates the active action, revision, visible button and typed fields", async () => {
  const registry = createSurfaceRegistry(),
    session = crypto.randomUUID(),
    surface = fixture();
  await registry.publish(session, surface, async () => {});
  const action = {
    sessionId: session,
    surfaceId: surface.surfaceId,
    revision: 1,
    actionId: "send",
    values: { text: "new", enabled: true },
  };
  expect(JSON.parse(registry.action(action))).toEqual({
    type: "ui.action",
    ...action,
  });
  for (const patch of [
    { surfaceId: crypto.randomUUID() },
    { sessionId: crypto.randomUUID() },
    { revision: 2 },
    { actionId: "unknown" },
    { values: { text: 7, enabled: true } },
    { values: { text: "hi", enabled: false } },
    { values: { text: "hi", enabled: true, extra: "x" } },
  ]) {
    expect(() => registry.action({ ...action, ...patch })).toThrow();
  }
  registry.clear(session);
  expect(() => registry.action(action)).toThrow();
});
it("does not expose mutable registry state", async () => {
  const registry = createSurfaceRegistry(),
    session = crypto.randomUUID(),
    surface = fixture();
  await registry.publish(session, surface, async () => {});
  registry.get(session)!.revision = 99;
  surface.revision = 99;
  expect(registry.get(session)?.revision).toBe(1);
});
it("does not restore a cleared surface after a pending write", async () => {
  const registry = createSurfaceRegistry(),
    session = crypto.randomUUID();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publish = registry.publish(session, fixture(), async () => {
    entered();
    await hold;
  });
  await started;
  registry.clear(session);
  release();
  await expect(publish).rejects.toThrow("cleared");
  expect(registry.get(session)).toBeNull();
});
it("rejects an action under a hidden ancestor", async () => {
  const registry = createSurfaceRegistry(),
    session = crypto.randomUUID(),
    surface = fixture();
  const input = {
    ...surface,
    spec: {
      ...surface.spec,
      elements: {
        ...surface.spec.elements,
        root: {
          ...surface.spec.elements.root,
          visible: { $state: "/form/enabled", eq: false },
        },
      },
    },
  };
  await registry.publish(session, input, async () => {});
  expect(() =>
    registry.action({
      sessionId: session,
      surfaceId: surface.surfaceId,
      revision: 1,
      actionId: "send",
      values: surface.spec.state.form,
    }),
  ).toThrow("unavailable");
});
