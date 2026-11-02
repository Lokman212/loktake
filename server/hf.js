// Pont vers la CLI HyperFrames installée (même version que les projets : 0.8.229).
// On réutilise `hyperframes timeline --json` (analyse statique, sans navigateur) pour
// connaître les scènes/éléments du film et leurs instants.
import { createRequire } from "node:module";
import path from "node:path";
import { run } from "./media.js";

const require = createRequire(import.meta.url);

export function hyperframesBin() {
  const override = process.env.LOKTAKE_HYPERFRAMES_BIN;
  if (override) return override;
  const pkgPath = require.resolve("hyperframes/package.json");
  const pkg = require(pkgPath);
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.hyperframes;
  return path.join(path.dirname(pkgPath), bin);
}

export function hyperframesVersion() {
  try { return require("hyperframes/package.json").version; } catch { return null; }
}

/** Lit la timeline du projet et la ramène à une liste plate de clips. */
export async function readTimeline(projectDir) {
  const env = { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1", HYPERFRAMES_NO_UPDATE_CHECK: "1" };
  const buf = await runNode([hyperframesBin(), "timeline", "--json"], projectDir, env);
  const text = String(buf);
  const json = JSON.parse(text.slice(text.indexOf("{")));
  const tl = json.timeline ?? json;
  const clips = [];
  const visit = (row, track, depth, parentId) => {
    const start = num(row.absStart ?? row.start);
    const end = num(row.absEnd ?? row.end ?? (start + num(row.duration)));
    if (row.id && Number.isFinite(start) && Number.isFinite(end)) {
      clips.push({
        id: String(row.id),
        label: row.label ?? null,
        kind: row.kind ?? null,
        trackKind: row.trackKind ?? track.kind ?? null,
        trackIndex: row.trackIndex ?? null,
        start, end,
        file: row.file ?? null,
        sourceFile: row.sourceFile ?? row.src ?? row.file ?? null,
        hfId: row.hfId ?? null,
        depth,
        parentId: parentId ?? null,
      });
    }
    for (const c of row.children ?? []) visit(c, track, depth + 1, row.id);
  };
  for (const track of tl.tracks ?? []) for (const row of track.rows ?? []) visit(row, track, 0, null);
  return { duration: num(tl.duration), clips, hyperframesVersion: json._meta?.version ?? hyperframesVersion() };
}

function runNode(args, cwd, env) {
  return import("node:child_process").then(({ spawn }) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = []; let err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("hyperframes timeline : délai dépassé")); }, 90000);
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`hyperframes timeline a échoué : ${err.trim().split("\n").slice(-3).join(" | ")}`));
    });
  }));
}

const num = (x) => (x === null || x === undefined ? NaN : Number(x));
export { run };
