import type { PairingInvitation } from "../src/rtc-identity.js";

export type PairingLink =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "invitation"; invitation: PairingInvitation };

export function consumePairingLink(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "state" | "replaceState">,
  decode: (encoded: string) => PairingInvitation,
): PairingLink {
  const fragment = location.hash;
  if (!fragment.startsWith("#pair")) return { kind: "none" };
  try {
    history.replaceState(
      history.state,
      "",
      location.pathname + location.search,
    );
    if (!/^#pair=[A-Za-z0-9_-]{1,2048}$/.test(fragment))
      return { kind: "invalid" };
    return { kind: "invitation", invitation: decode(fragment.slice(6)) };
  } catch {
    return { kind: "invalid" };
  }
}

export function watchPairingLinks(
  target: {
    location: Pick<Location, "hash" | "pathname" | "search">;
    history: Pick<History, "state" | "replaceState">;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
  },
  decode: (encoded: string) => PairingInvitation,
  receive: (link: PairingLink) => void,
): () => void {
  const changed = () => {
    const link = consumePairingLink(target.location, target.history, decode);
    if (link.kind !== "none") receive(link);
  };
  target.addEventListener("hashchange", changed);
  return () => target.removeEventListener("hashchange", changed);
}
