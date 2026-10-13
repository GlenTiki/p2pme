import { createStateStore, type Spec } from "@json-render/core";
import {
  ActionProvider,
  defineRegistry,
  Renderer,
  StateProvider,
  VisibilityProvider,
} from "@json-render/react";
import { useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { z } from "zod";
import {
  parseSurface,
  validateSurfaceValues,
  type AgentSurface,
  type SurfaceAction,
} from "../src/surface.js";
import { surfaceCatalog } from "./catalog.js";
import { PendingAction, surfaceComponents } from "./controls.js";

export type SurfaceActionHandler = (
  action: SurfaceAction,
) => void | Promise<void>;
interface SurfaceProps {
  sessionId: string;
  surface: AgentSurface;
  onAction: SurfaceActionHandler;
  current: () => boolean;
}

function useSurfaceActions({
  sessionId,
  surface,
  onAction,
  current,
}: SurfaceProps) {
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const runtime = useMemo(
    () => ({ store: createStateStore(surface.spec.state), busy: false }),
    [surface],
  );
  const definitions = useMemo(
    () =>
      defineRegistry(surfaceCatalog, {
        components: surfaceComponents,
        actions: {
          sendSessionAction: async (params, _setState, state) => {
            if (!current() || runtime.busy || !params) return;
            runtime.busy = true;
            setPending(true);
            setStatus("Send action…");
            try {
              const values = validateSurfaceValues(surface, state.form);
              await onAction({
                sessionId,
                surfaceId: surface.surfaceId,
                revision: surface.revision,
                actionId: params.actionId,
                values,
              });
              if (current()) setStatus("Action delivered.");
            } catch {
              if (current())
                setStatus("Action failed. Check the session connection.");
            } finally {
              runtime.busy = false;
              if (current()) setPending(false);
            }
          },
        },
      }),
    [sessionId, surface, onAction, current, runtime],
  );
  const handlers = useMemo(
    () => ({
      sendSessionAction: (params: Record<string, unknown>) =>
        definitions.executeAction(
          "sendSessionAction",
          params,
          () => {},
          runtime.store.getSnapshot(),
        ),
    }),
    [definitions, runtime],
  );
  return { ...definitions, handlers, store: runtime.store, status, pending };
}

function SurfaceView(props: SurfaceProps) {
  const { registry, handlers, store, status, pending } =
    useSurfaceActions(props);
  const spec = useMemo(() => rendererSpec(props.surface), [props.surface]);
  return (
    <StateProvider store={store}>
      <VisibilityProvider>
        <ActionProvider handlers={handlers}>
          <PendingAction.Provider value={pending}>
            <Renderer spec={spec} registry={registry} />
          </PendingAction.Provider>
          <p className="surface-status" role="status">
            {status}
          </p>
        </ActionProvider>
      </VisibilityProvider>
    </StateProvider>
  );
}

function rendererSpec(surface: AgentSurface): Spec {
  const elements = Object.fromEntries(
    Object.entries(surface.spec.elements).map(([key, element]) => {
      const { visible, ...rest } = element;
      return [key, visible === undefined ? rest : { ...rest, visible }];
    }),
  );
  return { ...surface.spec, elements };
}

export function createSurfaceMount(element: HTMLElement) {
  let root: Root | undefined;
  let generation = 0;
  return {
    mountSurface(
      sessionId: string,
      input: unknown,
      onAction: SurfaceActionHandler,
    ) {
      z.uuid().parse(sessionId);
      const surface = parseSurface(input);
      const result = surfaceCatalog.validate(surface.spec);
      if (!result.success)
        throw new Error("The surface does not match the component catalog.");
      const revision = ++generation;
      root ??= createRoot(element);
      root.render(
        <SurfaceView
          key={revision}
          sessionId={sessionId}
          surface={surface}
          onAction={onAction}
          current={() => generation === revision}
        />,
      );
    },
    clearSurface() {
      generation += 1;
      root?.unmount();
      root = undefined;
    },
  };
}
