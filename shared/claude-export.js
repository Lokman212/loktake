// Construit le texte « Copier pour Claude ». Logique pure, partagée et testée.
import { formatAnnotationTime, formatTime, frameAt, statusLabel } from "./format.js";
import { cutToBase, keptSegments, removedTotal } from "./timemap.js";

const kindLabel = (v) => (v.kind === "cut" ? "MP4 monté par LokTake" : "rendu HyperFrames");

/**
 * @param {object} p
 * @param {{name:string, path:string}} p.project
 * @param {object} p.version          version visionnée
 * @param {object[]} p.versions       toutes les versions (pour les libellés)
 * @param {object[]} p.annotations    annotations à exporter (déjà filtrées)
 * @param {object|null} p.draft       brouillon de coupe en cours sur le rendu de base
 * @param {object[]} p.montages       versions montées (kind "cut") à signaler
 */
export function buildClaudeText({ project, version, versions = [], annotations, draft = null, montages = [] }) {
  const fps = version.media?.fps ?? 30;
  const byId = new Map(versions.map((v) => [v.id, v]));
  const base = version.kind === "cut" ? byId.get(version.derivedFrom) : null;
  const L = [];

  L.push(`# Retours vidéo — ${project.name}`);
  L.push("");
  L.push(`- Projet HyperFrames : \`${project.path}\``);
  L.push(`- Version visionnée : \`${version.file}\` (${kindLabel(version)}) · ${fmtDur(version.media?.duration)} · ${fps} i/s · ${version.media?.frames ?? "?"} images`);
  if (version.kind === "cut") {
    L.push(`- ⚠️ Ce fichier est un **MP4 monté** à partir de \`${base?.file ?? version.derivedFrom}\`. Le code source HyperFrames n'a **pas** été modifié par ce montage.`);
    L.push(`  Les temps indiqués sont ceux du montage ; l'instant correspondant dans le rendu d'origine (donc dans le code) est donné entre crochets.`);
  }
  const tl = version.timeline;
  if (tl && tl.confidence !== "probable") {
    L.push(`- ⚠️ Correspondance scènes ↔ rendu incertaine : ${tl.reason}`);
  }
  L.push("");

  const todo = annotations.filter((a) => a.status === "a_traiter");
  const checking = annotations.filter((a) => a.status === "a_verifier");
  const done = annotations.filter((a) => a.status === "valide");
  L.push(`## Demandes de modification du code source (${todo.length})`);
  L.push("");
  if (!todo.length) L.push("_Aucune demande à traiter._", "");
  else {
    L.push("À appliquer dans le projet HyperFrames (`index.html`, `compositions/…`), puis relancer un rendu (`npx hyperframes render`).");
    L.push("");
    todo.forEach((a, i) => L.push(...annotationBlock(a, i + 1, fps, version)));
  }

  if (checking.length) {
    L.push(`## En cours de vérification par moi (${checking.length}) — ne pas modifier`);
    L.push("");
    for (const a of checking) L.push(`- ${a.id} · ${formatAnnotationTime(a, fps)} · ${oneLine(a.comment)}`);
    L.push("");
  }
  if (done.length) {
    L.push(`## Déjà validé (${done.length}) — ne pas modifier`);
    L.push("");
    for (const a of done) L.push(`- ${a.id} · ${formatAnnotationTime(a, fps)} · ${oneLine(a.comment)}`);
    L.push("");
  }

  const cutLines = [];
  for (const m of montages) {
    const b = byId.get(m.derivedFrom);
    const removed = m.edl?.removed ?? [];
    cutLines.push(`- Montage \`${m.file}\` (dérivé de \`${b?.file ?? m.derivedFrom}\`) : ${removed.length} plage(s) supprimée(s), durée ${fmtDur(b?.media?.duration)} → ${fmtDur(m.media?.duration)}.`);
    for (const r of removed) cutLines.push(`  - supprimé ${rangeLabel(r, b?.media?.fps ?? fps)}${scenesTouched(b, r)}`);
  }
  if (draft && (draft.removed?.length || draft.splits?.length)) {
    const b = byId.get(draft.baseVersionId);
    const bf = b?.media?.fps ?? fps;
    cutLines.push(`- Coupes en préparation (non appliquées) sur \`${b?.file ?? draft.baseVersionId}\` :`);
    for (const r of draft.removed ?? []) cutLines.push(`  - supprimer ${rangeLabel(r, bf)}${scenesTouched(b, r)}`);
    for (const s of draft.splits ?? []) cutLines.push(`  - point de scission à ${formatTime(s)} (f${frameAt(s, bf)}) — aucun contenu supprimé`);
  }
  if (cutLines.length) {
    L.push("## Coupes faites sur le MP4 uniquement (pas sur le code)");
    L.push("");
    L.push("Ces coupes ont été faites dans LokTake sur un fichier vidéo. Elles **ne modifient pas** le projet HyperFrames.");
    L.push("Si elles doivent devenir définitives, reporte-les dans le code source (retirer ou raccourcir les scènes concernées, ajuster `data-start` / `data-duration`, les animations GSAP et l'audio).");
    L.push("");
    L.push(...cutLines, "");
  }

  L.push("---");
  L.push("Merci de répondre en citant chaque identifiant (LT-…) avec la modification faite, puis de produire une nouvelle version du rendu.");
  return L.join("\n");
}

function annotationBlock(a, n, fps, version) {
  const out = [];
  let time = formatAnnotationTime(a, fps);
  if (version.kind === "cut") {
    const removed = version.edl?.removed ?? [];
    const baseTime = a.kind === "range"
      ? `${formatTime(cutToBase(a.start, removed))} → ${formatTime(cutToBase(a.end, removed))}`
      : formatTime(cutToBase(a.time, removed));
    time += ` [rendu d'origine : ${baseTime}]`;
  }
  out.push(`### ${n}. ${a.id} · ${a.kind === "range" ? "Plage" : "Instant"} ${time} · ${statusLabel(a.status)}`);
  if (a.targets?.length) {
    out.push(`Scènes / éléments : ${a.targets.map((t) => `\`${t.id}\`${t.sourceFile ? ` (${t.sourceFile})` : ""}`).join(", ")}`);
  }
  for (const line of (a.comment || "").trim().split("\n")) out.push(`> ${line}`);
  if (a.needsReposition) out.push(`⚠️ Position à confirmer : ${a.mapping?.reason ?? "correspondance incertaine"}`);
  out.push("");
  return out;
}

function scenesTouched(baseVersion, r) {
  const clips = baseVersion?.timeline?.clips ?? [];
  const hit = clips.filter((c) => c.depth === 0 && c.start < r.end && c.end > r.start).map((c) => `\`${c.id}\``);
  return hit.length ? ` — scènes touchées : ${hit.join(", ")}` : "";
}

const rangeLabel = (r, fps) =>
  `${formatTime(r.start)} → ${formatTime(r.end)} (f${frameAt(r.start, fps)}–f${Math.round(r.end * fps) - 1}, ${(r.end - r.start).toFixed(2)} s)`;
const fmtDur = (d) => (Number.isFinite(d) ? `${d.toFixed(2)} s` : "? s");
const oneLine = (s) => (s || "").replace(/\s+/g, " ").trim();

/** Résumé d'une EDL pour l'interface. */
export function edlSummary(edl, duration) {
  return {
    kept: keptSegments(edl.removed, duration),
    removedSeconds: removedTotal(edl.removed),
    resultDuration: duration - removedTotal(edl.removed),
  };
}
