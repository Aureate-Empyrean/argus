/* Argus: the user's own photographs. Vanilla JS in the Nexus sandbox: every request goes
   through the Nexus bridge to this module's own API; images arrive as data: URLs. */

"use strict";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  setTimeout(() => el.remove(), 4200);
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
  if (argusNavigation.enabled && ArgusRoutes.serialize({ view, id }) !== shownRoute) {
    return queueNavigation(ArgusRoutes.serialize({ view, id }), mode).catch((error) => {
      if (!/superseded/i.test(error.message)) toast(error.message, "danger");
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
    <main class="sheet" id="sheet"></main>`;
}
function nav() {
  const r = state.route.view;
  const item = (view, ic, text, count) => `<button class="nav-item" data-go="${view}" ${r === view || (view === "library" && r === "photo") ? 'aria-current="page"' : ""}>${icon(ic)}<span>${text}</span>${count ? `<span class="count">${count}</span>` : ""}</button>`;
  $("#nav").innerHTML = item("library", "photos", "Photos", state.counts.active) + item("people", "people", "People") + item("import", "folder", "Import") + item("trash", "trash", "Trash", state.counts.trashed) + item("settings", "settings", "Settings");
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
async function render() {
  const token = ++renderToken;
  const restoring = state.restoring;
  state.restoring = null;
  nav();
  const sheet = $("#sheet");
  let outcome;
  const notFound = () => {
    sheet.innerHTML = `<div class="page"><div class="empty"><h3 data-heading tabindex="-1">This page could not be found</h3><p>The address may be wrong, or the photo may have been deleted.</p><button class="ae-btn" data-go="library">Back to Photos</button></div></div>`;
    outcome = "not-found";
  };
  try {
    if (state.route.view === "not-found") notFound();
    else if (state.route.view === "photo") await viewPhoto(sheet, state.route.id, token);
    else if (state.route.view === "trash") await viewGrid(sheet, "trashed", token, restoring);
    else if (state.route.view === "settings") viewSettings(sheet, restoring);
    else if (state.route.view === "people") await viewPeople(sheet, token);
    else if (state.route.view === "cluster") await viewCluster(sheet, state.route.id, token);
    else if (state.route.view === "import") await viewImport(sheet, token);
    else await viewGrid(sheet, "active", token, restoring);
  } catch (error) {
    if (stale(token)) return;
    if (/not found/i.test(error.message)) notFound();
    else sheet.innerHTML = `<div class="page"><div class="empty"><h3>This could not be loaded</h3><p>${esc(error.message)}</p><button class="ae-btn" data-go="library">Back to Photos</button></div></div>`;
  }
  if (stale(token)) return;
  sheet.scrollTop = restoring?.scroll || 0;
  $("[data-heading]", sheet)?.focus({ preventScroll: true });
  return outcome;
}

/* ── Library and Trash ── */
const pickBand = () =>
  state.pick ? `<div class="picker-band" role="status"><p><b>Choose a photo for ${esc(appName(state.pick.module))}.</b> Open one and select “Use this photo”, or upload a new one.</p><button class="ae-btn ae-btn--sm" data-act="pick-cancel">Cancel</button></div>` : "";
let apps = [];
const appName = (id) => apps.find((a) => a.id === id)?.name || id;

function tileHtml(p) {
  return `<li><button class="tile" data-photo="${esc(p.id)}" aria-label="${esc(label(p))}, ${esc(p.width)} × ${esc(p.height)}">${p.thumbnail ? `<img src="${p.thumbnail}" alt="">` : `<span class="broken">Preview unavailable</span>`}<span class="caption">${esc(label(p))}</span></button></li>`;
}
async function viewGrid(sheet, which, token, restoring) {
  const trash = which === "trashed";
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
  const count = trash ? state.counts.trashed : state.counts.active;
  sheet.innerHTML = `<div class="page">
    ${trash ? "" : pickBand()}
    <header class="head"><div><p class="eyebrow">${trash ? "Trash" : "Library"}</p><h2 class="display" data-heading tabindex="-1">${trash ? "Trash" : "Photos"}</h2>
      <p class="meta">${count === 1 ? "1 photo" : `${count} photos`}${trash ? " · restore them, or delete them for good" : ""}</p></div>
      ${trash ? "" : `<div class="tools"><button class="ae-btn ae-btn--primary" data-act="choose">${icon("upload")}<span>Upload photos</span></button></div>`}</header>
    ${trash ? "" : `<input type="file" id="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden>
      <div class="drop" id="drop" tabindex="0" role="button" aria-label="Upload photos: drop files here or press Enter to choose">${icon("upload")}<strong>Drop photos here</strong><small>JPEG, PNG, WebP or GIF · up to ${esc(state.settings?.max_upload_mb)} MB and ${esc(state.settings?.max_megapixels)} megapixels each. Originals are kept exactly as uploaded.</small></div>
      <ul class="uploads" id="uploads" aria-live="polite"></ul>`}
    ${state.items.length ? `<ul class="grid" id="grid">${state.items.map(tileHtml).join("")}</ul>` : `<div class="empty"><h3>${trash ? "Trash is empty" : "No photos yet"}</h3><p>${trash ? "Photos you move to Trash wait here until you restore them or delete them for good." : "Upload your first photos. They stay private to you and to the applications you allow."}</p></div>`}
    <div class="more" ${state.cursor ? "" : "hidden"}><button class="ae-btn" data-act="more" data-state="${which}">Show more</button></div>
  </div>`;
  if (!trash) bindUpload();
  renderUploads();
}

/* ── Upload: files go up in chunks (module requests are limited to 2 MiB) ── */
function bindUpload() {
  const drop = $("#drop");
  const input = $("#file");
  input.onchange = () => queue([...input.files]);
  drop.onclick = () => input.click();
  drop.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.click());
  for (const t of ["dragenter", "dragover"]) drop.addEventListener(t, (e) => (e.preventDefault(), drop.classList.add("is-over")));
  for (const t of ["dragleave", "drop"]) drop.addEventListener(t, () => drop.classList.remove("is-over"));
  drop.addEventListener("drop", (e) => (e.preventDefault(), queue([...e.dataTransfer.files])));
}
function renderUploads() {
  const list = $("#uploads");
  if (!list) return;
  list.innerHTML = state.uploads
    .map((u) => `<li><span class="name">${esc(u.name)}</span><span class="state ${u.error ? "bad" : ""}">${esc(u.error || u.status)}</span><span class="bar"><span style="--p:${Math.round(u.progress * 100)}%"></span></span></li>`)
    .join("");
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
  if (state.route.view === "library") {
    const done = state.uploads.filter((u) => !u.error);
    state.uploads = state.uploads.filter((u) => u.error);
    await render();
    if (state.pick && done.length === 1 && last) go("photo", last.id);
  } else nav();
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
  if (result.duplicate && !quiet) toast(`${u.name} is already in your library`);
  return result.photo;
}

/* ── One photo ── */
async function viewPhoto(sheet, id, token) {
  const p = await api(`/photos/${id}`);
  if (stale(token)) return;
  const trashed = p.state === "trashed";
  const fact = (k, v) => (v ? `<dt>${esc(k)}</dt><dd>${v}</dd>` : "");
  sheet.innerHTML = `<div class="page">
    ${!trashed ? pickBand() : ""}
    <header class="head"><div><p class="eyebrow"><button class="ae-btn ae-btn--quiet ae-btn--sm" data-go="${trashed ? "trash" : "library"}">${icon("back")}<span>${trashed ? "Trash" : "Photos"}</span></button></p>
      <h2 class="display" data-heading tabindex="-1">${esc(label(p))}</h2><p class="meta">${esc(p.width)} × ${esc(p.height)} · ${esc(p.format)} · ${bytes(p.bytes)}${trashed ? " · in Trash" : ""}</p></div>
      <div class="tools">${state.pick && !trashed ? `<button class="ae-btn ae-btn--primary" data-act="use" data-id="${esc(p.id)}">${icon("check")}<span>Use this photo</span></button>` : ""}</div></header>
    <div class="photo">
      <div class="stage">${p.display ? `<img src="${p.display.src}" alt="${esc(label(p))}">` : `<div class="empty"><h3>The picture cannot be shown</h3><p>${p.original_available ? "Its preview could not be made." : "Its original file is missing from storage. The record is kept so nothing that refers to it breaks."}</p></div>`}</div>
      <section class="facts" aria-label="About this photo">
        <div class="ae-field"><label class="ae-label" for="title">Title</label><input class="ae-input" id="title" maxlength="200" value="${esc(p.title)}" placeholder="Add a title" ${trashed ? "disabled" : ""}></div>
        <dl>${fact("Taken", esc(when(p.taken_at)))}${fact("Camera", esc(p.camera))}${fact("Size", `${esc(p.width)} × ${esc(p.height)} px`)}${fact("File", `${esc(p.filename || "—")} · ${esc(p.format)} · ${bytes(p.bytes)}`)}${fact("Uploaded", esc(when(p.created_at)))}${fact("Location", p.has_location ? "Recorded in the original file; never shown to other applications" : "")}${p.animated ? fact("Animation", "Still images are made from the first frame") : ""}</dl>
        <p class="section-label">People in this photo</p><div id="face-panel"></div>
        <p class="section-label">Linked from other modules</p><ul class="usage" id="usage"><li>Checking…</li></ul>
        <div class="actions">
          ${p.original_available ? `<button class="ae-btn" data-act="download" data-id="${esc(p.id)}">${icon("download")}<span>Download original</span></button>` : ""}
          ${trashed ? `<button class="ae-btn" data-act="restore" data-id="${esc(p.id)}">${icon("restore")}<span>Restore</span></button><button class="ae-btn ae-btn--danger" data-act="purge" data-id="${esc(p.id)}">${icon("trash")}<span>Delete for good</span></button>` : `<button class="ae-btn ae-btn--quiet" data-act="trash" data-id="${esc(p.id)}">${icon("trash")}<span>Move to Trash</span></button>`}
        </div>
      </section>
    </div></div>`;
  const title = $("#title");
  title.dataset.saved = title.value.trim();
  title.onchange = async () => {
    if (title.value.trim() === title.dataset.saved) return;
    await api(`/photos/${id}`, "PATCH", { title: title.value.trim() });
    title.dataset.saved = title.value.trim();
    toast("Title saved", "good");
  };
  usageInto(id);
  loadPhotoFaces(id).catch(() => {});
}
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
    if (el.dataset.photo && !el.dataset.act) return go("photo", el.dataset.photo);
    const act = el.dataset.act;
    const id = el.dataset.id;
    if (act === "choose") return $("#file").click();
    if (act === "more") {
      const page = await api(`/photos?state=${el.dataset.state}&cursor=${state.cursor}`);
      state.cursor = page.next_cursor;
      $("#grid").insertAdjacentHTML("beforeend", page.items.map(tileHtml).join(""));
      el.parentElement.hidden = !state.cursor;
      return;
    }
    if (act === "download") return download(id);
    if (act === "open-usage") return bridge("navigate", { module: el.dataset.module, path: el.dataset.path });
    if (act === "trash") {
      await api(`/photos/${id}`, "DELETE");
      await refreshState();
      toast("Moved to Trash. Applications that use it show their own placeholder until you restore it.");
      return go("library", null, "replace");
    }
    if (act === "restore") {
      await api(`/photos/${id}/restore`, "POST");
      await refreshState();
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
  sheet.innerHTML = `<div class="page">${head}${items.length ? `<ul class="clusters">${items.map((c) => `<li><button class="cluster" data-cluster="${esc(c.id)}"><span class="cluster-faces">${c.faces.map((f) => (f.thumb ? `<img src="${f.thumb}" alt="">` : "")).join("")}</span><strong>${esc(c.person_label || "Not named yet")}</strong><span class="meta">${c.count === 1 ? "1 photo" : `${c.count} photos`}</span></button></li>`).join("")}</ul>` : `<div class="empty"><h3>No faces found yet</h3><p>Scanning continues in the background.</p></div>`}</div>`;
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
  const stage = $(".stage");
  const img = $(".stage img");
  let layer = $("#face-layer");
  if (img && !layer) {
    layer = document.createElement("div");
    layer.id = "face-layer";
    stage.classList.add("has-faces");
    stage.append(layer);
  }
  const place = () => {
    if (!layer || !img) return;
    const r = img.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    Object.assign(layer.style, { left: `${r.left - s.left}px`, top: `${r.top - s.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  };
  if (img) {
    if (img.complete) place();
    img.onload = place;
    window.addEventListener("resize", place);
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
  if (state.route.view === "photo") return loadPhotoFaces(state.route.id);
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
