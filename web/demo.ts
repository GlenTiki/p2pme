import { parseSurface } from "../src/surface.js";

export const demoSurface = parseSurface({
  surfaceId: "8e21fba8-f5bd-4d35-b744-3a44bc3a6898",
  revision: 1,
  spec: {
    root: "form",
    state: {
      form: {
        task: "Review the latest change",
        details: false,
        mode: "review",
        effort: 2,
      },
    },
    elements: {
      form: {
        type: "Stack",
        props: {},
        children: [
          "task",
          "preview",
          "mode",
          "effort",
          "details",
          "hint",
          "send",
        ],
      },
      task: {
        type: "TextInput",
        props: { label: "Task", value: { $bindState: "/form/task" } },
        children: [],
      },
      preview: {
        type: "Text",
        props: { text: { $state: "/form/task" } },
        children: [],
      },
      mode: {
        type: "Select",
        props: {
          label: "Task mode",
          value: { $bindState: "/form/mode" },
          options: [
            { label: "Review", value: "review" },
            { label: "Plan", value: "plan" },
          ],
        },
        children: [],
      },
      effort: {
        type: "Slider",
        props: {
          label: "Detail level",
          min: 1,
          max: 5,
          step: 1,
          value: { $bindState: "/form/effort" },
        },
        children: [],
      },
      details: {
        type: "Checkbox",
        props: {
          label: "Show a task note",
          checked: { $bindState: "/form/details" },
        },
        children: [],
      },
      hint: {
        type: "Card",
        props: { title: "Task note" },
        visible: { $state: "/form/details", eq: true },
        children: ["note"],
      },
      note: {
        type: "Text",
        props: {
          text: "Keep the change small. Ask the agent to explain its result.",
        },
        children: [],
      },
      send: {
        type: "Button",
        props: { label: "Try a local action" },
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
});
