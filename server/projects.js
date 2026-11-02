// Découverte des projets HyperFrames et registre des versions (rendus et MP4 montés).
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readTimeline, hyperframesVersion } from "./hf.js";
import { probe } from "./media.js";
import { ensureGitignore, loktakePath, readJson, updateJson, withLock, writeJson } from "./store.js";
import { mapClipsThroughCut } from "../shared/timemap.js";

export const MONTAGE_DIR = path.join("renders", "loktake-montages");
/** Fiche posée à côté d'un MP4 monté. */
export const SIDECAR_EXT = ".loktake.json";
const VIDEO_EXT = new Set([".mp4", ".m4v", ".webm", ".mov"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".loktake", ".hyperframes", ".cache", "dist"]);

// ---------------------------------------------------------------- projets

export async function isProject(dir) {
  if (await exists(path.join(dir, "hyperframes.json"))) return true;
  try {
    const html = await fs.readFile(path.join(dir, "index.html"), "utf8");
    return html.includes("data-composition-id");
  } catch { return false; }
}

/** Cherche les projets dans les racines (la racine elle-même, puis 2 niveaux). */
export async function discoverProjects(roots) {
  const found = [];
  const seen = new Set();
  const add = (dir) => { const r = path.resolve(dir); if (!seen.has(r)) { seen.add(r); found.push(r); } };
  for (const root of roots) {
    if (await isProject(root)) { add(root); continue; }
    for (const d1 of await subdirs(root)) {
      if (await isProject(d1)) { add(d1); continue; }
      for (const d2 of await subdirs(d1)) if (await isProject(d2)) add(d2);
    }
  }
  const ids = new Map();
  return found.map((dir) => {
    let id = slug(path.basename(dir));
    const n = ids.get(id) ?? 0; ids.set(id, n + 1);
    if (n) id = `${id}-${n + 1}`;
    return { id, name: path.basename(dir), path: dir };
  });
}

async function subdirs(dir) {
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)).map((e) => path.join(dir, e.name));
  } catch { return []; }
}

// ---------------------------------------------------------------- fichiers rendus

async function findVideoFiles(projectDir) {
  const out = [];
  const walk = async (dir, depth) => {
    let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3 && !e.name.startsWith(".")) await walk(p, depth + 1);
      else if (e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase()) && !e.name.endsWith(".partial.mp4")) out.push(p);
    }
  };
  await walk(path.join(projectDir, "renders"), 0);
  // Rendus posés à la racine du projet (ex. `render -o output.mp4`).
  for (const e of await fs.readdir(projectDir, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())) out.push(path.join(projectDir, e.name));
  }
  return out;
}

/** Empreinte du contenu : taille + SHA-1 du premier et du dernier Mo. */
export async function fingerprint(file) {
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    const n = Math.min(size, 1 << 20);
    const head = Buffer.alloc(n), tail = Buffer.alloc(n);
    await fh.read(head, 0, n, 0);
    await fh.read(tail, 0, n, Math.max(0, size - n));
    const h = crypto.createHash("sha1").update(String(size)).update(head).update(tail).digest("hex");
    return h.slice(0, 10);
  } finally { await fh.close(); }
}

/** État du code source (fichiers hors rendus) : date de dernière modification + empreinte. */
export async function sourceState(projectDir) {
  const entries = [];
  const walk = async (dir, rel, depth) => {
    let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      if (depth === 0 && e.name === "renders") continue;
      const p = path.join(dir, e.name), r = path.join(rel, e.name);
      if (e.isDirectory()) { if (depth < 6) await walk(p, r, depth + 1); }
      else if (e.isFile()) {
        if (depth === 0 && VIDEO_EXT.has(path.extname(e.name).toLowerCase())) continue;
        const st = await fs.stat(p);
        entries.push([r, st.size, Math.floor(st.mtimeMs)]);
      }
      if (entries.length > 5000) return;
    }
  };
  await walk(projectDir, "", 0);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const maxMtime = entries.reduce((m, e) => Math.max(m, e[2]), 0);
  const latest = entries.find((e) => e[2] === maxMtime)?.[0] ?? null;
  const hash = crypto.createHash("sha1").update(JSON.stringify(entries)).digest("hex").slice(0, 12);
  return { hash, maxMtime, latest, files: entries.length };
}

// ---------------------------------------------------------------- registre des versions

const REGISTRY = (dir) => loktakePath(dir, "versions.json");
const EMPTY_REGISTRY = { schema: 1, versions: [] };

export function readRegistry(projectDir) {
  return readJson(REGISTRY(projectDir), EMPTY_REGISTRY);
}

/**
 * Parcourt les rendus, enregistre les nouveaux, marque les disparus.
 * Une version = un contenu (empreinte) ; si un rendu est réécrit sous le même nom,
 * c'est une nouvelle version et l'ancienne passe en « fichier remplacé ».
 */
