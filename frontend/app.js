/* Argus: the user's own photographs. Vanilla JS in the Nexus sandbox: every request goes
   through the Nexus bridge to this module's own API; images arrive as data: URLs. */

"use strict";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const ICONS = {
  photos: '<rect x="3" y="4.5" width="14" height="11" rx="2"/><circle cx="7.5" cy="8.5" r="1.4"/><path d="m3.5 14 4-3.6 3 2.6 2.2-1.8L16.5 14"/>',
  trash: '<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 10h6.6L14 6"/>',
  settings: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.8v1.8M10 15.4v1.8M17.2 10h-1.8M4.6 10H2.8M15.1 4.9l-1.3 1.3M6.2 13.8l-1.3 1.3M15.1 15.1l-1.3-1.3M6.2 6.2 4.9 4.9"/>',
  upload: '<path d="M10 13V4M6.5 7.3 10 3.8l3.5 3.5"/><path d="M4 12.5v2.2c0 .8.7 1.5 1.5 1.5h9c.8 0 1.5-.7 1.5-1.5v-2.2"/>',
  back: '<path d="M11.5 4.5 6 10l5.5 5.5"/>',
  download: '<path d="M10 4v9M6.5 9.7 10 13.2l3.5-3.5"/><path d="M4 14.5v.7c0 .8.7 1.5 1.5 1.5h9c.8 0 1.5-.7 1.5-1.5v-.7"/>',
  restore: '<path d="M4.5 9.5a5.5 5.5 0 1 1 1.6 4"/><path d="M4 5.5v4h4"/>',
  check: '<path d="m4.8 10.4 3.3 3.3 7.1-7.4"/>',
  eye: '<path d="M2.5 10C4.3 6.6 7 4.8 10 4.8s5.7 1.8 7.5 5.2c-1.8 3.4-4.5 5.2-7.5 5.2S4.3 13.4 2.5 10z"/><circle cx="10" cy="10" r="2.4"/>',
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
  const p = path.replace(/^\/modules\/[^/]+/, "") || "/";
  const pick = p.match(/^\/pick\/([a-z][a-z0-9-]{0,47})((?:\/[A-Za-z0-9_-]+)*)$/);
  if (pick) {
    state.pick = { module: pick[1], back: pick[2] || "" };
    return { view: "library" };
  }
  const photo = p.match(/^\/photos\/([0-9a-f-]{36})$/);
  if (photo) return { view: "photo", id: photo[1] };
  if (p === "/trash") return { view: "trash" };
  if (p === "/settings") return { view: "settings" };
  return { view: "library" };
}
function go(view, id = null) {
  state.route = { view, id };
  render();
}

function shell() {
  $("#app").innerHTML = `<aside class="rail" aria-label="Argus">
      <div class="brand"><span class="brand-mark">${icon("eye")}</span><span class="brand-name">Argus</span></div>
      <nav id="nav" aria-label="Sections"></nav>
    </aside>
    <main class="sheet" id="sheet"></main>`;
}
function nav() {
  const r = state.route.view;
  const item = (view, ic, text, count) => `<button class="nav-item" data-go="${view}" ${r === view || (view === "library" && r === "photo") ? 'aria-current="page"' : ""}>${icon(ic)}<span>${text}</span>${count ? `<span class="count">${count}</span>` : ""}</button>`;
  $("#nav").innerHTML = item("library", "photos", "Photos", state.counts.active) + item("trash", "trash", "Trash", state.counts.trashed) + item("settings", "settings", "Settings");
}
async function refreshState() {
  const s = await api("/state");
  state.counts = s.counts;
  state.settings = s.settings;
  state.limits = s.limits;
}

async function render() {
  nav();
  const sheet = $("#sheet");
  try {
    if (state.route.view === "photo") await viewPhoto(sheet, state.route.id);
    else if (state.route.view === "trash") await viewGrid(sheet, "trashed");
    else if (state.route.view === "settings") viewSettings(sheet);
    else await viewGrid(sheet, "active");
  } catch (error) {
    sheet.innerHTML = `<div class="page"><div class="empty"><h3>This could not be loaded</h3><p>${esc(error.message)}</p><button class="ae-btn" data-go="library">Back to Photos</button></div></div>`;
  }
  sheet.scrollTop = 0;
  $("[data-heading]", sheet)?.focus({ preventScroll: true });
}

/* ── Library and Trash ── */
const pickBand = () =>
  state.pick ? `<div class="picker-band" role="status"><p><b>Choose a photo for ${esc(appName(state.pick.module))}.</b> Open one and select “Use this photo”, or upload a new one.</p><button class="ae-btn ae-btn--sm" data-act="pick-cancel">Cancel</button></div>` : "";
let apps = [];
const appName = (id) => apps.find((a) => a.id === id)?.name || id;

