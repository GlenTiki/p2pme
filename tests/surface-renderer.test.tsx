// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createSurfaceMount } from "../web/surface.js";
import { demoSurface } from "../web/demo.js";

const sessionId = "651f06dd-8e07-4c3e-acd4-1ac5db41b49a";
let container: HTMLDivElement;
let mount: ReturnType<typeof createSurfaceMount>;

function button() {
  return container.querySelector("button")!;
}
function input(type: string) {
  return container.querySelector<HTMLInputElement>(`input[type="${type}"]`)!;
}
async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}
async function edit(element: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  mount = createSurfaceMount(container);
});
afterEach(async () => {
  await act(async () => {
    mount.clearSurface();
  });
  container.remove();
});

describe("agent surface controls", () => {
  it("reports local form validation separately from a network error", async () => {
    const onAction = vi.fn();
    await act(async () => {
      mount.mountSurface(sessionId, demoSurface, onAction);
    });
    await edit(input("text"), "界".repeat(3000));
    await click(button());
    expect(onAction).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Check the form values and size");
  });
  it("changes local text and visibility without an action, then sends on click", async () => {
    const onAction = vi.fn();
    await act(async () => {
      mount.mountSurface(sessionId, demoSurface, onAction);
    });
    expect(onAction).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Keep the change small");
    await edit(input("text"), "Check the tests");
    expect(container.querySelector(".surface-text")?.textContent).toBe(
      "Check the tests",
    );
    await click(input("checkbox"));
    expect(container.textContent).toContain("Keep the change small");
    expect(onAction).not.toHaveBeenCalled();
    await click(button());
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith({
      sessionId,
      surfaceId: demoSurface.surfaceId,
      revision: 1,
      actionId: "submit-task",
      values: {
        task: "Check the tests",
        details: true,
        mode: "review",
        effort: 2,
      },
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Action delivered.",
    );
  });

  it("disables buttons until the action finishes and reports errors", async () => {
    let reject!: (error: Error) => void;
    const onAction = vi.fn(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    await act(async () => {
      mount.mountSurface(sessionId, demoSurface, onAction);
    });
    await click(button());
    expect(button().disabled).toBe(true);
    await click(button());
    expect(onAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      reject(new Error("Remote secrets should not be shown"));
    });
    expect(button().disabled).toBe(false);
    expect(container.textContent).toContain(
      "Action failed. Check the session connection.",
    );
    expect(container.textContent).not.toContain("Remote secrets");
  });

  it("keeps the current surface when a replacement fails validation", async () => {
    await act(async () => {
      mount.mountSurface(sessionId, demoSurface, vi.fn());
    });
    const before = container.textContent;
    expect(() =>
      mount.mountSurface(sessionId, { ...demoSurface, script: "bad" }, vi.fn()),
    ).toThrow();
    expect(container.textContent).toBe(before);
  });

  it("resets form state on replacement and detaches old controls", async () => {
    const onAction = vi.fn();
    await act(async () => {
      mount.mountSurface(sessionId, demoSurface, onAction);
    });
    await edit(input("text"), "Old draft");
    const oldButton = button();
    await act(async () => {
      mount.mountSurface(sessionId, { ...demoSurface, revision: 2 }, onAction);
    });
    expect(input("text").value).toBe("Review the latest change");
    await click(oldButton);
    expect(onAction).not.toHaveBeenCalled();
    const replacedButton = button();
    await act(async () => {
      mount.clearSurface();
    });
    await click(replacedButton);
    expect(onAction).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("renders HTML strings as inert text", async () => {
    const surface = structuredClone(demoSurface);
    surface.spec.state.form.task =
      '<img src="https://example.org" onerror="alert(1)">';
    await act(async () => {
      mount.mountSurface(sessionId, surface, vi.fn());
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img");
  });

  it("sends select and slider values only after the user presses the button", async () => {
    const onAction = vi.fn();
    await act(async () => {
      mount.mountSurface(sessionId, demoSurface, onAction);
    });
    await act(async () => {
      const select = container.querySelector("select")!;
      select.value = "plan";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await edit(input("range"), "4");
    expect(onAction).not.toHaveBeenCalled();
    await click(button());
    expect(onAction.mock.calls[0]?.[0].values).toMatchObject({
      mode: "plan",
      effort: 4,
    });
  });

  it("suppresses a late completion from a replaced surface", async () => {
    let finish!: () => void;
    await act(async () => {
      mount.mountSurface(
        sessionId,
        demoSurface,
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    });
    await click(button());
    await act(async () => {
      mount.mountSurface(sessionId, { ...demoSurface, revision: 2 }, vi.fn());
    });
    await act(async () => {
      finish();
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
    expect(button().disabled).toBe(false);
  });
});
