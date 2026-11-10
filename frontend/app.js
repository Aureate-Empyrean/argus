/* Argus: the user's own photographs. Vanilla JS in the Nexus sandbox: every request goes
   through the Nexus bridge to this module's own API; images arrive as data: URLs. */

"use strict";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/* Meridian's durations and curves. Nothing waits for an animation to finish. */
const MOTION = { fast: 120, page: 220, panel: 260, exit: 160, ease: "cubic-bezier(.22,1,.36,1)", exitEase: "cubic-bezier(.4,0,1,1)" };
function animate(el, frames, duration = MOTION.page, easing = MOTION.ease, extra = {}) {
  if (!el?.animate || reducedMotion()) return null;
  return el.animate(frames, { duration, easing, ...extra });
}

// Filled by the server from frontend/icon.svg; the header and manifest share one asset.
const ARGUS_ICON = "/*ARGUS_ICON*/";

const ICONS = {
  photos: '<rect x="3" y="4.5" width="14" height="11" rx="2"/><circle cx="7.5" cy="8.5" r="1.4"/><path d="m3.5 14 4-3.6 3 2.6 2.2-1.8L16.5 14"/>',
  trash: '<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 10h6.6L14 6"/>',
  settings: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.8v1.8M10 15.4v1.8M17.2 10h-1.8M4.6 10H2.8M15.1 4.9l-1.3 1.3M6.2 13.8l-1.3 1.3M15.1 15.1l-1.3-1.3M6.2 6.2 4.9 4.9"/>',
  upload: '<path d="M10 13V4M6.5 7.3 10 3.8l3.5 3.5"/><path d="M4 12.5v2.2c0 .8.7 1.5 1.5 1.5h9c.8 0 1.5-.7 1.5-1.5v-2.2"/>',
  back: '<path d="M11.5 4.5 6 10l5.5 5.5"/>',
  download: '<path d="M10 4v9M6.5 9.7 10 13.2l3.5-3.5"/><path d="M4 14.5v.7c0 .8.7 1.5 1.5 1.5h9c.8 0 1.5-.7 1.5-1.5v-.7"/>',
  restore: '<path d="M4.5 9.5a5.5 5.5 0 1 1 1.6 4"/><path d="M4 5.5v4h4"/>',
  check: '<path d="m4.8 10.4 3.3 3.3 7.1-7.4"/>',
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
  people: '<circle cx="7.5" cy="7" r="2.8"/><path d="M2.5 16c.5-3 2.5-4.5 5-4.5s4.5 1.500 5 4.500"/><path d="M13 4.500a2.800 2.800 0 0 1 0 5M14.500 11.800c1.600.6 2.700 2 3 4.200"/>',
  folder: '<path d="M3 5.500c0-.8.7-1.500 1.500-1.500h3.200l1.800 2h6c.8 0 1.500.7 1.500 1.500v7c0 .8-.7 1.500-1.500 1.500h-11c-.8 0-1.500-.7-1.500-1.500z"/>',
  forward: '<path d="m8.500 4.500 5.500 5.500-5.500 5.500"/>',
  minus: '<path d="M4.500 10h11"/>',
  close: '<path d="m5.500 5.500 9 9M14.500 5.500l-9 9"/>',
  info: '<circle cx="10" cy="10" r="7"/><path d="M10 9.200v4.300M10 6.500v.1"/>',
  expand: '<path d="M3.500 7.500v-4h4M16.500 7.500v-4h-4M3.500 12.500v4h4M16.500 12.500v4h-4"/>',
};
const icon = (n) => `<svg class="i" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ""}</svg>`;

/* ── Bridge ── */
let serial = 0;
const pending = new Map();
addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.channel !== "empyrean-v1") return;
  const req = pending.get(event.data.id);
  if (!req) return;
  clearTimeout(req.timer);
  pending.delete(event.data.id);
  event.data.error ? req.reject(Error(event.data.error)) : req.resolve(event.data.result);
});
function bridge(action, data = {}) {
  return new Promise((resolve, reject) => {
    const id = String(++serial);
    const timer = setTimeout(() => (pending.delete(id), reject(Error("Nexus did not respond. Try again in a moment."))), 30000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ channel: "empyrean-v1", id, action, ...data }, "*");
  });
}
const api = (path, method = "GET", body) => bridge("request", { path: "/api" + path, method, ...(body === undefined ? {} : { body }) });

/* ── Feedback ── */
function toast(message, tone = "") {
  const el = document.createElement("div");
  el.className = `ae-toast ae-glass ${tone ? "ae-toast--" + tone : ""}`;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => {
    const leaving = animate(el, [{ opacity: 1 }, { opacity: 0, transform: "translateY(6px)" }], MOTION.exit, MOTION.exitEase);
    leaving ? leaving.finished.finally(() => el.remove()) : el.remove();
  }, 4200);
}
function confirmDialog(title, text, label, { danger = true } = {}) {
  const d = $("#dialog");
  d.innerHTML = `<div class="ae-dialog-head"><h2>${esc(title)}</h2></div><div class="ae-dialog-body">${text}</div>
    <div class="ae-dialog-foot"><button class="ae-btn" value="cancel">Cancel</button><button class="ae-btn ${danger ? "ae-btn--danger" : "ae-btn--primary"}" value="ok">${esc(label)}</button></div>`;
  d.showModal();
  $('[value="cancel"]', d).focus();
  return new Promise((resolve) => {
    const done = (v) => (d.close(), resolve(v));
    $('[value="cancel"]', d).onclick = () => done(false);
    $('[value="ok"]', d).onclick = () => done(true);
    d.oncancel = () => resolve(false);
  });
}

/* ── Formatting ── */
const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (iso) => (iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "long", ...(iso.length > 10 ? { timeStyle: "short" } : {}) }).format(new Date(iso.endsWith("Z") ? iso : iso)) : "");
const label = (p) => p.title || p.filename || "Photo";

/* ── State and routing ── */
const state = { route: { view: "library" }, counts: { active: 0, trashed: 0 }, items: [], cursor: null, settings: null, limits: null, uploads: [], pick: null };

function routeFrom(path) {
  const p = path.replace(/^\/modules\/[^/]+/, "").replace(/\/+$/, "") || "/";
  const pick = p.match(/^\/pick\/([a-z][a-z0-9-]{0,47})((?:\/[A-Za-z0-9_-]+)*)$/);
  if (pick) {
    state.pick = { module: pick[1], back: pick[2] || "" };
    return { view: "library" };
  }
  const photo = p.match(/^\/photos\/([0-9a-f-]{36})$/);
  if (photo) return { view: "photo", id: photo[1] };
  const cluster = p.match(/^\/clusters\/([0-9a-f-]{36})$/);
  if (cluster) return { view: "cluster", id: cluster[1] };
  if (p === "/") return { view: "library" };
  if (["/people", "/import", "/trash", "/settings"].includes(p)) return { view: p.slice(1) };
  return { view: "not-found", path: p };
}
/** Inside a Nexus with the navigation contract every move is a browser history entry and is
 * shown when Nexus confirms it (frontend/navigation.js); otherwise it is shown directly. */
