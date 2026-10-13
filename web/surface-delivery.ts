import { z } from "zod";
import { parseSurface, type AgentSurface } from "../src/surface.js";

interface DeliveryView {
  render(sessionId: string, surface: AgentSurface): void;
  clear(): void;
  fail(message: string): void;
}

export function createSurfaceDelivery(view: DeliveryView) {
  let sessionId: string | null = null;
  let sequence = 0;
  let current: AgentSurface | null = null;
  const accept = (surface: unknown) => {
    if (!sessionId) return;
    const parsed = parseSurface(surface);
    if (
      current?.surfaceId === parsed.surfaceId &&
      current.revision >= parsed.revision
    )
      return;
    view.render(sessionId, parsed);
    current = parsed;
  };
  return {
    select(selected: string | null) {
      sessionId = selected;
      sequence += 1;
      current = null;
      view.clear();
    },
    receive(selected: string, surface: unknown) {
      if (sessionId !== selected) return;
      try {
        accept(surface);
        sequence += 1;
      } catch {
        view.fail("The host sent invalid agent controls.");
      }
    },
    async refresh(fetch: () => Promise<unknown>) {
      if (!sessionId) return;
      const request = ++sequence;
      try {
        const response = await fetch();
        if (sequence !== request) return;
        const { surface } = z
          .strictObject({ surface: z.unknown() })
          .parse(response);
        if (surface === null) {
          current = null;
          view.clear();
        } else accept(surface);
      } catch {
        if (sequence === request)
          view.fail("Could not load agent controls for this session.");
      }
    },
  };
}
