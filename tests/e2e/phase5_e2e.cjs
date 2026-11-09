// Argus 0.2.0 inside the real aetest Nexus (never production): a server-side import, a Full backup
// of a library larger than 256 MiB, restore after loss, Quick backup labelling, and face recognition
// with cluster and per-photo corrections. Synthetic data, removed at the end. The face picture is a
// public-domain NASA portrait from scikit-image (tests/fixtures/astronaut.png).
//
//   PLAYWRIGHT_PATH=G:/AureateEmpyrean/mnemosyne/node_modules/playwright node tests/e2e/phase5_e2e.cjs
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const NEXUS = "http://localhost:12334";
const RUN = Date.now().toString(36);
const LARGE = `large-${RUN}`;
const PEOPLE = `people-${RUN}`;
const SHOTS = path.join(__dirname, "../../docs/screenshots/0.2.0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (ok, what) => {
  if (!ok) {
    console.error(`FAIL ${what}`);
    process.exit(1);
  }
  passed++;
  console.log(`ok   ${what}`);
};
async function until(fn, what, seconds = 180) {
  for (let i = 0; i < seconds * 2; i++) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(500);
  }
  check(false, `${what} (timed out)`);
}
const inArgus = (code, input) => execFileSync("docker", ["exec", "-i", "aetest-module-argus", "python", "-c", code], { input, encoding: "utf8", maxBuffer: 1 << 26 });
const manage = (...args) => JSON.parse(execFileSync("docker", ["exec", "aetest-nexus-1", "python", "-m", "nexus.manage", ...args], { encoding: "utf8", maxBuffer: 1 << 26, timeout: 280000 }).trim().split("\n").pop());
const nexusSql = (sql, arg) => JSON.parse(execFileSync("docker", ["exec", "aetest-nexus-1", "python", "-c", `import sqlite3,json,sys
c=sqlite3.connect('file:/data/nexus.sqlite3?mode=ro',uri=True)
print(json.dumps(c.execute(sys.argv[1],(sys.argv[2],)).fetchall()))`, sql, arg], { encoding: "utf8" }));

