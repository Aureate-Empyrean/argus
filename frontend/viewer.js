/* The photo viewer: one full-module surface over the gallery. The gallery underneath is left exactly
   as it was, so returning needs no reload and keeps its scroll position. Opening and moving between
   photos happen at once on the thumbnail already in memory; the address follows, and the full image
   replaces the thumbnail when it arrives. Animations never hold anything up. */

const Viewer = (() => {
  const ZOOM_MAX = 6;
  const DOCKED_WIDTH = 1100; // below this the panel floats over the picture instead of narrowing it
  const v = { open: false, id: null, photo: null, detail: null, s: 1, x: 0, y: 0, info: false, localAhead: false, commitTimer: 0, detailTimer: 0, loadTimer: 0, idleTimer: 0, smoothTimer: 0, closing: null, ghost: null };
  const details = new Map();
  /* A module page is framed by Nexus, which decides whether full screen is allowed. Merely asking
     fullscreenEnabled in a frame that may not use it is reported as an error by WebKit. */
  const canFullscreen = () => !!document.featurePolicy?.allowsFeature?.("fullscreen") && document.fullscreenEnabled;
  const dom = {};
  const root = () => $("#viewer");

  function getDetail(id) {
    if (!details.has(id)) {
      const request = api(`/photos/${id}`);
      details.set(id, request);
      request.catch(() => details.delete(id));
      while (details.size > 12) details.delete(details.keys().next().value);
    }
    return details.get(id);
  }

  function build() {
    const box = root();
    if (box.firstChild) return;
    box.innerHTML = `<div class="v-backdrop"></div>
      <div class="v-stage" id="v-stage"><div class="v-canvas" id="v-canvas"><img id="v-img" alt="" draggable="false"></div></div>
      <div class="v-missing" id="v-missing" hidden></div>
      <p class="v-loading" id="v-loading" role="status" hidden>Loading…</p>
      <header class="v-top">
        <button class="v-btn" data-act="viewer-close" id="v-close">${icon("back")}</button>
        <div class="v-heading"><h2 data-heading tabindex="-1" id="v-title"></h2><p id="v-sub"></p></div>
        <div class="v-tools">
          <span id="v-use"></span>
          <button class="v-btn" data-act="viewer-zoom-out" aria-label="Zoom out" title="Zoom out (−)">${icon("minus")}</button>
          <button class="v-btn v-level" data-act="viewer-zoom-reset" id="v-level" aria-label="Fit to screen" title="Fit to screen (0)">Fit</button>
          <button class="v-btn" data-act="viewer-zoom-in" aria-label="Zoom in" title="Zoom in (+)">${icon("plus")}</button>
          ${canFullscreen() ? `<button class="v-btn" data-act="viewer-fullscreen" aria-label="Full screen" title="Full screen (F)">${icon("expand")}</button>` : ""}
          <button class="v-btn" data-act="viewer-info" id="v-info-toggle" aria-label="About this photo" title="About this photo (I)" aria-expanded="false" aria-controls="v-info">${icon("info")}</button>
        </div>
      </header>
      <div class="v-band" id="v-band"></div>
      <button class="v-nav v-prev" data-act="viewer-prev" aria-label="Previous photo" hidden>${icon("back")}</button>
      <button class="v-nav v-next" data-act="viewer-next" aria-label="Next photo" hidden>${icon("forward")}</button>
      <aside class="v-info" id="v-info" aria-label="About this photo"></aside>`;
    for (const [k, id] of Object.entries({ stage: "v-stage", canvas: "v-canvas", img: "v-img", title: "v-title", sub: "v-sub", info: "v-info", missing: "v-missing", loading: "v-loading", level: "v-level", toggle: "v-info-toggle", use: "v-use", band: "v-band", close: "v-close" })) dom[k] = $("#" + id, box);
    dom.prev = $(".v-prev", box);
    dom.next = $(".v-next", box);
    dom.backdrop = $(".v-backdrop", box);
    bindStage();
    new ResizeObserver(() => v.open && layout()).observe(dom.stage);
  }

  /* ── Fit, zoom and pan: the picture is a box of its fitted size, moved by one transform ── */
  function fitted() {
    if (!v.photo) return null;
    const [w, h] = [v.photo.width, v.photo.height];
    const scale = Math.min(dom.stage.clientWidth / w, dom.stage.clientHeight / h, 1);
    return [w * scale, h * scale];
  }
  function clampPan() {
    const size = fitted();
    if (!size) return;
    const mx = Math.max(0, (size[0] * v.s - dom.stage.clientWidth) / 2);
    const my = Math.max(0, (size[1] * v.s - dom.stage.clientHeight) / 2);
    v.x = Math.max(-mx, Math.min(mx, v.x));
    v.y = Math.max(-my, Math.min(my, v.y));
  }
  function origin(size) {
    return [(dom.stage.clientWidth - size[0] * v.s) / 2 + v.x, (dom.stage.clientHeight - size[1] * v.s) / 2 + v.y];
  }
  function apply(smooth = false, swipe = 0) {
    const size = fitted();
    if (!size) return;
    clearTimeout(v.smoothTimer);
    dom.canvas.classList.toggle("is-smooth", smooth && !reducedMotion());
    if (smooth) v.smoothTimer = setTimeout(() => dom.canvas.classList.remove("is-smooth"), 300);
    dom.canvas.style.width = `${size[0]}px`;
    dom.canvas.style.height = `${size[1]}px`;
    const [left, top] = origin(size);
    dom.canvas.style.transform = `translate(${left + swipe}px, ${top}px) scale(${v.s})`;
    root().classList.toggle("is-zoomed", v.s > 1.001);
    dom.level.textContent = v.s > 1.001 ? `${Math.round(v.s * 100)}%` : "Fit";
  }
  function layout() {
    clampPan();
    apply();
  }
  function zoomTo(next, px, py, smooth) {
    const size = fitted();
    if (!size) return;
    const target = Math.max(1, Math.min(ZOOM_MAX, next));
    const [left, top] = origin(size);
    const ux = (px - left) / (size[0] * v.s);
    const uy = (py - top) / (size[1] * v.s);
    v.s = target;
    v.x = px - ux * size[0] * v.s - (dom.stage.clientWidth - size[0] * v.s) / 2;
    v.y = py - uy * size[1] * v.s - (dom.stage.clientHeight - size[1] * v.s) / 2;
    if (target === 1) v.x = v.y = 0;
    clampPan();
    apply(smooth);
  }
  const zoomCentre = (factor) => zoomTo(v.s * factor, dom.stage.clientWidth / 2, dom.stage.clientHeight / 2, true);
  function resetZoom(smooth = false) {
    v.s = 1;
    v.x = v.y = 0;
    apply(smooth);
  }

  /* Plays from a screen rectangle to where the picture now is. Uses the separate translate and scale
     properties, so it never fights the transform that holds the zoom. */
  function playFrom(rect, duration = MOTION.panel, easing = MOTION.ease, reverse = false) {
    const now = dom.canvas.getBoundingClientRect();
    if (!now.width || reducedMotion()) return null;
    const stage = dom.stage.getBoundingClientRect();
    const k = rect.width / now.width;
    const tx = rect.left - stage.left - k * (now.left - stage.left);
    const ty = rect.top - stage.top - k * (now.top - stage.top);
    const frames = [{ translate: `${tx}px ${ty}px`, scale: String(k) }, { translate: "0px 0px", scale: "1" }];
    return dom.canvas.animate(reverse ? frames.reverse() : frames, { duration, easing, fill: reverse ? "forwards" : "none" });
  }

  /* ── Pointer, touch and wheel ── */
  function bindStage() {
    const pointers = new Map();
    let pinch = 0;
    let moved = 0;
    let downAt = 0;
    let startX = 0;
    let startY = 0;
    let lastTap = 0;
    const local = (e) => {
      const r = dom.stage.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const skip = (e) => e.target.closest(".face-box, #face-layer.is-marking");
    dom.stage.addEventListener("wheel", (e) => {
      e.preventDefault();
      poke();
      zoomTo(v.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), ...local(e), false);
    }, { passive: false });
    dom.stage.addEventListener("dblclick", (e) => {
      if (skip(e)) return;
      zoomTo(v.s > 1.001 ? 1 : 2.5, ...local(e), true);
    });
    dom.stage.addEventListener("pointerdown", (e) => {
      if (skip(e) || (e.pointerType === "mouse" && e.button !== 0)) return;
      dom.stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      [moved, pinch, downAt] = [0, 0, performance.now()];
      [startX, startY] = local(e);
    });
    dom.stage.addEventListener("pointermove", (e) => {
      const last = pointers.get(e.pointerId);
      if (!last) return;
      const now = local(e);
      pointers.set(e.pointerId, now);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) zoomTo((v.s * dist) / pinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, false);
        pinch = dist;
        moved += 10;
        return;
      }
      moved += Math.abs(now[0] - last[0]) + Math.abs(now[1] - last[1]);
      if (v.s > 1.001) {
        v.x += now[0] - last[0];
        v.y += now[1] - last[1];
        clampPan();
        apply();
      } else if (e.pointerType !== "mouse") apply(false, now[0] - startX);
    });
    const end = (e) => {
      if (!pointers.has(e.pointerId)) return;
      const [x, y] = pointers.get(e.pointerId);
      const touch = e.pointerType !== "mouse";
      const wasPinch = pointers.size > 1;
      pointers.delete(e.pointerId);
      pinch = 0;
      if (e.type !== "pointerup" || wasPinch || !touch) return;
      const [dx, dy] = [x - startX, y - startY];
      if (v.s <= 1.001 && Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.4) return step(dx < 0 ? 1 : -1);
      if (v.s <= 1.001) apply(true);
      if (moved < 10 && performance.now() - downAt < 300) {
        const now = performance.now();
        if (now - lastTap < 280) {
          lastTap = 0;
          return zoomTo(v.s > 1.001 ? 1 : 2.5, x, y, true);
        }
        lastTap = now;
        toggleChrome();
      }
    };
    dom.stage.addEventListener("pointerup", end);
    dom.stage.addEventListener("pointercancel", end);
  }

  /* ── Controls that step aside ── */
  const isBusyWithChrome = () => v.info || !!root().querySelector(".v-top :focus-visible:not([data-heading]), .v-nav:focus-visible, .v-top:hover, .v-nav:hover");
  function setChrome(on) {
    root().classList.toggle("chrome-off", !on);
  }
  function poke() {
    setChrome(true);
    clearTimeout(v.idleTimer);
    v.idleTimer = setTimeout(() => v.open && !isBusyWithChrome() && setChrome(false), 2800);
  }
  function toggleChrome() {
    if (root().classList.contains("chrome-off")) poke();
    else setChrome(false);
  }

  /* ── Sequence ── */
  const list = () => state.items;
  const indexOfCurrent = () => list().findIndex((x) => x.id === v.id);
  function refreshArrows() {
    const i = indexOfCurrent();
    dom.prev.hidden = i <= 0;
    dom.next.hidden = i < 0 || (i >= list().length - 1 && !state.cursor);
  }
  /** A deep link has no gallery behind it: find this photo's place so the arrows work. */
  async function ensureSequence(p) {
    if (indexOfCurrent() >= 0) return refreshArrows();
    const which = p.state;
    const items = [];
    let cursor = "";
    for (let pages = 0; pages < 6; pages++) {
      const page = await api(`/photos?state=${which}${cursor ? `&cursor=${cursor}` : ""}`).catch(() => null);
      if (!page || !v.open || v.id !== p.id) return;
      items.push(...page.items);
      cursor = page.next_cursor;
      if (items.some((x) => x.id === p.id) || !cursor) break;
    }
    if (!items.some((x) => x.id === p.id) || state.galleryOf) return;
    state.items = items;
    state.cursor = cursor || null;
    state.itemsOf = which;
    refreshArrows();
  }
  function preloadNeighbours() {
    const i = indexOfCurrent();
    if (i < 0) return;
    const run = () => [list()[i + 1], list()[i - 1]].forEach((x) => x && v.open && getDetail(x.id).catch(() => {}));
    (window.requestIdleCallback || ((f) => setTimeout(f, 200)))(run);
  }

  /* ── Painting one photo ── */
  function paintItem(item) {
    v.photo = item;
    v.detail = null;
    v.s = 1;
    v.x = v.y = 0;
    dom.title.textContent = label(item);
    dom.sub.textContent = subtitle(item);
    dom.missing.hidden = true;
    dom.canvas.hidden = false;
    dom.img.src = item.thumbnail || "";
    $("#face-layer")?.remove();
    apply();
    refreshArrows();
  }
  const subtitle = (p) => [`${p.width} × ${p.height}`, p.format, bytes(p.bytes), p.state === "trashed" ? "in Trash" : ""].filter(Boolean).join(" · ");
  function setImage(src, id) {
    const next = new Image();
    next.src = src;
    Promise.resolve(next.decode?.()).catch(() => {}).then(() => {
      if (v.id === id && v.open) dom.img.src = src;
    });
  }
  function showDetail(p) {
    clearTimeout(v.loadTimer);
    dom.loading.hidden = true;
    v.detail = p;
    v.photo = p;
    dom.title.textContent = label(p);
    dom.sub.textContent = subtitle(p);
    dom.close.setAttribute("aria-label", p.state === "trashed" ? "Back to Trash" : "Back to Photos");
    dom.close.title = "Back (Esc)";
    const trashed = p.state === "trashed";
    dom.use.innerHTML = state.pick && !trashed ? `<button class="ae-btn ae-btn--primary ae-btn--sm" data-act="use" data-id="${esc(p.id)}">${icon("check")}<span>Use this photo</span></button>` : "";
    dom.band.innerHTML = !trashed ? pickBand() : "";
    if (p.display) {
      dom.canvas.hidden = false;
      dom.missing.hidden = true;
      setImage(p.display.src, p.id);
    } else {
      dom.canvas.hidden = true;
      dom.missing.hidden = false;
      dom.missing.innerHTML = `<div class="empty"><h3>The picture cannot be shown</h3><p>${p.original_available ? "Its preview could not be made." : "Its original file is missing from storage. The record is kept so nothing that refers to it breaks."}</p></div>`;
    }
    renderInfo(p);
    apply();
    refreshArrows();
    preloadNeighbours();
    ensureSequence(p).catch(() => {});
  }
  function renderInfo(p) {
    const trashed = p.state === "trashed";
    const fact = (k, val) => (val ? `<dt>${esc(k)}</dt><dd>${val}</dd>` : "");
    dom.info.innerHTML = `<div class="v-info-head"><h3>About this photo</h3><button class="v-btn" data-act="viewer-info" aria-label="Close">${icon("close")}</button></div>
      <section class="facts">
        <div class="ae-field"><label class="ae-label" for="title">Title</label><input class="ae-input" id="title" maxlength="200" value="${esc(p.title)}" placeholder="Add a title" ${trashed ? "disabled" : ""}></div>
        <dl>${fact("Taken", esc(when(p.taken_at)))}${fact("Camera", esc(p.camera))}${fact("Size", `${esc(p.width)} × ${esc(p.height)} px`)}${fact("File", `${esc(p.filename || "—")} · ${esc(p.format)} · ${bytes(p.bytes)}`)}${fact("Uploaded", esc(when(p.created_at)))}${fact("Location", p.has_location ? "Recorded in the original file; never shown to other applications" : "")}${p.animated ? fact("Animation", "Still images are made from the first frame") : ""}</dl>
        <p class="section-label">People in this photo</p><div id="face-panel"></div>
        <p class="section-label">Linked from other modules</p><ul class="usage" id="usage"><li>Checking…</li></ul>
        <div class="actions">
          ${p.original_available ? `<button class="ae-btn" data-act="download" data-id="${esc(p.id)}">${icon("download")}<span>Download original</span></button>` : ""}
          ${trashed ? `<button class="ae-btn" data-act="restore" data-id="${esc(p.id)}">${icon("restore")}<span>Restore</span></button><button class="ae-btn ae-btn--danger" data-act="purge" data-id="${esc(p.id)}">${icon("trash")}<span>Delete for good</span></button>` : `<button class="ae-btn ae-btn--quiet" data-act="trash" data-id="${esc(p.id)}">${icon("trash")}<span>Move to Trash</span></button>`}
        </div>
      </section>`;
    const title = $("#title");
    title.dataset.saved = title.value.trim();
    title.dataset.photo = p.id;
    title.onchange = () => saveTitle().catch((error) => toast(error.message, "danger"));
    usageInto(p.id);
    loadPhotoFaces(p.id).catch(() => {});
  }
  async function saveTitle() {
    const input = $("#title");
    if (!input || input.disabled || input.value.trim() === input.dataset.saved) return;
    const value = input.value.trim();
    const id = input.dataset.photo;
    await api(`/photos/${id}`, "PATCH", { title: value });
    input.dataset.saved = value;
    details.delete(id);
    const item = state.items.find((x) => x.id === id);
    if (item) item.title = value;
    if (v.id === id) {
      v.photo = { ...v.photo, title: value };
      dom.title.textContent = label(v.photo);
    }
    const tile = $(`#grid [data-photo="${CSS.escape(id)}"]`);
    if (tile && item) {
      $(".caption", tile).textContent = label(item);
      tile.setAttribute("aria-label", `${label(item)}, ${item.width} × ${item.height}`);
    }
    if (input.isConnected) toast("Title saved", "good");
  }

  /* ── Opening, moving and leaving ── */
  /* A tile hides while its picture is in flight. An interrupted flight must never leave it hidden. */
  const clearHero = () => $$(".tile.is-hero").forEach((t) => t.classList.remove("is-hero"));
  function surface() {
    build();
    const box = root();
    v.closing?.cancel();
    v.closing = null;
    clearHero();
    v.open = true;
    box.hidden = false;
    box.classList.remove("is-closing");
    box.classList.toggle("info-open", v.info);
    box.classList.toggle("info-docked", v.info && innerWidth >= DOCKED_WIDTH);
    $("#sheet").inert = true;
    $(".rail").inert = true;
    // One heading and one picker notice at a time.
    $$("#sheet [data-heading]").forEach((el) => (el.removeAttribute("data-heading"), (el.dataset.headingOff = "1")));
    if ($("#sheet .picker-band")) {
      $("#sheet .picker-band").remove();
      state.galleryDirty = true;
    }
    poke();
  }
  /** From a gallery tile: on screen immediately, growing out of the tile. */
  function openFrom(tile, id) {
    const item = state.items.find((x) => x.id === id);
    if (!item) return;
    const rect = $("img", tile)?.getBoundingClientRect();
    surface();
    v.id = id;
    v.localAhead = false;
    paintItem(item);
    getDetail(id).catch(() => {});
    tile.classList.add("is-hero");
    const done = () => tile.classList.remove("is-hero");
    animate(dom.backdrop, [{ opacity: 0 }, { opacity: 1 }], MOTION.page);
    const flight = rect?.width ? playFrom(rect) : null;
    flight ? flight.finished.finally(done) : done();
    animate($(".v-top", root()), [{ opacity: 0 }, { opacity: 1 }], MOTION.page);
  }
  /** Called by render() for the photo route, whichever way the address got here. */
  async function show(id, token, restoring) {
    if (restoring?.info !== undefined) setInfo(!!restoring.info, { quiet: true });
    if (v.localAhead && v.id !== id) return;
    const fresh = !v.open;
    if (fresh) {
      surface();
      animate(dom.backdrop, [{ opacity: 0 }, { opacity: 1 }], MOTION.page);
    }
    if (v.id === id) v.localAhead = false;
    if (v.id === id && v.detail?.id === id) return;
    if (v.id !== id || fresh) {
      v.id = id;
      const item = state.items.find((x) => x.id === id);
      if (item) paintItem(item);
      else {
        v.photo = null;
        v.detail = null;
        dom.img.removeAttribute("src");
        dom.title.textContent = "";
        dom.sub.textContent = "";
      }
    }
    clearTimeout(v.loadTimer);
    v.loadTimer = setTimeout(() => (dom.loading.hidden = false), 260);
    const p = await getDetail(id).finally(() => {
      clearTimeout(v.loadTimer);
      dom.loading.hidden = true;
    });
    if (stale(token) || v.id !== id) return;
    showDetail(p);
    if (fresh) animate(dom.canvas, [{ opacity: 0 }, { opacity: 1 }], MOTION.page);
  }
  function loadCurrentSoon() {
    clearTimeout(v.detailTimer);
    const id = v.id;
    v.detailTimer = setTimeout(async () => {
      try {
        const p = await getDetail(id);
        if (v.open && v.id === id && v.detail?.id !== id) showDetail(p);
      } catch (error) {
        if (v.id === id) toast(error.message, "danger");
      }
    }, 70);
  }
  function step(delta) {
    if (!v.open) return;
    const i = indexOfCurrent();
    if (i < 0) return;
    const item = list()[i + delta];
    if (!item) {
      if (delta > 0 && state.cursor) loadMore().then((more) => more && step(delta)).catch(() => {});
      else animate(dom.canvas, [{ translate: "0 0" }, { translate: `${-delta * 18}px 0` }, { translate: "0 0" }], MOTION.page);
      return;
    }
    saveTitle().catch((error) => toast(error.message, "danger"));
    v.ghost?.remove();
    v.ghost = null;
    if (!reducedMotion() && !dom.canvas.hidden && dom.img.getAttribute("src")) {
      const ghost = dom.canvas.cloneNode(true);
      ghost.querySelector("#face-layer")?.remove();
      ghost.removeAttribute("id");
      ghost.querySelectorAll("[id]").forEach((x) => x.removeAttribute("id"));
      ghost.classList.add("v-ghost");
      dom.stage.append(ghost);
      v.ghost = ghost;
      animate(ghost, [{ translate: "0 0", opacity: 1 }, { translate: `${-delta * 56}px 0`, opacity: 0 }], MOTION.exit, MOTION.exitEase).finished.finally(() => ghost.remove());
    }
    v.id = item.id;
    v.localAhead = true;
    paintItem(item);
    animate(dom.canvas, [{ translate: `${delta * 56}px 0`, opacity: 0 }, { translate: "0 0", opacity: 1 }], MOTION.page);
    loadCurrentSoon();
    clearTimeout(v.commitTimer);
    v.commitTimer = setTimeout(() => v.open && go("photo", v.id, "replace"), 140);
  }
  function back() {
    const from = state.sheetRoute;
    if (from) return go(from.view, from.id || null);
    return go(v.detail?.state === "trashed" ? "trash" : "library");
  }
  /** Back to whatever is underneath. The picture returns to its tile when the tile is on screen. */
  function close({ toTile = true } = {}) {
    if (!v.open) return;
    const box = root();
    const id = v.id;
    v.open = false;
    v.localAhead = false;
    v.ghost?.remove();
    v.ghost = null;
    for (const t of ["commitTimer", "detailTimer", "loadTimer", "idleTimer"]) clearTimeout(v[t]);
    dom.loading.hidden = true;
    if (canFullscreen() && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    $("#sheet").inert = false;
    $(".rail").inert = false;
    $$("#sheet [data-heading-off]").forEach((el) => (el.setAttribute("data-heading", ""), el.removeAttribute("data-heading-off")));
    const tile = toTile ? $(`#grid [data-photo="${CSS.escape(id || "")}"]`) : null;
    const frame = $("#sheet").getBoundingClientRect();
    const rect = tile && $("img", tile)?.getBoundingClientRect();
    const onScreen = rect?.width && rect.bottom > frame.top && rect.top < frame.bottom;
    (tile || $("#sheet [data-heading]"))?.focus({ preventScroll: true });
    const finish = () => {
      if (v.open) return;
      clearHero();
      box.hidden = true;
      box.classList.remove("is-closing");
      dom.canvas.getAnimations().forEach((a) => a.cancel());
      v.closing = null;
      v.id = v.photo = v.detail = null;
    };
    if (reducedMotion()) return finish();
    box.classList.add("is-closing");
    tile?.classList.add("is-hero");
    resetZoomForExit();
    const plane = animate(dom.backdrop, [{ opacity: 1 }, { opacity: 0 }], MOTION.page, MOTION.exitEase, { fill: "forwards" });
    const flight = onScreen ? playFrom(rect, MOTION.page, MOTION.ease, true) : animate(dom.canvas, [{ opacity: 1 }, { opacity: 0, scale: "0.97" }], MOTION.exit, MOTION.exitEase, { fill: "forwards" });
    v.closing = { cancel: () => [plane, flight].forEach((a) => a?.cancel()) };
    Promise.all([plane?.finished, flight?.finished]).then(finish, () => {});
  }
  function resetZoomForExit() {
    if (v.s > 1.001) resetZoom(false);
  }
  /** Moves the picture between two sizes with transform only, never by animating its layout. */
  function setInfo(open, { quiet = false, focus = false } = {}) {
    if (!root().firstChild) {
      v.info = open;
      return;
    }
    const before = !quiet && !reducedMotion() && !dom.canvas.hidden ? dom.canvas.getBoundingClientRect() : null;
    v.info = open;
    const box = root();
    box.classList.toggle("info-open", open);
    box.classList.toggle("info-docked", open && innerWidth >= DOCKED_WIDTH);
    dom.toggle.setAttribute("aria-expanded", String(open));
    dom.toggle.classList.toggle("is-on", open);
    layout();
    if (before?.width && v.s <= 1.001) playFrom(before);
    if (open) setChrome(true);
    else poke();
    if (focus && open) $("#title", dom.info)?.focus({ preventScroll: true });
    argusNavigation.viewChanged?.();
  }
  function ensureInfo() {
    if (!v.info) setInfo(true);
  }
  function action(act) {
    if (act === "viewer-close") return back();
    if (act === "viewer-prev") return step(-1);
    if (act === "viewer-next") return step(1);
    if (act === "viewer-zoom-in") return zoomCentre(1.5);
    if (act === "viewer-zoom-out") return zoomCentre(1 / 1.5);
    if (act === "viewer-zoom-reset") return resetZoom(true);
    if (act === "viewer-info") return setInfo(!v.info);
    if (act === "viewer-fullscreen") return toggleFullscreen();
  }
  function toggleFullscreen() {
    if (!canFullscreen()) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else root().requestFullscreen().catch(() => {});
  }
  addEventListener("pointermove", () => v.open && poke(), { passive: true });
  addEventListener("resize", () => v.open && root().classList.toggle("info-docked", v.info && innerWidth >= DOCKED_WIDTH));
  document.addEventListener("keydown", (e) => {
    if (!v.open || $("#dialog").open || e.altKey || e.ctrlKey || e.metaKey) return;
    const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
    if (typing) {
      if (e.key === "Escape") {
        e.target.blur();
        e.preventDefault();
      }
      return;
    }
    if ($("#face-layer.is-marking")) return;
    poke();
    const pan = 80;
    const zoomed = v.s > 1.001;
    const moves = { ArrowLeft: [pan, 0], ArrowRight: [-pan, 0], ArrowUp: [0, pan], ArrowDown: [0, -pan] };
    if (moves[e.key] && zoomed) {
      v.x += moves[e.key][0];
      v.y += moves[e.key][1];
      clampPan();
      apply(true);
    } else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "Escape") {
      if (v.info && innerWidth < DOCKED_WIDTH) setInfo(false);
      else back();
    } else if (e.key === "+" || e.key === "=") zoomCentre(1.5);
    else if (e.key === "-") zoomCentre(1 / 1.5);
    else if (e.key === "0") resetZoom(true);
    else if (e.key === "i" || e.key === "I") setInfo(!v.info);
    else if (e.key === "f" || e.key === "F") toggleFullscreen();
    else return;
    e.preventDefault();
  });

  return {
    isOpen: () => v.open,
    currentId: () => v.id,
    infoOpen: () => v.info,
    openFrom,
    show,
    close,
    saveTitle,
    action,
    ensureInfo,
    forget: (id) => {
      details.delete(id);
      if (v.id === id) v.detail = null;
    },
    /** The address did not follow an optimistic move: go back to agreeing with it. */
    resync() {
      v.localAhead = false;
      if (v.open && state.route.view !== "photo") close({ toTile: false });
    },
  };
})();
