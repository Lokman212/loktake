// Test d'intégration : vrai MP4 (ffmpeg), vraie coupe, vraie vérification.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderMontage } from "../../server/cuts.js";
import { probe } from "../../server/media.js";

async function fixture(audioExpr) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loktake-cut-"));
  await fs.mkdir(path.join(dir, "renders"));
  const file = path.join(dir, "renders", "film.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=10",
    "-f", "lavfi", "-i", `aevalsrc='${audioExpr}':d=10:s=44100`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
  const media = await probe(file);
  const base = { id: "film-x", kind: "render", file: "renders/film.mp4", media, timeline: null };
  return { project: { id: "p", path: dir }, base, dir };
}

test("coupe exacte à l'image, source intacte, saut audio réel détecté", async () => {
  // Son fort jusqu'à 5 s puis silence : couper 4 → 6 s crée un vrai saut au raccord.
  const { project, base, dir } = await fixture("if(lt(t,5),0.5*sin(2*PI*440*t),0)");
  const before = await fs.readFile(path.join(dir, base.file));
  const v = await renderMontage(project, base, { removed: [{ start: 4, end: 6 }], splits: [] });
  assert.equal(v.kind, "cut");
  assert.equal(v.media.frames, 240);
  assert.ok(v.report.ok, JSON.stringify(v.report.checks.filter((c) => c.level === "error")));
  assert.ok(v.report.joints[0].framesMatch);
  assert.ok(v.report.checks.some((c) => c.level === "warn" && /Saut de niveau/.test(c.detail)), "saut audio signalé");
  assert.ok((await fs.readFile(path.join(dir, base.file))).equals(before), "le MP4 d'origine n'est pas modifié");
  const side = JSON.parse(await fs.readFile(path.join(dir, v.file + ".loktake.json"), "utf8"));
  assert.match(side.note, /code source HyperFrames n'a pas été modifié/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("son continu : pas de fausse alerte au raccord", async () => {
  const { project, base, dir } = await fixture("0.4*sin(2*PI*330*t)");
  const v = await renderMontage(project, base, { removed: [{ start: 2, end: 3.5 }], splits: [] });
  assert.ok(v.report.ok);
  assert.ok(!v.report.checks.some((c) => /Saut de niveau/.test(c.detail)));
  await fs.rm(dir, { recursive: true, force: true });
});
