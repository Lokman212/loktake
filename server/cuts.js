// Coupes appliquées au MP4 (montage). Ne touche JAMAIS au code source HyperFrames :
// on produit un nouveau fichier dans renders/loktake-montages/, le rendu d'origine est intact.
import fs from "node:fs/promises";
import path from "node:path";
import { FFMPEG, run, probe, decodeAudio, rmsDb, grabFramesGray, meanAbsDiff, frameStrip } from "./media.js";
import { loktakePath, readJson, updateJson, writeJson } from "./store.js";
import { MONTAGE_DIR, SIDECAR_EXT, deriveCutTimeline, fingerprint, registerVersion, slug } from "./projects.js";
import { keptSegments, normalizeEdl, removedTotal } from "../shared/timemap.js";
import { formatTime } from "../shared/format.js";

const AUDIO_FADE = 0.006; // micro-fondu (6 ms) à chaque raccord pour éviter un clic
const EPS = 1e-6;

// ---------------------------------------------------------------- brouillon (EDL) avec annuler/rétablir

const draftFile = (project, baseId) => loktakePath(project.path, "edits", `${baseId}.json`);
const emptyDraft = (baseId) => ({ schema: 1, baseVersionId: baseId, removed: [], splits: [], past: [], future: [] });

export function readDraft(project, base) {
  return readJson(draftFile(project, base.id), emptyDraft(base.id));
}

/** Applique une opération au brouillon de coupe. Toutes les opérations sont réversibles. */
export function applyDraftOp(project, base, op) {
  const { duration, fps } = base.media;
  return updateJson(draftFile(project, base.id), emptyDraft(base.id), (d) => {
    const snapshot = () => ({ removed: structuredClone(d.removed), splits: [...d.splits] });
    const commit = (next) => {
      const n = normalizeEdl(next, duration, fps);
      if (JSON.stringify(n) === JSON.stringify({ removed: d.removed, splits: d.splits })) return;
      d.past.push(snapshot()); if (d.past.length > 200) d.past.shift();
      d.future = [];
      d.removed = n.removed; d.splits = n.splits;
    };
    switch (op.type) {
      case "split": commit({ removed: d.removed, splits: [...d.splits, Number(op.t)] }); break;
      case "unsplit": commit({ removed: d.removed, splits: d.splits.filter((s) => Math.abs(s - op.t) > 0.5 / fps) }); break;
      case "delete": commit({ removed: [...d.removed, { start: Number(op.start), end: Number(op.end) }], splits: d.splits }); break;
      case "restore": { // ré-insère une plage précédemment supprimée
        const s = Number(op.start), e = Number(op.end);
        const out = [];
        for (const r of d.removed) {
          if (r.end <= s + EPS || r.start >= e - EPS) out.push(r);
          else { if (r.start < s) out.push({ start: r.start, end: s }); if (r.end > e) out.push({ start: e, end: r.end }); }
        }
        commit({ removed: out, splits: d.splits }); break;
      }
      case "load": commit(op.edl ?? { removed: [], splits: [] }); break;
      case "reset": commit({ removed: [], splits: [] }); break;
      case "undo": if (d.past.length) { d.future.push(snapshot()); Object.assign(d, d.past.pop()); } break;
      case "redo": if (d.future.length) { d.past.push(snapshot()); Object.assign(d, d.future.pop()); } break;
      default: throw Object.assign(new Error("opération inconnue"), { status: 400 });
    }
    return d;
  });
}

// ---------------------------------------------------------------- rendu du montage

/**
 * Construit le MP4 monté (ré-encodage précis à l'image), le vérifie et l'enregistre.
 * @returns {Promise<object>} la nouvelle version
 */
