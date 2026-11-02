// Parcours complet dans un vrai Chromium (Playwright) :
// ouvrir → lire → annoter (instant + plage) → statut → fermer → redémarrer le serveur →
// rouvrir → retrouver les annotations → cliquer = retour au passage → copier pour Claude →
// export JSON → couper (scinder, supprimer, annuler, rétablir) → générer le MP4 monté → vérifier.
//
// Usage : node test/e2e.mjs [DOSSIER_PROJET_HYPERFRAMES] [--shots DOSSIER]
// Le projet est COPIÉ dans un dossier temporaire : l'original n'est jamais modifié.
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const shotsIdx = args.indexOf("--shots");
const SHOTS = shotsIdx >= 0 ? path.resolve(args.splice(shotsIdx, 2)[1]) : null;
const srcProject = args[0] ? path.resolve(args[0]) : null;

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch {
  const g = execFileSync("npm", ["root", "-g"]).toString().trim();
  ({ chromium } = createRequire(g + "/")("playwright"));
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loktake-e2e-"));
const proj = path.join(tmp, srcProject ? path.basename(srcProject) : "fixture-hf");
if (srcProject) await fs.cp(srcProject, proj, { recursive: true, preserveTimestamps: true, filter: (s) => !s.includes(`${path.sep}.loktake`) && !s.includes("node_modules") });
else await makeFixture(proj);

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let server = await startServer();
const step = (s) => console.log(`\n▶ ${s}`);
const ok = (s) => console.log(`  ✓ ${s}`);
let shotN = 0;
const shot = async (page, name) => { if (SHOTS) { await fs.mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${String(++shotN).padStart(2, "0")}-${name}.png`) }); } };

const browser = await chromium.launch();
try {
  // ------------------------------------------------------------------ 1. ouvrir & lire
  step("Ouverture du projet et de la vraie vidéo");
  let ctx = await browser.newContext({ viewport: { width: 1500, height: 1050 }, acceptDownloads: true });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  let page = await ctx.newPage();
  const errors = [];
  const watch = (pg) => {
    pg.on("pageerror", (e) => errors.push(e.message));
    pg.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    pg.exposeFunction("__toastError", (m) => errors.push(`toast: ${m}`));
    pg.addInitScript(() => new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains("error")) window.__toastError(n.textContent); })
      .observe(document, { childList: true, subtree: true }));
  };
  watch(page);
  await page.goto(BASE);
  await page.waitForFunction(() => window.__loktake?.player?.ready && window.__loktake.S.version, null, { timeout: 30000 });
  const info = await page.evaluate(() => ({ kind: window.__loktake.player.kind, d: window.__loktake.player.duration, v: window.__loktake.S.version }));
  assert.ok(info.d > 1, "durée lue");
  ok(`lecteur ${info.kind}, ${info.d.toFixed(2)} s, ${info.v.media.frames} images, version ${info.v.file}`);
  const fps = info.v.media.fps;
  const clips = await page.locator(".clip").count();
  ok(`${clips} clip(s) HyperFrames dans la timeline (confiance : ${info.v.timeline?.confidence})`);

  await page.click("#playBtn");
  await page.waitForTimeout(1200);
  await page.click("#playBtn");
  await page.waitForTimeout(300);
  const t1 = await page.evaluate(() => window.__loktake.S.time);
  const playerT = await page.evaluate(() => window.__loktake.player.currentTime);
  const headX = await page.evaluate(() => parseFloat(window.__loktake.timeline.headEl.style.left));
  const pps = await page.evaluate(() => window.__loktake.timeline.pps);
  assert.ok(t1 > 0.5, "la lecture avance");
  assert.ok(Math.abs(playerT - t1) < 1 / fps + 1e-3, "lecteur et état synchronisés");
  assert.ok(Math.abs(headX - t1 * pps) < 1.5, "tête de lecture de la timeline synchronisée");
  ok(`lecture puis pause à ${t1.toFixed(3)} s ; lecteur ${playerT.toFixed(3)} s ; tête timeline à ${headX.toFixed(1)} px (attendu ${(t1 * pps).toFixed(1)})`);
  const f0 = await page.evaluate(() => Math.round(window.__loktake.S.time * window.__loktake.S.version.media.fps));
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
  const f1 = await page.evaluate(() => Math.round(window.__loktake.S.time * window.__loktake.S.version.media.fps));
  assert.equal(f1 - f0, 2, "pas image par image");
  ok(`→ → : image ${f0} → ${f1}`);
  await page.click('#speeds [data-rate="1.5"]');
  assert.equal(await page.evaluate(() => window.__loktake.player.playbackRate), 1.5);
  await page.click('#speeds [data-rate="1"]');
  ok("vitesse 1,5× appliquée au lecteur");
  await shot(page, "ouverture");

  // ------------------------------------------------------------------ 2. annoter
  step("Annotations : instant puis plage");
  await page.evaluate(() => window.__loktake.seek(1.0));
  await page.fill("#commentInput", "Le titre arrive trop tôt, décaler de 6 images.");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ann");
  // Plage : glisser dans la ligne des retours de la timeline.
  const lane = page.locator(".tl-row").filter({ has: page.locator(".marker") }).first();
  await lane.scrollIntoViewIfNeeded();
  const box = await lane.boundingBox();
  const x = async (t) => box.x + t * (await page.evaluate(() => window.__loktake.timeline.pps)) - (await page.evaluate(() => window.__loktake.timeline.scroller.scrollLeft));
  await page.mouse.move(await x(2.0), box.y + box.height - 4);
  await page.mouse.down();
  await page.mouse.move(await x(2.6), box.y + box.height - 4, { steps: 5 });
  await page.mouse.move(await x(3.5), box.y + box.height - 4, { steps: 5 });
  await page.mouse.up();
  const sel = await page.evaluate(() => window.__loktake.S.selection);
  assert.ok(sel && sel.end - sel.start > 1, "plage sélectionnée à la souris");
  ok(`plage sélectionnée ${sel.start.toFixed(3)} → ${sel.end.toFixed(3)} s`);
  await page.fill("#commentInput", "Transition molle sur ce passage : accélérer l'easing.");
  await page.click("#addBtn");
  await page.waitForFunction(() => document.querySelectorAll(".ann").length === 2);
  // Statut
  await page.locator(".ann").first().locator("select.status-sel").selectOption("a_verifier");
  await page.waitForTimeout(300);
  const disk = JSON.parse(await fs.readFile(path.join(proj, ".loktake", "annotations.json"), "utf8"));
  assert.equal(disk.annotations.length, 2);
  const [aInst, aRange] = disk.annotations;
  for (const k of ["id", "projectId", "versionId", "comment", "status", "targets", "createdAt"]) assert.ok(k in aInst, `champ ${k}`);
  assert.equal(aInst.kind, "instant"); assert.equal(aRange.kind, "range");
  assert.equal(aInst.status, "a_verifier");
  ok(`sur disque : ${aInst.id} instant ${aInst.time.toFixed(3)} s [${aInst.targets.map((t) => t.id).join(", ")}] ${aInst.status}`);
  ok(`sur disque : ${aRange.id} plage ${aRange.start.toFixed(3)}→${aRange.end.toFixed(3)} s [${aRange.targets.map((t) => t.id).join(", ")}] ${aRange.status}`);
  await shot(page, "annotations");

  // ------------------------------------------------------------------ 3. fermer, redémarrer, rouvrir
  step("Fermeture, redémarrage du serveur, réouverture");
  await ctx.close();
  server.kill(); await new Promise((r) => server.on("exit", r));
  server = await startServer();
  ctx = await browser.newContext({ viewport: { width: 1500, height: 1050 }, acceptDownloads: true });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  page = await ctx.newPage();
  watch(page);
  await page.goto(BASE);
  await page.waitForFunction(() => window.__loktake?.player?.ready && document.querySelectorAll(".ann").length === 2, null, { timeout: 30000 });
  ok("les 2 annotations sont rechargées depuis le disque");
  await page.locator(`.ann[data-id="${aRange.id}"] .ann-time`).click();
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => ({ t: window.__loktake.S.time, sel: window.__loktake.S.selection, p: window.__loktake.player.currentTime }));
  assert.ok(Math.abs(after.t - aRange.start) < 1e-6, "clic = retour au début de la plage");
  assert.ok(after.sel && Math.abs(after.sel.end - aRange.end) < 1e-6, "plage resélectionnée");
  ok(`clic sur ${aRange.id} → curseur ${after.t.toFixed(3)} s, lecteur ${after.p.toFixed(3)} s, plage resélectionnée`);
  await page.locator(`.marker[data-ann="${aInst.id}"]`).click();
  await page.waitForTimeout(200);
  assert.ok(Math.abs((await page.evaluate(() => window.__loktake.S.time)) - aInst.time) < 1e-6);
  ok(`clic sur le marqueur ${aInst.id} de la timeline → ${aInst.time.toFixed(3)} s`);

  // ------------------------------------------------------------------ 4. copier pour Claude + JSON
  step("Copier pour Claude et export JSON");
  await page.click("#copyClaude");
  await page.waitForTimeout(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /Demandes de modification du code source \(1\)/);
  assert.match(clip, /En cours de vérification par moi \(1\)/);
  assert.ok(clip.includes(aInst.id) && clip.includes(aRange.id));
  ok(`presse-papiers : ${clip.length} caractères, contient ${aInst.id} et ${aRange.id}`);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportJson")]);
  const exported = JSON.parse(await fs.readFile(await dl.path(), "utf8"));
  assert.equal(exported.annotations.length, 2);
  ok(`JSON exporté : ${dl.suggestedFilename()} (${exported.annotations.length} annotations, ${exported.versions.length} version(s))`);
  if (SHOTS) await fs.writeFile(path.join(SHOTS, "copie-pour-claude.md"), clip);

  // ------------------------------------------------------------------ 5. coupes
  step("Coupes MP4 : scinder, supprimer, annuler, rétablir, générer");
  await page.click('.tabs [data-tab="montage"]');
  await page.evaluate(() => window.__loktake.seek(6.0));
  await page.keyboard.press("s");
  await page.waitForFunction(() => window.__loktake.S.draft?.splits?.length === 1);
  ok("scission à 6,00 s (aucun contenu supprimé)");
  await page.evaluate(() => window.__loktake.seek(4.0));
  await page.keyboard.press("i");
  await page.evaluate(() => window.__loktake.seek(5.0 - 1 / window.__loktake.S.version.media.fps));
  await page.keyboard.press("o");
  const cutSel = await page.evaluate(() => window.__loktake.S.selection);
  await page.locator('[data-m="delete"]').click();
  await page.waitForFunction(() => window.__loktake.S.draft?.removed?.length === 1);
  const removed = await page.evaluate(() => window.__loktake.S.draft.removed[0]);
  ok(`I/O puis « Supprimer la sélection » : ${removed.start.toFixed(3)} → ${removed.end.toFixed(3)} s supprimé (sélection ${cutSel.start.toFixed(3)} → ${cutSel.end.toFixed(3)})`);
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => window.__loktake.S.draft?.removed?.length === 0);
  ok("Ctrl+Z : suppression annulée");
  await page.keyboard.press("Control+Shift+z");
  await page.waitForFunction(() => window.__loktake.S.draft?.removed?.length === 1);
  ok("Ctrl+Maj+Z : suppression rétablie");
  const impacts = await page.evaluate(() => window.__loktake.S.draft.impacts);
  ok(`analyse avant rendu : ${impacts.length} effet(s) prévu(s) — ${impacts.map((i) => i.label).join(" | ")}`);
  // Aperçu : la lecture saute la plage supprimée.
  await page.evaluate(() => window.__loktake.seek(3.6));
  await page.click("#playBtn");
  await page.waitForFunction(() => window.__loktake.S.time > 5.3, null, { timeout: 5000 });
  await page.click("#playBtn");
  ok("aperçu : la lecture a sauté 4,00 → 5,00 s sans modifier le fichier");
  await shot(page, "montage-brouillon");
  // Un retour placé DANS le passage qui va être supprimé : il devra être signalé « à repositionner ».
  await page.click('.tabs [data-tab="retours"]');
  await page.evaluate(() => { window.__loktake.seek(4.5); });
  await page.keyboard.press("Escape");
  await page.fill("#commentInput", "Ce passage est en trop.");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".ann").length === 3);
  await page.click('.tabs [data-tab="montage"]');
  const srcHashBefore = await sha(path.join(proj, info.v.file));
  await page.locator('[data-m="render"]').click();
  await page.waitForFunction(() => window.__loktake.S.version?.kind === "cut", null, { timeout: 180000 });
  await page.waitForTimeout(500);
  const cut = await page.evaluate(() => window.__loktake.S.version);
  assert.equal(await sha(path.join(proj, info.v.file)), srcHashBefore, "le rendu d'origine est intact");
  ok(`rendu d'origine inchangé (empreinte identique)`);
  ok(`nouveau MP4 monté : ${cut.file} · ${cut.media.duration.toFixed(3)} s · ${cut.media.frames} images`);
  for (const c of cut.report.checks) console.log(`    ${c.level === "ok" ? "✓" : c.level === "warn" ? "!" : "✗"} ${c.label} — ${c.detail}`);
  assert.ok(cut.report.ok, "vérification du montage sans erreur");
  assert.equal(cut.media.frames, info.v.media.frames - Math.round((removed.end - removed.start) * fps));
  const anns = JSON.parse(await fs.readFile(path.join(proj, ".loktake", "annotations.json"), "utf8")).annotations;
  const onCut = anns.filter((a) => a.versionId === cut.id);
  const onBase = anns.filter((a) => a.versionId === info.v.id);
  assert.equal(onBase.length, 3, "annotations d'origine conservées sur leur version");
  assert.equal(onCut.length, 3, "annotations reportées sur le montage");
  assert.equal(onCut.filter((a) => a.needsReposition).length, 1, "le retour dans le passage coupé est à repositionner");
  const exactOnes = onCut.filter((a) => !a.needsReposition);
  assert.ok(exactOnes.every((a) => a.mapping.confidence === "exacte"));
  for (const a of onCut) ok(`report ${a.origin.annotationId} → ${a.id} : ${a.kind === "range" ? `${a.start.toFixed(3)}→${a.end.toFixed(3)}` : a.time.toFixed(3)} s · ${a.mapping.confidence}${a.needsReposition ? " · À REPOSITIONNER" : ""} (${a.mapping.reason})`);
  await shot(page, "montage-rapport");
  // Copie depuis le montage : la distinction MP4 / code doit apparaître.
  await page.click("#copyClaude");
  await page.waitForTimeout(300);
  const clip2 = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip2, /MP4 monté/);
  assert.match(clip2, /n'a \*\*pas\*\* été modifié/);
  ok("le texte pour Claude signale explicitement que le code source n'a pas été modifié");
  if (SHOTS) await fs.writeFile(path.join(SHOTS, "copie-pour-claude-montage.md"), clip2);

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\n✅ Parcours complet réussi.");
} finally {
  await browser.close();
  server.kill();
  if (!process.env.KEEP_TMP) await fs.rm(tmp, { recursive: true, force: true });
  else console.log(`(dossier conservé : ${tmp})`);
}

// --------------------------------------------------------------------------------
function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, "bin/loktake.js"), tmp, "--port", String(PORT), "--no-open"], { stdio: ["ignore", "pipe", "inherit"] });
    p.stdout.on("data", (d) => { if (String(d).includes("LokTake →")) resolve(p); });
    p.on("exit", (c) => reject(new Error(`serveur arrêté (${c})`)));
  });
}

