// Correspondance des temps entre versions. Logique pure, partagée serveur/navigateur.
//
// Un montage (coupe MP4) est décrit par une EDL exprimée dans le temps du rendu
// de base : `removed` = plages [start, end) supprimées, `splits` = points de scission
// (qui ne suppriment rien). Tous les temps sont alignés sur les frontières d'images.

const EPS = 1e-6;

export function snap(t, fps) {
  return Math.round(t * fps) / fps;
}

/** Nettoie une EDL : aligne sur les images, borne, fusionne les chevauchements, trie. */
export function normalizeEdl(edl, duration, fps) {
  const removed = (edl?.removed ?? [])
    .map((r) => ({
      start: Math.max(0, Math.min(duration, snap(Math.min(r.start, r.end), fps))),
      end: Math.max(0, Math.min(duration, snap(Math.max(r.start, r.end), fps))),
    }))
    .filter((r) => r.end - r.start > EPS)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of removed) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + EPS) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  const splits = [...new Set((edl?.splits ?? []).map((t) => snap(t, fps)))]
    .filter((t) => t > EPS && t < duration - EPS)
    .sort((a, b) => a - b);
  return { removed: merged, splits };
}

/** Plages conservées [start, end) dans le temps de base. */
export function keptSegments(removed, duration) {
  const out = [];
  let cur = 0;
  for (const r of removed) {
    if (r.start > cur + EPS) out.push({ start: cur, end: r.start });
    cur = Math.max(cur, r.end);
  }
  if (duration > cur + EPS) out.push({ start: cur, end: duration });
  return out;
}

export function removedTotal(removed) {
  return removed.reduce((s, r) => s + (r.end - r.start), 0);
}

/** Plage supprimée contenant t (début inclus, fin exclue), sinon null. */
export function removedAt(t, removed) {
  return removed.find((r) => t >= r.start - EPS && t < r.end - EPS) ?? null;
}

/** Temps de base -> temps du montage. Un instant supprimé est ramené au raccord. */
export function baseToCut(t, removed) {
  let shift = 0;
  for (const r of removed) {
    if (t >= r.end - EPS) shift += r.end - r.start;
    else if (t > r.start + EPS) return { t: r.start - shift, removed: true };
    else break;
  }
  return { t: t - shift, removed: false };
}

/** Temps du montage -> temps de base. */
export function cutToBase(t, removed) {
  let base = t;
  for (const r of removed) {
    if (base >= r.start - EPS) base += r.end - r.start;
    else break;
  }
  return base;
}

/**
 * Reporte une annotation du rendu de base vers le montage.
 * Retourne la nouvelle position + niveau de confiance :
 *  - "exacte" : le passage annoté est intact, seul son instant a été décalé ;
 *  - "incertaine" : tout ou partie du passage a été supprimé -> à repositionner.
 */
export function mapAnnotationThroughCut(a, removed) {
  if (a.kind !== "range") {
    const m = baseToCut(a.time, removed);
    return m.removed
      ? { kind: "instant", time: m.t, confidence: "incertaine",
          reason: "L'instant annoté a été supprimé par la coupe ; placé au raccord." }
      : { kind: "instant", time: m.t, confidence: "exacte",
          reason: shiftReason(a.time, m.t) };
  }
  const s = baseToCut(a.start, removed);
  const e = baseToCut(a.end, removed);
  const touched = removed.some((r) => r.start < a.end - EPS && r.end > a.start + EPS);
  if (e.t - s.t <= EPS) {
    return { kind: "instant", time: s.t, confidence: "incertaine",
      reason: "La plage annotée a été entièrement supprimée ; placée au raccord." };
  }
  if (touched) {
    return { kind: "range", start: s.t, end: e.t, confidence: "incertaine",
      reason: "Une partie de la plage annotée a été supprimée ; vérifier ses bornes." };
  }
  return { kind: "range", start: s.t, end: e.t, confidence: "exacte",
    reason: shiftReason(a.start, s.t) };
}

function shiftReason(from, to) {
  const d = to - from;
  return Math.abs(d) < EPS ? "Passage intact, même position." :
    `Passage intact, décalé de ${d.toFixed(2)} s par la coupe.`;
}

/** Projette les clips du rendu de base sur le montage (pour afficher les scènes). */
export function mapClipsThroughCut(clips, removed) {
  const out = [];
  for (const c of clips) {
    const s = baseToCut(c.start, removed).t;
    const e = baseToCut(c.end, removed).t;
    if (e - s <= EPS) continue;
    const cutInside = removed.some((r) => r.start < c.end - EPS && r.end > c.start + EPS);
    out.push({ ...c, start: s, end: e, cutInside });
  }
  return out;
}

/**
 * Reporte une annotation vers un NOUVEAU RENDU HyperFrames (le code a changé).
 * La correspondance n'est jamais garantie : au mieux "probable".
 */
export function mapAnnotationAcrossRender(a, from, to) {
  const oldClips = from.clips ?? [];
  const newClips = to.clips ?? [];
  const sameTimeline = timelinesEquivalent(oldClips, newClips) &&
    Math.abs((from.duration ?? 0) - (to.duration ?? 0)) < 0.02;
  const clampT = (t) => Math.max(0, Math.min(to.duration ?? t, t));

  // 1) Ancrage sur une scène/élément ciblé présent dans les deux rendus.
  const target = (a.targets ?? []).map((tg) => ({
    old: oldClips.find((c) => c.id === tg.id),
    neu: newClips.find((c) => c.id === tg.id),
  })).find((p) => p.old && p.neu);

  if (target) {
    const { old, neu } = target;
    const sameLen = Math.abs((old.end - old.start) - (neu.end - neu.start)) < 0.02;
    const shift = neu.start - old.start;
    const conf = sameLen && (from.timelineReliable && to.timelineReliable) ? "probable" : "incertaine";
    const reason = sameLen
      ? (Math.abs(shift) < 0.005 ? `Scène « ${neu.id} » au même endroit.` : `Suit la scène « ${neu.id} » (décalée de ${shift.toFixed(2)} s).`)
      : `La scène « ${neu.id} » a changé de durée ; position approximative.`;
    return withPos(a, (t) => clampT(t + shift), conf, reason);
  }
  if (sameTimeline) {
    return withPos(a, clampT, from.timelineReliable && to.timelineReliable ? "probable" : "incertaine",
      "Structure du film inchangée ; même instant.");
  }
  return withPos(a, clampT, "incertaine",
    "La structure du film a changé et aucune scène commune n'est ciblée ; même instant par défaut.");
}

function withPos(a, f, confidence, reason) {
  if (a.kind === "range") {
    const start = f(a.start), end = f(a.end);
    if (end - start <= EPS) return { kind: "instant", time: start, confidence: "incertaine", reason: reason + " Plage hors du nouveau film." };
    return { kind: "range", start, end, confidence, reason };
  }
  return { kind: "instant", time: f(a.time), confidence, reason };
}

function timelinesEquivalent(a, b) {
  if (!a.length || a.length !== b.length) return false;
  const key = (c) => `${c.id}|${c.start.toFixed(3)}|${c.end.toFixed(3)}`;
  const sa = new Set(a.map(key));
  return b.every((c) => sa.has(key(c)));
}

/** Clips (scènes/éléments) recouvrant un instant ou une plage. */
export function clipsAt(clips, a) {
  const s = a.kind === "range" ? a.start : a.time;
  const e = a.kind === "range" ? a.end : a.time;
  return (clips ?? []).filter((c) =>
    a.kind === "range" ? c.start < e - EPS && c.end > s + EPS : c.start <= s + EPS && c.end > s + EPS);
}
