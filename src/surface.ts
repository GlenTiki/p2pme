import { z } from "zod";
import { isId } from "./protocol.js";

const safeKey = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
  .refine((key) => !(key in Object.prototype) && key !== "prototype");
const fieldPath = z
  .string()
  .refine(
    (path) =>
      path.startsWith("/form/") && safeKey.safeParse(path.slice(6)).success,
  );
const scalar = z.union([
  z.string().max(4096),
  z.number().finite(),
  z.boolean(),
]);
const binding = z.strictObject({ $bindState: fieldPath });
const reference = z.strictObject({ $state: fieldPath });
const label = z.string().min(1).max(120);
const base = {
  children: z.array(safeKey).max(64),
  visible: z.strictObject({ $state: fieldPath, eq: scalar }).optional(),
};

export const surfaceProps = {
  Stack: z.strictObject({}),
  Card: z.strictObject({ title: label }),
  Text: z.strictObject({ text: z.union([z.string().max(4096), reference]) }),
  TextInput: z.strictObject({ label, value: binding }),
  Select: z.strictObject({
    label,
    value: binding,
    options: z
      .array(z.strictObject({ label, value: z.string().max(120) }))
      .min(1)
      .max(32),
  }),
  Slider: z.strictObject({
    label,
    value: binding,
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().positive(),
  }),
  Checkbox: z.strictObject({ label, checked: binding }),
  Button: z.strictObject({ label }),
};

const elementSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("Stack"),
    props: surfaceProps.Stack,
  }),
  z.strictObject({
    ...base,
    type: z.literal("Card"),
    props: surfaceProps.Card,
  }),
  z.strictObject({
    ...base,
    type: z.literal("Text"),
    props: surfaceProps.Text,
  }),
  z.strictObject({
    ...base,
    type: z.literal("TextInput"),
    props: surfaceProps.TextInput,
  }),
  z.strictObject({
    ...base,
    type: z.literal("Select"),
    props: surfaceProps.Select,
  }),
  z.strictObject({
    ...base,
    type: z.literal("Slider"),
    props: surfaceProps.Slider,
  }),
  z.strictObject({
    ...base,
    type: z.literal("Checkbox"),
    props: surfaceProps.Checkbox,
  }),
  z.strictObject({
    ...base,
    type: z.literal("Button"),
    props: surfaceProps.Button,
    on: z.strictObject({
      press: z.strictObject({
        action: z.literal("sendSessionAction"),
        params: z.strictObject({ actionId: safeKey }),
      }),
    }),
  }),
]);

const valuesSchema = z
  .record(safeKey, scalar)
  .refine((values) => Object.keys(values).length <= 32);
export const surfaceSchema = z.strictObject({
  surfaceId: z.string().refine(isId),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  spec: z.strictObject({
    root: safeKey,
    state: z.strictObject({ form: valuesSchema }),
    elements: z
      .record(safeKey, elementSchema)
      .refine((elements) => Object.keys(elements).length <= 64),
  }),
});

export type AgentSurface = z.infer<typeof surfaceSchema>;
export type SurfaceElement = z.infer<typeof elementSchema>;
export type SurfaceValues = z.infer<typeof valuesSchema>;
export interface SurfaceAction {
  sessionId: string;
  surfaceId: string;
  revision: number;
  actionId: string;
  values: SurfaceValues;
}

function boundValue(values: SurfaceValues, path: string) {
  const key = path.slice(6);
  if (!Object.hasOwn(values, key))
    throw new Error("The surface references a missing form value.");
  return values[key];
}

function checkSelect(
  element: Extract<SurfaceElement, { type: "Select" }>,
  values: SurfaceValues,
) {
  const options = element.props.options.map((option) => option.value);
  const value = boundValue(values, element.props.value.$bindState);
  if (
    new Set(options).size !== options.length ||
    typeof value !== "string" ||
    !options.includes(value)
  ) {
    throw new Error("The selected form value must match one unique option.");
  }
}

function checkSlider(
  element: Extract<SurfaceElement, { type: "Slider" }>,
  values: SurfaceValues,
) {
  const { min, max, step, value: binding } = element.props;
  const value = boundValue(values, binding.$bindState);
  if (
    typeof value !== "number" ||
    min >= max ||
    step > max - min ||
    value < min ||
    value > max
  ) {
    throw new Error("The slider value or limits are invalid.");
  }
}

function checkControl(element: SurfaceElement, values: SurfaceValues) {
  switch (element.type) {
    case "TextInput":
      if (
        typeof boundValue(values, element.props.value.$bindState) !== "string"
      )
        throw new Error("A text input requires a string.");
      break;
    case "Checkbox":
      if (
        typeof boundValue(values, element.props.checked.$bindState) !==
        "boolean"
      )
        throw new Error("A checkbox requires a boolean.");
      break;
    case "Select":
      checkSelect(element, values);
      break;
    case "Slider":
      checkSlider(element, values);
      break;
    case "Text":
      if (typeof element.props.text !== "string")
        boundValue(values, element.props.text.$state);
      break;
  }
}

function checkTree(spec: AgentSurface["spec"]) {
  const visited = new Set<string>();
  function visit(key: string, depth: number) {
    if (!Object.hasOwn(spec.elements, key))
      throw new Error("The surface references a missing element.");
    const element = spec.elements[key];
    if (!element || visited.has(key) || depth > 8)
      throw new Error(
        "The surface must be a bounded tree with unique children.",
      );
    visited.add(key);
    if (
      element.type !== "Stack" &&
      element.type !== "Card" &&
      element.children.length
    )
      throw new Error("A leaf cannot contain children.");
    for (const child of element.children) visit(child, depth + 1);
  }
  visit(spec.root, 1);
  if (visited.size !== Object.keys(spec.elements).length)
    throw new Error("Every element must be reachable from the root.");
}

export function parseSurface(input: unknown): AgentSurface {
  const json = JSON.stringify(input);
  if (typeof json !== "string" || new TextEncoder().encode(json).length > 32768)
    throw new Error("A surface must fit in 32 KiB of JSON.");
  const surface = surfaceSchema.parse(input);
  checkTree(surface.spec);
  validateSurfaceValues(surface, surface.spec.state.form);
  return surface;
}

export function validateSurfaceValues(
  surface: AgentSurface,
  input: unknown,
): SurfaceValues {
  const values = valuesSchema.parse(input);
  const fields = Object.keys(surface.spec.state.form);
  if (
    Object.keys(values).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(values, field))
  )
    throw new Error("The surface form fields changed.");
  for (const element of Object.values(surface.spec.elements)) {
    if (element.visible) boundValue(values, element.visible.$state);
    checkControl(element, values);
  }
  if (new TextEncoder().encode(JSON.stringify(values)).length > 8192)
    throw new Error("Form values must fit in 8 KiB of JSON.");
  return values;
}