export async function renderMontage(project, base, edlInput, onProgress = () => {}) {
  const { duration, fps } = base.media;
  const edl = normalizeEdl(edlInput, duration, fps);
  if (!edl.removed.length) throw Object.assign(new Error("Aucune plage supprimée : un simple point de scission ne modifie pas le MP4."), { status: 400 });
  const kept = keptSegments(edl.removed, duration);
  if (!kept.length) throw Object.assign(new Error("La coupe supprimerait tout le film."), { status: 400 });

  const srcAbs = path.join(project.path, base.file);
  const outDir = path.join(project.path, MONTAGE_DIR);
  await fs.mkdir(outDir, { recursive: true });
  const stem = slug(path.basename(base.file, path.extname(base.file)));
  let n = 1;
  while (await fs.access(path.join(outDir, `${stem}__montage-${String(n).padStart(2, "0")}.mp4`)).then(() => true, () => false)) n++;
  const outRel = path.join(MONTAGE_DIR, `${stem}__montage-${String(n).padStart(2, "0")}.mp4`).split(path.sep).join("/");
  const outAbs = path.join(project.path, outRel);
  const tmpAbs = outAbs.replace(/\.mp4$/, ".partial.mp4");

  // Filtre : trim à l'image près pour la vidéo, atrim pour l'audio, puis concat.
  const hasAudio = base.media.hasAudio;
  const parts = [];
  const labels = [];
  kept.forEach((seg, i) => {
    const f0 = Math.round(seg.start * fps), f1 = Math.round(seg.end * fps);
    parts.push(`[0:v]trim=start_frame=${f0}:end_frame=${f1},setpts=PTS-STARTPTS[v${i}]`);
    labels.push(`[v${i}]`);
    if (hasAudio) {
      const len = (f1 - f0) / fps;
      const fades = [];
      if (i > 0) fades.push(`afade=t=in:st=0:d=${AUDIO_FADE}`);
      if (i < kept.length - 1) fades.push(`afade=t=out:st=${(len - AUDIO_FADE).toFixed(6)}:d=${AUDIO_FADE}`);
      parts.push(`[0:a]atrim=start=${(f0 / fps).toFixed(6)}:end=${(f1 / fps).toFixed(6)},asetpts=PTS-STARTPTS${fades.length ? "," + fades.join(",") : ""}[a${i}]`);
      labels.push(`[a${i}]`);
    }
  });
  parts.push(`${labels.join("")}concat=n=${kept.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? "[a]" : ""}`);
  const expectedDuration = kept.reduce((s, k) => s + (Math.round(k.end * fps) - Math.round(k.start * fps)) / fps, 0);

  const args = ["-v", "error", "-stats", "-y", "-i", srcAbs, "-filter_complex", parts.join(";"), "-map", "[v]"];
  if (hasAudio) args.push("-map", "[a]", "-c:a", "aac", "-b:a", "192k");
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
    "-r", base.media.fpsRational || String(fps), "-movflags", "+faststart", tmpAbs);

  onProgress({ phase: "encodage", progress: 0 });
  await run(FFMPEG, args, {
    timeout: 3600000,
    onStderr: (s) => {
      const m = /time=(\d+):(\d+):([\d.]+)/.exec(s);
      if (m) onProgress({ phase: "encodage", progress: Math.min(0.99, (m[1] * 3600 + m[2] * 60 + Number(m[3])) / expectedDuration) });
    },
  });
  await fs.rename(tmpAbs, outAbs);

  onProgress({ phase: "vérification", progress: 1 });
  const media = await probe(outAbs);
  const report = await verifyMontage({ project, base, srcAbs, outAbs, outRel, edl, kept, media, expectedDuration });

  const st = await fs.stat(outAbs);
  const hash = await fingerprint(outAbs);
  const version = {
    id: `${slug(path.basename(outRel, ".mp4"))}-${hash.slice(0, 6)}`,
    kind: "cut",
    file: outRel,
    fingerprint: { size: st.size, mtimeMs: Math.floor(st.mtimeMs), hash },
    fileDate: new Date(st.mtimeMs).toISOString(),
    registeredAt: new Date().toISOString(),
    media,
    derivedFrom: base.id,
    edl,
    report,
    timeline: null,
    missing: false,
  };
  if (base.timeline && !base.timeline.error) version.timeline = deriveCutTimeline(base, version);
  // Fiche à côté du MP4 : le montage reste identifiable même si `.loktake/` est perdu.
  await writeJson(`${outAbs}${SIDECAR_EXT}`, {
    kind: "cut", tool: "LokTake", note: "MP4 monté : le code source HyperFrames n'a pas été modifié.",
    derivedFrom: base.id, baseFile: base.file, edl, report, createdAt: version.registeredAt,
  });
  await registerVersion(project, version);
  return version;
}