function go(view, id = null, mode = "push") {
  // The screen already on show is refreshed instead: an identical address commits nothing.
  const target = ArgusRoutes.serialize({ view, id });
  if (argusNavigation.enabled && queuedRoute === target) return;
  if (argusNavigation.enabled && target !== (queuedRoute ?? shownRoute)) {
    return queueNavigation(target, mode).catch((error) => {
      if (/superseded/i.test(error.message)) return;
      toast(error.message, "danger");
      Viewer.resync();
    });
  }
  state.route = { view, id };
  render();
}

function shell() {
  $("#app").innerHTML = `<aside class="rail" aria-label="Argus">
      <div class="brand"><span class="brand-mark"><img src="${ARGUS_ICON}" alt="" aria-hidden="true" width="32" height="32"></span><span class="brand-name">Argus</span></div>
      <nav id="nav" aria-label="Sections"></nav>
    </aside>
    <main class="sheet" id="sheet"></main>
    <section class="viewer" id="viewer" aria-label="Photo viewer" hidden></section>`;
}
function nav() {
  const r = state.route.view;
  const box = $("#nav");
  const items = [["library", "photos", "Photos", state.counts.active], ["people", "people", "People"], ["import", "folder", "Import"], ["trash", "trash", "Trash", state.counts.trashed], ["settings", "settings", "Settings"]];
  // Updated in place, so the highlight can move instead of being rebuilt.
  if (!box.children.length) box.innerHTML = items.map(([view, ic, text]) => `<button class="nav-item" data-go="${view}">${icon(ic)}<span>${text}</span><span class="count" hidden></span></button>`).join("");
  for (const [view, , , count] of items) {
    const button = $(`[data-go="${view}"]`, box);
    r === view || (view === "library" && r === "photo") ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current");
    const badge = $(".count", button);
    badge.hidden = !count;
    badge.textContent = count || "";
  }
}
async function refreshState() {
  const s = await api("/state");
  state.counts = s.counts;
  state.settings = s.settings;
  state.limits = s.limits;
}

/* A newer render supersedes this one: a late response never paints over the current screen. */
let renderToken = 0;
const stale = (token) => token !== renderToken;
let renderedView = null;
async function render() {
  const token = ++renderToken;
  let restoring = state.restoring;
  state.restoring = null;
  nav();
  const sheet = $("#sheet");
  const view = state.route.view;
  const changed = view !== renderedView;
  let outcome;
  const notFound = () => {
    Viewer.close({ toTile: false });
    state.galleryOf = null;
    sheet.innerHTML = `<div class="page"><div class="empty"><h3 data-heading tabindex="-1">This page could not be found</h3><p>The address may be wrong, or the photo may have been deleted.</p><button class="ae-btn" data-go="library">Back to Photos</button></div></div>`;
    outcome = "not-found";
  };
  try {
    if (view === "photo") {
      await Viewer.show(state.route.id, token, restoring);
      if (stale(token)) return;
      renderedView = view;
      $("#viewer [data-heading]")?.focus({ preventScroll: true });
      return outcome;
    }
    const which = view === "trash" ? "trashed" : view === "library" ? "active" : null;
    if (Viewer.isOpen()) {
      // The gallery is still underneath, exactly as it was left: nothing needs loading again.
      if (which && state.galleryOf === which && !state.galleryDirty) {
        Viewer.close();
        state.sheetRoute = { view };
        renderedView = view;
        return outcome;
      }
      if (which && state.galleryOf === which) restoring ||= { scroll: sheet.scrollTop, loaded: state.items.length };
      Viewer.close({ toTile: false });
    }
    state.galleryOf = null;
    sheet.ondragenter = sheet.ondragover = sheet.ondragleave = sheet.ondrop = null;
    if (view === "not-found") notFound();
    else if (view === "trash") await viewGrid(sheet, "trashed", token, restoring);
    else if (view === "settings") viewSettings(sheet, restoring);
    else if (view === "people") await viewPeople(sheet, token);
    else if (view === "cluster") await viewCluster(sheet, state.route.id, token);
    else if (view === "import") await viewImport(sheet, token);
    else await viewGrid(sheet, "active", token, restoring);
    if (view !== "not-found") state.sheetRoute = { view, id: state.route.id };
  } catch (error) {
    if (stale(token)) return;
    if (/not found/i.test(error.message)) notFound();
    else {
      Viewer.close({ toTile: false });
      state.galleryOf = null;
      sheet.innerHTML = `<div class="page"><div class="empty"><h3>This could not be loaded</h3><p>${esc(error.message)}</p><button class="ae-btn" data-go="library">Back to Photos</button></div></div>`;
    }
  }
  if (stale(token)) return;
  sheet.scrollTop = restoring?.scroll || 0;
  $("[data-heading]", sheet)?.focus({ preventScroll: true });
  if (changed && !restoring) animate($(".page", sheet), [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], MOTION.page);
  renderedView = view;
  return outcome;
}

/* ── Library and Trash ── */
const pickBand = () =>
  state.pick ? `<div class="picker-band" role="status"><p><b>Choose a photo for ${esc(appName(state.pick.module))}.</b> Open one and select “Use this photo”, or upload a new one.</p><button class="ae-btn ae-btn--sm" data-act="pick-cancel">Cancel</button></div>` : "";
let apps = [];
const appName = (id) => apps.find((a) => a.id === id)?.name || id;

/* The gallery is a justified layout done by flexbox alone: a cell's share of its row is the photo's
   aspect ratio, so every row is flush, nothing is distorted, and a resize costs no JavaScript. */
