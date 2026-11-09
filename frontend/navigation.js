/* Argus adapter for the Nexus navigation contract (`empyrean-navigation-v1`, SDK in
   vendor/nexus-navigation.js, kept in sync by empyrean-nexus/scripts/sync-navigation.mjs).
   Nexus owns the browser URL and history; Argus owns its routes. A route reference is the
   screen and a stable ID; how much of the library was loaded, scroll, the import folder and
   typed settings are private per-entry view state. Picker mode is carried by the bootstrap
   path (`/pick/...`), so it survives every move and a reload. Without a supporting host,
   Argus keeps its old in-memory navigation. */

const ArgusRoutes = {
  parse(value) {
    const path = String(value || "/").split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
    return routeFrom(path);
  },
  serialize(route) {
    if (route.view === "not-found") return route.path;
    if (route.view === "photo") return `/photos/${route.id}`;
    if (route.view === "cluster") return `/clusters/${route.id}`;
    return route.view === "library" || !route.view ? "/" : `/${route.view}`;
  },
};

let shownRoute = null;
const argusNavigation = EmpyreanNavigation.createClient({
  async apply(value, message) {
    const next = ArgusRoutes.parse(value);
    const reference = ArgusRoutes.serialize(next);
    if (reference === shownRoute) return;
    if (!message.isCurrent()) return;
    shownRoute = reference;
    state.route = next;
    state.restoring = message.viewState || null;
    if (message.viewState?.importPath !== undefined) state.importPath = message.viewState.importPath;
    const outcome = await render();
    // Superseded while loading: nothing was shown, so the next restore must show it.
    if (!message.isCurrent() && shownRoute === reference) shownRoute = null;
    return outcome;
  },
  /* A photo's title saves itself when the field loses focus; a browser traversal does not blur it.
     A save that fails keeps the photo on screen and Nexus says so. */
  async beforeLeave() {
    const title = $("#title");
    if (!title || title.disabled || title.value.trim() === title.dataset.saved) return;
    await api(`/photos/${state.route.id}`, "PATCH", { title: title.value.trim() });
    title.dataset.saved = title.value.trim();
  },
  captureView() {
    if (!state.route) return null;
    const view = { scroll: $("#sheet")?.scrollTop || 0, importPath: state.importPath ?? "" };
    if (state.route.view === "library" || state.route.view === "trash") view.loaded = state.items.length;
    if (state.route.view === "settings" && $("#max-mb")) view.settings = { mb: $("#max-mb").value, mp: $("#max-mp").value };
    return view;
  },
  onError(error) {
    toast(error.message, "danger");
  },
});

let navigationQueue = Promise.resolve();
function queueNavigation(reference, mode) {
  const next = navigationQueue.catch(() => {}).then(() => argusNavigation.navigate(reference, mode));
  navigationQueue = next;
  return next;
}
