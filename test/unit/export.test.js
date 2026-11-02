import test from "node:test";
import assert from "node:assert/strict";
import { buildClaudeText } from "../../shared/claude-export.js";
import { analyseImpacts } from "../../server/cuts.js";

const base = {
  id: "v1", kind: "render", file: "renders/film-v1.mp4", media: { duration: 10, fps: 30, frames: 300 },
  timeline: { confidence: "probable", clips: [{ id: "intro", start: 0, end: 4, depth: 0, sourceFile: "compositions/intro.html", trackKind: "graphics" },
    { id: "music", start: 0, end: 10, depth: 0, trackKind: "audio", kind: "audio" }] },
};
const project = { name: "pub", path: "/p/pub" };
const ann = (o) => ({ id: "LT-001", kind: "instant", time: 1, comment: "Plus lent", status: "a_traiter", targets: [{ id: "intro", sourceFile: "compositions/intro.html" }], ...o });

test("le texte pour Claude liste les demandes et les fichiers sources", () => {
  const t = buildClaudeText({ project, version: base, versions: [base], annotations: [ann(), ann({ id: "LT-002", status: "valide", comment: "ok" })] });
  assert.match(t, /Demandes de modification du code source \(1\)/);
  assert.match(t, /LT-001 · Instant 00:01\.00 \(f30\)/);
  assert.match(t, /`intro` \(compositions\/intro\.html\)/);
  assert.match(t, /Déjà validé \(1\)/);
  const t2 = buildClaudeText({ project, version: base, versions: [base], annotations: [ann({ status: "a_verifier" })] });
  assert.match(t2, /Demandes de modification du code source \(0\)/);
  assert.match(t2, /En cours de vérification par moi \(1\) — ne pas modifier/);
  assert.doesNotMatch(t, /MP4 monté/);
});

test("un montage est présenté comme une coupe MP4, jamais comme une modification du code", () => {
  const cut = { id: "c1", kind: "cut", file: "renders/loktake-montages/film-v1__montage-01.mp4", derivedFrom: "v1",
    edl: { removed: [{ start: 2, end: 3 }] }, media: { duration: 9, fps: 30, frames: 270 }, timeline: base.timeline };
  const t = buildClaudeText({ project, version: cut, versions: [base, cut], annotations: [ann({ time: 5 })], montages: [cut] });
  assert.match(t, /\*\*MP4 monté\*\*/);
  assert.match(t, /n'a \*\*pas\*\* été modifié/);
  assert.match(t, /\[rendu d'origine : 00:06\.00\]/);
  assert.match(t, /Coupes faites sur le MP4 uniquement \(pas sur le code\)/);
});

test("analyse des effets d'une coupe : animation d'entrée et musique", () => {
  const im = analyseImpacts(base, { removed: [{ start: 3, end: 5 }] });
  const txt = im.map((i) => i.detail).join("\n");
  assert.match(txt, /fin de « intro »/);
  assert.match(txt, /music.*coupé en plein milieu/);
});
