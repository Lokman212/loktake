// Annotations : `.loktake/annotations.json` dans le projet (versionnable avec git).
import { loktakePath, readJson, updateJson } from "./store.js";
import { mapAnnotationAcrossRender, mapAnnotationThroughCut } from "../shared/timemap.js";

const FILE = (dir) => loktakePath(dir, "annotations.json");
const EMPTY = { schema: 1, nextNumber: 1, annotations: [] };
const STATUSES = new Set(["a_traiter", "a_verifier", "valide"]);

export async function listAnnotations(project) {
  return (await readJson(FILE(project.path), EMPTY)).annotations;
}

function nextId(data) {
  let n = data.nextNumber ?? 1;
  const ids = new Set(data.annotations.map((a) => a.id));
  while (ids.has(fmtId(n))) n++;
  data.nextNumber = n + 1;
  return fmtId(n);
}
const fmtId = (n) => `LT-${String(n).padStart(3, "0")}`;

/** Valide et normalise les champs modifiables. */
function clean(input, base = {}) {
  const a = { ...base };
  if (input.kind !== undefined) {
    if (!["instant", "range"].includes(input.kind)) throw httpError(400, "kind invalide");
    a.kind = input.kind;
  }
  if (a.kind === "range" || input.start !== undefined) {
    if (input.start !== undefined) a.start = Number(input.start);
    if (input.end !== undefined) a.end = Number(input.end);
  }
  if (input.time !== undefined) a.time = Number(input.time);
  if (a.kind === "range") {
    if (!(Number.isFinite(a.start) && Number.isFinite(a.end) && a.end > a.start)) throw httpError(400, "plage invalide");
    delete a.time;
  } else {
    if (!Number.isFinite(a.time)) throw httpError(400, "instant invalide");
    delete a.start; delete a.end;
  }
  if (input.comment !== undefined) a.comment = String(input.comment).slice(0, 20000);
  if (input.status !== undefined) {
    if (!STATUSES.has(input.status)) throw httpError(400, "statut invalide");
    a.status = input.status;
  }
  if (input.targets !== undefined) {
    a.targets = (Array.isArray(input.targets) ? input.targets : []).slice(0, 50).map((t) => ({
      id: String(t.id), sourceFile: t.sourceFile ?? null, trackKind: t.trackKind ?? null, auto: Boolean(t.auto),
    }));
  }
  if (input.needsReposition !== undefined) a.needsReposition = Boolean(input.needsReposition);
  return a;
}

export async function createAnnotation(project, version, input) {
  return updateJson(FILE(project.path), EMPTY, (data) => {
    const now = new Date().toISOString();
    const a = clean(input, {
      kind: "instant", comment: "", status: "a_traiter", targets: [], needsReposition: false,
    });
    Object.assign(a, {
      id: input.id && !data.annotations.some((x) => x.id === input.id) ? input.id : nextId(data),
      projectId: project.id,
      versionId: version.id,
      versionFile: version.file,
      fps: version.media?.fps ?? null,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    });
    if (input.origin) a.origin = input.origin;
    if (input.mapping) a.mapping = input.mapping;
    data.annotations.push(order(a));
    return a;
  });
}

export async function updateAnnotation(project, id, patch) {
  return updateJson(FILE(project.path), EMPTY, (data) => {
    const i = data.annotations.findIndex((a) => a.id === id);
    if (i < 0) throw httpError(404, "annotation introuvable");
    const a = clean(patch, data.annotations[i]);
    // Déplacer une annotation « à repositionner » vaut confirmation.
    if ((patch.time !== undefined || patch.start !== undefined) && patch.needsReposition === undefined) a.needsReposition = false;
    a.updatedAt = new Date().toISOString();
    data.annotations[i] = order(a);
    return a;
  });
}

export async function deleteAnnotation(project, id) {
  return updateJson(FILE(project.path), EMPTY, (data) => {
    const i = data.annotations.findIndex((a) => a.id === id);
    if (i < 0) throw httpError(404, "annotation introuvable");
    const [removed] = data.annotations.splice(i, 1);
    return removed;
  });
}

/** Restaure une annotation supprimée (annulation), avec son identifiant d'origine. */
export async function restoreAnnotation(project, a) {
  return updateJson(FILE(project.path), EMPTY, (data) => {
    if (data.annotations.some((x) => x.id === a.id)) throw httpError(409, "identifiant déjà utilisé");
    data.annotations.push(order({ ...a, updatedAt: new Date().toISOString() }));
    return a;
  });
}

/**
 * Reporte des annotations d'une version vers une autre. Les originales restent
 * attachées à leur version ; des copies liées (`origin`) sont créées.
 * - vers un montage dérivé : correspondance exacte sauf passages supprimés ;
 * - vers un nouveau rendu : correspondance au mieux « probable », donc à confirmer.
 */
export async function carryAnnotations(project, from, to, { ids = null, promote = false } = {}) {
  return updateJson(FILE(project.path), EMPTY, (data) => {
    const now = new Date().toISOString();
    const already = new Set(data.annotations.filter((a) => a.versionId === to.id && a.origin).map((a) => a.origin.annotationId));
    const src = data.annotations.filter((a) => a.versionId === from.id && !already.has(a.id) && (!ids || ids.includes(a.id)));
    const created = [];
    const viaCut = to.kind === "cut" && to.derivedFrom === from.id;
    for (const a of src) {
      const m = viaCut
        ? mapAnnotationThroughCut(a, to.edl?.removed ?? [])
        : mapAnnotationAcrossRender(a, timelineInfo(from), timelineInfo(to));
      const copy = {
        id: nextId(data),
        projectId: project.id,
        versionId: to.id,
        versionFile: to.file,
        fps: to.media?.fps ?? null,
        kind: m.kind,
        ...(m.kind === "range" ? { start: m.start, end: m.end } : { time: m.time }),
        comment: a.comment,
        status: promote && a.status === "a_traiter" ? "a_verifier" : a.status,
        targets: a.targets ?? [],
        needsReposition: m.confidence !== "exacte",
        origin: { annotationId: a.id, versionId: from.id, versionFile: from.file },
        mapping: { confidence: m.confidence, reason: m.reason, via: viaCut ? "coupe" : "nouveau-rendu" },
        createdAt: now, updatedAt: now,
      };
      a.carriedTo = [...(a.carriedTo ?? []), { annotationId: copy.id, versionId: to.id }];
      data.annotations.push(order(copy));
      created.push(copy);
    }
    return created;
  });
}

function timelineInfo(v) {
  return {
    clips: (v.timeline?.clips ?? []).filter((c) => c.depth === 0),
    duration: v.media?.duration,
    timelineReliable: v.timeline?.confidence === "probable",
  };
}

// Ordre de clés stable pour un JSON lisible.
function order(a) {
  const keys = ["id", "projectId", "versionId", "versionFile", "fps", "kind", "time", "start", "end", "comment", "status",
    "targets", "needsReposition", "origin", "mapping", "carriedTo", "createdAt", "updatedAt"];
  const o = {};
  for (const k of keys) if (a[k] !== undefined) o[k] = a[k];
  for (const k of Object.keys(a)) if (!(k in o)) o[k] = a[k];
  return o;
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
