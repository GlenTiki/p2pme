import { describe, expect, it, vi } from "vitest";
import { consumePairingLink, watchPairingLinks } from "../web/pairing-link.js";

const invitation = {
  version: 1 as const,
  roomId: "c5bf44c5-3e6d-40f9-8476-6a668d136903",
  secret: "a".repeat(43),
  label: "Host offer",
  expiresAt: "2020-01-01T00:00:00Z",
};
function fixture(hash: string) {
  const location = { hash, pathname: "/", search: "?view=chat" };
  const history = {
    state: { view: "chat" },
    replaceState: vi.fn(() => {
      location.hash = "";
    }),
  };
  return { location, history };
}
describe("host invitation URLs", () => {
  it("removes the secret before decoding and leaves expiry to the host", () => {
    const f = fixture("#pair=encoded");
    const decode = vi.fn(() => {
      expect(f.location.hash).toBe("");
      return invitation;
    });
    expect(consumePairingLink(f.location, f.history, decode)).toEqual({
      kind: "invitation",
      invitation,
    });
    expect(f.history.replaceState).toHaveBeenCalledWith(
      f.history.state,
      "",
      "/?view=chat",
    );
  });
  it.each(["#pair", "#pair=", "#pair=secret&pair=other", "#pair=%ZZ"])(
    "scrubs malformed pairing fragments: %s",
    (hash) => {
      const f = fixture(hash);
      const decode = vi.fn(() => {
        throw new Error("secret must not appear");
      });
      expect(consumePairingLink(f.location, f.history, decode)).toEqual({
        kind: "invalid",
      });
      expect(f.location.hash).toBe("");
    },
  );
  it("does not decode if browser history cannot remove the fragment", () => {
    const f = fixture("#pair=secret");
    f.history.replaceState.mockImplementation(() => {
      throw new Error("blocked");
    });
    const decode = vi.fn(() => invitation);
    expect(consumePairingLink(f.location, f.history, decode)).toEqual({
      kind: "invalid",
    });
    expect(decode).not.toHaveBeenCalled();
  });
  it.each(["", "#app", "#about", "#demo"])(
    "preserves ordinary navigation: %s",
    (hash) => {
      const f = fixture(hash);
      const decode = vi.fn(() => invitation);
      expect(consumePairingLink(f.location, f.history, decode)).toEqual({
        kind: "none",
      });
      expect(f.history.replaceState).not.toHaveBeenCalled();
      expect(decode).not.toHaveBeenCalled();
    },
  );
});

it("scrubs same-document links, preserves anchors and removes its listener", () => {
  const f = fixture("#app");
  const target = Object.assign(new EventTarget(), f);
  const receive = vi.fn();
  const stop = watchPairingLinks(target, () => invitation, receive);
  target.dispatchEvent(new Event("hashchange"));
  expect(f.location.hash).toBe("#app");
  expect(receive).not.toHaveBeenCalled();
  f.location.hash = "#pair=valid";
  target.dispatchEvent(new Event("hashchange"));
  expect(f.location.hash).toBe("");
  expect(receive).toHaveBeenCalledWith({ kind: "invitation", invitation });
  stop();
  f.location.hash = "#pair=another";
  target.dispatchEvent(new Event("hashchange"));
  expect(receive).toHaveBeenCalledTimes(1);
  expect(f.location.hash).toBe("#pair=another");
});
