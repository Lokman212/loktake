// Serveur HTTP local de LokTake (aucune dépendance externe).
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { discoverProjects, readRegistry, scanVersions, refreshTimeline, removeVersion, MONTAGE_DIR } from "./projects.js";
import { listAnnotations, createAnnotation, updateAnnotation, deleteAnnotation, restoreAnnotation, carryAnnotations, httpError } from "./annotations.js";
import { readDraft, applyDraftOp, renderMontage, deleteMontageFiles, analyseImpacts } from "./cuts.js";
import { computePeaks, makeFilmstrip, serveFileRange } from "./media.js";
import { loktakePath, readJson, writeJson } from "./store.js";
import { hyperframesVersion } from "./hf.js";
import { normalizeEdl } from "../shared/timemap.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".map": "application/json",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ttf": "font/ttf" };
// Polices de la charte LokTake (DejaVu Sans / DejaVu Sans Mono), servies localement.
const FONTS = new Set(["DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSansMono.ttf", "DejaVuSansMono-Bold.ttf"]);

export function createServer({ roots }) {
  let projects = [];
  const jobs = new Map();

  async function refreshProjects() { projects = await discoverProjects(roots); return projects; }
  function getProject(id) {
    const p = projects.find((x) => x.id === id);
    if (!p) throw httpError(404, `Projet « ${id} » introuvable`);
    return p;
  }
  async function getVersion(project, vid) {
    const reg = await readRegistry(project.path);
    const v = reg.versions.find((x) => x.id === vid);
    if (!v) throw httpError(404, `Version « ${vid} » introuvable`);
    return v;
  }

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    routes.push({ method, re, keys, handler });
  };

  // ------------------------------------------------------------ projets & versions
  route("GET", "/api/state", async () => ({
    roots, hyperframesVersion: hyperframesVersion(), app: "LokTake 0.2.0",
    projects: await Promise.all((await refreshProjects()).map(async (p) => {
      const reg = await readRegistry(p.path);
      return { ...p, versionsKnown: reg.versions.filter((v) => !v.missing).length };
    })),
  }));

  // Ajoute un dossier à surveiller (utilisé par `loktake --background`).
  route("POST", "/api/roots", async (_p, body) => {
    const dir = path.resolve(String(body?.path ?? ""));
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw httpError(400, "dossier introuvable");
    if (!roots.includes(dir)) roots.push(dir);
    return { roots, projects: await refreshProjects() };
  });

  route("GET", "/api/projects/:pid", async ({ pid }) => {
    const project = getProject(pid);
    const versions = await scanVersions(project);
    const settings = await readJson(loktakePath(project.path, "settings.json"), {});
    return { project, versions, settings };
  });

  const saveSettings = async ({ pid }, body) => {
    const project = getProject(pid);
    const file = loktakePath(project.path, "settings.json");
    const cur = await readJson(file, {});
    const next = { ...cur, ...pick(body, ["lastVersionId", "lastTime", "zoom", "knownVersionIds"]) };
    await writeJson(file, next);
    return next;
  };
  route("PUT", "/api/projects/:pid/settings", saveSettings);
  route("POST", "/api/projects/:pid/settings", saveSettings); // navigator.sendBeacon (fermeture de l'onglet)

  route("POST", "/api/projects/:pid/versions/:vid/timeline", async ({ pid, vid }) => {
    return refreshTimeline(getProject(pid), vid);
  });

  route("DELETE", "/api/projects/:pid/versions/:vid", async ({ pid, vid }) => {
    const project = getProject(pid);
    const v = await getVersion(project, vid);
    if (v.kind !== "cut") throw httpError(400, "Seuls les MP4 montés par LokTake peuvent être supprimés ici (un rendu HyperFrames n'est jamais supprimé).");
    await deleteMontageFiles(project, v);
    await removeVersion(project, vid);
    return { ok: true };
  });

  // ------------------------------------------------------------ média
  route("GET", "/api/projects/:pid/versions/:vid/media", async ({ pid, vid }, _b, req, res) => {
    const project = getProject(pid);
    const v = await getVersion(project, vid);
    const abs = safeJoin(project.path, v.file);
    await serveFileRange(req, res, abs, MIME[path.extname(abs).toLowerCase()] ?? "video/mp4");
    return NO_BODY;
  });

  route("GET", "/api/projects/:pid/versions/:vid/peaks", async ({ pid, vid }) => {
    const project = getProject(pid);
    const v = await getVersion(project, vid);
    if (!v.media?.hasAudio) return { count: 0, peaks: [], duration: v.media?.duration ?? 0 };
    const cache = loktakePath(project.path, "cache", `peaks-${v.fingerprint.hash}.json`);
    let data = await readJson(cache, null);
    if (!data) { data = await computePeaks(safeJoin(project.path, v.file), v.media.duration); await writeJson(cache, data); }
    return data;
  });

  route("GET", "/api/projects/:pid/versions/:vid/filmstrip", async ({ pid, vid }, _b, req, res) => {
    const project = getProject(pid);
    const v = await getVersion(project, vid);
    const img = loktakePath(project.path, "cache", `filmstrip-${v.fingerprint.hash}.jpg`);
    const meta = `${img}.json`;
    let info = await readJson(meta, null);
    if (!info) { info = await makeFilmstrip(safeJoin(project.path, v.file), v.media.duration, img); await writeJson(meta, info); }
    if (new URL(req.url, "http://x").searchParams.get("meta")) return info;
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" });
    res.end(await fs.readFile(img));
    return NO_BODY;
  });

  // Images de raccord produites lors de la vérification d'un montage.
  route("GET", "/api/projects/:pid/montage-file", async ({ pid }, _b, req, res) => {
    const project = getProject(pid);
    const rel = new URL(req.url, "http://x").searchParams.get("path") ?? "";
    if (!rel.startsWith(MONTAGE_DIR.split(path.sep).join("/") + "/") || !rel.endsWith(".jpg")) throw httpError(403, "chemin refusé");
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(await fs.readFile(safeJoin(project.path, rel)));
    return NO_BODY;
  });

  // ------------------------------------------------------------ annotations
  route("GET", "/api/projects/:pid/annotations", async ({ pid }) => listAnnotations(getProject(pid)));

  route("POST", "/api/projects/:pid/annotations", async ({ pid }, body) => {
    const project = getProject(pid);
    const v = await getVersion(project, body.versionId);
    return createAnnotation(project, v, body);
  });

  route("POST", "/api/projects/:pid/annotations/restore", async ({ pid }, body) => restoreAnnotation(getProject(pid), body));

  route("PATCH", "/api/projects/:pid/annotations/:aid", async ({ pid, aid }, body) => updateAnnotation(getProject(pid), aid, body));

  route("DELETE", "/api/projects/:pid/annotations/:aid", async ({ pid, aid }) => deleteAnnotation(getProject(pid), aid));

  route("POST", "/api/projects/:pid/carry", async ({ pid }, body) => {
    const project = getProject(pid);
    const from = await getVersion(project, body.fromVersionId);
    const to = await getVersion(project, body.toVersionId);
    return carryAnnotations(project, from, to, { ids: body.ids ?? null, promote: Boolean(body.promote) });
  });

  // ------------------------------------------------------------ coupes (MP4 uniquement)
  route("GET", "/api/projects/:pid/edits/:vid", async ({ pid, vid }) => {
    const project = getProject(pid);
    const base = await getVersion(project, vid);
    const d = await readDraft(project, base);
    return draftView(base, d);
  });

  route("POST", "/api/projects/:pid/edits/:vid", async ({ pid, vid }, body) => {
    const project = getProject(pid);
    const base = await getVersion(project, vid);
    if (base.kind !== "render") throw httpError(400, "Les coupes se préparent sur un rendu HyperFrames d'origine.");
    return draftView(base, await applyDraftOp(project, base, body));
  });

  route("POST", "/api/projects/:pid/edits/:vid/render", async ({ pid, vid }) => {
    const project = getProject(pid);
    const base = await getVersion(project, vid);
    if (base.missing) throw httpError(400, "Le fichier de ce rendu n'existe plus.");
    const d = await readDraft(project, base);
    const id = Math.random().toString(36).slice(2, 10);
    const job = { id, state: "running", phase: "préparation", progress: 0, startedAt: Date.now() };
    jobs.set(id, job);
    renderMontage(project, base, d, (p) => Object.assign(job, p))
      .then(async (version) => {
        // Les annotations du rendu d'origine sont reportées sur le montage (originales conservées).
        const carried = await carryAnnotations(project, base, version);
        Object.assign(job, { state: "done", version, carried: carried.length, progress: 1 });
      })
      .catch((e) => Object.assign(job, { state: "error", error: e.message }));
    return job;
  });

  route("GET", "/api/jobs/:id", async ({ id }) => {
    const j = jobs.get(id);
    if (!j) throw httpError(404, "tâche inconnue");
    return j;
  });

  // ------------------------------------------------------------ serveur
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        for (const r of routes) {
          if (r.method !== req.method && !(r.method === "GET" && req.method === "HEAD")) continue;
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : null;
          const out = await r.handler(params, body, req, res);
          if (out !== NO_BODY) sendJson(res, 200, out ?? null);
          return;
        }
        throw httpError(404, "route inconnue");
      }
      await serveStatic(url.pathname, req, res);
    } catch (e) {
      if (!e.status) console.error(e);
      if (!res.headersSent) sendJson(res, e.status ?? 500, { error: e.message });
      else res.end();
    }
  });
  server.refreshProjects = refreshProjects;
  return server;
}