// ---------------------------------------------------------------- vérification

async function verifyMontage({ project, base, srcAbs, outAbs, outRel, edl, kept, media, expectedDuration }) {
  const fps = base.media.fps;
  const checks = [];
  const ok = (label, detail) => checks.push({ level: "ok", label, detail });
  const warn = (label, detail) => checks.push({ level: "warn", label, detail });
  const err = (label, detail) => checks.push({ level: "error", label, detail });

  // 1. Durées et nombre d'images
  const expFrames = kept.reduce((s, k) => s + Math.round(k.end * fps) - Math.round(k.start * fps), 0);
  if (media.frames === expFrames) ok("Nombre d'images", `${media.frames} images, comme attendu (${base.media.frames} − ${base.media.frames - expFrames}).`);
  else err("Nombre d'images", `${media.frames} images au lieu de ${expFrames}.`);
  if (Math.abs(media.duration - expectedDuration) <= 1 / fps + 1e-3) ok("Durée vidéo", `${media.duration.toFixed(3)} s (attendu ${expectedDuration.toFixed(3)} s).`);
  else err("Durée vidéo", `${media.duration.toFixed(3)} s au lieu de ${expectedDuration.toFixed(3)} s.`);
  if (Math.abs(media.fps - fps) > 0.01) err("Cadence", `${media.fps} i/s au lieu de ${fps}.`);

  // 2. Audio : présence et synchronisation globale
  if (base.media.hasAudio) {
    if (!media.hasAudio) err("Audio", "La piste audio a disparu.");
    else {
      const drift = media.audioDuration - media.duration;
      if (Math.abs(drift) <= 0.05) ok("Audio / vidéo", `Écart de fin ${(drift * 1000).toFixed(0)} ms (tolérance 50 ms, encodeur AAC).`);
      else warn("Audio / vidéo", `La piste audio dure ${media.audioDuration.toFixed(3)} s pour ${media.duration.toFixed(3)} s de vidéo.`);
    }
  }

  // 3. Raccords : images identiques à la source de part et d'autre + niveaux audio
  const joints = [];
  let acc = 0;
  for (let i = 0; i < kept.length - 1; i++) {
    acc += Math.round(kept[i].end * fps) - Math.round(kept[i].start * fps);
    joints.push({ index: i + 1, outFrame: acc, at: acc / fps, srcBefore: Math.round(kept[i].end * fps) - 1, srcAfter: Math.round(kept[i + 1].start * fps) });
  }
  const srcFrames = await grabFramesGray(srcAbs, joints.flatMap((j) => [j.srcBefore, j.srcAfter]));
  const outFrames = await grabFramesGray(outAbs, joints.flatMap((j) => [j.outFrame - 1, j.outFrame]));
  let pcmSrc = null, pcmOut = null;
  if (base.media.hasAudio && media.hasAudio) { pcmSrc = await decodeAudio(srcAbs); pcmOut = await decodeAudio(outAbs); }
  const imgDir = path.join(path.dirname(outAbs), `${path.basename(outAbs, ".mp4")}.raccords`);
  for (const j of joints) {
    j.diffBefore = round(meanAbsDiff(srcFrames.get(j.srcBefore), outFrames.get(j.outFrame - 1)));
    j.diffAfter = round(meanAbsDiff(srcFrames.get(j.srcAfter), outFrames.get(j.outFrame)));
    j.visualJump = round(meanAbsDiff(outFrames.get(j.outFrame - 1), outFrames.get(j.outFrame)));
    const exact = j.diffBefore !== null && j.diffBefore < 4 && j.diffAfter < 4;
    j.framesMatch = exact;
    const label = `Raccord ${j.index} à ${formatTime(j.at)}`;
    if (exact) ok(`${label} — images`, `f${j.srcBefore} puis f${j.srcAfter} de la source, sans image perdue ni dupliquée.`);
    else err(`${label} — images`, `Les images du raccord ne correspondent pas à la source (écart ${j.diffBefore} / ${j.diffAfter}).`);
    if (pcmOut) {
      const r = 8000, w = 0.05;
      const a = (j.srcBefore + 1) / fps, b = j.srcAfter / fps; // points de coupe dans la source
      j.audio = {
        outBefore: round(rmsDb(pcmOut, r, j.at - w, j.at)), outAfter: round(rmsDb(pcmOut, r, j.at, j.at + w)),
        // variations naturelles du son d'origine autour des deux points de coupe
        srcAtCutStart: [round(rmsDb(pcmSrc, r, a - w, a)), round(rmsDb(pcmSrc, r, a, a + w))],
        srcAtCutEnd: [round(rmsDb(pcmSrc, r, b - w, b)), round(rmsDb(pcmSrc, r, b, b + w))],
      };
      const jump = Math.abs(fin(j.audio.outAfter) - fin(j.audio.outBefore));
      const natural = Math.max(
        Math.abs(fin(j.audio.srcAtCutStart[1]) - fin(j.audio.srcAtCutStart[0])),
        Math.abs(fin(j.audio.srcAtCutEnd[1]) - fin(j.audio.srcAtCutEnd[0])));
      j.audio.jump = round(jump); j.audio.naturalJump = round(natural);
      const loud = Math.max(fin(j.audio.outBefore), fin(j.audio.outAfter)) > -45;
      if (!loud) ok(`${label} — audio`, "Silence ou son très faible au raccord.");
      else if (jump > 6 && jump > natural + 3) warn(`${label} — audio`, `Saut de niveau de ${jump.toFixed(1)} dB au raccord (le son d'origine varie au plus de ${natural.toFixed(1)} dB à ces endroits) : la reprise du son risque de s'entendre.`);
      else ok(`${label} — audio`, `Variation de ${jump.toFixed(1)} dB, comparable au son d'origine (${natural.toFixed(1)} dB) ; micro-fondu de 6 ms.`);
    }
    try {
      const rel = `${path.basename(imgDir)}/raccord-${String(j.index).padStart(2, "0")}.jpg`;
      await frameStrip(outAbs, [j.outFrame - 2, j.outFrame - 1, j.outFrame, j.outFrame + 1], path.join(path.dirname(outAbs), rel));
      j.image = path.join(path.dirname(outAbs), rel).slice(project.path.length + 1).split(path.sep).join("/");
    } catch { j.image = null; }
  }

  // 4. Effet sur les scènes, transitions, animations et audio du code (d'après la timeline)
  const impacts = analyseImpacts(base, edl);
  for (const im of impacts) (im.level === "warn" ? warn : ok)(im.label, im.detail);
  if (base.timeline?.confidence && base.timeline.confidence !== "probable") {
    warn("Fiabilité de l'analyse des scènes", base.timeline.reason);
  }

  return {
    createdAt: new Date().toISOString(),
    ok: !checks.some((c) => c.level === "error"),
    warnings: checks.filter((c) => c.level === "warn").length,
    source: base.file, output: outRel,
    removed: edl.removed, removedSeconds: removedTotal(edl.removed),
    durationBefore: base.media.duration, durationAfter: media.duration,
    checks, joints,
  };
}