export async function scanVersions(project) {
  const dir = project.path;
  await ensureGitignore(dir);
  return withLock(REGISTRY(dir), async () => {
    const reg = await readRegistry(dir);
    const before = JSON.stringify(reg);
    const files = await findVideoFiles(dir);
    const seenIds = new Set();
    const recent = new Set();
    const pendingTimeline = [];

    const foundRel = new Set(files.map((abs) => path.relative(dir, abs).split(path.sep).join("/")));
    for (const abs of files) {
      const rel = path.relative(dir, abs).split(path.sep).join("/");
      const st = await fs.stat(abs);
      let v = reg.versions.find((x) => x.file === rel && x.fingerprint?.size === st.size && x.fingerprint?.mtimeMs === Math.floor(st.mtimeMs));
      if (!v && Date.now() - st.mtimeMs < 2500) { recent.add(rel); continue; } // rendu probablement en cours d'écriture
      if (!v) {
        const hash = await fingerprint(abs);
        // Même contenu qu'une version connue : renommage seulement si l'ancien fichier a disparu
        // (deux rendus identiques sous deux noms restent deux versions distinctes).
        v = reg.versions.find((x) => x.fingerprint?.hash === hash && !foundRel.has(x.file));
        if (v) { v.file = rel; v.fingerprint = { size: st.size, mtimeMs: Math.floor(st.mtimeMs), hash }; }
        else {
          let media = null, error = null;
          try { media = await probe(abs); } catch (e) { error = e.message; }
          const sidecar = await readJson(`${abs}${SIDECAR_EXT}`, null);
          v = {
            id: `${slug(path.basename(rel, path.extname(rel)))}-${hash.slice(0, 6)}`,
            kind: sidecar?.kind === "cut" ? "cut" : "render",
            file: rel,
            fingerprint: { size: st.size, mtimeMs: Math.floor(st.mtimeMs), hash },
            fileDate: new Date(st.mtimeMs).toISOString(),
            registeredAt: new Date().toISOString(),
            media, error,
            timeline: null,
          };
          if (sidecar?.kind === "cut") Object.assign(v, { derivedFrom: sidecar.derivedFrom, edl: sidecar.edl, report: sidecar.report ?? null });
          reg.versions.push(v);
        }
      }
      v.missing = false;
      seenIds.add(v.id);
      if (!v.timeline && v.kind === "render" && v.media) pendingTimeline.push(v);
    }
    for (const v of reg.versions) if (!seenIds.has(v.id) && !recent.has(v.file)) v.missing = true;

    if (pendingTimeline.length) await attachTimelines(dir, pendingTimeline);
    for (const v of reg.versions) {
      if (v.kind === "cut" && !v.timeline) {
        const base = reg.versions.find((b) => b.id === v.derivedFrom);
        if (base?.timeline) v.timeline = deriveCutTimeline(base, v);
      }
    }
    reg.versions.sort((a, b) => a.fileDate.localeCompare(b.fileDate));
    // N'écrit que si quelque chose a changé (le registre est relu toutes les quelques secondes).
    if (JSON.stringify(reg) !== before) await writeJson(REGISTRY(dir), reg);
    return reg.versions;
  });
}

/** Instantané de la timeline du code source, avec un niveau de confiance honnête. */
async function attachTimelines(dir, versions) {
  const src = await sourceState(dir);
  const cacheFile = loktakePath(dir, "cache", `timeline-${src.hash}.json`);
  let snap = await readJson(cacheFile, null);
  if (!snap) {
    try { snap = await readTimeline(dir); } catch (e) { snap = { error: e.message }; }
    await writeJson(cacheFile, snap);
  }
  for (const v of versions) {
    if (snap.error) { v.timeline = { error: snap.error, clips: [], confidence: "indisponible", reason: snap.error }; continue; }
    const renderMs = v.fingerprint.mtimeMs;
    let confidence = "probable";
    let reason = "Code source inchangé depuis ce rendu.";
    if (src.maxMtime > renderMs + 1000) {
      confidence = "incertaine";
      reason = `Le code source a été modifié après ce rendu (${src.latest}) : les scènes affichées sont celles du code actuel.`;
    } else if (Math.abs((snap.duration || 0) - v.media.duration) > 1.5 / v.media.fps) {
      confidence = "incertaine";
      reason = `Durée du code (${snap.duration} s) ≠ durée du MP4 (${v.media.duration.toFixed(2)} s).`;
    }
    v.timeline = {
      capturedAt: new Date().toISOString(),
      sourceHash: src.hash,
      hyperframesVersion: snap.hyperframesVersion ?? hyperframesVersion(),
      duration: snap.duration,
      clips: snap.clips,
      confidence, reason,
    };
  }
}

export function deriveCutTimeline(base, v) {
  return {
    ...base.timeline,
    derivedFrom: base.id,
    duration: v.media?.duration ?? null,
    clips: mapClipsThroughCut(base.timeline.clips ?? [], v.edl?.removed ?? []),
    reason: `Scènes du rendu ${base.file} projetées à travers la coupe. ${base.timeline.reason ?? ""}`.trim(),
  };
}

/** Force la relecture de la timeline d'une version (après correction du code par ex.). */
export async function refreshTimeline(project, versionId) {
  return updateJson(REGISTRY(project.path), EMPTY_REGISTRY, async (reg) => {
    const v = reg.versions.find((x) => x.id === versionId);
    if (!v || v.kind !== "render") return null;
    await attachTimelines(project.path, [v]);
    return v;
  });
}

export async function registerVersion(project, entry) {
  return updateJson(REGISTRY(project.path), EMPTY_REGISTRY, (reg) => {
    reg.versions = reg.versions.filter((x) => x.id !== entry.id);
    reg.versions.push(entry);
    reg.versions.sort((a, b) => a.fileDate.localeCompare(b.fileDate));
    return entry;
  });
}

export async function removeVersion(project, versionId) {
  return updateJson(REGISTRY(project.path), EMPTY_REGISTRY, (reg) => {
    reg.versions = reg.versions.filter((x) => x.id !== versionId);
  });
}

// ---------------------------------------------------------------- utilitaires

export function slug(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