function draftView(base, d) {
  const edl = normalizeEdl(d, base.media.duration, base.media.fps);
  return {
    baseVersionId: base.id, removed: edl.removed, splits: edl.splits,
    canUndo: d.past.length > 0, canRedo: d.future.length > 0,
    impacts: edl.removed.length ? analyseImpacts(base, edl) : [],
  };
}

const NO_BODY = Symbol("no-body");

async function serveStatic(pathname, req, res) {
  let file;
  if (pathname === "/" || pathname === "/index.html") file = path.join(ROOT, "web", "index.html");
  else if (pathname.startsWith("/shared/")) file = safeJoin(path.join(ROOT, "shared"), pathname.slice(8));
  else if (pathname.startsWith("/vendor/player/")) {
    // Composant officiel <hyperframes-player> (ESM + son chunk).
    file = safeJoin(path.dirname(require.resolve("@hyperframes/player")), pathname.slice(15));
  } else if (pathname.startsWith("/vendor/fonts/")) {
    const name = pathname.slice(14);
    if (!FONTS.has(name)) throw httpError(404, "police introuvable");
    file = path.join(path.dirname(require.resolve("dejavu-fonts-ttf/package.json")), "ttf", name);
  } else file = safeJoin(path.join(ROOT, "web"), pathname.slice(1));
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  } catch {
    throw httpError(404, "fichier introuvable");
  }
}

function safeJoin(base, rel) {
  const p = path.resolve(base, rel);
  if (p !== base && !p.startsWith(base + path.sep)) throw httpError(403, "chemin refusé");
  return p;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (d) => { s += d; if (s.length > 5e6) req.destroy(); });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(httpError(400, "JSON invalide")); } });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  const s = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(s);
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
