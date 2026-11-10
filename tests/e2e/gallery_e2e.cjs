// The Argus gallery and viewer, in a real Nexus, on a disposable installation with synthetic photos.
// Destructive to nothing but its own records, yet it needs a library of at least 12 photos.
//
//   NEXUS_URL=http://localhost:12398 OWNER_FILE=owner.json BROWSER=chromium PLAYWRIGHT_PATH=... node tests/e2e/gallery_e2e.cjs
const fs = require("fs");
const playwright = require(process.env.PLAYWRIGHT_PATH || "playwright");

const NEXUS = process.env.NEXUS_URL;
const ENGINE = process.env.BROWSER || "chromium";
if (!NEXUS || !process.env.OWNER_FILE) throw new Error("NEXUS_URL and OWNER_FILE are required");
const owner = JSON.parse(fs.readFileSync(process.env.OWNER_FILE, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
const check = (ok, what) => {
  if (ok) {
    passed++;
    console.log(`ok   ${what}`);
  } else {
    failures.push(what);
    console.log(`FAIL ${what}`);
  }
};
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await Promise.resolve().then(fn).catch(() => null);
    if (value) return value;
    await sleep(60);
  }
  check(false, `${what} (timed out)`);
  return null;
}
const frameOf = async (page) => (await page.locator("#module-application").elementHandle({ timeout: 25000 })).contentFrame();
async function open(page, path) {
  await page.goto(`${NEXUS}/app/modules/argus${path ? `?path=${encodeURIComponent(path)}` : ""}`);
  await page.locator("#username, #module-application").first().waitFor({ timeout: 30000 });
  if (await page.locator("#username").isVisible()) {
    await page.locator("#username").fill(owner.username);
    await page.locator("#password").fill(owner.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  return until(async () => {
    const f = await frameOf(page);
    return (await f.evaluate(() => globalThis.eval('typeof argusNavigation !== "undefined" && argusNavigation.enabled'))) ? f : null;
  }, "Argus ready", 30000);
}
const call = (f, p, m = "GET", b) => f.evaluate(([x, y, z]) => (z === null ? api(x, y) : api(x, y, z)), [p, m, b === undefined ? null : b]);
const pathOf = (page) => new URL(page.url()).searchParams.get("path") || "";
const routeOf = (page) => new URL(page.url()).searchParams.get("route") || pathOf(page) || "/";
const noOverflow = (f) => f.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const settled = (f) => until(() => f.evaluate(() => {
  const c = document.querySelector("#v-canvas");
  return c && !c.getAnimations().length && !document.querySelector(".v-ghost");
}), "the viewer settles");

(async () => {
  const browser = await playwright[ENGINE].launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const external = new Set();
  page.on("request", (r) => {
    if (/^https?:/.test(r.url()) && new URL(r.url()).hostname !== "localhost") external.add(new URL(r.url()).hostname);
  });
  let f = await open(page);
  await f.locator("#grid .tile").first().waitFor();

  /* ── Gallery ── */
  const cells = await f.evaluate(() => [...document.querySelectorAll(".tile-cell")].slice(0, 24).map((c) => { const r = c.getBoundingClientRect(); return { ratio: r.width / r.height, a: +c.style.getPropertyValue("--a"), top: r.top, h: r.height }; }));
  check(cells.every((c) => Math.abs(c.ratio - c.a) < 0.05), "every tile keeps its photo's proportions");
  check(new Set(cells.map((c) => c.a.toFixed(1))).size >= 2, "portrait and landscape photos are mixed");
  const rows = {};
  for (const c of cells) (rows[Math.round(c.top)] ||= []).push(c.h);
  check(Object.values(rows).every((h) => Math.max(...h) - Math.min(...h) < 2), "tiles in a row share one height");
  const share = await f.evaluate(() => document.querySelector("#grid").getBoundingClientRect().width / document.querySelector("#sheet").getBoundingClientRect().width);
  check(share > 0.95, "the gallery uses the full width of its sheet");
  check((await f.locator("#drop").count()) === 0 && (await f.locator('[data-act="choose"]').isVisible()), "a populated library has an Upload button and no drop zone");
  check((await f.locator(".month-head").count()) >= 2 && (await f.locator(".day-head").count()) >= 2, "photos are grouped by month and day");
  check((await f.locator(".day-note").first().count()) === 1, "photos with no capture date say which date is used");
  for (const [w, h] of [[1920, 1080], [768, 1024], [390, 844], [1440, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(150);
    check(await noOverflow(f), `no sideways scrolling at ${w} px`);
  }
  await f.evaluate(() => { document.querySelector("#sheet").scrollTop = 620; document.querySelector("#grid").dataset.alive = "1"; });
  await sleep(120);
  const list = (await f.evaluate(() => state.items.map((x) => x.id)));

  /* ── Opening: at once, with a real transition, leaving the gallery alone ── */
  const tile = f.locator(".tile").nth(await f.evaluate(() => { const s = document.querySelector("#sheet").getBoundingClientRect(); return [...document.querySelectorAll(".tile")].findIndex((t) => { const r = t.getBoundingClientRect(); return r.top > s.top + 80 && r.bottom < s.bottom; }); }));
  const id = await tile.getAttribute("data-photo");
  const widths = await f.evaluate(async (pid) => {
    const seen = [];
    document.querySelector(`.tile[data-photo="${pid}"]`).click();
    const start = performance.now();
    while (performance.now() - start < 420) {
      seen.push(Math.round(document.querySelector("#v-canvas")?.getBoundingClientRect().width || 0));
      await new Promise(requestAnimationFrame);
    }
    return seen;
  }, id);
  const animated = !(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches));
  check(animated && new Set(widths).size >= 4, "the picture grows out of its tile");
  check(widths[0] > 0, "the viewer is on screen on the first frame");
  await until(() => routeOf(page) === `/photos/${id}`, "the address follows");
  await until(() => f.evaluate(() => document.querySelector("#v-img").naturalWidth >= 1000), "the full image replaces the thumbnail");
  check((await f.locator("[data-heading]").count()) === 1, "there is one page heading");
  const fit = await f.evaluate(() => { const r = document.querySelector("#v-canvas").getBoundingClientRect(); return r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; });
  check(fit, "the whole picture fits the viewport");
  check(!(await f.locator("#v-info").isVisible()), "the information panel starts closed");

  /* ── Rapid movement ends on the right photo ── */
  const at = list.indexOf(id);
  await f.locator("body").focus().catch(() => {});
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  await until(() => routeOf(page) === `/photos/${list[at + 6]}`, "six fast arrows reach the sixth photo");
  await settled(f);
  check((await f.evaluate(() => Viewer.currentId())) === list[at + 6], "the viewer and the address agree");
  for (let i = 0; i < 2; i++) await page.keyboard.press("ArrowLeft");
  await until(() => routeOf(page) === `/photos/${list[at + 4]}`, "left arrows go back");
  await settled(f);

  /* ── Zoom ── */
  const scale = () => f.evaluate(() => +document.querySelector("#v-canvas").style.transform.match(/scale\(([\d.]+)\)/)[1]);
  await page.keyboard.press("+");
  await until(async () => (await scale()) > 1.4, "plus zooms in");
  await f.locator("#v-canvas").hover();
  await page.mouse.wheel(0, -300);
  await until(async () => (await scale()) > 1.6, "the wheel zooms");
  const before = await f.evaluate(() => document.querySelector("#v-canvas").style.transform);
  const box = await f.locator("#v-stage").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  check((await f.evaluate(() => document.querySelector("#v-canvas").style.transform)) !== before, "a zoomed picture can be dragged");
  await page.keyboard.press("0");
  await until(async () => (await scale()) === 1, "zero returns to fit");
  check((await f.locator("#v-level").innerText()) === "Fit", "the control says Fit");
  await settled(f);

  /* ── Information panel, title and faces ── */
  const current = await f.evaluate(() => Viewer.currentId());
  const wide = await f.evaluate(() => document.querySelector("#v-canvas").getBoundingClientRect().right);
  const innerWidthOf = await f.evaluate(() => innerWidth);
  await f.locator("#v-info-toggle").click();
  await f.locator("#title").waitFor({ state: "visible" });
  await until(() => f.evaluate(() => document.querySelector("#v-info").getBoundingClientRect().right <= innerWidth + 1 && !document.querySelector("#v-info").getAnimations().length), "the panel slides in");
  await settled(f);
  const moved = await f.evaluate(() => document.querySelector("#v-canvas").getBoundingClientRect().right);
  check(moved <= innerWidthOf - 372 + 1, `the picture moves aside on a wide screen (${Math.round(wide)} to ${Math.round(moved)})`);
  const face = await call(f, `/photos/${current}/faces`, "POST", { x: 0.3, y: 0.2, w: 0.2, h: 0.2 });
  await f.evaluate((pid) => loadPhotoFaces(pid), current);
  await until(async () => (await f.locator(`[data-act="face-select"][data-id="${face.id}"]`).count()) === 1, "a marked face appears over the picture");
  await f.locator("#title").fill("Synthetic title");
  await f.locator("#title").blur();
  await until(async () => (await call(f, `/photos/${current}`)).title === "Synthetic title", "the title saves");
  await until(async () => (await f.locator("#v-title").innerText()) === "Synthetic title", "the heading follows");
  for (const key of ["Download original", "Move to Trash"]) check(await f.getByRole("button", { name: key }).isVisible(), `${key} is in the panel`);
  if (ENGINE === "chromium") {
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), f.locator('[data-act="download"]').click()]);
    check(!!download.suggestedFilename(), "Download original delivers a file");
  } else {
    // Playwright reports no download event for a sandboxed blob link in these engines.
    await f.evaluate(() => { window.__clicks = []; HTMLAnchorElement.prototype.click = function () { window.__clicks.push(this.download); }; });
    await f.locator('[data-act="download"]').click();
    await until(() => f.evaluate(() => window.__clicks[0]), "Download original assembles the file and asks the browser to save it");
    check(true, "Download original assembles the file");
  }
  await call(f, `/photos/${current}`, "PATCH", { title: "" });
  check((await call(f, `/photos/${current}/faces`)).items.some((x) => x.id === face.id), "the face association is preserved");
  await call(f, `/faces/${face.id}`, "DELETE");
  await f.locator("#v-info-toggle").click();
  await until(() => f.locator("#title").isHidden(), "the panel closes");

  /* ── Returning: same gallery, same place, no reload ── */
  await page.keyboard.press("Escape");
  await until(() => routeOf(page) === "/", "Escape returns to the gallery");
  await until(() => f.evaluate(() => document.querySelector("#viewer").hidden), "the viewer goes away");
  check(await f.evaluate(() => document.querySelector("#grid").dataset.alive === "1"), "the gallery was not rebuilt");
  check((await f.evaluate(() => document.querySelector("#sheet").scrollTop)) === 620, "its scroll position is exactly as it was");
  check(await f.evaluate(() => !!document.activeElement.closest("[data-photo]") || document.activeElement.hasAttribute("data-heading")), "focus returns to the gallery");
  check(await f.evaluate(() => !document.querySelector(".tile.is-hero")), "no tile is left hidden");

  /* ── Browser history ── */
  await f.locator(`.tile[data-photo="${list[1]}"]`).click();
  await until(() => routeOf(page) === `/photos/${list[1]}`, "open again");
  await page.goBack();
  await until(() => routeOf(page) === "/", "Back returns to the gallery");
  await page.goForward();
  await until(() => routeOf(page) === `/photos/${list[1]}`, "Forward returns to the photo");
  await until(() => f.evaluate(() => Viewer.isOpen()), "the viewer reopens");
  await f.locator("#v-stage").click({ position: { x: 4, y: 200 } }); // WebKit: script cannot focus a frame after a traversal
  await page.keyboard.press("Escape");
  await until(() => f.evaluate(() => !Viewer.isOpen()), "closed");

  /* ── Rapid open and close leaves nothing stuck ── */
  for (let i = 0; i < 4; i++) {
    await f.evaluate((pid) => document.querySelector(`.tile[data-photo="${pid}"]`).click(), list[2]);
    await sleep(40);
    await page.keyboard.press("Escape");
    await sleep(60);
  }
  await until(() => f.evaluate(() => !Viewer.isOpen() && document.querySelector("#viewer").hidden && !document.querySelector(".tile.is-hero")), "rapid opening and closing ends closed");
  await until(() => routeOf(page) === "/", "and on the gallery");
  check(await f.evaluate(() => !document.querySelector("#sheet").inert), "the gallery stays usable");

  /* ── Deep links, Trash ── */
  f = await open(page, `/photos/${list[5]}`);
  await until(() => f.evaluate(() => Viewer.isOpen() && document.querySelector("#v-title").textContent.length > 0), "a deep link opens the viewer");
  await until(() => f.evaluate(() => !document.querySelector(".v-next").hidden && !document.querySelector(".v-prev").hidden), "a deep link can move to its neighbours");
  await f.locator("#v-info-toggle").click();
  await f.locator('[data-act="trash"]').click();
  await until(() => routeOf(page) === "/" || routeOf(page) === "", "Move to Trash returns to the gallery");
  await until(async () => (await f.locator("#grid").count()) === 1 && (await f.locator(`.tile[data-photo="${list[5]}"]`).count()) === 0, "the trashed photo has left the gallery");
  await call(f, `/photos/${list[5]}/restore`, "POST");

  /* ── Narrow screens ── */
  if (ENGINE !== "firefox") {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await ctx.storageState() });
    const small = await phone.newPage();
    let m = await open(small, `/photos/${list[0]}`);
    await until(() => m.evaluate(() => Viewer.isOpen() && document.querySelector("#v-img").getAttribute("src")), "the viewer opens on a phone");
    await settled(m);
    check(await m.evaluate(() => { const r = document.querySelector("#v-canvas").getBoundingClientRect(); return r.width <= innerWidth + 1 && r.height <= innerHeight + 1; }), "the picture fits a phone");
    check(await m.evaluate(() => { const r = document.querySelector("#v-info-toggle").getBoundingClientRect(); return r.width >= 44 && r.height >= 44; }), "controls are practical to touch");
    await m.locator("#v-info-toggle").tap();
    await m.locator("#title").waitFor({ state: "visible" });
    await until(() => m.evaluate(() => !document.querySelector("#v-info").getAnimations().length), "the sheet settles");
    check(await m.evaluate(() => { const c = document.querySelector("#v-canvas").getBoundingClientRect(); return c.width > innerWidth * 0.8 || c.height > innerHeight * 0.8; }), "the panel does not squeeze the picture");
    check(await noOverflow(m), "no sideways scrolling in the viewer");
    await m.locator("#v-info-toggle").tap({ force: true }).catch(() => {});
    await m.evaluate(() => { Element.prototype.setPointerCapture = () => {}; });
    const swipe = await m.evaluate(async () => {
      const before = Viewer.currentId();
      const stage = document.querySelector("#v-stage");
      const send = (type, x) => stage.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 5, pointerType: "touch", clientX: x, clientY: 400, button: 0 }));
      send("pointerdown", 300);
      send("pointermove", 200);
      send("pointermove", 120);
      send("pointerup", 120);
      await new Promise((r) => setTimeout(r, 40));
      return before !== Viewer.currentId();
    });
    check(swipe, "a swipe moves to the next photo");
    await phone.close();
  }

  /* ── Reduced motion ── */
  const calm = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", storageState: await ctx.storageState() });
  const still = await calm.newPage();
  const q = await open(still);
  await q.locator("#grid .tile").first().waitFor();
  const running = await q.evaluate(async (pid) => {
    document.querySelector(`.tile[data-photo="${pid}"]`).click();
    await new Promise(requestAnimationFrame);
    return document.getAnimations().filter((a) => a.effect.getTiming().duration > 1).length;
  }, list[3]);
  check(running === 0, "with reduced motion nothing animates");
  await calm.close();

  check(errors.filter((e) => !/access control checks/.test(e)).length === 0, `no page errors ${errors.slice(0, 2).join(" | ")}`);
  check(external.size === 0, `no external requests ${[...external].join(",")}`);
  await browser.close();
  console.log(JSON.stringify({ engine: ENGINE, passed, failed: failures.length, failures }));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  console.log(JSON.stringify({ engine: ENGINE, passed, failed: failures.length + 1, failures: [...failures, e.message.slice(0, 300)] }));
  process.exit(1);
});
