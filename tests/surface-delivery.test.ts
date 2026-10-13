import { describe, expect, it, vi } from "vitest";
import { createSurfaceDelivery } from "../web/surface-delivery.js";
import { demoSurface } from "../web/demo.js";

function setup() {
  const render = vi.fn();
  const clear = vi.fn();
  const fail = vi.fn();
  const delivery = createSurfaceDelivery({ render, clear, fail });
  delivery.select("session-a");
  return { delivery, render, clear, fail };
}

describe("selected surface delivery", () => {
  it("fetches the selected surface and ignores older live revisions", async () => {
    const { delivery, render } = setup();
    await delivery.refresh(async () => ({ surface: demoSurface }));
    delivery.receive("session-a", { ...demoSurface, revision: 2 });
    delivery.receive("session-a", demoSurface);
    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenLastCalledWith(
      "session-a",
      expect.objectContaining({ revision: 2 }),
    );
  });

  it("does not replace a live surface with a late null fetch", async () => {
    const { delivery, render, clear } = setup();
    let resolve!: (value: unknown) => void;
    const pending = delivery.refresh(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    delivery.receive("session-a", demoSurface);
    resolve({ surface: null });
    await pending;
    expect(render).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("ignores an old selection even after selecting the same session again", async () => {
    const { delivery, render } = setup();
    let resolve!: (value: unknown) => void;
    const pending = delivery.refresh(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    delivery.select("session-b");
    delivery.select("session-a");
    resolve({ surface: demoSurface });
    await pending;
    expect(render).not.toHaveBeenCalled();
  });

  it("accepts only the latest overlapping fetch", async () => {
    const { delivery, render } = setup();
    let resolve!: (value: unknown) => void;
    const pending = delivery.refresh(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await delivery.refresh(async () => ({
      surface: { ...demoSurface, revision: 2 },
    }));
    resolve({ surface: demoSurface });
    await pending;
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("keeps valid controls on invalid delivery and ignores another session", () => {
    const { delivery, render, clear, fail } = setup();
    delivery.receive("session-a", demoSurface);
    delivery.receive("session-b", { unsafe: true });
    delivery.receive("session-a", { ...demoSurface, spec: { code: "eval" } });
    expect(render).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith("The host sent invalid agent controls.");
  });

  it("clears a current null result and reports only current fetch failures", async () => {
    const { delivery, clear, fail } = setup();
    await delivery.refresh(async () => ({ surface: null }));
    expect(clear).toHaveBeenCalledTimes(2);
    await delivery.refresh(async () => {
      throw new Error("secret");
    });
    expect(fail).toHaveBeenCalledWith(
      "Could not load agent controls for this session.",
    );
    delivery.select(null);
    await delivery.refresh(async () => {
      throw new Error("not called");
    });
    expect(fail).toHaveBeenCalledTimes(1);
  });
});
