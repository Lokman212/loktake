#!/usr/bin/env node
// LokTake — lancement : loktake [dossier-projets ...] [--port 8093] [--no-open] [--background]
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "../server/index.js";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : def; };
const env = (k) => process.env[`LOKTAKE_${k}`];
const flag = (name) => { const i = args.indexOf(name); if (i >= 0) { args.splice(i, 1); return true; } return false; };

if (flag("--help") || flag("-h")) {
  console.log(`LokTake — atelier de revue des vidéos HyperFrames

Usage : loktake [DOSSIER ...] [--port 8093] [--host 127.0.0.1] [--no-open] [--background]

  DOSSIER       un projet HyperFrames ou un dossier qui en contient (2 niveaux).
                Par défaut : $LOKTAKE_ROOTS (séparés par « : ») ou le dossier courant.
  --background  ne bloque pas : démarre le serveur en arrière-plan s'il ne tourne pas
                déjà, lui ajoute les dossiers donnés, puis affiche l'adresse à ouvrir
                (celle du projet si DOSSIER est un projet) et rend la main.`);
  process.exit(0);
}
const port = Number(opt("--port", env("PORT") || 8093));
const host = opt("--host", "127.0.0.1");
const noOpen = flag("--no-open") || env("NO_OPEN") === "1";
const background = flag("--background");
const roots = (args.length ? args : (env("ROOTS")?.split(":").filter(Boolean) ?? [process.cwd()]))
  .map((r) => path.resolve(r));
const base = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;

if (background) {
  await runBackground();
} else {
  const server = createServer({ roots });
  await server.refreshProjects();
  server.listen(port, host, () => {
    console.log(`LokTake → ${base}/`);
    console.log(`Dossiers surveillés : ${roots.join(", ")}`);
    if (!noOpen) openBrowser(`${base}/`);
  });
}

async function runBackground() {
  let alive = await ping();
  if (!alive) {
    const log = path.join(os.tmpdir(), `loktake-${port}.log`);
    const out = fs.openSync(log, "a");
    const self = fileURLToPath(import.meta.url);
    spawn(process.execPath, [self, ...roots, "--port", String(port), "--host", host, "--no-open"],
      { detached: true, stdio: ["ignore", out, out] }).unref();
    for (let i = 0; i < 50 && !alive; i++) { await sleep(200); alive = await ping(); }
    if (!alive) { console.error(`Le serveur n'a pas démarré (journal : ${log})`); process.exit(1); }
  } else {
    // Serveur déjà lancé : on lui ajoute les dossiers qu'il ne connaît pas encore.
    for (const r of roots) await fetch(`${base}/api/roots`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: r }) }).catch(() => {});
  }
  const state = await (await fetch(`${base}/api/state`)).json();
  const project = state.projects.find((p) => roots.includes(p.path));
  const url = project ? `${base}/#/p/${encodeURIComponent(project.id)}` : `${base}/`;
  console.log(url);
  if (!noOpen) openBrowser(url);
}

async function ping() {
  try { const r = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(800) }); return r.ok; } catch { return false; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).on("error", () => {}).unref();
}