/** Ce que chaque plage supprimée touche dans le film, d'après la timeline HyperFrames. */
export function analyseImpacts(base, edl) {
  const clips = base.timeline?.clips ?? [];
  const out = [];
  const near = 0.35; // s : une coupe aussi proche d'une frontière ampute souvent une transition
  for (const r of edl.removed) {
    const where = `${formatTime(r.start)} → ${formatTime(r.end)}`;
    for (const c of clips) {
      if (c.end <= r.start + EPS || c.start >= r.end - EPS) continue;
      const name = `« ${c.id} »${c.sourceFile ? ` (${c.sourceFile})` : ""}`;
      const isAudio = c.trackKind === "audio" || c.kind === "audio";
      const full = c.start >= r.start - EPS && c.end <= r.end + EPS;
      if (full) { out.push({ level: "warn", label: `Coupe ${where}`, detail: `${isAudio ? "Le son" : "La scène/l'élément"} ${name} disparaît entièrement.` }); continue; }
      if (isAudio) {
        out.push({ level: "warn", label: `Coupe ${where} — audio`, detail: `${name} est coupé en plein milieu : la musique/voix saute de ${formatTime(r.start - c.start)} à ${formatTime(r.end - c.start)} dans le fichier. Raccord non musical possible.` });
        continue;
      }
      if (c.depth > 0) continue;
      const cutsEntry = r.start <= c.start + EPS && r.end < c.end;
      const cutsExit = r.end >= c.end - EPS && r.start > c.start;
      if (cutsEntry) out.push({ level: "warn", label: `Coupe ${where} — entrée`, detail: `Le début de ${name} est supprimé : son animation d'entrée est amputée de ${(r.end - c.start).toFixed(2)} s.` });
      else if (cutsExit) out.push({ level: "warn", label: `Coupe ${where} — sortie`, detail: `La fin de ${name} est supprimée : son animation de sortie est amputée de ${(c.end - r.start).toFixed(2)} s.` });
      else out.push({ level: "warn", label: `Coupe ${where} — milieu`, detail: `Coupe à l'intérieur de ${name} : les animations GSAP en cours sautent d'un état à l'autre (saut visuel probable).` });
    }
    // Transitions : frontières de scènes proches des raccords ou chevauchements touchés
    const tops = clips.filter((c) => c.depth === 0 && c.trackKind !== "audio");
    for (const a of tops) for (const b of tops) {
      if (a === b || a.end <= b.start || b.start < a.start) continue;
      const overlap = a.end > b.start + EPS && a.end < b.end;
      if (overlap && r.start < a.end && r.end > b.start) {
        out.push({ level: "warn", label: `Coupe ${where} — transition`, detail: `La transition entre « ${a.id} » et « ${b.id} » (${formatTime(b.start)} → ${formatTime(a.end)}) est touchée.` });
      }
    }
    for (const c of tops) for (const edge of [c.start, c.end]) {
      if (edge <= EPS || edge >= (base.media.duration - EPS)) continue;
      for (const j of [r.start, r.end]) {
        const d = Math.abs(edge - j);
        if (d > EPS && d < near) out.push({ level: "warn", label: `Coupe ${where} — frontière`, detail: `Raccord à ${(d * 1000).toFixed(0)} ms d'une frontière de « ${c.id} » (${formatTime(edge)}) : une transition peut être tronquée.` });
      }
    }
  }
  if (!clips.length) out.push({ level: "warn", label: "Scènes", detail: "Timeline HyperFrames indisponible : impossible d'analyser l'effet sur les scènes et transitions." });
  else if (!out.length) out.push({ level: "ok", label: "Scènes", detail: "Aucune scène, transition ni piste audio touchée de façon partielle." });
  // dédoublonnage
  const seen = new Set();
  return out.filter((o) => { const k = o.label + o.detail; if (seen.has(k)) return false; seen.add(k); return true; });
}

const round = (x) => (x === null || x === undefined || !Number.isFinite(x) ? (x === -Infinity ? -120 : null) : Math.round(x * 100) / 100);
const fin = (x) => (Number.isFinite(x) ? x : -120);

export async function deleteMontageFiles(project, version) {
  const abs = path.join(project.path, version.file);
  await fs.rm(abs, { force: true });
  await fs.rm(`${abs}${SIDECAR_EXT}`, { force: true });
  await fs.rm(abs.replace(/\.mp4$/, ".raccords"), { recursive: true, force: true });
}