async function open(page, module) {
  await page.goto(`${NEXUS}/app/modules/${module}`);
  await page.locator("#username, #module-application").first().waitFor({ timeout: 30000 });
  if (await page.locator("#username").isVisible()) {
    const owner = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../empyrean-nexus/.data/aetest-owner.json"), "utf8"));
    await page.locator("#username").fill(owner.username);
    await page.locator("#password").fill(owner.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  let frame;
  for (let i = 0; i < 80 && !frame; i++) {
    frame = page.frames().find((fr) => fr !== page.mainFrame() && fr.url().includes(`/modules/${module}`));
    if (!frame) await sleep(250);
  }
  await frame.waitForFunction(() => typeof api === "function", null, { timeout: 30000 });
  await sleep(600);
  return frame;
}
const call = (frame, p, method = "GET", body) => frame.evaluate(([x, m, b]) => (b === null ? api(x, m) : api(x, m, b)), [p, method, body === undefined ? null : body]);

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  // The large synthetic library: incompressible 30 MB pictures, and three views of one face.
  inArgus(`
import os
from PIL import Image
d=f"/data/import/${LARGE}"; os.makedirs(d, exist_ok=True)
for i in range(10):
    Image.frombytes("RGB",(3200,3200),os.urandom(3200*3200*3)).save(f"{d}/noise-{i}.png",compress_level=0)
`);
  const portrait = fs.readFileSync(path.join(__dirname, "../fixtures/astronaut.png"));
  inArgus(`
import io,os,sys
from PIL import Image, ImageOps
d="/data/import/${PEOPLE}"; os.makedirs(d, exist_ok=True)
im=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB")
im.save(f"{d}/one.jpg",quality=92)
im.resize((800,800)).save(f"{d}/two.jpg",quality=90)
ImageOps.mirror(im).crop((40,0,512,472)).save(f"{d}/three.jpg",quality=90)
`, portrait);

  const browser = await chromium.launch();
  const page = await browser.newPage({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  let a = await open(page, "argus");
  const pane = page.frameLocator("#module-application");
  // Remove what an interrupted earlier run left behind.
  await a.evaluate(async () => {
    await api("/faces/data?confirm=true", "DELETE");
    for (;;) {
      const page = await api("/photos?state=active");
      const stale = page.items.filter((p) => /^(noise-\d|one|two|three)\.(png|jpg)$/.test(p.filename || p.title || ""));
      if (!stale.length) return;
      for (const p of stale) {
        await api(`/photos/${p.id}`, "DELETE");
        await api(`/photos/${p.id}/purge?confirm=true`, "DELETE");
      }
    }
  });
  inArgus(`import glob,shutil
for d in glob.glob("/data/import/*"):
    if d.rsplit("/",1)[1] not in ("${LARGE}","${PEOPLE}"): shutil.rmtree(d)`);
  const before = (await call(a, "/state")).counts.active;

  // Server-side import through the interface.
  await a.evaluate(() => go("import"));
  await pane.locator(`[data-act="import-open"][data-path="${LARGE}"]`).click();
  await pane.locator('[data-act="import-server"]').click();
  const large = await until(async () => { const j = (await call(a, "/import/jobs")).items.find((x) => x.root === LARGE); return j && j.state === "done" ? j : null; }, "the large import finishes", 280);
  check(large.imported === 10 && large.failed === 0, `the server-side import added ${large.imported} files`);
  await page.screenshot({ path: path.join(SHOTS, "import-1440.png") });
  const again = (await call(a, "/import/jobs", "POST", { path: LARGE })).id;
  const twin = await until(async () => { const j = (await call(a, "/import/jobs")).items.find((x) => x.id === again); return j && j.state === "done" ? j : null; }, "the repeat import finishes", 280);
  check(twin.imported === 0 && twin.duplicates === 10, "a repeat import finds every file as an exact duplicate");
  const outside = await a.evaluate(() => api("/import/folders?path=" + encodeURIComponent("../..")).then(() => "allowed", (e) => e.message));
  check(outside !== "allowed", `the import cannot leave its folder (${outside})`);
  const source = inArgus(`import os;print(len(os.listdir("/data/import/${LARGE}")))`).trim();
  check(source === "10", "the source files are still there");

  // Full backup: above the old 256 MiB limit, and incremental.
  const full = manage("--backup", "argus");
  check(full.completeness === "full" && full.objects.bytes > 256 * 1024 * 1024, `a Full backup covers ${Math.round(full.objects.bytes / 1048576)} MiB in ${full.objects.count} files`);
  const second = manage("--backup", "argus");
  check(second.objects.transferred === 0 && second.objects.count === full.objects.count, "a second Full backup transfers no unchanged original");
  const quick = manage("--backup", "argus", "--backup-mode", "quick");
  check(quick.completeness === "quick" && !quick.objects, "a Quick backup is recorded as incomplete");
  const shown = await open(page, "argus");
  a = shown;

  // Restore after losing an original.
  const victim = (await call(a, "/photos?state=active")).items.find((p) => /noise/.test(p.filename || p.title || "")) || (await call(a, "/photos?state=active")).items[0];
  const victimFull = await call(a, `/photos/${victim.id}`);
  await call(a, `/photos/${victim.id}`, "DELETE");
  await call(a, `/photos/${victim.id}/purge?confirm=true`, "DELETE");
  const count = (await call(a, "/state")).counts.active;
  const restored = manage("--restore", "argus", full.id, "--confirm-replace");
  a = await until(() => open(page, "argus"), "Argus answers after the restore", 60);
  const afterRestore = await call(a, `/photos/${victim.id}`);
  check(afterRestore.original_available === true && (await call(a, "/state")).counts.active === count + 1 && victimFull.bytes === afterRestore.bytes, `a Full backup restores a lost original (${restored.state || "restored"})`);

  // Faces: scan, group, name a group.
  await a.evaluate(() => go("import"));
  await pane.locator(`[data-act="import-open"][data-path="${PEOPLE}"]`).click();
  await pane.locator('[data-act="import-server"]').click();
  await until(async () => { const j = (await call(a, "/import/jobs")).items.find((x) => x.root === PEOPLE); return j && j.state === "done" && j.imported === 3; }, "the portraits are imported");
  await a.evaluate(() => go("people"));
  await pane.locator('[data-act="faces-on"]').click();
  await until(async () => { const s = await call(a, "/faces/status"); return s.scanned === s.photos; }, "every photo is scanned", 280);
  const oom = execFileSync("docker", ["inspect", "aetest-module-argus", "--format", "{{.State.OOMKilled}} {{.RestartCount}} {{.HostConfig.Memory}}"], { encoding: "utf8" }).trim();
  check(oom === "false 0 805306368", `scanning stayed within the 768 MB grant (${oom})`);
  const clusters = (await call(a, "/faces/clusters")).items;
  const biggest = clusters.reduce((x, y) => (y.count > x.count ? y : x));
  check(biggest.count >= 3, `recurring faces are grouped (${biggest.count} in the largest group)`);
  const m = await open(page, "meridian");
  const person = await call(m, "/people", "POST", { names: [{ kind: "full", value: `Tvár Skúšobná ${RUN}` }] });
  const personRef = `nexus:v1:meridian:person:${person.id}`;
  a = await open(page, "argus");
  await a.evaluate(() => go("people"));
  await pane.locator(`[data-cluster="${biggest.id}"]`).click();
  await pane.locator('[data-person-search="cluster"]').fill(`Tvár Skúšobná ${RUN}`);
  await pane.locator('[data-act="person-pick"]').first().click({ timeout: 20000 });
  await pane.locator('[data-act="cluster-unassign"]').waitFor({ timeout: 15000 });
  await page.screenshot({ path: path.join(SHOTS, "cluster-1440.png") });
  const named = await call(a, `/faces/clusters/${biggest.id}`);
  check(named.faces.filter((f) => f.status === "confirmed").length >= 1 && named.person === personRef, "naming a group confirms its confident faces");
  const facePhoto = named.faces[0].photo_id;
  await until(async () => nexusSql("select target,readers from resource_references where source=?", `nexus:v1:argus:photo:${facePhoto}`).some(([t, r]) => t === personRef && r === '["meridian"]'), "the confirmed person is registered with Nexus");
  check(true, "a confirmed person becomes an edge shared with Meridian");

  const mid = await open(page, "meridian");
  const linked = await call(mid, `/entities/${person.id}/linked-from`);
  check(linked.items.some((x) => x.module === "argus" && x.type === "photo" && x.availability === "available"), "Meridian lists the photo in Linked from other modules");
  a = await open(page, "argus");

  // One photograph: boxes, exclude, undo, mark a missed face, name it.
  await a.evaluate((id) => go("photo", id), facePhoto);
  await pane.locator(".face-box").first().waitFor({ timeout: 20000 });
  await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, "photo-faces-1440.png") });
  const first = named.faces[0].id;
  await pane.locator(`[data-act="face-state"][data-state="excluded"][data-id="${first}"]`).click();
  await until(async () => (await call(a, `/photos/${facePhoto}/faces`)).items.find((f) => f.id === first).status === "excluded", "the face is excluded");
  await pane.locator(`[data-act="face-reset"][data-id="${first}"]`).click();
  await until(async () => (await call(a, `/photos/${facePhoto}/faces`)).items.find((f) => f.id === first).status === "auto", "undo returns the face to automatic");
  check(true, "a face can be excluded and the correction undone");
  await pane.locator('[data-act="face-mark"]').click();
  const layer = await pane.locator("#face-layer").boundingBox();
  await page.mouse.move(layer.x + layer.width * 0.05, layer.y + layer.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(layer.x + layer.width * 0.25, layer.y + layer.height * 0.9, { steps: 5 });
  await page.mouse.up();
  await until(async () => (await call(a, `/photos/${facePhoto}/faces`)).items.some((f) => f.origin === "manual"), "the missed face is marked");
  const manual = (await call(a, `/photos/${facePhoto}/faces`)).items.find((f) => f.origin === "manual");
  await pane.locator(`[data-person-search="${manual.id}"]`).fill(`Tvár Skúšobná ${RUN}`);
  await pane.locator('[data-act="person-pick"]').first().click({ timeout: 20000 });
  await until(async () => (await call(a, `/photos/${facePhoto}/faces`)).items.find((f) => f.origin === "manual").status === "confirmed", "the marked face is named");
  check((await call(a, `/photos/${facePhoto}/faces`)).items.length >= 2, "a photograph can hold several people, including a face marked by hand");
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(400);
  const overflow = await a.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `the photo view fits a phone (${overflow})`);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Clean up: recognition data, this run's photos, and the import folders.
  await call(a, "/faces/data?confirm=true", "DELETE");
  const status = await call(a, "/faces/status");
  check(status.faces === 0 && status.enabled === false && status.photos >= before, "deleting recognition data keeps every photograph");
  let cursor = null;
  const all = [];
  do {
    const page2 = await call(a, `/photos?state=active${cursor ? `&cursor=${cursor}` : ""}`);
    all.push(...page2.items);
    cursor = page2.next_cursor;
  } while (cursor);
  const mine = all.filter((p) => /^(noise-\d|one|two|three)\.(png|jpg)$/.test(p.filename || p.title || ""));
  for (const p of mine) {
    await call(a, `/photos/${p.id}`, "DELETE");
    await call(a, `/photos/${p.id}/purge?confirm=true`, "DELETE");
  }
  inArgus(`import shutil;shutil.rmtree("/data/import/${LARGE}");shutil.rmtree("/data/import/${PEOPLE}")`);
  const m2 = await open(page, "meridian");
  await call(m2, `/people/${person.id}`, "DELETE");
  const a2 = await open(page, "argus");
  check((await call(a2, "/state")).counts.active === before, "this run's photographs are removed");
  check(errors.length === 0, `no page errors (${errors.join(" / ")})`);
  await browser.close();
  console.log(`${passed} checks passed`);
})().catch((error) => {
  console.error(String(error).slice(0, 2000));
  process.exit(1);
});