function tileHtml(p) {
  return `<li><button class="tile" data-photo="${esc(p.id)}" aria-label="${esc(label(p))}, ${esc(p.width)} × ${esc(p.height)}">${p.thumbnail ? `<img src="${p.thumbnail}" alt="">` : `<span class="broken">Preview unavailable</span>`}<span class="caption">${esc(label(p))}</span></button></li>`;
}
async function viewGrid(sheet, which) {
  const trash = which === "trashed";
  const page = await api(`/photos?state=${which}`);
  state.items = page.items;
  state.cursor = page.next_cursor;
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
async function uploadOne(u) {
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
  const result = await api(`/uploads/${start.id}/finish`, "POST");
  u.status = result.duplicate ? "Already in your library" : "Added";
  if (result.duplicate) toast(`${u.name} is already in your library`);
  return result.photo;
}

/* ── One photo ── */
async function viewPhoto(sheet, id) {
  const p = await api(`/photos/${id}`);
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
        <p class="section-label">Used by</p><ul class="usage" id="usage"><li>Checking…</li></ul>
        <div class="actions">
          ${p.original_available ? `<button class="ae-btn" data-act="download" data-id="${esc(p.id)}">${icon("download")}<span>Download original</span></button>` : ""}
          ${trashed ? `<button class="ae-btn" data-act="restore" data-id="${esc(p.id)}">${icon("restore")}<span>Restore</span></button><button class="ae-btn ae-btn--danger" data-act="purge" data-id="${esc(p.id)}">${icon("trash")}<span>Delete for good</span></button>` : `<button class="ae-btn ae-btn--quiet" data-act="trash" data-id="${esc(p.id)}">${icon("trash")}<span>Move to Trash</span></button>`}
        </div>
      </section>
    </div></div>`;
  const title = $("#title");
  title.onchange = async () => {
    await api(`/photos/${id}`, "PATCH", { title: title.value.trim() });
    toast("Title saved", "good");
  };
  usageInto(id);
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
        ? u.items.map((x) => `<li>${esc(appName(x.module))}${x.label ? ` · ${esc(x.label)}` : ""}${x.relation.endsWith("representative-image") ? " (profile picture)" : ""}</li>`).join("")
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
function viewSettings(sheet) {
  const s = state.settings;
  const l = state.limits;
  sheet.innerHTML = `<div class="page"><header class="head"><div><p class="eyebrow">Argus</p><h2 class="display" data-heading tabindex="-1">Settings</h2><p class="meta">Limits for new uploads. Photos already in the library are not affected.</p></div></header>
    <form class="settings" id="settings">
      <div class="ae-field"><label class="ae-label" for="max-mb">Largest file (MB)</label><input class="ae-input" id="max-mb" type="number" min="${l.max_upload_mb[0]}" max="${l.max_upload_mb[1]}" value="${s.max_upload_mb}"><p class="ae-hint">Between ${l.max_upload_mb[0]} and ${l.max_upload_mb[1]} MB.</p></div>
      <div class="ae-field"><label class="ae-label" for="max-mp">Largest picture (megapixels)</label><input class="ae-input" id="max-mp" type="number" min="${l.max_megapixels[0]}" max="${l.max_megapixels[1]}" value="${s.max_megapixels}"><p class="ae-hint">At most ${l.max_megapixels[1]}: Argus decodes pictures within the memory Nexus gives each module.</p></div>
      <div class="actions"><button class="ae-btn ae-btn--primary" type="submit">Save</button></div>
    </form></div>`;
  $("#settings").onsubmit = async (e) => {
    e.preventDefault();
    try {
      state.settings = await api("/settings", "PUT", { max_upload_mb: +$("#max-mb").value, max_megapixels: +$("#max-mp").value });
      toast("Settings saved", "good");
    } catch (error) {
      toast(error.message, "danger");
    }
  };
}

/* ── Actions ── */
document.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-go], [data-act], [data-photo]");
  if (!el || el.disabled) return;
  try {
    if (el.dataset.go) return go(el.dataset.go);
    if (el.dataset.photo) return go("photo", el.dataset.photo);
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
    if (act === "trash") {
      await api(`/photos/${id}`, "DELETE");
      await refreshState();
      toast("Moved to Trash. Applications that use it show their own placeholder until you restore it.");
      return go("library");
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
      return go("trash");
    }
    if (act === "use") return bridge("navigate", { module: state.pick.module, path: `${state.pick.back}/${id}` });
    if (act === "pick-cancel") return bridge("navigate", { module: state.pick.module, path: state.pick.back || "/" });
  } catch (error) {
    toast(error.message, "danger");
  }
});

async function start() {
  try {
    const ctx = await bridge("context");
    apps = ctx.applications || [];
  } catch {
    /* standalone preview */
  }
  state.route = routeFrom(location.pathname);
  try {
    await refreshState();
  } catch (error) {
    $("#app").innerHTML = `<p class="splash">Argus could not start: ${esc(error.message)}</p>`;
    return;
  }
  shell();
  render();
}
start();
