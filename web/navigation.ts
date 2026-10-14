export function redirectHome(
  location: Pick<Location, "pathname" | "search" | "hash" | "replace">,
  history: Pick<History, "state" | "replaceState">,
): boolean {
  if (location.pathname !== "/") return false;
  const fragment = location.hash;
  if (fragment !== "#app" && !fragment.startsWith("#pair")) return false;
  const destination =
    fragment === "#app"
      ? ""
      : /^#pair=[A-Za-z0-9_-]{1,2048}$/.test(fragment)
        ? fragment
        : "#pair";
  try {
    history.replaceState(
      history.state,
      "",
      location.pathname + location.search,
    );
    location.replace("/live/" + destination);
  } catch {
    location.replace("/live/#pair");
  }
  return true;
}
