import { createContext, useContext } from "react";
import { useBoundProp, type Components } from "@json-render/react";
import { surfaceCatalog } from "./catalog.js";

export const PendingAction = createContext(false);

export const surfaceComponents: Components<typeof surfaceCatalog> = {
  Stack: ({ children }) => <div className="surface-stack">{children}</div>,
  Card: ({ props, children }) => (
    <section className="surface-card">
      <h4>{props.title}</h4>
      {children}
    </section>
  ),
  Text: ({ props }) => <p className="surface-text">{String(props.text)}</p>,
  TextInput: function TextInput({ props, bindings }) {
    const [value, setValue] = useBoundProp(props.value, bindings?.value);
    return (
      <label className="surface-field">
        <span>{props.label}</span>
        <input
          type="text"
          value={value}
          maxLength={4096}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
    );
  },
  Checkbox: function Checkbox({ props, bindings }) {
    const [checked, setChecked] = useBoundProp(
      props.checked,
      bindings?.checked,
    );
    return (
      <label className="checkbox-label surface-checkbox">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => setChecked(event.target.checked)}
        />
        <span>{props.label}</span>
      </label>
    );
  },
  Select: function Select({ props, bindings }) {
    const [value, setValue] = useBoundProp(props.value, bindings?.value);
    return (
      <label className="surface-field">
        <span>{props.label}</span>
        <select
          value={value}
          onChange={(event) => setValue(event.target.value)}
        >
          {props.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  },
  Slider: function Slider({ props, bindings }) {
    const [value, setValue] = useBoundProp(props.value, bindings?.value);
    return (
      <label className="surface-field">
        <span>
          {props.label}: {value}
        </span>
        <input
          type="range"
          value={value}
          min={props.min}
          max={props.max}
          step={props.step}
          onChange={(event) => setValue(event.target.valueAsNumber)}
        />
      </label>
    );
  },
  Button: function Button({ props, emit }) {
    const pending = useContext(PendingAction);
    return (
      <button
        type="button"
        className="button primary"
        disabled={pending}
        onClick={() => emit("press")}
      >
        {props.label}
        <span aria-hidden="true">↑</span>
      </button>
    );
  },
};
