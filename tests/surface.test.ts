import { describe, expect, it } from "vitest";
import { parseSurface } from "../src/surface.js";

export function exampleSurface() {
  return {
    surfaceId: "8e21fba8-f5bd-4d35-b744-3a44bc3a6898",
    revision: 1,
    spec: {
      root: "root",
      state: { form: { task: "Review", details: false } },
      elements: {
        root: {
          type: "Stack",
          props: {},
          children: ["input", "toggle", "preview", "send"],
        },
        input: {
          type: "TextInput",
          props: { label: "Task", value: { $bindState: "/form/task" } },
          children: [],
        },
        toggle: {
          type: "Checkbox",
          props: {
            label: "Show details",
            checked: { $bindState: "/form/details" },
          },
          children: [],
        },
        preview: {
          type: "Text",
          props: { text: { $state: "/form/task" } },
          visible: { $state: "/form/details", eq: true },
          children: [],
        },
        send: {
          type: "Button",
          props: { label: "Send task" },
          on: {
            press: {
              action: "sendSessionAction",
              params: { actionId: "submit-task" },
            },
          },
          children: [],
        },
      },
    },
  };
}

describe("surface validation", () => {
  it("rejects a surface ID that the host protocol cannot accept", () => {
    const surface = exampleSurface();
    surface.surfaceId = "019a8000-0000-7000-8000-000000000001";
    expect(() => parseSurface(surface)).toThrow();
  });
  it.each([
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ])("rejects prototype key %s at every reference", (key) => {
    const root = exampleSurface();
    root.spec.root = key;
    expect(() => parseSurface(root)).toThrow();
    const child = exampleSurface();
    child.spec.elements.root.children.push(key);
    expect(() => parseSurface(child)).toThrow();
    const state = exampleSurface();
    Object.assign(state.spec.state.form, { [key]: "bad" });
    expect(() => parseSurface(state)).toThrow();
    const bound = exampleSurface();
    bound.spec.elements.input.props.value.$bindState = `/form/${key}`;
    expect(() => parseSurface(bound)).toThrow();
  });
  it("accepts an explicit form with local bindings and one click action", () => {
    expect(parseSurface(exampleSurface()).spec.state.form.task).toBe("Review");
  });

  it.each([
    { watch: { "/form/task": { action: "sendSessionAction" } } },
    { repeat: { statePath: "/form/task" } },
    { style: { position: "fixed" } },
    { on: { mount: { action: "sendSessionAction" } } },
    { type: "iframe" },
  ])("rejects executable or unsupported fields: %j", (extra) => {
    const surface = exampleSurface();
    Object.assign(surface.spec.elements.root, extra);
    expect(() => parseSurface(surface)).toThrow();
  });

  it.each([
    "/credentials",
    "/form/missing",
    "/form/constructor",
    "/form/__proto__",
  ])("rejects unsafe or missing binding %s", (path) => {
    const surface = exampleSurface();
    surface.spec.elements.input.props.value.$bindState = path;
    expect(() => parseSurface(surface)).toThrow();
  });

  it("rejects nested expressions and raw HTML properties", () => {
    const surface = exampleSurface();
    Object.assign(surface.spec.elements.input.props, {
      value: { $computed: "fetch", args: { url: "https://example.org" } },
    });
    expect(() => parseSurface(surface)).toThrow();
    Object.assign(surface.spec.elements.preview.props, {
      dangerouslySetInnerHTML: { __html: "<script>" },
    });
    expect(() => parseSurface(surface)).toThrow();
  });

  it.each(["root", "missing", "input"])(
    "rejects cycles, missing nodes and shared children: %s",
    (child) => {
      const surface = exampleSurface();
      surface.spec.elements.root.children.push(child);
      expect(() => parseSurface(surface)).toThrow();
    },
  );

  it("rejects an unreachable node", () => {
    const surface = exampleSurface();
    surface.spec.elements.root.children.pop();
    expect(() => parseSurface(surface)).toThrow();
  });

  it("rejects children on a leaf", () => {
    const surface = exampleSurface();
    surface.spec.elements.input.children = ["preview"] as never[];
    expect(() => parseSurface(surface)).toThrow();
  });

  it("rejects mismatched control state types", () => {
    const surface = exampleSurface();
    surface.spec.elements.input.props.value.$bindState = "/form/details";
    expect(() => parseSurface(surface)).toThrow();
  });

  it("rejects oversized JSON and excessive form state", () => {
    const surface = exampleSurface();
    surface.spec.state.form.task = "界".repeat(12000);
    expect(() => parseSurface(surface)).toThrow();
    const many = exampleSurface();
    Object.assign(
      many.spec.state.form,
      Object.fromEntries(
        Array.from({ length: 33 }, (_, i) => [`field${i}`, ""]),
      ),
    );
    expect(() => parseSurface(many)).toThrow();
  });

  it("rejects action chains and non-button actions", () => {
    const surface = exampleSurface();
    Object.assign(surface.spec.elements.send.on, {
      press: [surface.spec.elements.send.on.press],
    });
    expect(() => parseSurface(surface)).toThrow();
    Object.assign(surface.spec.elements.input, {
      on: exampleSurface().spec.elements.send.on,
    });
    expect(() => parseSurface(surface)).toThrow();
  });

  it("rejects excessive tree depth and node count", () => {
    const nodes = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [
        `node${i}`,
        {
          type: "Stack",
          props: {},
          children: i === 64 ? [] : [`node${i + 1}`],
        },
      ]),
    );
    const surface = {
      ...exampleSurface(),
      spec: { root: "node0", state: { form: {} }, elements: nodes },
    };
    expect(() => parseSurface(surface)).toThrow();
    surface.spec.elements = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `node${i}`,
        { type: "Stack", props: {}, children: i === 8 ? [] : [`node${i + 1}`] },
      ]),
    );
    expect(() => parseSurface(surface)).toThrow();
  });
});
