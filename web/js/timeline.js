// Timeline : règle temporelle, curseur, zoom, vignettes, scènes HyperFrames, forme d'onde,
// marqueurs d'annotations, sélection de plage et coupes.
import { formatTime } from "/shared/format.js";

const STATUS_COLOR = { a_traiter: "#6F8EF5", a_verifier: "#E0B341", valide: "#4FA97A" };
// Pastille de légende de chaque piste (couleurs de la charte LokTake).
const SWATCH = { film: "var(--encre)", visual: "var(--tk-visuel)", captions: "var(--tk-texte)", audio: "var(--tk-audio)", wave: "var(--tk-audio)", ann: "var(--tk-retour)", cut: "var(--tk-coupe)" };
const H = { ruler: 24, film: 40, clip: 22, wave: 36, ann: 22, cut: 26 };

export class Timeline {
  constructor(root, cb) {
    this.root = root;
    this.cb = cb; // { onSeek(t), onScrub(t), onSelection(sel|null), onAnnotation(id), onCut(sel), onClipRange(clip) }
    this.d = { duration: 0, fps: 30, clips: [], annotations: [], removed: [], splits: [], joints: [] };
    this.zoom = 0; // 0..100
    this.time = 0;
    this.selection = null;
    this.filmImg = null;
    this.root.innerHTML = `<div class="tl-labels"></div><div class="tl-scroll"><div class="tl-content"></div></div>`;
    this.labels = root.querySelector(".tl-labels");
    this.scroller = root.querySelector(".tl-scroll");
    this.content = root.querySelector(".tl-content");
    this.scroller.addEventListener("scroll", () => this.drawCanvases());
    new ResizeObserver(() => this.render()).observe(this.scroller);
    this.content.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.content.addEventListener("dblclick", (e) => {
      const c = e.target.closest(".clip");
      if (c) this.cb.onClipRange?.(this.d.clips.find((x) => x.uid === c.dataset.uid));
    });
    this.content.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const t = this.xToTime(e.clientX);
      const before = e.clientX - this.scroller.getBoundingClientRect().left;
      this.setZoom(this.zoom - Math.sign(e.deltaY) * 8, t, before);
    }, { passive: false });
  }

  // ------------------------------------------------------------ données
  setData(d) {
    Object.assign(this.d, d);
    if (d.filmstrip !== undefined) {
      this.filmImg = null;
      if (d.filmstrip?.url) {
        const img = new Image();
        img.onload = () => { this.filmImg = img; this.drawCanvases(); };
        img.src = d.filmstrip.url;
      }
    }
    this.render();
  }

  get pps() {
    const w = Math.max(200, this.scroller.clientWidth - 2);
    return (w / Math.max(0.1, this.d.duration)) * Math.pow(2, (this.zoom / 100) * 7);
  }
  timeToX(t) { return t * this.pps; }
  xToTime(clientX) {
    const r = this.content.getBoundingClientRect();
    return Math.max(0, Math.min(this.d.duration, (clientX - r.left) / this.pps));
  }
  snap(t) { return Math.round(t * this.d.fps) / this.d.fps; }

  setZoom(z, anchorT = this.time, anchorPx = null) {
    this.zoom = Math.max(0, Math.min(100, z));
    this.render();
    const px = anchorPx ?? this.scroller.clientWidth / 2;
    this.scroller.scrollLeft = this.timeToX(anchorT) - px;
    this.drawCanvases();
    this.cb.onZoom?.(this.zoom);
  }

  // ------------------------------------------------------------ rendu
  rows() {
    const rows = [{ key: "ruler", label: "", h: H.ruler }];
    if (this.d.filmstrip) rows.push({ key: "film", label: "Images", sw: "film", h: H.film });
    // Une ligne par piste HyperFrames (clips de premier niveau).
    const groups = new Map();
    for (const c of this.d.clips.filter((c) => c.depth === 0)) {
      const k = `${c.trackKind}|${c.trackIndex ?? "?"}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const sorted = [...groups.entries()].sort((a, b) => {
      const ia = a[1][0].trackKind === "audio" ? 1e6 : (a[1][0].trackIndex ?? 999);
      const ib = b[1][0].trackKind === "audio" ? 1e6 : (b[1][0].trackIndex ?? 999);
      return ia - ib;
    });
    for (const [k, clips] of sorted) {
      const name = clips.length === 1 ? clips[0].id : `piste ${clips[0].trackIndex ?? "?"}`;
      const kind = clips[0].trackKind === "audio" || clips[0].trackKind === "captions" ? clips[0].trackKind : "visual";
      rows.push({ key: `clips:${k}`, label: name, sub: clips[0].trackKind, sw: kind, h: H.clip, clips });
    }
    if (this.d.peaks?.count) rows.push({ key: "wave", label: "Audio (MP4)", sw: "wave", h: H.wave });
    const lanes = this.annotationLanes();
    rows.push({ key: "ann", label: "Retours", sw: "ann", h: Math.max(28, lanes.n * H.ann + 6), lanes });
    if (this.d.showCuts) rows.push({ key: "cut", label: this.d.isCutVersion ? "Raccords" : "Coupes", sw: "cut", h: H.cut });
    return rows;
  }

  annotationLanes() {
    const items = [...this.d.annotations].sort((a, b) => start(a) - start(b));
    const ends = [];
    const pos = new Map();
    const minW = 16 / this.pps; // largeur minimale d'un marqueur, en secondes
    for (const a of items) {
      const s = start(a), e = Math.max(a.kind === "range" ? a.end : a.time, s + minW);
      let lane = ends.findIndex((x) => x <= s);
      if (lane < 0) { lane = ends.length; ends.push(0); }
      ends[lane] = e;
      pos.set(a.id, lane);
    }
    return { n: Math.max(1, ends.length), pos };
  }

  render() {
    if (!this.d.duration) { this.labels.innerHTML = ""; this.content.innerHTML = ""; return; }
    const W = Math.ceil(this.timeToX(this.d.duration));
    const rows = this.rows();
    this.labels.innerHTML = rows.map((r) =>
      `<div class="tl-label" style="--h:${r.h}px" title="${esc(r.label + (r.sub ? " — piste " + r.sub : ""))}">${r.sw ? `<i class="sw" style="--sw:${SWATCH[r.sw]}"></i>` : ""}<span class="nm">${esc(r.label)}</span></div>`).join("");
    const html = [];
    for (const r of rows) {
      if (r.key === "ruler") html.push(`<div class="tl-row ruler" style="--h:${r.h}px"><canvas data-c="ruler"></canvas></div>`);
      else if (r.key === "film") html.push(`<div class="tl-row film" style="--h:${r.h}px"><canvas data-c="film" style="position:absolute;inset:0;width:100%;height:100%"></canvas></div>`);
      else if (r.key === "wave") html.push(`<div class="tl-row wave" style="--h:${r.h}px"><canvas data-c="wave"></canvas></div>`);
      else if (r.key.startsWith("clips:")) {
        html.push(`<div class="tl-row" style="--h:${r.h}px">` + r.clips.map((c) => {
          const cls = c.trackKind === "audio" ? "audio" : c.trackKind === "captions" ? "captions" : "";
          return `<div class="clip ${cls} ${c.cutInside ? "cut-inside" : ""} ${this.d.hotClips?.has(c.id) ? "hot" : ""}" data-uid="${esc(c.uid)}"
            style="left:${this.timeToX(c.start)}px;width:${Math.max(3, this.timeToX(c.end - c.start))}px"
            title="${esc(`${c.id}${c.sourceFile ? " — " + c.sourceFile : ""}\n${formatTime(c.start)} → ${formatTime(c.end)}${c.cutInside ? "\n(coupé par le montage)" : ""}\nDouble-clic : sélectionner toute la scène`)}">${esc(c.id)}</div>`;
        }).join("") + `</div>`);
      } else if (r.key === "ann") {
        html.push(`<div class="tl-row" style="--h:${r.h}px">` + this.d.annotations.map((a) => {
          const lane = r.lanes.pos.get(a.id) ?? 0;
          const top = 4 + lane * H.ann;
          const c = STATUS_COLOR[a.status] ?? "#888";
          const cls = `${a.id === this.d.selectedAnnId ? "sel" : ""} ${a.needsReposition ? "repos" : ""}`;
          const tip = esc(`${a.id} · ${a.comment.slice(0, 140)}`);
          if (a.kind === "range") {
            return `<div class="mrange ${cls}" data-ann="${a.id}" title="${tip}" style="--c:${c};top:${top + 2}px;left:${this.timeToX(a.start)}px;width:${Math.max(4, this.timeToX(a.end - a.start))}px"></div>`;
          }
          return `<div class="marker ${cls}" data-ann="${a.id}" title="${tip}" style="--c:${c};top:${top}px;height:${H.ann - 4}px;left:${this.timeToX(a.time)}px"></div>`;
        }).join("") + `</div>`);
      } else if (r.key === "cut") {
        const parts = [];
        for (const rm of this.d.removed) {
          const sel = this.d.selectedCut?.type === "removed" && Math.abs(this.d.selectedCut.start - rm.start) < 1e-6;
          parts.push(`<div class="removed ${sel ? "sel" : ""}" data-rm="${rm.start},${rm.end}" title="Supprimé : ${formatTime(rm.start)} → ${formatTime(rm.end)} (clic pour sélectionner)" style="left:${this.timeToX(rm.start)}px;width:${Math.max(3, this.timeToX(rm.end - rm.start))}px"></div>`);
        }
        for (const s of this.d.splits) parts.push(`<div class="split" data-split="${s}" title="Scission à ${formatTime(s)} — rien n'est supprimé" style="left:${this.timeToX(s)}px"></div>`);
        html.push(`<div class="tl-row" style="--h:${r.h}px">${parts.join("")}</div>`);
      }
    }
    // Calque : zones supprimées, raccords, sélection, curseur.
    const ov = [];
    for (const rm of this.d.removed) ov.push(`<div class="removed-shade" style="left:${this.timeToX(rm.start)}px;width:${this.timeToX(rm.end - rm.start)}px"></div>`);
    for (const j of this.d.joints) ov.push(`<div class="joint" style="left:${this.timeToX(j)}px" title="Raccord"></div>`);
    ov.push(`<div class="selection" style="display:none"><div class="h l" data-h="l"></div><div class="h r" data-h="r"></div></div>`);
    ov.push(`<div class="playhead"></div>`);
    html.push(`<div class="tl-overlay" style="position:absolute;inset:0;pointer-events:none">${ov.join("")}</div>`);
    this.content.style.width = `${W}px`;
    this.content.innerHTML = html.join("");
    this.selEl = this.content.querySelector(".selection");
    this.headEl = this.content.querySelector(".playhead");
    this.setTime(this.time, false);
    this.setSelection(this.selection);
    this.drawCanvases();
  }

  setTime(t, follow = true) {
    this.time = t;
    if (!this.headEl) return;
    const x = this.timeToX(t);
    this.headEl.style.left = `${x}px`;
    if (follow) {
      const vl = this.scroller.scrollLeft, vw = this.scroller.clientWidth;
      if (x < vl || x > vl + vw - 30) this.scroller.scrollLeft = x - vw * 0.15;
    }
  }

  setSelection(sel) {
    this.selection = sel;
    if (!this.selEl) return;
    if (!sel) { this.selEl.style.display = "none"; return; }
    this.selEl.style.display = "block";
    this.selEl.style.left = `${this.timeToX(sel.start)}px`;
    this.selEl.style.width = `${Math.max(2, this.timeToX(sel.end - sel.start))}px`;
  }

  // ------------------------------------------------------------ canevas (zone visible seulement)
  drawCanvases() {
    const vl = this.scroller.scrollLeft, vw = this.scroller.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    for (const cv of this.content.querySelectorAll("canvas")) {
      const h = cv.parentElement.clientHeight;
      cv.style.left = `${vl}px`; cv.style.width = `${vw}px`;
      cv.width = Math.round(vw * dpr); cv.height = Math.round(h * dpr);
      const g = cv.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, vw, h);
      if (cv.dataset.c === "ruler") this.drawRuler(g, vl, vw, h);
      else if (cv.dataset.c === "wave") this.drawWave(g, vl, vw, h);
      else if (cv.dataset.c === "film") this.drawFilm(g, vl, vw, h);
    }
  }

  drawRuler(g, vl, vw, h) {
    const pps = this.pps, fps = this.d.fps;
    const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find((s) => s * pps >= 90) ?? 600;
    const minor = major / (major < 1 && major * fps < 10 ? major * fps : 5);
    g.font = "11px 'DejaVu Sans Mono', Menlo, monospace";
    g.fillStyle = "#5E6C66"; g.strokeStyle = "#C9C3B3";
    const per = Math.round(major / minor);
    const k0 = Math.floor(vl / pps / minor), k1 = Math.ceil((vl + vw) / pps / minor);
    for (let k = k0; k <= k1; k++) {
      const t = k * minor;
      const x = t * pps - vl;
      const isMajor = k % per === 0;
      g.beginPath(); g.moveTo(x + 0.5, h); g.lineTo(x + 0.5, h - (isMajor ? 12 : 5)); g.stroke();
      if (isMajor) g.fillText(major < 1 ? `${formatTime(t).slice(0, 5)} f${Math.round(t * fps) % Math.round(fps)}` : formatTime(t).replace(/\.00$/, ""), x + 3, 11);
    }
  }

  drawWave(g, vl, vw, h) {
    const p = this.d.peaks; if (!p?.count) return;
    const pps = this.pps, mid = h / 2;
    const norm = 255 / Math.max(8, p.max ?? (p.max = Math.max(...p.peaks))); // affichage normalisé
    g.fillStyle = "#4E9DBA";
    for (let x = 0; x < vw; x++) {
      const ta = (vl + x) / pps, tb = (vl + x + 1) / pps;
      if (ta > this.d.duration) break;
      const ia = Math.floor((ta / p.duration) * p.count), ib = Math.max(ia + 1, Math.ceil((tb / p.duration) * p.count));
      let m = 0; for (let i = ia; i < ib && i < p.count; i++) m = Math.max(m, p.peaks[i]);
      const a = Math.min(1, (m * norm) / 255) * (h / 2 - 3);
      g.fillRect(x, mid - a, 1, Math.max(1, a * 2));
    }
    for (const rm of this.d.removed) { // son supprimé grisé
      g.fillStyle = "#EFA9C466";
      g.fillRect(rm.start * pps - vl, 0, (rm.end - rm.start) * pps, h);
    }
  }

  drawFilm(g, vl, vw, h) {
    const f = this.d.filmstrip, img = this.filmImg; if (!f || !img) return;
    const tileW = img.naturalWidth / f.count, tileH = img.naturalHeight;
    const drawW = (tileW / tileH) * h;
    const pps = this.pps;
    // On pose des vignettes de largeur naturelle, chacune montrant l'image la plus proche.
    const first = Math.floor(vl / drawW) * drawW;
    for (let x = first; x < vl + vw; x += drawW) {
      const tMid = (x + drawW / 2) / pps;
      if (tMid > this.d.duration) break;
      const i = Math.min(f.count - 1, Math.max(0, Math.floor(tMid / f.step)));
      g.drawImage(img, i * tileW, 0, tileW, tileH, x - vl, 0, drawW - 1, h);
    }
  }

  // ------------------------------------------------------------ interactions
  onPointerDown(e) {
    if (e.button !== 0) return;
    const ann = e.target.closest("[data-ann]");
    if (ann) { this.cb.onAnnotation?.(ann.dataset.ann); return; }
    const rm = e.target.closest("[data-rm]");
    if (rm) { const [s, en] = rm.dataset.rm.split(",").map(Number); this.cb.onCut?.({ type: "removed", start: s, end: en }); return; }
    const sp = e.target.closest("[data-split]");
    if (sp) { this.cb.onCut?.({ type: "split", t: Number(sp.dataset.split) }); return; }

    const handle = e.target.closest("[data-h]");
    const onRuler = Boolean(e.target.closest(".ruler"));
    const x0 = e.clientX;
    const t0 = this.snap(this.xToTime(e.clientX));
    let mode = handle ? `h-${handle.dataset.h}` : "pending";
    this.content.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const t = this.snap(this.xToTime(ev.clientX));
      if (mode === "pending" && Math.abs(ev.clientX - x0) > 4) mode = onRuler ? "scrub" : "select";
      if (mode === "scrub") this.cb.onScrub?.(t);
      else if (mode === "select") this.emitSel(Math.min(t0, t), Math.max(t0, t));
      else if (mode === "h-l" && this.selection) this.emitSel(Math.min(t, this.selection.end - 1 / this.d.fps), this.selection.end);
      else if (mode === "h-r" && this.selection) this.emitSel(this.selection.start, Math.max(t, this.selection.start + 1 / this.d.fps));
    };
    const up = (ev) => {
      this.content.removeEventListener("pointermove", move);
      this.content.removeEventListener("pointerup", up);
      if (mode === "pending") this.cb.onSeek?.(this.snap(this.xToTime(ev.clientX)));
      if (mode === "select" && this.selection && this.selection.end - this.selection.start < 1 / this.d.fps) this.cb.onSelection?.(null);
    };
    this.content.addEventListener("pointermove", move);
    this.content.addEventListener("pointerup", up);
  }

  emitSel(s, e) {
    const sel = e - s >= 1 / this.d.fps - 1e-6 ? { start: s, end: e } : null;
    this.setSelection(sel);
    this.cb.onSelection?.(sel);
  }
}

const start = (a) => (a.kind === "range" ? a.start : a.time);
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
