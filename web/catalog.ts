import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

export const surfaceCatalog = defineCatalog(schema, {
  components: {
    Stack: { props: z.object({}), slots: ["default"] },
    Card: { props: z.object({ title: z.string() }), slots: ["default"] },
    Text: { props: z.object({ text: z.string() }) },
    TextInput: { props: z.object({ label: z.string(), value: z.string() }) },
    Select: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        options: z.array(z.object({ label: z.string(), value: z.string() })),
      }),
    },
    Slider: {
      props: z.object({
        label: z.string(),
        value: z.number(),
        min: z.number(),
        max: z.number(),
        step: z.number(),
      }),
    },
    Checkbox: { props: z.object({ label: z.string(), checked: z.boolean() }) },
    Button: { props: z.object({ label: z.string() }) },
  },
  actions: {
    sendSessionAction: { params: z.object({ actionId: z.string() }) },
  },
});
