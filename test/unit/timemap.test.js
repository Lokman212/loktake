import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEdl, keptSegments, baseToCut, cutToBase, mapAnnotationThroughCut,
  mapAnnotationAcrossRender, mapClipsThroughCut, clipsAt, removedAt,
} from "../../shared/timemap.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("normalizeEdl aligne sur les images, fusionne et borne", () => {
  const e = normalizeEdl({ removed: [{ start: 2.01, end: 3 }, { start: 2.9, end: 4.004 }, { start: 9, end: 12 }], splits: [5.02, 5.02, 0, 10] }, 10, 30);
  assert.equal(e.removed.length, 2);
  near(e.removed[0].start, 2.0); near(e.removed[0].end, 4.0);
  near(e.removed[1].start, 9); near(e.removed[1].end, 10);
  assert.deepEqual(e.splits.map((s) => Math.round(s * 30)), [151]);
});

test("scinder ne supprime rien : segments conservés = film entier", () => {
  const e = normalizeEdl({ removed: [], splits: [3] }, 10, 30);
  assert.deepEqual(keptSegments(e.removed, 10), [{ start: 0, end: 10 }]);
});

test("baseToCut / cutToBase sont inverses hors des plages supprimées", () => {
  const removed = [{ start: 2, end: 3 }, { start: 5, end: 6.5 }];
  for (const t of [0, 1.9, 3, 4.2, 6.5, 9]) near(cutToBase(baseToCut(t, removed).t, removed), t);
  assert.deepEqual(baseToCut(2.5, removed), { t: 2, removed: true });
  near(baseToCut(7, removed).t, 4.5);
  assert.equal(removedAt(2, removed)?.start, 2);
  assert.equal(removedAt(3, removed), null);
});

test("annotation intacte après coupe : exacte et décalée", () => {
  const m = mapAnnotationThroughCut({ kind: "instant", time: 8 }, [{ start: 2, end: 3 }]);
  assert.equal(m.confidence, "exacte"); near(m.time, 7);
});

test("annotation dans un passage supprimé : à repositionner (incertaine)", () => {
  const m = mapAnnotationThroughCut({ kind: "instant", time: 2.5 }, [{ start: 2, end: 3 }]);
  assert.equal(m.confidence, "incertaine"); near(m.time, 2);
  const r = mapAnnotationThroughCut({ kind: "range", start: 1, end: 2.5 }, [{ start: 2, end: 3 }]);
  assert.equal(r.confidence, "incertaine"); near(r.start, 1); near(r.end, 2);
  const gone = mapAnnotationThroughCut({ kind: "range", start: 2.2, end: 2.8 }, [{ start: 2, end: 3 }]);
  assert.equal(gone.kind, "instant"); assert.equal(gone.confidence, "incertaine");
});

test("clips projetés à travers la coupe", () => {
  const clips = [{ id: "a", start: 0, end: 4 }, { id: "b", start: 4, end: 6 }, { id: "c", start: 2.2, end: 2.8 }];
  const out = mapClipsThroughCut(clips, [{ start: 2, end: 3 }]);
  assert.deepEqual(out.map((c) => [c.id, c.start, c.end, c.cutInside]), [["a", 0, 3, true], ["b", 3, 5, false]]);
});

test("nouveau rendu : suit la scène ciblée, jamais « exacte »", () => {
  const from = { clips: [{ id: "intro", start: 0, end: 3 }, { id: "fin", start: 3, end: 8 }], duration: 8, timelineReliable: true };
  const to = { clips: [{ id: "intro", start: 0, end: 4 }, { id: "fin", start: 4, end: 9 }], duration: 9, timelineReliable: true };
  const a = { kind: "instant", time: 5, targets: [{ id: "fin" }] };
  const m = mapAnnotationAcrossRender(a, from, to);
  near(m.time, 6); assert.equal(m.confidence, "probable");
  const b = mapAnnotationAcrossRender({ kind: "instant", time: 1, targets: [{ id: "intro" }] }, from, to);
  assert.equal(b.confidence, "incertaine"); // la scène a changé de durée
  const c = mapAnnotationAcrossRender({ kind: "instant", time: 1, targets: [] }, from, to);
  assert.equal(c.confidence, "incertaine");
});

test("clipsAt : instant et plage", () => {
  const clips = [{ id: "a", start: 0, end: 2 }, { id: "b", start: 2, end: 4 }];
  assert.deepEqual(clipsAt(clips, { kind: "instant", time: 2 }).map((c) => c.id), ["b"]);
  assert.deepEqual(clipsAt(clips, { kind: "range", start: 1, end: 3 }).map((c) => c.id), ["a", "b"]);
});