async function sha(file) {
  const { createHash } = await import("node:crypto");
  return createHash("sha1").update(await fs.readFile(file)).digest("hex");
}

/** Projet HyperFrames minimal + rendu MP4 synthétique (ffmpeg), si aucun projet n'est fourni. */
async function makeFixture(dir) {
  await fs.mkdir(path.join(dir, "renders"), { recursive: true });
  await fs.writeFile(path.join(dir, "hyperframes.json"), "{}\n");
  await fs.writeFile(path.join(dir, "index.html"), `<!doctype html><html><body>
<div id="main" data-composition-id="main" data-width="640" data-height="360" data-start="0" data-duration="10">
  <div id="scene-intro" data-composition-id="intro" data-start="0" data-duration="3.5" data-track-index="1"></div>
  <div id="scene-produit" data-composition-id="produit" data-start="3.5" data-duration="4" data-track-index="1"></div>
  <div id="scene-fin" data-composition-id="fin" data-start="7.5" data-duration="2.5" data-track-index="1"></div>
  <audio id="musique" src="m.mp3" data-start="0" data-duration="10" data-track-index="4"></audio>
</div></body></html>`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=10", "-f", "lavfi", "-i", "sine=f=330:d=10",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(dir, "renders", "fixture-v01.mp4")]);
  const older = new Date(Date.now() - 120000), old = new Date(Date.now() - 60000);
  for (const f of ["hyperframes.json", "index.html"]) await fs.utimes(path.join(dir, f), older, older);
  await fs.utimes(path.join(dir, "renders", "fixture-v01.mp4"), old, old);
}
