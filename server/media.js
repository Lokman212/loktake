// Outils média : ffprobe, forme d'onde, vignettes, extraction d'images, streaming HTTP Range.
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const FFMPEG = process.env.LOKTAKE_FFMPEG || "ffmpeg";
export const FFPROBE = process.env.LOKTAKE_FFPROBE || "ffprobe";

/** Lance un processus et renvoie stdout (Buffer). Rejette si code ≠ 0. */
export function run(cmd, args, { cwd, timeout = 120000, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd} : délai dépassé`)); }, timeout);
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => { err += d; onStderr?.(String(d)); if (err.length > 200000) err = err.slice(-100000); });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(Object.assign(new Error(`${cmd} a échoué (code ${code}) : ${err.trim().split("\n").slice(-4).join(" | ")}`), { stderr: err }));
    });
  });
}

function parseRate(r) {
  if (!r || r === "0/0") return null;
  const [n, d] = r.split("/").map(Number);
  return d ? n / d : n;
}

/** Métadonnées d'une vidéo. */
export async function probe(file) {
  const buf = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeout: 30000 });
  const j = JSON.parse(String(buf));
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  if (!v) throw new Error("Aucune piste vidéo");
  const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30;
  const duration = Number(v.duration || j.format.duration);
  const frames = Number(v.nb_frames) || Math.round(duration * fps);
  return {
    duration,
    fps: Math.round(fps * 1000) / 1000,
    fpsRational: v.r_frame_rate,
    frames,
    width: v.width,
    height: v.height,
    videoCodec: v.codec_name,
    hasAudio: Boolean(a),
    audioCodec: a?.codec_name ?? null,
    audioDuration: a ? Number(a.duration || j.format.duration) : null,
    sampleRate: a ? Number(a.sample_rate) : null,
    bitrate: Number(j.format.bit_rate) || null,
  };
}

/** Audio mono décodé (Int16, 8 kHz par défaut). */
export async function decodeAudio(file, { rate = 8000 } = {}) {
  const buf = await run(FFMPEG, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"], { timeout: 300000 });
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}

/** Crêtes de forme d'onde (0–255) réparties en `count` cases. */
export async function computePeaks(file, duration) {
  const rate = 8000;
  const pcm = await decodeAudio(file, { rate });
  const count = Math.max(200, Math.min(6000, Math.ceil(duration * 100)));
  const per = pcm.length / count;
  const peaks = new Array(count).fill(0);
  for (let i = 0; i < count; i++) {
    let m = 0;
    const a = Math.floor(i * per), b = Math.min(pcm.length, Math.floor((i + 1) * per));
    for (let k = a; k < b; k++) { const x = Math.abs(pcm[k]); if (x > m) m = x; }
    peaks[i] = Math.round((m / 32768) * 255);
  }
  return { count, duration, peaks };
}

/** Niveau RMS (dBFS) sur [t0, t1) d'un PCM décodé. */
export function rmsDb(pcm, rate, t0, t1) {
  const a = Math.max(0, Math.floor(t0 * rate)), b = Math.min(pcm.length, Math.floor(t1 * rate));
  if (b <= a) return -Infinity;
  let s = 0;
  for (let k = a; k < b; k++) s += (pcm[k] / 32768) ** 2;
  const rms = Math.sqrt(s / (b - a));
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/** Bande de vignettes (une seule image JPEG en ligne). */
export async function makeFilmstrip(file, duration, outFile) {
  const count = Math.max(8, Math.min(120, Math.ceil(duration)));
  const tileH = 72;
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  await run(FFMPEG, ["-v", "error", "-y", "-i", file, "-vf",
    `fps=${count}/${duration.toFixed(4)},scale=-2:${tileH},tile=${count}x1`, "-frames:v", "1", "-q:v", "5", outFile], { timeout: 300000 });
  return { count, step: duration / count, tileH };
}

/**
 * Extrait des images par index (niveaux de gris 64×36) pour comparaison numérique.
 * Retourne une Map index -> Uint8Array.
 */
export async function grabFramesGray(file, indices, { w = 64, h = 36 } = {}) {
  const uniq = [...new Set(indices.filter((i) => i >= 0))].sort((a, b) => a - b);
  if (!uniq.length) return new Map();
  const select = uniq.map((i) => `eq(n\\,${i})`).join("+");
  const buf = await run(FFMPEG, ["-v", "error", "-i", file, "-vf", `select='${select}',scale=${w}:${h},format=gray`,
    "-fps_mode", "passthrough", "-f", "rawvideo", "-"], { timeout: 300000 });
  const size = w * h;
  const map = new Map();
  uniq.forEach((idx, k) => { if ((k + 1) * size <= buf.length) map.set(idx, new Uint8Array(buf.subarray(k * size, (k + 1) * size))); });
  return map;
}

export function meanAbsDiff(a, b) {
  if (!a || !b) return null;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** Planche JPEG des images [indices] côte à côte (pour visualiser un raccord). */
export async function frameStrip(file, indices, outFile, height = 135) {
  const select = indices.map((i) => `eq(n\\,${Math.max(0, i)})`).join("+");
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  await run(FFMPEG, ["-v", "error", "-y", "-i", file, "-vf",
    `select='${select}',scale=-2:${height},tile=${indices.length}x1:padding=4:color=black`,
    "-fps_mode", "passthrough", "-frames:v", "1", "-q:v", "4", outFile], { timeout: 120000 });
}

/** Sert un fichier avec prise en charge des requêtes Range (indispensable au déplacement dans la vidéo). */
export async function serveFileRange(req, res, file, type) {
  const stat = await fsp.stat(file);
  const range = req.headers.range;
  const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "Last-Modified": stat.mtime.toUTCString() };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (m && !m[1] && m[2]) { start = Math.max(0, stat.size - Number(m[2])); end = stat.size - 1; }
    if (start >= stat.size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  }
}
