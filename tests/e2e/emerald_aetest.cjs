// Argus Emerald inside the real aetest Nexus (never production): the Nexus application switcher
// shows the Emerald icon (Nexus's validated copy, refreshed after the update), Argus opens from
// the switcher with its Emerald header and accent, the library is intact, and switching to
// Meridian and back works. Read-only: it creates, edits and deletes nothing.
//
//   PLAYWRIGHT_PATH=G:/AureateEmpyrean/mnemosyne/node_modules/playwright node tests/e2e/emerald_aetest.cjs
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const NEXUS = process.env.NEXUS_URL || "http://localhost:12334";
const SHOTS = path.join(__dirname, "../../docs/screenshots/emerald-aetest");
const ICON = fs.readFileSync(path.join(__dirname, "../../frontend/icon.svg"));
const ICON_SHA = crypto.createHash("sha256").update(ICON).digest("hex");
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "../../manifest.json"), "utf8")).version;
const PHOTOS = Number(process.env.EXPECT_PHOTOS || 3);
let passed = 0;
const check = (ok, what) => {
  if (!ok) {
    console.error(`FAIL ${what}`);
    process.exit(1);
  }
  passed++;
  console.log(`ok   ${what}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(page) {
  await page.goto(`${NEXUS}/`);
  await page.locator("#username, #product-switch").first().waitFor({ timeout: 30000 });
  if (await page.locator("#username").isVisible()) {
    const owner = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../empyrean-nexus/.data/aetest-owner.json"), "utf8"));
    await page.locator("#username").fill(owner.username);
    await page.locator("#password").fill(owner.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page.locator("#product-switch").waitFor({ timeout: 30000 });
}

async function moduleFrame(page, id) {
  for (let i = 0; i < 80; i++) {
    const frame = page.frames().find((fr) => fr !== page.mainFrame() && fr.url().includes(`/modules/${id}`));
    if (frame) {
      await frame.waitForSelector("#app .rail, #app .sheet, #app nav, #app main", { timeout: 30000 });
      return frame;
    }
    await sleep(250);
  }
  throw new Error(`no ${id} frame`);
}

async function switcherItem(page, name) {
  // Inside an application Nexus tucks its bar away; it slides in when the pointer reaches the top edge.
  await page.mouse.move(page.viewportSize().width / 2, 200);
  await page.mouse.move(page.viewportSize().width / 2, 2, { steps: 4 });
  await sleep(700);
  await page.locator("#product-switch").click();
  const item = page.locator("#launcher-items .launcher-item", { hasText: name });
  await item.waitFor({ timeout: 10000 });
  return item;
}

async function run(width, height, label) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await signIn(page);

  const modules = await page.evaluate(async () => (await fetch("/api/v1/modules")).json());
  const list = Array.isArray(modules) ? modules : modules.items || modules.modules;
  const argus = list.find((m) => m.id === "argus");
  check(argus && argus.manifest.version === VERSION && argus.state === "enabled", `${label}: Nexus lists Argus ${argus?.manifest.version} enabled`);
  check(
    JSON.stringify(argus.manifest.capabilities) === JSON.stringify(JSON.parse(fs.readFileSync(path.join(__dirname, "../../manifest.json"), "utf8")).capabilities),
    `${label}: Argus permissions match its manifest (${argus.manifest.capabilities.join(", ")})`,
  );

  const item = await switcherItem(page, "Argus");
  check((await item.innerText()).includes(`v${VERSION}`), `${label}: switcher shows Argus v${VERSION}`);
  const img = item.locator(".monogram.has-icon img");
  await img.waitFor({ timeout: 10000 });
  await page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await img.elementHandle(), { timeout: 10000 });
  const src = await img.getAttribute("src");
  check(src.includes(`/api/v1/modules/argus/icon?v=${VERSION}`), `${label}: switcher icon URL carries the new version`);
  const served = await page.evaluate(async (u) => {
    const r = await fetch(u, { cache: "no-store" });
    const b = new Uint8Array(await r.arrayBuffer());
    const d = await crypto.subtle.digest("SHA-256", b);
    return { status: r.status, type: r.headers.get("content-type"), sha: [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("") };
  }, src);
  check(served.status === 200 && served.sha === ICON_SHA, `${label}: Nexus serves the Emerald icon (sha256 ${served.sha.slice(0, 12)}…, ${served.type})`);
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.locator("#product-menu").screenshot({ path: path.join(SHOTS, `switcher-${label}.png`) });

  await item.click();
  const frame = await moduleFrame(page, "argus");
  const brand = await frame.evaluate(() => {
    const el = document.querySelector(".brand-mark img");
    return { src: el?.getAttribute("src") || "", ok: !!el && el.complete && el.naturalWidth > 0, accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() };
  });
  const embedded = brand.src.startsWith("data:image/svg+xml;base64,") ? Buffer.from(brand.src.split(",")[1], "base64") : Buffer.alloc(0);
  check(brand.ok && embedded.equals(ICON), `${label}: Argus header shows the same icon bytes`);
  check(brand.accent.toLowerCase() === "#4dad72", `${label}: Emerald accent ${brand.accent}`);
  await frame.waitForSelector("#grid .tile, .empty", { timeout: 20000 });
  const tiles = await frame.locator("#grid .tile").count();
  check(tiles === PHOTOS, `${label}: library lists ${tiles} photos`);
  const overflow = await frame.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `${label}: no horizontal overflow in Argus (${overflow})`);
  await page.screenshot({ path: path.join(SHOTS, `argus-${label}.png`) });

  const meridian = await switcherItem(page, "Meridian");
  await meridian.click();
  await moduleFrame(page, "meridian");
  check(page.url().includes("/app/modules/meridian"), `${label}: switcher opens Meridian`);
  const back = await switcherItem(page, "Argus");
  check(await back.locator(".monogram.has-icon img").count() === 1, `${label}: Argus icon still shown after switching`);
  await page.keyboard.press("Escape");
  await page.goBack();
  await moduleFrame(page, "argus");
  check(page.url().includes("/app/modules/argus"), `${label}: browser Back returns to Argus`);
  check(errors.length === 0, `${label}: no page errors (${errors.join(" / ")})`);
  await browser.close();
}

(async () => {
  await run(1440, 900, "1440");
  await run(390, 844, "390");
  console.log(`${passed} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
