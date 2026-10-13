import { isId } from "./protocol.js";
import {
  parseSurface,
  validateSurfaceValues,
  type AgentSurface,
  type SurfaceAction,
  type SurfaceValues,
} from "./surface.js";

function activeAction(
  surface: AgentSurface,
  actionId: string,
  values: SurfaceValues,
): boolean {
  function visit(key: string): boolean {
    const element = surface.spec.elements[key]!;
    if (
      element.visible &&
      values[element.visible.$state.slice(6)] !== element.visible.eq
    )
      return false;
    if (
      element.type === "Button" &&
      element.on.press.params.actionId === actionId
    )
      return true;
    return element.children.some(visit);
  }
  return visit(surface.spec.root);
}

export function createSurfaceRegistry() {
  const surfaces = new Map<string, AgentSurface>();
  const pending = new Map<string, Promise<unknown>>();
  const generations = new Map<string, symbol>();
  return {
    publish(
      sessionId: string,
      input: unknown,
      append: (surface: AgentSurface) => Promise<void>,
    ): Promise<AgentSurface> {
      if (!isId(sessionId))
        return Promise.reject(new Error("Invalid session ID"));
      const surface = parseSurface(input);
      const generation = generations.get(sessionId) ?? Symbol();
      generations.set(sessionId, generation);
      const result = (pending.get(sessionId) ?? Promise.resolve()).then(
        async () => {
          const current = surfaces.get(sessionId);
          if (current && surface.revision <= current.revision)
            throw new Error("Surface revision must increase");
          if (generations.get(sessionId) !== generation)
            throw new Error("Session surface was cleared");
          await append(structuredClone(surface));
          if (generations.get(sessionId) !== generation)
            throw new Error("Session surface was cleared");
          surfaces.set(sessionId, surface);
          return structuredClone(surface);
        },
      );
      const settled = result
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          if (pending.get(sessionId) === settled) pending.delete(sessionId);
        });
      pending.set(sessionId, settled);
      return result;
    },
    get(sessionId: string): AgentSurface | null {
      return structuredClone(surfaces.get(sessionId) ?? null);
    },
    action(
      action: Omit<SurfaceAction, "values"> & { values: unknown },
    ): string {
      const surface = surfaces.get(action.sessionId);
      if (
        !surface ||
        surface.surfaceId !== action.surfaceId ||
        surface.revision !== action.revision
      )
        throw new Error("Surface is unavailable or stale");
      const values = validateSurfaceValues(surface, action.values);
      if (!activeAction(surface, action.actionId, values))
        throw new Error("Surface action is unavailable");
      return JSON.stringify({ type: "ui.action", ...action, values });
    },
    clear(sessionId: string): void {
      surfaces.delete(sessionId);
      generations.delete(sessionId);
    },
  };
}
