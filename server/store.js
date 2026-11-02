// Stockage JSON sur disque, dans le dossier `.loktake/` de chaque projet.
// Écriture atomique (fichier temporaire + rename) et sérialisation par fichier.
import fs from "node:fs/promises";
import path from "node:path";

export const LOKTAKE_DIR = ".loktake";

export function loktakePath(projectDir, ...parts) {
  return path.join(projectDir, LOKTAKE_DIR, ...parts);
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return structuredClone(fallback);
    if (e instanceof SyntaxError) {
      // Fichier corrompu : on le met de côté plutôt que de l'écraser.
      const aside = `${file}.corrompu-${Date.now()}`;
      await fs.rename(file, aside).catch(() => {});
      console.warn(`[loktake] ${file} illisible, déplacé vers ${aside}`);
      return structuredClone(fallback);
    }
    throw e;
  }
}

export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await fs.rename(tmp, file);
}

const locks = new Map();
/** Exécute fn en exclusion mutuelle pour une clé (ex. chemin de fichier). */
export function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/** Lecture-modification-écriture atomique d'un fichier JSON. */
export function updateJson(file, fallback, mutate) {
  return withLock(file, async () => {
    const data = await readJson(file, fallback);
    const result = await mutate(data);
    await writeJson(file, data);
    return result;
  });
}

export async function ensureGitignore(projectDir) {
  // Le cache (forme d'onde, vignettes) n'a pas à être versionné ; les annotations oui.
  const gi = loktakePath(projectDir, ".gitignore");
  try { await fs.access(gi); } catch {
    await fs.mkdir(path.dirname(gi), { recursive: true });
    await fs.writeFile(gi, "cache/\n*.tmp\nsettings.json\n");
  }
}