function tileHtml(p, fresh = false) {
  const ratio = Math.max(0.5, Math.min(3, p.width / p.height || 1)).toFixed(4);
  return `<li class="tile-cell${fresh ? " is-fresh" : ""}" style="--a:${ratio}"><button class="tile" data-photo="${esc(p.id)}" aria-label="${esc(label(p))}, ${esc(p.width)} × ${esc(p.height)}">${p.thumbnail ? `<img src="${p.thumbnail}" alt="" decoding="async" draggable="false">` : `<span class="broken">Preview unavailable</span>`}<span class="caption">${esc(label(p))}</span></button></li>`;
}
const twoDigits = (n) => String(n).padStart(2, "0");
const monthFormat = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
/** Capture date when the file records a usable one; otherwise the upload date, and it says so. */
function dayOf(p) {
  const taken = !!p.taken_at && !Number.isNaN(Date.parse(p.taken_at));
  const date = new Date(taken ? p.taken_at : p.created_at);
  return { key: `${taken ? "t" : "u"}${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`, month: `${date.getFullYear()}-${date.getMonth()}`, date, taken };
}
function dayHtml(day, cells) {
  return `<section class="day" data-day="${day.key}" data-month="${day.month}"><h4 class="day-head">${esc(dayFormat.format(day.date))}${day.taken ? "" : '<span class="day-note">date uploaded</span>'}</h4><ul class="day-tiles">${cells}</ul></section>`;
}
const monthHtml = (day) => `<h3 class="month-head">${esc(monthFormat.format(day.date))}</h3>`;
function timelineHtml(items, fresh) {
  let html = "";
  let month = null;
  for (let i = 0; i < items.length; ) {
    const day = dayOf(items[i]);
    let cells = "";
    for (; i < items.length && dayOf(items[i]).key === day.key; i++) cells += tileHtml(items[i], fresh?.has(items[i].id));
    if (day.month !== month) html += monthHtml(day);
    month = day.month;
    html += dayHtml(day, cells);
  }
  return html;
}
const flatHtml = (items) => `<section class="day" data-day="all"><ul class="day-tiles">${items.map((p) => tileHtml(p)).join("")}</ul></section>`;
function appendTiles(items) {
  const grid = $("#grid");
  if (!grid) return;
  if (state.itemsOf !== "active") {
    $('[data-day="all"] .day-tiles', grid).insertAdjacentHTML("beforeend", items.map((p) => tileHtml(p)).join(""));
  } else {
    for (const p of items) {
      const day = dayOf(p);
      const last = grid.lastElementChild;
      if (last?.dataset.day === day.key) $(".day-tiles", last).insertAdjacentHTML("beforeend", tileHtml(p));
      else grid.insertAdjacentHTML("beforeend", (last?.dataset.month === day.month ? "" : monthHtml(day)) + dayHtml(day, tileHtml(p)));
    }
  }
  watchTiles();
}
/* Loading further: by scrolling near the end, or by the button, or when the viewer runs out. */
let loadingMore = null;
function loadMore() {
  if (!state.cursor) return Promise.resolve(false);
  loadingMore ||= (async () => {
    try {
      const which = state.itemsOf;
      const page = await api(`/photos?state=${which}&cursor=${state.cursor}`);
      if (which !== state.itemsOf) return false;
      state.items.push(...page.items);
      state.cursor = page.next_cursor;
      if (state.galleryOf === which) appendTiles(page.items);
      const more = $(".more");
      if (more) more.hidden = !state.cursor;
      return true;
    } finally {
      loadingMore = null;
    }
  })();
  return loadingMore;
}
/* A sharper picture only for tiles that are on screen and larger than the thumbnail. */
const previews = new Map();
const previewQueue = [];
let previewsRunning = 0;
function pumpPreviews() {
  while (previewsRunning < 2 && previewQueue.length) {
    const img = previewQueue.pop();
    if (!img.isConnected) continue;
    previewsRunning++;
    const id = img.closest("[data-photo]").dataset.photo;
    (previews.has(id) ? Promise.resolve(previews.get(id)) : api(`/photos/${id}/preview`).then((r) => r.src))
      .then((src) => {
        previews.set(id, src);
        if (previews.size > 240) previews.delete(previews.keys().next().value);
        const next = new Image();
        next.src = src;
        return Promise.resolve(next.decode?.()).catch(() => {}).then(() => {
          if (img.isConnected) img.src = src;
        });
      })
      .catch(() => {})
      .finally(() => {
        previewsRunning--;
        pumpPreviews();
      });
  }
}
const previewWatcher = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    previewWatcher.unobserve(entry.target);
    const dense = devicePixelRatio || 1;
    if (Math.max(entry.target.clientWidth, entry.target.clientHeight) * dense > 340) previewQueue.push(entry.target);
  }
  pumpPreviews();
}, { rootMargin: "200px" });
const moreWatcher = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && !Viewer.isOpen()) loadMore().catch((error) => toast(error.message, "danger"));
}, { rootMargin: "900px" });
function watchTiles() {
  for (const img of $$("#grid .tile img:not([data-watched])")) {
    img.dataset.watched = "1";
    previewWatcher.observe(img);
  }
}
const skeleton = () => `<div class="page gallery-page"><div class="gallery-bar is-skeleton"></div><div class="skeleton" aria-hidden="true">${[1.5, 0.75, 1.33, 1, 1.5, 1.78, 0.67, 1.33, 1.5, 1, 0.75, 1.5].map((a) => `<span style="--a:${a}"></span>`).join("")}</div></div>`;
async function viewGrid(sheet, which, token, restoring) {
  const trash = which === "trashed";
  if (!sheet.firstChild && !restoring) sheet.innerHTML = skeleton();
  const page = await api(`/photos?state=${which}`);
  if (stale(token)) return;
  const items = page.items;
  let cursor = page.next_cursor;
  // Returning to a list: load as far as it had been loaded, within reason.
  for (let i = 0; cursor && items.length < (restoring?.loaded || 0) && i < 20; i++) {
    const more = await api(`/photos?state=${which}&cursor=${cursor}`);
    if (stale(token)) return;
    items.push(...more.items);
    cursor = more.next_cursor;
  }
  state.items = items;
  state.cursor = cursor;
  state.itemsOf = which;
  const count = trash ? state.counts.trashed : state.counts.active;
  const fresh = state.freshIds;
  state.freshIds = null;
  const hero = !trash && !items.length;
  sheet.innerHTML = `<div class="page gallery-page">
    ${trash ? "" : pickBand()}
    <header class="gallery-bar"><div class="gallery-name"><h2 class="gallery-title" data-heading tabindex="-1">${trash ? "Trash" : "Photos"}</h2>
      <p class="meta">${count === 1 ? "1 photo" : `${count} photos`}${trash ? " · restore them, or delete them for good" : ""}</p></div>
      ${trash || hero ? "" : `<div class="tools"><button class="ae-btn ae-btn--primary" data-act="choose">${icon("upload")}<span>Upload</span></button></div>`}</header>
    ${trash ? "" : `<input type="file" id="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden>`}
    ${items.length ? `<div class="timeline" id="grid">${trash ? flatHtml(items) : timelineHtml(items, fresh)}</div>`
      : trash ? `<div class="empty"><h3>Trash is empty</h3><p>Photos you move to Trash wait here until you restore them or delete them for good.</p></div>`
      : `<div class="empty empty-hero" id="drop" tabindex="0" role="button" aria-label="Upload photos: drop files here or press Enter to choose">${icon("photos")}<h3>Your photographs start here</h3><p>Drop photos anywhere on this page, or choose them. They stay private to you and to the applications you allow.</p><span class="ae-btn ae-btn--primary">${icon("upload")}<span>Upload photos</span></span><small>JPEG, PNG, WebP or GIF · up to ${esc(state.settings?.max_upload_mb)} MB and ${esc(state.settings?.max_megapixels)} megapixels each. Originals are kept exactly as uploaded.</small></div>`}
    <div class="more" ${state.cursor ? "" : "hidden"}><button class="ae-btn" data-act="more">Show more</button></div>
    ${trash ? "" : `<div class="drop-veil" id="drop-veil" hidden><div>${icon("upload")}<strong>Drop to upload</strong></div></div>`}
  </div>`;
  state.galleryOf = which;
  state.galleryDirty = false;
  if (!trash) bindUpload(sheet);
  renderUploads();
  watchTiles();
  moreWatcher.disconnect();
  if ($(".more")) moreWatcher.observe($(".more"));
  if (!restoring && !fresh) $$(".tile-cell", sheet).slice(0, 24).forEach((cell, i) => animate(cell, [{ opacity: 0 }, { opacity: 1 }], MOTION.page, MOTION.ease, { delay: Math.min(i, 10) * 12, fill: "backwards" }));
}

/* ── Upload: files go up in chunks (module requests are limited to 2 MiB) ── */
function bindUpload(sheet) {
  const input = $("#file");
  input.onchange = () => {
    queue([...input.files]);
    input.value = "";
  };
  const drop = $("#drop");
  if (drop) {
    drop.onclick = () => input.click();
    drop.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.click());
  }
  // The whole page accepts a drop; the large target exists only while the library is empty.
  const veil = $("#drop-veil");
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  let depth = 0;
  sheet.ondragenter = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) veil.hidden = false;
  };
  sheet.ondragover = (e) => hasFiles(e) && e.preventDefault();
  sheet.ondragleave = (e) => {
    if (hasFiles(e) && --depth <= 0) (depth = 0), (veil.hidden = true);
  };
  sheet.ondrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    veil.hidden = true;
    queue([...e.dataTransfer.files]);
  };
}
/* One row per file, updated in place so its bar moves smoothly. */
function renderUploads() {
  let list = $("#uploads");
  if (!state.uploads.length) return list?.remove();
  if (!list) {
    list = Object.assign(document.createElement("ul"), { id: "uploads", className: "uploads ae-glass" });
    list.setAttribute("aria-live", "polite");
    $("#app").append(list);
  }
  for (const u of state.uploads) {
    if (!u.row) {
      u.row = document.createElement("li");
      u.row.innerHTML = `<span class="name"></span><span class="state"></span><span class="bar"><span></span></span>`;
      $(".name", u.row).textContent = u.name;
      list.append(u.row);
      animate(u.row, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], MOTION.page);
    }
    const stateEl = $(".state", u.row);
    stateEl.textContent = u.error || u.status;
    stateEl.classList.toggle("bad", !!u.error);
    u.row.classList.toggle("is-done", u.status === "Added" || u.status === "Already in your library");
    $(".bar span", u.row).style.transform = `scaleX(${u.progress})`;
  }
  for (const row of [...list.children]) if (!state.uploads.some((u) => u.row === row)) row.remove();
}
function b64(bytesArray) {
  let s = "";
  for (let i = 0; i < bytesArray.length; i += 0x8000) s += String.fromCharCode.apply(null, bytesArray.subarray(i, i + 0x8000));
  return btoa(s);
}
let uploading = false;
async function queue(files) {
  for (const f of files) state.uploads.push({ file: f, name: f.name, status: "Waiting", progress: 0 });
  renderUploads();
  if (uploading) return;
  uploading = true;
  let last = null;
  while (state.uploads.some((u) => u.status === "Waiting")) {
    const u = state.uploads.find((x) => x.status === "Waiting");
    try {
      last = await uploadOne(u);
    } catch (error) {
      u.error = error.message;
      u.status = "Failed";
      renderUploads();
    }
  }
  uploading = false;
  await refreshState();
  const done = state.uploads.filter((u) => !u.error);
  const added = done.filter((u) => u.status === "Added");
  state.uploads = state.uploads.filter((u) => u.error);
  if (added.length) toast(added.length === 1 ? "1 photo added" : `${added.length} photos added`, "good");
  state.freshIds = new Set(added.map((u) => u.photoId));
  renderUploads();
  if (state.route.view === "library" && !Viewer.isOpen()) {
    await render();
    if (state.pick && done.length === 1 && last) go("photo", last.id);
  } else {
    state.galleryDirty = true;
    nav();
  }
}
async function uploadOne(u, { quiet = false } = {}) {
  u.status = "Uploading";
  renderUploads();
  const start = await api("/uploads", "POST", { filename: u.name, size: u.file.size });
  const data = new Uint8Array(await u.file.arrayBuffer());
  for (let i = 0; i < start.chunks; i++) {
    const part = data.subarray(i * start.chunk_size, (i + 1) * start.chunk_size);
    await api(`/uploads/${start.id}/${i}`, "PUT", { data: b64(part) });
    u.progress = (i + 1) / start.chunks;
    renderUploads();
  }
  u.status = "Checking";
  renderUploads();
  const result = await api(`/uploads/${start.id}/finish${u.source ? `?source=${encodeURIComponent(u.source)}` : ""}`, "POST");
  u.status = result.duplicate ? "Already in your library" : "Added";
  u.photoId = result.photo.id;
  u.progress = 1;
  renderUploads();
  if (result.duplicate && !quiet) toast(`${u.name} is already in your library`);
  return result.photo;
}

/* ── One photo: frontend/viewer.js ── */
async function usageInto(id) {
  const box = $("#usage");
  try {
    const u = await api(`/photos/${id}/usage`);
    if (!box.isConnected) return;
    box.dataset.known = u.known;
    box.dataset.count = u.items.length;
    box.innerHTML = !u.known
      ? "<li>Could not be checked right now.</li>"
      : u.items.length
        ? u.items.map((x) => `<li><span>${esc(appName(x.module))} · ${esc(x.label || "Something linked here")}${x.relation.endsWith("representative-image") ? " (profile picture)" : ""}${x.availability === "deleted" ? " · deleted there" : x.availability && x.availability !== "available" ? " · not available right now" : ""}</span>${x.open_path && x.availability === "available" && apps.some((a) => a.id === x.module) ? ` <button class="ae-btn ae-btn--sm ae-btn--quiet" data-act="open-usage" data-module="${esc(x.module)}" data-path="${esc(x.open_path)}">Open</button>` : ""}</li>`).join("")
        : "<li>No other application uses this photo.</li>";
  } catch {
    if (box.isConnected) box.innerHTML = "<li>Could not be checked right now.</li>";
  }
}
async function download(id) {
  let offset = 0;
  const parts = [];
  let meta = null;
  toast("Preparing the original…");
  do {
    meta = await api(`/photos/${id}/original?offset=${offset}`);
    const raw = Uint8Array.from(atob(meta.data), (c) => c.charCodeAt(0));
    parts.push(raw);
    offset += raw.length;
  } while (offset < meta.size);
  const url = URL.createObjectURL(new Blob(parts, { type: meta.mime }));
  const a = Object.assign(document.createElement("a"), { href: url, download: meta.filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ── Settings ── */
function viewSettings(sheet, restoring) {
  const s = { ...state.settings, ...(restoring?.settings ? { max_upload_mb: restoring.settings.mb, max_megapixels: restoring.settings.mp } : {}) };
  const l = state.limits;
  sheet.innerHTML = `<div class="page"><header class="head"><div><p class="eyebrow">Argus</p><h2 class="display" data-heading tabindex="-1">Settings</h2><p class="meta">Limits for new uploads. Photos already in the library are not affected.</p></div></header>
    <form class="settings" id="settings">
      <div class="ae-field"><label class="ae-label" for="max-mb">Largest file (MB)</label><input class="ae-input" id="max-mb" type="number" min="${l.max_upload_mb[0]}" max="${l.max_upload_mb[1]}" value="${s.max_upload_mb}"><p class="ae-hint">Between ${l.max_upload_mb[0]} and ${l.max_upload_mb[1]} MB.</p></div>
      <div class="ae-field"><label class="ae-label" for="max-mp">Largest picture (megapixels)</label><input class="ae-input" id="max-mp" type="number" min="${l.max_megapixels[0]}" max="${l.max_megapixels[1]}" value="${s.max_megapixels}"><p class="ae-hint">At most ${l.max_megapixels[1]}: Argus decodes pictures within the memory Nexus gives each module.</p></div>
      <div class="actions"><button class="ae-btn ae-btn--primary" type="button" id="save-settings">Save</button></div>
    </form></div>`;
  // The Nexus sandbox has no allow-forms, so a <form> is never submitted: the button and
  // Enter call the handler directly.
  const form = $("#settings");
  const save = async () => {
    const button = $("#save-settings");
    if (button.disabled || !form.reportValidity()) return;
    button.disabled = true;
    try {
      state.settings = await api("/settings", "PUT", { max_upload_mb: +$("#max-mb").value, max_megapixels: +$("#max-mp").value });
      toast("Settings saved", "good");
    } catch (error) {
      toast(error.message, "danger");
    } finally {
      button.disabled = false;
    }
  };
  $("#save-settings").onclick = save;
  form.onsubmit = (e) => e.preventDefault();
  form.onkeydown = (e) => {
    if (e.key === "Enter" && e.target.tagName === "INPUT") {
      e.preventDefault();
      save();
    }
  };
}

/* ── Actions ── */
document.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-go], [data-act], [data-photo], [data-cluster]");
  if (!el || el.disabled) return;
  try {
    if (el.dataset.go) return go(el.dataset.go);
    if (el.dataset.cluster) return go("cluster", el.dataset.cluster);
    if (el.dataset.photo && !el.dataset.act) {
      if (el.matches(".tile")) Viewer.openFrom(el, el.dataset.photo);
      return go("photo", el.dataset.photo);
    }
    const act = el.dataset.act;
    const id = el.dataset.id;
    if (act === "choose") return $("#file").click();
    if (act === "more") return loadMore();
    if (act.startsWith("viewer-")) return Viewer.action(act);
    if (act === "download") return download(id);
    if (act === "open-usage") return bridge("navigate", { module: el.dataset.module, path: el.dataset.path });
    if (act === "trash") {
      await api(`/photos/${id}`, "DELETE");
      await refreshState();
      Viewer.forget(id);
      state.galleryDirty = true;
      toast("Moved to Trash. Applications that use it show their own placeholder until you restore it.");
      return go("library", null, "replace");
    }
    if (act === "restore") {
      await api(`/photos/${id}/restore`, "POST");
      await refreshState();
      Viewer.forget(id);
      state.galleryDirty = true;
      toast("Restored", "good");
      return go("photo", id);
    }
    if (act === "purge") {
      const box = $("#usage");
      const known = box?.dataset.known === "true";
      const n = +(box?.dataset.count || 0);
      const why = !known
        ? "<p>Argus could not check whether another application still uses this photo.</p>"
        : n
          ? `<p>This photo is still used in ${n === 1 ? "one place" : `${n} places`}. Those applications will show their own placeholder instead.</p>`
          : "<p>No other application uses it.</p>";
      if (!(await confirmDialog("Delete this photo for good?", `${why}<p>The original file is removed and cannot be recovered, unless another photo shares the same bytes.</p>`, "Delete for good"))) return;
      await api(`/photos/${id}/purge?confirm=true`, "DELETE");
      await refreshState();
      Viewer.forget(id);
      state.galleryDirty = true;
      toast("Deleted for good");
      return go("trash", null, "replace");
    }
    const handled = await peopleAction(act, el);
    if (handled !== undefined) return handled;
    if (act === "use") return bridge("navigate", { module: state.pick.module, path: `${state.pick.back}/${id}` });
    if (act === "pick-cancel") return bridge("navigate", { module: state.pick.module, path: state.pick.back || "/" });
  } catch (error) {
    toast(error.message, "danger");
  }
});

/* ── Import (ADR 0027) ── */
let importTimer = null;
const IMAGE_FILE = /\.(jpe?g|png|webp|gif)$/i;
const folderRun = { active: false, cancel: false, total: 0, done: 0, added: 0, duplicates: 0, failed: 0 };
function jobRow(j) {
  const running = ["scanning", "running", "cancelling"].includes(j.state);
  const stateText = { scanning: "Looking through the folder…", running: "Importing", cancelling: "Stopping…", cancelled: "Cancelled", done: "Finished", failed: "Stopped by an error" }[j.state];
  const pct = j.total ? Math.round((j.processed / j.total) * 100) : 0;
  return `<li class="job"><div class="job-head"><strong>${esc(j.root || "Import folder")}</strong><span>${esc(stateText)}</span></div>
    <span class="bar"><span style="--p:${pct}%"></span></span>
    <p class="meta">${j.processed} of ${j.total} · ${j.imported} added · ${j.duplicates} already in your library · ${j.failed} could not be imported</p>
    ${running ? `<button class="ae-btn ae-btn--sm" data-act="import-cancel" data-id="${esc(j.id)}">Cancel</button>` : j.failed ? `<button class="ae-btn ae-btn--sm ae-btn--quiet" data-act="import-errors" data-id="${esc(j.id)}">See what failed</button><ul class="usage" id="errors-${esc(j.id)}"></ul>` : ""}</li>`;
}
async function viewImport(sheet, token) {
  const browse = await api("/import/folders?path=" + encodeURIComponent(state.importPath || "")).catch(() => ({ path: "", folders: [], files: 0 }));
  if (stale(token)) return;
  sheet.innerHTML = `<div class="page"><header class="head"><div><p class="eyebrow">Library</p><h2 class="display" data-heading tabindex="-1">Import</h2><p class="meta">Exact duplicates are found by their content. Your source files are never changed or deleted.</p></div></header>
    <section class="panel-block"><h3>From this device</h3><p class="meta">Choose a folder. Each photo is uploaded in turn, so large batches are fine.</p>
      <input type="file" id="folder" webkitdirectory multiple hidden><button class="ae-btn ae-btn--primary" data-act="import-local">${icon("folder")}<span>Choose a folder</span></button><div id="folder-run"></div></section>
    <section class="panel-block"><h3>From the server</h3><p class="meta">Folders inside Argus's import folder${browse.path ? `: <code>${esc(browse.path)}</code>` : ""}.</p>
      <ul class="folders">${browse.path ? `<li><button class="ae-btn ae-btn--sm ae-btn--quiet" data-act="import-open" data-path="${esc(browse.path.split("/").slice(0, -1).join("/"))}">${icon("back")}<span>Up</span></button></li>` : ""}${browse.folders.map((x) => `<li><button class="ae-btn ae-btn--sm ae-btn--quiet" data-act="import-open" data-path="${esc(x.path)}">${icon("folder")}<span>${esc(x.name)}</span></button></li>`).join("") || (browse.path ? "" : "<li class='meta'>No folders yet. Copy photos into the import folder on the server first.</li>")}</ul>
      <button class="ae-btn" data-act="import-server" data-path="${esc(browse.path)}" ${browse.files || browse.folders.length ? "" : "disabled"}>Import this folder${browse.files ? ` (${browse.files} here, and any subfolders)` : ""}</button></section>
    <section class="panel-block"><h3>Recent imports</h3><ul class="jobs" id="jobs"><li class="meta">Checking…</li></ul></section></div>`;
  $("#folder").onchange = (e) => runFolder([...e.target.files]);
  renderFolderRun();
  pollJobs();
}
async function pollJobs() {
  clearTimeout(importTimer);
  if (state.route.view !== "import") return;
  const { items } = await api("/import/jobs").catch(() => ({ items: [] }));
  const box = $("#jobs");
  if (!box) return;
  box.innerHTML = items.length ? items.map(jobRow).join("") : '<li class="meta">No imports yet.</li>';
  if (items.some((j) => ["scanning", "running", "cancelling"].includes(j.state))) importTimer = setTimeout(pollJobs, 1500);
  else refreshState().then(nav).catch(() => {});
}
function renderFolderRun() {
  const box = $("#folder-run");
  if (!box || !folderRun.total) return;
  const r = folderRun;
  box.innerHTML = `<span class="bar"><span style="--p:${Math.round((r.done / r.total) * 100)}%"></span></span><p class="meta">${r.done} of ${r.total} · ${r.added} added · ${r.duplicates} already in your library · ${r.failed} could not be imported${r.cancel ? " · cancelled" : ""}</p>${r.active ? '<button class="ae-btn ae-btn--sm" data-act="import-local-cancel">Cancel</button>' : ""}`;
}
async function runFolder(files) {
  const images = files.filter((x) => IMAGE_FILE.test(x.name));
  Object.assign(folderRun, { active: true, cancel: false, total: images.length, done: 0, added: 0, duplicates: 0, failed: 0 });
  renderFolderRun();
  for (const file of images) {
    if (folderRun.cancel) break;
    try {
      const u = { file, name: file.name, status: "", progress: 0, source: file.webkitRelativePath };
      const before = await uploadOne(u, { quiet: true });
      folderRun[u.status === "Added" ? "added" : "duplicates"]++;
      void before;
    } catch {
      folderRun.failed++;
    }
    folderRun.done++;
    renderFolderRun();
  }
  folderRun.active = false;
  renderFolderRun();
  await refreshState().catch(() => {});
  nav();
}

/* ── People: face recognition (ADR 0028) ── */
const CONF = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };
const STATUS_TEXT = { auto: "Automatic suggestion", confirmed: "Confirmed by you", unknown: "Marked unknown", excluded: "Excluded from recognition" };
function faceCaption(f) {
  if (f.status === "confirmed") return `${f.person_label || "Confirmed"} · confirmed`;
  if (f.status === "unknown") return "Unknown";
  if (f.status === "excluded") return "Excluded";
  if (f.suggested) return `Maybe ${f.suggested_label || "someone in Meridian"}`;
  return "Not named";
}
async function viewPeople(sheet, token) {
  const status = await api("/faces/status");
  if (stale(token)) return;
  const head = `<header class="head"><div><p class="eyebrow">Library</p><h2 class="display" data-heading tabindex="-1">People</h2><p class="meta">${status.enabled ? `${status.scanned} of ${status.photos} photos scanned · ${status.faces} faces · ${status.confirmed} confirmed` : "Face recognition is off"}</p></div>
    ${status.enabled ? '<div class="tools"><button class="ae-btn" data-act="faces-off">Turn off</button><button class="ae-btn ae-btn--danger" data-act="faces-delete">Delete all recognition data</button></div>' : ""}</header>`;
  if (!status.enabled) {
    sheet.innerHTML = `<div class="page">${head}<div class="empty"><h3>Find the people in your photos</h3><p>Argus can detect faces, group the ones that look alike and let you name them from Meridian. It runs entirely on this server: photos and face data are never sent anywhere, and nothing is added to Meridian.</p>${status.supported ? '<button class="ae-btn ae-btn--primary" data-act="faces-on">Turn on face recognition</button>' : `<p class="notice">Argus needs more memory than Nexus has granted it (${status.memory_limit_mb} MB). Update Nexus and Argus.</p>`}</div></div>`;
    return;
  }
  const { items } = await api("/faces/clusters");
  if (stale(token)) return;
  sheet.innerHTML = `<div class="page">${head}${items.length ? `<ul class="clusters">${items.map((c) => `<li><button class="cluster" data-cluster="${esc(c.id)}"><span class="cluster-faces">${c.faces.slice(0, 3).map((f) => (f.thumb ? `<img src="${f.thumb}" alt="">` : "")).join("")}</span><strong>${esc(c.person_label || "Not named yet")}</strong><span class="meta">${c.count === 1 ? "1 photo" : `${c.count} photos`}</span></button></li>`).join("")}</ul>` : `<div class="empty"><h3>No faces found yet</h3><p>Scanning continues in the background.</p></div>`}</div>`;
}
function personPicker(id) {
  return `<div class="person-pick"><input class="ae-input" id="pick-${id}" data-person-search="${id}" type="search" placeholder="Search people in Meridian" aria-label="Search people in Meridian" autocomplete="off" maxlength="100"><div class="person-results" id="results-${id}"></div></div>`;
}
let searchTimer = null;
document.addEventListener("input", (event) => {
  const id = event.target.dataset?.personSearch;
  if (!id) return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const box = $(`#results-${CSS.escape(id)}`);
    const found = await api("/people?q=" + encodeURIComponent(event.target.value)).catch(() => ({ availability: "error", items: [] }));
    if (!box) return;
    box.innerHTML = found.availability !== "available" ? '<p class="meta">Meridian cannot be reached right now.</p>' : found.items.map((p) => `<button class="ae-btn ae-btn--sm ae-btn--quiet" data-act="person-pick" data-target="${esc(id)}" data-resource="${esc(p.resource)}" data-label="${esc(p.label)}">${esc(p.label)}</button>`).join("") || '<p class="meta">No one in Meridian matches.</p>';
  }, 180);
});
async function viewCluster(sheet, id, token) {
  const c = await api(`/faces/clusters/${id}`);
  const { items } = await api("/faces/clusters");
  if (stale(token)) return;
  const others = items.filter((x) => x.id !== id);
  sheet.innerHTML = `<div class="page"><header class="head"><div><p class="eyebrow"><button class="ae-btn ae-btn--quiet ae-btn--sm" data-go="people">${icon("back")}<span>People</span></button></p><h2 class="display" data-heading tabindex="-1">${esc(c.person_label || "Not named yet")}</h2><p class="meta">${c.faces.length} faces. Naming this group confirms only the confident matches; the others stay suggestions for you to check.</p></div>
    ${c.person ? '<div class="tools"><button class="ae-btn" data-act="cluster-unassign">Remove this name</button></div>' : ""}</header>
    ${c.person ? "" : `<section class="panel-block"><h3>Who is this?</h3>${personPicker("cluster")}</section>`}
    ${others.length ? `<section class="panel-block"><h3>Same person as another group?</h3><select class="ae-select" id="merge-into" aria-label="Merge into"><option value="">Choose a group</option>${others.map((o) => `<option value="${esc(o.id)}">${esc(o.person_label || `Not named (${o.count})`)}</option>`).join("")}</select> <button class="ae-btn ae-btn--sm" data-act="cluster-merge">Merge</button></section>` : ""}
    <ul class="face-grid">${c.faces.map(faceCard).join("")}</ul></div>`;
  state.clusterId = id;
}
function faceCard(f) {
  return `<li class="face-card" data-face="${esc(f.id)}">${f.thumb ? `<img src="${f.thumb}" alt="">` : ""}<div><strong>${esc(faceCaption(f))}</strong><span class="meta">${esc(STATUS_TEXT[f.status])}${f.status === "auto" && f.confidence ? ` · ${CONF[f.confidence]}` : ""}</span></div>
    <div class="actions">${f.status === "auto" && (f.suggested || state.route.view === "cluster") ? `<button class="ae-btn ae-btn--sm" data-act="face-confirm" data-id="${esc(f.id)}">${icon("check")}<span>Yes</span></button>` : ""}<button class="ae-btn ae-btn--sm ae-btn--quiet" data-act="face-open" data-photo="${esc(f.photo_id)}">Open photo</button></div></li>`;
}
/* One photo: boxes over the picture, and a card per face. */
async function loadPhotoFaces(id) {
  const panel = $("#face-panel");
  const status = await api("/faces/status").catch(() => null);
  if (!panel || !status) return;
  const { items } = await api(`/photos/${id}/faces`);
  if (!panel.isConnected || Viewer.currentId() !== id) return;
  const canvas = $("#v-canvas");
  let layer = $("#face-layer");
  if (canvas && !canvas.hidden && !layer) {
    layer = document.createElement("div");
    layer.id = "face-layer";
    canvas.append(layer);
  }
  if (layer) layer.innerHTML = items.map((f) => `<button class="face-box is-${f.status}" data-act="face-select" data-id="${esc(f.id)}" style="left:${f.box.x * 100}%;top:${f.box.y * 100}%;width:${f.box.w * 100}%;height:${f.box.h * 100}%" aria-label="${esc(faceCaption(f))}"><span>${esc(faceCaption(f))}</span></button>`).join("");
  state.photoFaces = { id, items };
  const faceHtml = items.length ? items.map(photoFaceRow).join("") : `<p class="meta">${status.enabled ? "No faces marked in this photo." : "Face recognition is off, but you can still mark a face by hand."}</p>`;
  panel.innerHTML = `<div class="face-rows">${faceHtml}</div><button class="ae-btn ae-btn--sm" data-act="face-mark" data-id="${esc(id)}">${icon("plus")}<span>Mark a face</span></button>`;
}
function photoFaceRow(f) {
  const decided = f.status !== "auto";
  const tools = [
    f.status === "auto" && f.suggested ? `<button class="ae-btn ae-btn--sm" data-act="face-confirm" data-id="${esc(f.id)}">${icon("check")}<span>Confirm</span></button>` : "",
    `<button class="ae-btn ae-btn--sm" data-act="face-change" data-id="${esc(f.id)}">${f.status === "confirmed" ? "Change" : "Name"}</button>`,
    f.status !== "unknown" ? `<button class="ae-btn ae-btn--sm ae-btn--quiet" data-act="face-state" data-state="unknown" data-id="${esc(f.id)}">Unknown</button>` : "",
    f.status !== "excluded" ? `<button class="ae-btn ae-btn--sm ae-btn--quiet" data-act="face-state" data-state="excluded" data-id="${esc(f.id)}">Exclude</button>` : "",
    decided ? `<button class="ae-btn ae-btn--sm ae-btn--quiet" data-act="face-reset" data-id="${esc(f.id)}">Undo</button>` : "",
    f.origin === "manual" ? `<button class="ae-btn ae-btn--sm ae-btn--quiet" data-act="face-remove" data-id="${esc(f.id)}">Remove</button>` : "",
  ].join("");
  return `<div class="face-row" id="face-${esc(f.id)}">${f.thumb ? `<img src="${f.thumb}" alt="">` : ""}<div class="grow"><strong>${esc(faceCaption(f))}</strong><span class="meta">${esc(STATUS_TEXT[f.status])}${f.origin === "manual" ? " · marked by hand" : ""}${f.status === "auto" && f.confidence ? ` · ${CONF[f.confidence]}` : ""}</span><div class="actions">${tools}</div><div id="picker-${esc(f.id)}"></div></div></div>`;
}
function startMarking(photoId) {
  const layer = $("#face-layer");
  if (!layer) return toast("The picture is not available to mark.", "danger");
  Viewer.ensureInfo();
  layer.classList.add("is-marking");
  toast("Drag a box around the face.");
  let start = null;
  let box = null;
  const point = (e) => {
    const r = layer.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))];
  };
  layer.onpointerdown = (e) => {
    if (e.target.closest(".face-box")) return;
    e.preventDefault();
    layer.setPointerCapture(e.pointerId);
    start = point(e);
    box = document.createElement("div");
    box.className = "face-draft";
    layer.append(box);
  };
  layer.onpointermove = (e) => {
    if (!start) return;
    const [x, y] = point(e);
    Object.assign(box.style, { left: `${Math.min(x, start[0]) * 100}%`, top: `${Math.min(y, start[1]) * 100}%`, width: `${Math.abs(x - start[0]) * 100}%`, height: `${Math.abs(y - start[1]) * 100}%` });
  };
  layer.onpointerup = async (e) => {
    if (!start) return;
    const [x, y] = point(e);
    const area = { x: Math.min(x, start[0]), y: Math.min(y, start[1]), w: Math.abs(x - start[0]), h: Math.abs(y - start[1]) };
    start = null;
    layer.classList.remove("is-marking");
    layer.onpointerdown = layer.onpointermove = layer.onpointerup = null;
    box.remove();
    if (area.w < 0.01 || area.h < 0.01) return toast("That box is too small.", "danger");
    try {
      const made = await api(`/photos/${photoId}/faces`, "POST", area);
      await loadPhotoFaces(photoId);
      openFacePicker(made.id);
    } catch (error) {
      toast(error.message, "danger");
    }
  };
}
function openFacePicker(id) {
  const holder = $(`#picker-${CSS.escape(id)}`);
  if (!holder) return;
  holder.innerHTML = personPicker(id);
  $("input", holder).focus();
}
async function afterFaceChange() {
  if (state.route.view === "photo") return loadPhotoFaces(Viewer.currentId());
  return render();
}
async function peopleAction(act, el) {
  const id = el.dataset.id;
  if (act === "import-open") {
    state.importPath = el.dataset.path;
    argusNavigation.viewChanged();
    return render();
  }
  if (act === "import-server") {
    await api("/import/jobs", "POST", { path: el.dataset.path || "" });
    toast("Import started");
    return pollJobs();
  }
  if (act === "import-cancel") {
    await api(`/import/jobs/${id}/cancel`, "POST");
    return pollJobs();
  }
  if (act === "import-errors") {
    const { items } = await api(`/import/jobs/${id}/errors`);
    $(`#errors-${CSS.escape(id)}`).innerHTML = items.map((x) => `<li>${esc(x.path)}: ${esc(x.error)}</li>`).join("");
    return true;
  }
  if (act === "import-local") return $("#folder").click();
  if (act === "import-local-cancel") {
    folderRun.cancel = true;
    return renderFolderRun();
  }
  if (act === "faces-on" || act === "faces-off") {
    await api("/faces/settings", "PUT", { enabled: act === "faces-on" });
    return render();
  }
  if (act === "faces-delete") {
    if (!(await confirmDialog("Delete all recognition data?", "<p>Every detected face, grouping and name you assigned is removed, and recognition is turned off. Your photographs are not affected.</p>", "Delete recognition data"))) return true;
    await api("/faces/data?confirm=true", "DELETE");
    toast("Recognition data deleted");
    return render();
  }
  if (act === "person-pick") {
    const body = { resource: el.dataset.resource, label: el.dataset.label };
    if (el.dataset.target === "cluster") await api(`/faces/clusters/${state.clusterId}/assign`, "POST", body);
    else await api(`/faces/${el.dataset.target}/assign`, "POST", body);
    toast("Saved", "good");
    return afterFaceChange();
  }
  if (act === "cluster-unassign") {
    await api(`/faces/clusters/${state.clusterId}/unassign`, "POST");
    return render();
  }
  if (act === "cluster-merge") {
    const into = $("#merge-into").value;
    if (!into) return true;
    await api(`/faces/clusters/${state.clusterId}/merge`, "POST", { into });
    if (argusNavigation.enabled) return go("cluster", into, "replace");
    state.route = { view: "cluster", id: into };
    return render();
  }
  if (act === "face-confirm") {
    await api(`/faces/${id}/confirm`, "POST").catch(async (error) => {
      if (state.route.view !== "cluster" || !/no suggestion/.test(error.message)) throw error;
      toast("Name this group first.");
    });
    return afterFaceChange();
  }
  if (act === "face-open") return go("photo", el.dataset.photo);
  if (act === "face-select") {
    $(`#face-${CSS.escape(id)}`)?.scrollIntoView({ block: "nearest" });
    return openFacePicker(id);
  }
  if (act === "face-change") return openFacePicker(id);
  if (act === "face-state") {
    await api(`/faces/${id}/state`, "POST", { state: el.dataset.state });
    return afterFaceChange();
  }
  if (act === "face-reset") {
    await api(`/faces/${id}/reset`, "POST");
    return afterFaceChange();
  }
  if (act === "face-remove") {
    await api(`/faces/${id}`, "DELETE");
    return afterFaceChange();
  }
  if (act === "face-mark") return startMarking(id);
  return undefined;
}

async function start() {
  let ctx = null;
  try {
    ctx = await bridge("context");
    apps = ctx.applications || [];
  } catch {
    /* standalone preview */
  }
  // Also records picker mode, which belongs to this document's bootstrap path.
  state.route = routeFrom(location.pathname);
  try {
    await refreshState();
  } catch (error) {
    $("#app").innerHTML = `<p class="splash">Argus could not start: ${esc(error.message)}</p>`;
    return;
  }
  shell();
  // Inside a Nexus that supports it, the browser URL and Back/Forward follow Argus's screens.
  if (ctx?.navigation?.versions?.includes(1)) {
    try {
      if (await argusNavigation.start(ctx)) {
        if (shownRoute) await queueNavigation(shownRoute, "replace").catch(() => {});
        return;
      }
    } catch {
      /* the host did not answer the handshake: keep the in-memory navigation below */
    }
  }
  render();
}
start();
