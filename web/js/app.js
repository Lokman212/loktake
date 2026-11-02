// LokTake — application principale.
import { api } from "./api.js";
import { Player } from "./player.js";
import { Timeline } from "./timeline.js";
import { formatTime, formatTimecode, formatAnnotationTime, frameAt, STATUSES, statusLabel } from "/shared/format.js";
import { clipsAt, removedAt, keptSegments, removedTotal, baseToCut } from "/shared/timemap.js";
import { buildClaudeText } from "/shared/claude-export.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Statut = un mot + une icône + une couleur (jamais la couleur seule).
const STATUS_STYLE = {
  a_traiter: { c: "#3554C7", bg: "#E6ECFF", icon: "◆" },
  a_verifier: { c: "#8A5D00", bg: "#F6EBCB", icon: "!" },
  valide: { c: "#1F7A4D", bg: "#DCEFE3", icon: "✓" },
};
const statusText = (id) => `${STATUS_STYLE[id]?.icon ?? ""} ${statusLabel(id)}`.trim();

const S = {
  appState: null, project: null, versions: [], version: null, annotations: [], draft: null,
  peaks: null, filmstrip: null,
  time: 0, rate: 1, selection: null, selectedAnnId: null, selectedCut: null,
  tab: "retours", statusFilter: "open", allVersions: false, previewSkip: true, loop: false,
  targetsOff: new Set(), targetsOn: new Set(), job: null,
};

const player = new Player($("#screen"));
const timeline = new Timeline($("#timeline"), {
  onSeek: (t) => seek(t),
  onScrub: (t) => seek(t),
  onSelection: (sel) => { S.selection = sel; S.selectedCut = null; renderSelectionInfo(); renderComposer(); renderScrubSel(); },
  onAnnotation: (id) => focusAnnotation(id),
  onCut: (c) => { S.selectedCut = c; if (c.type === "removed") setSelection({ start: c.start, end: c.end }); else seek(c.t); setTab("montage"); updateTimeline(); renderMontage(); },
  onClipRange: (c) => { if (c) { setSelection({ start: c.start, end: c.end }); seek(c.start); } },
  onZoom: (z) => { $("#zoom").value = z; },
});

// ====================================================================== chargement

async function init() {
  bindUi();
  S.appState = await api.state();
  const sel = $("#projectSelect");
  if (!S.appState.projects.length) {
    sel.innerHTML = `<option>Aucun projet HyperFrames trouvé</option>`;
    $("#screenEmpty").textContent = `Aucun projet trouvé dans : ${S.appState.roots.join(", ")}`;
    return;
  }
  sel.innerHTML = S.appState.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  const h = parseHash();
  const pid = (h.pid && S.appState.projects.some((p) => p.id === h.pid)) ? h.pid : (lsGet("lt:lastProject") ?? S.appState.projects[0].id);
  await openProject(S.appState.projects.some((p) => p.id === pid) ? pid : S.appState.projects[0].id, h);
  setInterval(pollVersions, 5000);
}

async function openProject(pid, hint = {}) {
  $("#projectSelect").value = pid;
  lsSet("lt:lastProject", pid);
  const data = await api.project(pid);
  S.project = data.project;
  S.settings = data.settings ?? {};
  S.versions = data.versions;
  S.annotations = await api.annotations(pid);
  renderVersionSelect();
  const usable = S.versions.filter((v) => !v.missing && v.media);
  // Un rendu apparu depuis la dernière session (ex. produit par Claude) est ouvert en priorité.
  const known = S.settings.knownVersionIds ? new Set(S.settings.knownVersionIds) : null;
  const newest = known && usable.filter((v) => v.kind === "render" && !known.has(v.id)).at(-1);
  const vid = [hint.vid, newest?.id, S.settings.lastVersionId].find((id) => id && usable.some((v) => v.id === id))
    ?? usable.filter((v) => v.kind === "render").at(-1)?.id ?? usable.at(-1)?.id;
  if (vid) {
    await openVersion(vid, { time: hint.t ?? (vid === S.settings.lastVersionId ? S.settings.lastTime : 0) });
    if (newest && vid === newest.id && !hint.vid) toast(`Nouveau rendu ouvert : ${newest.file}`);
  } else {
    S.version = null;
    player.destroy();
    let empty = $("#screenEmpty");
    if (!empty) { empty = Object.assign(document.createElement("div"), { id: "screenEmpty", className: "screen-empty" }); $("#screen").appendChild(empty); }
    empty.textContent = "Aucun rendu MP4 dans ce projet. Lancez « npx hyperframes render », puis « Actualiser ».";
    renderVersionSelect(); renderAll();
  }
}

async function openVersion(vid, { time = 0 } = {}) {
  const v = S.versions.find((x) => x.id === vid);
  if (!v) return;
  S.version = v;
  S.selection = null; S.selectedAnnId = null; S.selectedCut = null; S.targetsOff.clear(); S.targetsOn.clear();
  S.peaks = null; S.filmstrip = null; S.draft = null;
  $("#versionSelect").value = vid;
  $("#screenEmpty")?.remove();
  writeHash();
  renderAll();
  try {
    await player.load(api.mediaUrl(S.project.id, v), { width: v.media.width, height: v.media.height });
  } catch (e) { toast(e.message, { error: true }); }
  $("#screen").style.aspectRatio = `${v.media.width} / ${v.media.height}`;
  player.playbackRate = S.rate;
  seek(Number(time) || 0);
  saveSettingsSoon();
  // Données secondaires (en parallèle) : forme d'onde, vignettes, brouillon de coupe.
  const pid = S.project.id;
  const [peaks, film, draft] = await Promise.all([
    api.peaks(pid, vid).catch(() => null),
    api.filmstripMeta(pid, vid).catch(() => null),
    v.kind === "render" ? api.draft(pid, vid).catch(() => null) : null,
  ]);
  if (S.version?.id !== vid) return;
  S.peaks = peaks;
  S.filmstrip = film ? { ...film, url: `${api.filmstripUrl(pid, vid)}?h=${v.fingerprint.hash}` } : null;
  S.draft = draft;
  timeline.setData({ peaks: S.peaks, filmstrip: S.filmstrip });
  renderAll();
}

async function pollVersions() {
  if (!S.project || document.hidden || S.job) return;
  try {
    const data = await api.project(S.project.id);
    const known = new Set(S.versions.map((v) => v.id));
    const fresh = data.versions.filter((v) => !known.has(v.id) && !v.missing);
    const changed = JSON.stringify(data.versions.map((v) => [v.id, v.missing])) !== JSON.stringify(S.versions.map((v) => [v.id, v.missing]));
    S.versions = data.versions;
    if (S.version) S.version = S.versions.find((v) => v.id === S.version.id) ?? S.version;
    if (changed) { renderVersionSelect(); renderBanners(); }
    for (const v of fresh) toast(`Nouvelle version détectée : ${v.file}`, { action: "Ouvrir", onAction: () => openVersion(v.id) });
  } catch { /* serveur arrêté : on réessaie plus tard */ }
}

// ====================================================================== lecture

function fps() { return S.version?.media?.fps ?? 30; }
function duration() { return S.version?.media?.duration ?? 0; }
function lastFrameTime() { return Math.max(0, (Math.round(duration() * fps()) - 1) / fps()); }

/** Place la tête de lecture au début de l'image contenant t. */
function seek(t) {
  if (!S.version) return;
  const f = fps();
  const snapped = Math.min(lastFrameTime(), Math.max(0, Math.floor(t * f + 1e-6) / f));
  S.time = snapped;
  player.seek(snapped + 0.5 / f); // milieu de l'image : affichage exact de l'image visée
  renderTime();
}
function stepFrames(n) { if (!player.paused) player.pause(); seek(S.time + n / fps()); }
function togglePlay() {
  if (!S.version) return;
  if (player.paused) {
    if (S.time >= lastFrameTime() - 1e-6) seek(S.loop && S.selection ? S.selection.start : 0);
    if (S.loop && S.selection && (S.time < S.selection.start || S.time >= S.selection.end)) seek(S.selection.start);
    player.play();
  } else player.pause();
}

let wasPlaying = false;
function tick() {
  requestAnimationFrame(tick);
  if (!S.version || !player.ready) return;
  const playing = !player.paused;
  if (playing) {
    let t = player.currentTime;
    // Un saut demandé pendant la lecture met quelques images à se refléter dans currentTime :
    // on n'en relance pas un autre tant qu'il n'a pas abouti.
    const js = S.jump;
    if (js && performance.now() - js.at < 600 && Math.abs(t - js.target) > 0.08) t = js.target;
    else {
      S.jump = null;
      // Aperçu du montage : on saute les plages supprimées (le MP4 n'est pas modifié).
      if (S.version.kind === "render" && S.previewSkip && S.draft?.removed?.length) {
        const r = removedAt(t, S.draft.removed);
        if (r) { jumpTo(r.end); t = r.end; }
      }
      if (S.loop && S.selection && t >= S.selection.end) { jumpTo(S.selection.start); t = S.selection.start; }
    }
    S.time = t;
    renderTime(true);
  } else if (wasPlaying) {
    seek(player.currentTime); // à la pause, on se cale sur l'image affichée
    saveSettingsSoon();
  }
  if (playing !== wasPlaying) {
    $("#playIcon").setAttribute("d", playing ? "M6 4h4v16H6zM14 4h4v16h-4z" : "M7 4l13 8-13 8z");
    wasPlaying = playing;
  }
}

function jumpTo(t) {
  const target = t + 0.5 / fps();
  S.jump = { target, at: performance.now() };
  player.seek(target, { keepPlaying: true });
}

function renderTime(follow = false) {
  const t = S.time, d = duration();
  $("#timecode").textContent = formatTimecode(t, fps());
  const pct = d ? (t / d) * 100 : 0;
  $("#scrubFill").style.width = `${pct}%`;
  $("#scrubKnob").style.left = `${pct}%`;
  timeline.setTime(t, follow);
  if (player.paused) renderComposerTarget();
}

// ====================================================================== rendu général

function renderAll() {
  renderHeaderBadge(); renderHint(); renderBanners(); updateTimeline(); renderSelectionInfo();
  renderComposer(); renderAnnotations(); renderMontage(); renderScrubSel(); renderTime();
}

function versionLabel(v) {
  const n = S.versions.filter((x) => x.kind === "render").indexOf(v) + 1;
  const name = v.file.split("/").pop();
  if (v.kind === "cut") return `Montage · ${name}`;
  return `Version ${String(n).padStart(2, "0")} · ${name}`;
}

function renderVersionSelect() {
  const renders = S.versions.filter((v) => v.kind === "render");
  const cuts = S.versions.filter((v) => v.kind === "cut");
  const opt = (v) => `<option value="${esc(v.id)}" ${v.missing || !v.media ? "disabled" : ""}>${esc(versionLabel(v))}${v.missing ? " (fichier remplacé/absent)" : ""} — ${new Date(v.fileDate).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</option>`;
  $("#versionSelect").innerHTML =
    (renders.length ? `<optgroup label="Rendus HyperFrames">${renders.slice().reverse().map(opt).join("")}</optgroup>` : "") +
    (cuts.length ? `<optgroup label="MP4 montés (coupes, code non modifié)">${cuts.slice().reverse().map(opt).join("")}</optgroup>` : "") ||
    `<option>Aucun rendu</option>`;
  if (S.version) $("#versionSelect").value = S.version.id;
}

function renderHeaderBadge() {
  const b = $("#versionBadge"), v = S.version;
  if (!v) { b.textContent = ""; b.className = "vbadge"; return; }
  b.className = `vbadge ${v.kind}`;
  b.textContent = v.kind === "cut" ? `MP4 monté / ${v.file.split("/").pop()}` : `Rendu original / ${v.file}`;
  b.title = v.file;
}

function renderHint() {
  const v = S.version;
  if (!v) { $("#hint").innerHTML = ""; return; }
  const m = v.media;
  $("#hint").innerHTML = `${formatTime(m.duration).replace(/\.\d+$/, "")} · ${m.frames} images · ${m.width}×${m.height} · ${m.fps} i/s${m.hasAudio ? " · son" : " · muet"} · lecteur ${player.kind === "hyperframes" ? "HyperFrames" : "natif"}
    — <b>Espace</b> lecture · <b>←→</b> image par image · <b>I/O</b> plage · <b>↑</b> ajouter un retour`;
}

function renderBanners() {
  const v = S.version, out = [];
  if (v) {
    if (v.missing) out.push(banner("danger", "Le fichier de cette version n'existe plus (remplacé ou supprimé). Ses annotations restent consultables."));
    if (v.kind === "cut") {
      const base = S.versions.find((b) => b.id === v.derivedFrom);
      out.push(banner("info", `<b>MP4 monté</b> à partir de <code>${esc(base?.file ?? v.derivedFrom)}</code> : seules des coupes vidéo ont été appliquées. <b>Le code source HyperFrames n'a pas été modifié.</b>`,
        base ? `<button class="btn small" data-act="open-base">Voir l'original</button>` : ""));
    }
    const cand = carryCandidate();
    if (cand) out.push(banner("info", `${cand.list.length} retour(s) ouvert(s) sur <code>${esc(cand.from.file)}</code> ne sont pas encore reportés sur cette version.`,
      `<button class="btn small primary" data-act="carry">Reporter ici</button>`));
    const repos = S.annotations.filter((a) => a.versionId === v.id && a.needsReposition).length;
    if (repos) out.push(banner("warn", `${repos} annotation(s) <b>à repositionner</b> : leur correspondance avec cette version n'est pas certaine.`,
      `<button class="btn small" data-act="show-repos">Afficher</button>`));
  }
  $("#banners").innerHTML = out.join("");
}
const banner = (kind, html, actions = "") => `<div class="banner ${kind}"><div>${html}</div><span class="spacer"></span>${actions}</div>`;

/** Rendu précédent dont des retours ouverts n'ont pas été reportés sur la version courante. */
function carryCandidate() {
  const v = S.version;
  if (!v || v.kind !== "render") return null;
  const renders = S.versions.filter((x) => x.kind === "render");
  const prev = renders.slice(0, renders.indexOf(v)).reverse();
  const carried = new Set(S.annotations.filter((a) => a.versionId === v.id && a.origin).map((a) => a.origin.annotationId));
  for (const from of prev) {
    const list = S.annotations.filter((a) => a.versionId === from.id && a.status !== "valide" && !carried.has(a.id));
    if (list.length) return { from, list };
    if (S.annotations.some((a) => a.versionId === from.id)) return null; // on ne remonte pas plus loin
  }
  return null;
}

function clipsForVersion() {
  return (S.version?.timeline?.clips ?? []).map((c) => ({ ...c, uid: `${c.id}@${c.start}` }));
}

function updateTimeline() {
  const v = S.version;
  if (!v) { timeline.setData({ duration: 0 }); return; }
  const isCut = v.kind === "cut";
  const draft = !isCut ? S.draft : null;
  const joints = isCut ? (v.report?.joints ?? []).map((j) => j.at) : [];
  const hot = new Set(currentTargets().filter(isTargetOn).map((c) => c.id));
  timeline.setData({
    duration: v.media.duration, fps: v.media.fps,
    clips: clipsForVersion(),
    annotations: S.annotations.filter((a) => a.versionId === v.id),
    removed: draft?.removed ?? [], splits: draft?.splits ?? [], joints,
    showCuts: isCut || S.tab === "montage" || Boolean(draft?.removed?.length || draft?.splits?.length),
    isCutVersion: isCut,
    selectedAnnId: S.selectedAnnId, selectedCut: S.selectedCut, hotClips: hot,
  });
  const tl = v.timeline;
  const w = $("#tlWarn");
  if (!tl || tl.error) { w.textContent = "⚠ scènes indisponibles"; w.title = tl?.error ?? "Timeline HyperFrames non lue"; }
  else if (tl.confidence !== "probable") { w.textContent = "⚠ scènes : correspondance incertaine"; w.title = tl.reason; }
  else { w.textContent = ""; w.title = ""; }
}

function setSelection(sel) {
  S.selection = sel;
  timeline.setSelection(sel);
  renderSelectionInfo(); renderComposer(); renderScrubSel();
}
function renderSelectionInfo() {
  const s = S.selection;
  const el = $("#selInfo");
  el.classList.toggle("idle", !s);
  el.textContent = s ? `/ Sélection active  ${formatTime(s.start)} – ${formatTime(s.end)} · ${(s.end - s.start).toFixed(2)} s · ${Math.round((s.end - s.start) * fps())} img` : "Glissez pour sélectionner une plage · double-clic sur une scène";
}
function renderScrubSel() {
  const el = $("#scrubSel"), s = S.selection, d = duration();
  if (!s || !d) { el.style.display = "none"; return; }
  el.style.display = "block";
  el.style.left = `${(s.start / d) * 100}%`; el.style.width = `${((s.end - s.start) / d) * 100}%`;
}

// ====================================================================== annotations : saisie

function currentTarget() {
  return S.selection ? { kind: "range", start: S.selection.start, end: S.selection.end } : { kind: "instant", time: S.time };
}
function isTargetOn(c) {
  // Par défaut, les pistes audio ne sont pas ciblées (clic sur la puce pour les inclure).
  return c.trackKind === "audio" ? S.targetsOn.has(c.id) : !S.targetsOff.has(c.id);
}
function currentTargets() {
  if (!S.version) return [];
  return clipsAt(clipsForVersion().filter((c) => c.depth === 0), currentTarget());
}
function renderComposerTarget() {
  const t = currentTarget();
  const el = $("#targetLabel");
  el.className = `target-label ${t.kind === "range" ? "range" : ""}`;
  el.textContent = t.kind === "range" ? `${formatTime(t.start)} – ${formatTime(t.end)}` : formatTimecode(t.time, fps());
  el.title = t.kind === "range" ? "Le retour portera sur la plage sélectionnée" : "Le retour portera sur l'image au curseur";
  $("#clearSel").style.visibility = S.selection ? "visible" : "hidden";
  const clips = currentTargets();
  const key = clips.map((c) => c.id).join("|");
  if (key !== renderComposerTarget.last) {
    renderComposerTarget.last = key;
    $("#targetChips").innerHTML = clips.map((c) =>
      `<button class="chip ${isTargetOn(c) ? "on" : "off"}" data-target="${esc(c.id)}" aria-pressed="${isTargetOn(c)}" title="${esc(c.sourceFile ?? "")} — cliquer pour inclure ou exclure">${esc(c.id)}</button>`).join("");
    timeline.content.querySelectorAll(".clip").forEach((el) => el.classList.toggle("hot", clips.some((c) => el.dataset.uid === c.uid && isTargetOn(c))));
  }
}
function renderComposer() {
  const ok = Boolean(S.version) && !S.version.missing;
  $("#commentInput").disabled = !ok; $("#addBtn").disabled = !ok;
  renderComposerTarget();
}

async function addAnnotation() {
  const text = $("#commentInput").value.trim();
  if (!text || !S.version) { $("#commentInput").focus(); return; }
  const target = currentTarget();
  const targets = currentTargets().filter(isTargetOn)
    .map((c) => ({ id: c.id, sourceFile: c.sourceFile, trackKind: c.trackKind, auto: true }));
  try {
    const a = await api.createAnnotation(S.project.id, { versionId: S.version.id, ...target, comment: text, status: "a_traiter", targets });
    S.annotations.push(a);
    S.selectedAnnId = a.id;
    $("#commentInput").value = "";
    renderAnnotations(); updateTimeline(); renderBanners();
    toast(`${a.id} ajouté · ${formatAnnotationTime(a, fps())}`);
  } catch (e) { toast(e.message, { error: true }); }
}

// ====================================================================== annotations : liste

function visibleAnnotations() {
  const f = S.statusFilter;
  return S.annotations
    .filter((a) => S.allVersions || a.versionId === S.version?.id)
    .filter((a) => f === "all" || (f === "open" ? a.status !== "valide" : f === "repos" ? a.needsReposition : a.status === f))
    .sort((a, b) => (a.versionId === S.version?.id ? 0 : 1) - (b.versionId === S.version?.id ? 0 : 1)
      || (a.kind === "range" ? a.start : a.time) - (b.kind === "range" ? b.start : b.time));
}

function renderAnnotations() {
  const list = visibleAnnotations();
  const mine = S.annotations.filter((a) => a.versionId === S.version?.id);
  $("#annCount").textContent = mine.filter((a) => a.status !== "valide").length || "";
  document.querySelectorAll("#statusFilter button").forEach((b) => b.classList.toggle("on", b.dataset.f === S.statusFilter));
  if (!list.length) {
    $("#annList").innerHTML = `<li class="ann-empty">${mine.length ? "Aucun retour pour ce filtre." : "Aucun retour sur cette version.<br>Regardez. Repérez. Précisez : placez le curseur ou sélectionnez une plage, puis écrivez votre retour."}</li>`;
    return;
  }
  const verFile = (id) => S.versions.find((v) => v.id === id);
  $("#annList").innerHTML = list.map((a) => {
    const other = a.versionId !== S.version?.id;
    const ov = verFile(a.versionId);
    const f = a.fps ?? fps();
    const st = STATUS_STYLE[a.status] ?? STATUS_STYLE.a_traiter;
    const sources = [...new Set((a.targets ?? []).map((t) => t.sourceFile).filter(Boolean))];
    return `<li class="ann ${a.id === S.selectedAnnId ? "sel" : ""} ${other ? "other" : ""}" data-id="${a.id}">
      <div class="ann-head">
        <span class="ann-id">${a.id}</span>
        <button class="ann-time" data-act="goto" title="Aller au passage">${esc(formatAnnotationTime(a, f))}</button>
        ${other ? `<span class="ann-ver" title="${esc(a.versionFile)}">${esc(ov ? versionLabel(ov) : a.versionFile)}</span>` : ""}
        <select class="status-sel" data-act="status" style="--c:${st.c};--cb:${st.bg}" aria-label="Statut">
          ${STATUSES.map((s) => `<option value="${s.id}" ${s.id === a.status ? "selected" : ""}>${statusText(s.id)}</option>`).join("")}
        </select>
      </div>
      <div class="ann-text" data-role="text">${esc(a.comment)}</div>
      ${a.targets?.length ? `<div class="ann-meta"><span>${a.targets.length > 1 ? "Scènes" : "Scène"} : ${a.targets.map((t) => esc(t.id)).join(", ")}</span>${sources.length ? `<span class="src" title="${esc(sources.join("\n"))}">Source : ${sources.map(esc).join(", ")}</span>` : ""}</div>` : ""}
      ${a.needsReposition ? `<div class="ann-warn"><b>! À repositionner</b> — ${esc(a.mapping?.reason ?? "correspondance incertaine")}
        ${other ? "" : `<div class="row"><button class="btn small" data-act="confirm">Position OK</button><button class="btn small" data-act="place">Placer au curseur${S.selection ? " (sélection)" : ""}</button></div>`}</div>` : ""}
      ${a.origin ? `<div class="ann-origin">Reporté de ${esc(a.origin.annotationId)} (${esc(a.origin.versionFile ?? "")}) · correspondance ${esc(a.mapping?.confidence ?? "?")}</div>` : ""}
      ${a.carriedTo?.length ? `<div class="ann-origin">Reporté vers ${a.carriedTo.map((c) => esc(c.annotationId)).join(", ")}</div>` : ""}
      <div class="ann-actions">
        ${other ? `<button class="link" data-act="goto">Ouvrir cette version</button>` : `<button class="link" data-act="edit">Modifier</button><button class="link" data-act="place">Placer au curseur${S.selection ? " (sélection)" : ""}</button>`}
        <button class="link" data-act="delete">Supprimer</button>
      </div>
    </li>`;
  }).join("");
}

async function focusAnnotation(id, { scroll = true } = {}) {
  const a = S.annotations.find((x) => x.id === id);
  if (!a) return;
  if (a.versionId !== S.version?.id) {
    const v = S.versions.find((x) => x.id === a.versionId);
    if (!v || v.missing) { toast("Le fichier de cette version n'existe plus.", { error: true }); return; }
    S.allVersions = true; $("#allVersions").checked = true;
    await openVersion(v.id);
  }
  S.selectedAnnId = id;
  if (!player.paused) player.pause();
  if (a.kind === "range") { setSelection({ start: a.start, end: a.end }); seek(a.start); }
  else { setSelection(null); seek(a.time); }
  setTab("retours");
  renderAnnotations(); updateTimeline();
  if (scroll) document.querySelector(`.ann[data-id="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function patchAnnotation(id, patch) {
  try {
    const a = await api.updateAnnotation(S.project.id, id, patch);
    S.annotations = S.annotations.map((x) => (x.id === id ? a : x));
    renderAnnotations(); updateTimeline(); renderBanners();
    return a;
  } catch (e) { toast(e.message, { error: true }); }
}

async function onAnnListClick(e) {
  const li = e.target.closest(".ann"); if (!li) return;
  const id = li.dataset.id;
  const a = S.annotations.find((x) => x.id === id);
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "status") return;
  if (act === "delete") {
    try {
      const removed = await api.deleteAnnotation(S.project.id, id);
      S.annotations = S.annotations.filter((x) => x.id !== id);
      renderAnnotations(); updateTimeline(); renderBanners();
      toast(`${id} supprimé`, { action: "Annuler", onAction: async () => {
        const back = await api.restoreAnnotation(S.project.id, removed);
        S.annotations.push(back); renderAnnotations(); updateTimeline();
      } });
    } catch (err) { toast(err.message, { error: true }); }
    return;
  }
  if (act === "edit") return editComment(li, a);
  if (act === "confirm") return patchAnnotation(id, { needsReposition: false });
  if (act === "place") {
    const t = currentTarget();
    const targets = currentTargets().filter(isTargetOn).map((c) => ({ id: c.id, sourceFile: c.sourceFile, trackKind: c.trackKind, auto: true }));
    const keepManual = a.targets?.some((x) => !x.auto);
    return patchAnnotation(id, { ...t, ...(keepManual ? {} : { targets }), needsReposition: false });
  }
  if (e.target.closest('[data-role="text"][contenteditable="true"]')) return;
  focusAnnotation(id, { scroll: false });
}

function editComment(li, a) {
  const el = li.querySelector('[data-role="text"]');
  el.contentEditable = "true"; el.focus();
  document.getSelection().selectAllChildren(el); document.getSelection().collapseToEnd();
  const finish = async (save) => {
    el.removeEventListener("keydown", onKey); el.removeEventListener("blur", onBlur);
    el.contentEditable = "false";
    const text = el.innerText.trim();
    if (save && text && text !== a.comment) await patchAnnotation(a.id, { comment: text });
    else renderAnnotations();
  };
  const onKey = (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); finish(true); }
    if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  el.addEventListener("keydown", onKey); el.addEventListener("blur", onBlur);
}

async function carryFromPrevious() {
  const cand = carryCandidate(); if (!cand) return;
  try {
    const created = await api.carry(S.project.id, { fromVersionId: cand.from.id, toVersionId: S.version.id, promote: true });
    S.annotations = await api.annotations(S.project.id);
    renderAll();
    toast(`${created.length} retour(s) reporté(s). Les « à traiter » passent « à vérifier » ; positions à confirmer.`);
  } catch (e) { toast(e.message, { error: true }); }
}

// ====================================================================== export

function claudeText() {
  const v = S.version;
  const anns = S.annotations.filter((a) => a.versionId === v.id)
    .sort((a, b) => (a.kind === "range" ? a.start : a.time) - (b.kind === "range" ? b.start : b.time));
  const montages = v.kind === "cut" ? [v] : S.versions.filter((m) => m.kind === "cut" && m.derivedFrom === v.id && !m.missing);
  return { text: buildClaudeText({ project: S.project, version: v, versions: S.versions, annotations: anns, draft: v.kind === "render" ? S.draft : null, montages }), count: anns.filter((a) => a.status === "a_traiter").length };
}

async function copyForClaude() {
  if (!S.version) return;
  const { text, count } = claudeText();
  const ok = await copyText(text);
  toast(ok ? `Copié pour Claude : ${count} demande(s) à traiter` : "Copie bloquée par le navigateur — texte affiché à la place", { action: "Voir le texte", onAction: () => showText(text) });
  if (!ok) showText(text);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch {}
    ta.remove(); return ok;
  }
}

function showText(text) {
  const d = $("#dialog");
  d.innerHTML = `<div class="dlg"><h3>Texte à coller dans Claude Code</h3><pre id="dlgText">${esc(text)}</pre>
    <div class="row"><button class="btn" data-close>Fermer</button><button class="btn primary" id="dlgCopy">Copier</button></div></div>`;
  d.querySelector("[data-close]").onclick = () => d.close();
  d.querySelector("#dlgCopy").onclick = async () => { toast((await copyText(text)) ? "Copié" : "Sélectionnez le texte et copiez-le manuellement"); };
  d.showModal();
}

function exportJson() {
  const data = {
    schema: "loktake/annotations@1",
    exportedAt: new Date().toISOString(),
    project: { id: S.project.id, name: S.project.name, path: S.project.path },
    currentVersionId: S.version?.id ?? null,
    versions: S.versions.map((v) => ({ id: v.id, kind: v.kind, file: v.file, missing: Boolean(v.missing), fileDate: v.fileDate,
      media: v.media && { duration: v.media.duration, fps: v.media.fps, frames: v.media.frames, width: v.media.width, height: v.media.height },
      derivedFrom: v.derivedFrom ?? null, edl: v.edl ?? null,
      timeline: v.timeline && { confidence: v.timeline.confidence, reason: v.timeline.reason } })),
    annotations: S.annotations,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `annotations-${S.project.id}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Export JSON : ${S.annotations.length} annotation(s), toutes versions`);
}

// ====================================================================== montage (coupes MP4)

function renderMontage() {
  const el = $("#panel-montage"), v = S.version;
  const cutCount = v?.kind === "render" ? (S.draft?.removed?.length ?? 0) + (S.draft?.splits?.length ?? 0) : 0;
  $("#cutCount").textContent = cutCount || "";
  if (!v) { el.innerHTML = ""; return; }
  if (v.kind === "cut") { el.innerHTML = montageReportView(v); return; }
  const d = S.draft ?? { removed: [], splits: [], impacts: [] };
  const dur = v.media.duration;
  const kept = keptSegments(d.removed, dur);
  const resDur = dur - removedTotal(d.removed);
  const derived = S.versions.filter((m) => m.kind === "cut" && m.derivedFrom === v.id && !m.missing);
  const segUnderCursor = segmentAtCursor();
  const canDelete = Boolean(S.selection || segUnderCursor);
  el.innerHTML = `<div class="montage">
    <div class="notice">Les coupes produisent un <b>nouveau fichier MP4</b> dans <code>renders/loktake-montages/</code>.
      Le rendu d'origine et le <b>code source HyperFrames ne sont pas modifiés</b>. Pour rendre une coupe définitive, transmettez-la à Claude (« Copier pour Claude »).</div>
    <div class="mrow">
      <button class="btn" data-m="split" title="S">Scinder au curseur</button>
      <button class="btn" data-m="delete" ${canDelete ? "" : "disabled"} title="Suppr">Supprimer ${S.selection ? "la sélection" : segUnderCursor ? "le segment" : "la sélection"} et raccorder</button>
    </div>
    <div class="mrow">
      <button class="btn small" data-m="undo" ${S.draft?.canUndo ? "" : "disabled"} title="Ctrl+Z">↶ Annuler</button>
      <button class="btn small" data-m="redo" ${S.draft?.canRedo ? "" : "disabled"} title="Ctrl+Maj+Z">↷ Rétablir</button>
      <button class="btn small" data-m="reset" ${d.removed.length || d.splits.length ? "" : "disabled"}>Tout rétablir</button>
    </div>
    <label class="check"><input type="checkbox" id="previewSkip" ${S.previewSkip ? "checked" : ""}/> Aperçu : sauter les passages supprimés pendant la lecture</label>
    ${d.removed.length || d.splits.length ? `<h4>Opérations (temps du rendu d'origine)</h4><ul class="mlist">
      ${d.removed.map((r) => `<li class="${S.selectedCut?.type === "removed" && Math.abs(S.selectedCut.start - r.start) < 1e-6 ? "sel" : ""}"><span class="dot" style="background:var(--red)"></span>
        <span>Supprimé <span class="t">${formatTime(r.start)} → ${formatTime(r.end)}</span> <small>(${(r.end - r.start).toFixed(2)} s)</small></span><span class="spacer"></span>
        <button class="btn small" data-m="goto" data-t="${r.start}">Voir</button><button class="btn small" data-m="restore" data-s="${r.start}" data-e="${r.end}">Restaurer</button></li>`).join("")}
      ${d.splits.map((s) => `<li class="${S.selectedCut?.type === "split" && Math.abs(S.selectedCut.t - s) < 1e-6 ? "sel" : ""}"><span class="dot" style="background:var(--blue)"></span>
        <span>Scission à <span class="t">${formatTime(s)}</span> <small>· rien n'est supprimé</small></span><span class="spacer"></span>
        <button class="btn small" data-m="goto" data-t="${s}">Voir</button><button class="btn small" data-m="unsplit" data-t="${s}">Retirer</button></li>`).join("")}
    </ul>` : `<p class="ann-empty" style="padding:8px">Aucune coupe. Sélectionnez une plage (glisser sur la timeline, ou <b>I</b>/<b>O</b>), ou scindez au curseur puis supprimez un segment.</p>`}
    <div class="msum"><span>Durée d'origine</span><b>${dur.toFixed(2)} s</b><span>Après coupe</span><b>${resDur.toFixed(2)} s</b><span>Segments conservés</span><b>${kept.length}</b></div>
    ${d.impacts?.length ? `<h4>Effets prévus (d'après la timeline HyperFrames)</h4>${checksList(d.impacts)}` : ""}
    <button class="btn primary" data-m="render" ${d.removed.length && !S.job ? "" : "disabled"}>Générer le MP4 monté</button>
    ${S.job ? `<div><div class="progress"><div style="width:${Math.round((S.job.progress ?? 0) * 100)}%"></div></div><small>${esc(S.job.phase ?? "")}…</small></div>` : ""}
    ${derived.length ? `<h4>MP4 montés depuis ce rendu</h4><ul class="mlist">${derived.map((m) => `<li><span class="dot" style="background:${m.report?.ok ? "var(--green)" : "var(--amber)"}"></span>
      <span>${esc(m.file.split("/").pop())} <small>${m.media.duration.toFixed(2)} s</small></span><span class="spacer"></span><button class="btn small" data-m="open" data-v="${esc(m.id)}">Ouvrir</button></li>`).join("")}</ul>` : ""}
  </div>`;
}

function montageReportView(v) {
  const base = S.versions.find((b) => b.id === v.derivedFrom);
  const r = v.report;
  return `<div class="montage">
    <div class="notice cut"><b>MP4 monté</b> (coupe vidéo) dérivé de <code>${esc(base?.file ?? v.derivedFrom)}</code>.<br>Le code source HyperFrames <b>n'a pas été modifié</b> : un nouveau rendu HyperFrames ne contiendra pas ces coupes tant qu'elles ne sont pas reportées dans le code.</div>
    <div class="msum"><span>Fichier</span><b style="font-size:12px">${esc(v.file)}</b><span>Durée</span><b>${(r?.durationBefore ?? base?.media?.duration ?? 0).toFixed(2)} s → ${v.media.duration.toFixed(2)} s</b><span>Supprimé</span><b>${(v.edl?.removed ?? []).map((x) => `${formatTime(x.start)}→${formatTime(x.end)}`).join(", ")}</b></div>
    <div class="mrow">
      ${base && !base.missing ? `<button class="btn small" data-m="open" data-v="${esc(base.id)}">Ouvrir l'original</button><button class="btn small" data-m="resume">Reprendre ce montage</button>` : ""}
      <button class="btn small danger" data-m="delete-version">Supprimer ce MP4 monté</button>
    </div>
    ${r ? `<h4>Vérification ${r.ok ? "✓" : "✗"} ${r.warnings ? `· ${r.warnings} point(s) d'attention` : ""}</h4>${checksList(r.checks)}
      ${(r.joints ?? []).map((j) => `<div><h4>Raccord ${j.index} · ${formatTime(j.at)} (source f${j.srcBefore} | f${j.srcAfter})</h4>
        ${j.image ? `<img class="joint-img" alt="Images autour du raccord ${j.index}" src="${api.montageFileUrl(S.project.id, j.image)}" />` : ""}
        <button class="btn small" data-m="goto" data-t="${Math.max(0, j.at - 1)}">Voir le raccord</button></div>`).join("")}` : `<p>Pas de rapport de vérification.</p>`}
  </div>`;
}

const checksList = (checks) => `<ul class="checks">${checks.map((c) => `<li class="${c.level}"><span class="i">${c.level === "ok" ? "✓" : c.level === "warn" ? "!" : "✗"}</span><span>${esc(c.label)}<small>${esc(c.detail)}</small></span></li>`).join("")}</ul>`;

function segmentAtCursor() {
  const d = S.draft; if (!d?.splits?.length || !S.version) return null;
  const edges = [0, ...d.splits, S.version.media.duration];
  for (let i = 0; i < edges.length - 1; i++) if (S.time >= edges[i] - 1e-6 && S.time < edges[i + 1] - 1e-6) return { start: edges[i], end: edges[i + 1] };
  return null;
}

async function montageOp(op) {
  const v = S.version;
  if (!v || v.kind !== "render") { toast("Les coupes se préparent sur un rendu HyperFrames d'origine.", { error: true }); return; }
  try {
    S.draft = await api.draftOp(S.project.id, v.id, op);
    if (op.type === "delete") { setSelection(null); S.selectedCut = null; }
    if (op.type === "restore" || op.type === "unsplit") S.selectedCut = null;
    updateTimeline(); renderMontage();
  } catch (e) { toast(e.message, { error: true }); }
}

async function onMontageClick(e) {
  const b = e.target.closest("[data-m]"); if (!b || b.disabled) return;
  const m = b.dataset.m;
  if (m === "split") return montageOp({ type: "split", t: S.time });
  if (m === "delete") return deleteSelectionCut();
  if (m === "undo" || m === "redo" || m === "reset") return montageOp({ type: m });
  if (m === "restore") return montageOp({ type: "restore", start: Number(b.dataset.s), end: Number(b.dataset.e) });
  if (m === "unsplit") return montageOp({ type: "unsplit", t: Number(b.dataset.t) });
  if (m === "goto") { if (!player.paused) player.pause(); return seek(Math.max(0, Number(b.dataset.t) - 0)); }
  if (m === "open") return openVersion(b.dataset.v);
  if (m === "render") return startRender();
  if (m === "resume") {
    const v = S.version;
    await openVersion(v.derivedFrom);
    await montageOp({ type: "load", edl: v.edl });
    setTab("montage");
    toast("Montage rechargé dans le brouillon (réversible avec Annuler).");
    return;
  }
  if (m === "delete-version") {
    if (!confirm(`Supprimer le fichier ${S.version.file} ?\nLe rendu d'origine n'est pas touché ; ce montage pourra être régénéré depuis son brouillon.`)) return;
    const base = S.version.derivedFrom;
    try {
      await api.deleteVersion(S.project.id, S.version.id);
      const data = await api.project(S.project.id); S.versions = data.versions; renderVersionSelect();
      await openVersion(base);
      toast("MP4 monté supprimé. Ses annotations restent dans le fichier d'annotations.");
    } catch (err) { toast(err.message, { error: true }); }
  }
}

function deleteSelectionCut() {
  const r = S.selection ?? segmentAtCursor();
  if (!r) { toast("Sélectionnez d'abord une plage (glisser sur la timeline, ou I puis O)."); return; }
  if (r.end - r.start >= duration() - 1e-6) { toast("Impossible de supprimer tout le film.", { error: true }); return; }
  return montageOp({ type: "delete", start: r.start, end: r.end });
}

async function startRender() {
  const v = S.version;
  try {
    S.job = await api.renderMontage(S.project.id, v.id);
    renderMontage();
    while (S.job && S.job.state === "running") {
      await new Promise((r) => setTimeout(r, 500));
      S.job = await api.job(S.job.id);
      renderMontage();
    }
    const job = S.job; S.job = null;
    if (job.state === "error") { renderMontage(); toast(`Échec du montage : ${job.error}`, { error: true }); return; }
    const data = await api.project(S.project.id);
    S.versions = data.versions; S.annotations = await api.annotations(S.project.id);
    renderVersionSelect();
    await openVersion(job.version.id);
    setTab("montage");
    toast(`MP4 monté créé${job.version.report?.ok ? " et vérifié" : " — voir les erreurs"} · ${job.carried} annotation(s) reportée(s)`);
  } catch (e) { S.job = null; renderMontage(); toast(e.message, { error: true }); }
}

// ====================================================================== interface

function setTab(tab) {
  S.tab = tab;
  document.querySelectorAll(".tabs button").forEach((b) => { b.classList.toggle("on", b.dataset.tab === tab); b.setAttribute("aria-selected", String(b.dataset.tab === tab)); });
  $("#panel-retours").classList.toggle("hidden", tab !== "retours");
  $("#panel-montage").classList.toggle("hidden", tab !== "montage");
  updateTimeline();
}

function bindUi() {
  $("#projectSelect").onchange = (e) => openProject(e.target.value);
  $("#versionSelect").onchange = (e) => openVersion(e.target.value);
  $("#refreshBtn").onclick = async () => {
    const cur = S.version?.id;
    S.appState = await api.state();
    const data = await api.project(S.project.id);
    S.versions = data.versions; S.annotations = await api.annotations(S.project.id);
    renderVersionSelect();
    if (cur && S.versions.some((v) => v.id === cur)) { S.version = S.versions.find((v) => v.id === cur); renderAll(); }
    toast(`${S.versions.filter((v) => !v.missing).length} version(s) trouvée(s)`);
  };
  $("#playBtn").onclick = togglePlay;
  document.querySelectorAll("[data-step]").forEach((b) => b.onclick = () => {
    const s = b.dataset.step;
    if (s.endsWith("f")) stepFrames(parseInt(s, 10));
    else { if (!player.paused) player.pause(); seek(S.time + parseInt(s, 10)); }
  });
  $("#speeds").onclick = (e) => {
    const b = e.target.closest("[data-rate]"); if (!b) return;
    S.rate = Number(b.dataset.rate); player.playbackRate = S.rate;
    document.querySelectorAll("#speeds button").forEach((x) => x.classList.toggle("on", x === b));
  };
  $("#fullscreenBtn").onclick = toggleFullscreen;
  $("#loopBtn").onclick = () => { S.loop = !S.loop; $("#loopBtn").classList.toggle("on", S.loop); $("#loopBtn").setAttribute("aria-pressed", String(S.loop)); if (S.loop && !S.selection) toast("Boucle : sélectionnez une plage à lire en boucle."); };
  const scrub = $("#scrub");
  scrub.addEventListener("pointerdown", (e) => {
    const at = (ev) => { const r = scrub.getBoundingClientRect(); seek(((ev.clientX - r.left) / r.width) * duration()); };
    at(e); scrub.setPointerCapture(e.pointerId);
    const mv = (ev) => at(ev);
    scrub.addEventListener("pointermove", mv);
    scrub.addEventListener("pointerup", () => scrub.removeEventListener("pointermove", mv), { once: true });
  });
  $("#zoom").oninput = (e) => timeline.setZoom(Number(e.target.value));
  $("#zoomIn").onclick = () => timeline.setZoom(timeline.zoom + 12);
  $("#zoomOut").onclick = () => timeline.setZoom(timeline.zoom - 12);
  $("#zoomFit").onclick = () => { timeline.setZoom(0); timeline.scroller.scrollLeft = 0; };
  $("#clearSel").onclick = () => setSelection(null);
  $("#addBtn").onclick = addAnnotation;
  $("#commentInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); addAnnotation(); }
    if (e.key === "Escape") e.target.blur();
  });
  $("#targetChips").onclick = (e) => {
    const c = e.target.closest("[data-target]"); if (!c) return;
    const id = c.dataset.target;
    const clip = currentTargets().find((x) => x.id === id);
    const set = clip?.trackKind === "audio" ? S.targetsOn : S.targetsOff;
    set.has(id) ? set.delete(id) : set.add(id);
    renderComposerTarget.last = null; renderComposerTarget();
  };
  $("#statusFilter").onclick = (e) => { const b = e.target.closest("[data-f]"); if (b) { S.statusFilter = b.dataset.f; renderAnnotations(); } };
  $("#allVersions").onchange = (e) => { S.allVersions = e.target.checked; renderAnnotations(); };
  $("#annList").addEventListener("click", onAnnListClick);
  $("#annList").addEventListener("change", (e) => {
    if (e.target.dataset.act === "status") patchAnnotation(e.target.closest(".ann").dataset.id, { status: e.target.value });
  });
  $("#copyClaude").onclick = copyForClaude;
  $("#exportJson").onclick = exportJson;
  document.querySelector(".tabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) { setTab(b.dataset.tab); renderMontage(); } };
  $("#panel-montage").addEventListener("click", onMontageClick);
  $("#panel-montage").addEventListener("change", (e) => { if (e.target.id === "previewSkip") S.previewSkip = e.target.checked; });
  $("#banners").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "carry") carryFromPrevious();
    if (act === "show-repos") { S.statusFilter = "repos"; setTab("retours"); renderAnnotations(); }
    if (act === "open-base") openVersion(S.version.derivedFrom);
  });
  document.addEventListener("keydown", onKey);
  window.addEventListener("beforeunload", () => saveSettingsNow());
  player.addEventListener("pause", () => saveSettingsSoon());
  requestAnimationFrame(tick);
}

function onKey(e) {
  const tag = e.target.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || e.target.isContentEditable) return;
  if ($("#dialog").open) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  if (k === " " || k === "k" || k === "K") { e.preventDefault(); togglePlay(); }
  else if (k === "ArrowLeft") { e.preventDefault(); e.shiftKey ? (player.pause(), seek(S.time - 1)) : stepFrames(-1); }
  else if (k === "ArrowRight") { e.preventDefault(); e.shiftKey ? (player.pause(), seek(S.time + 1)) : stepFrames(1); }
  else if (k === "Home") { e.preventDefault(); seek(0); }
  else if (k === "End") { e.preventDefault(); seek(lastFrameTime()); }
  else if (k === "i" || k === "I") setSelection({ start: S.time, end: Math.max(S.time + 1 / fps(), S.selection && S.selection.end > S.time ? S.selection.end : S.time + 1 / fps()) });
  else if (k === "o" || k === "O") { const s = S.selection?.start ?? 0; const end = S.time + 1 / fps(); if (end > s) setSelection({ start: s, end }); }
  else if (k === "Escape") { setSelection(null); S.selectedCut = null; updateTimeline(); }
  else if (k === "ArrowUp" || k === "Enter" || k === "m" || k === "M") { e.preventDefault(); setTab("retours"); if (!player.paused) player.pause(); $("#commentInput").focus(); }
  else if (k === "f" || k === "F") toggleFullscreen();
  else if (k === "l" || k === "L") $("#loopBtn").click();
  else if (S.tab === "montage" && (k === "s" || k === "S") && !mod) montageOp({ type: "split", t: S.time });
  else if (S.tab === "montage" && (k === "Delete" || k === "Backspace")) { e.preventDefault(); deleteSelectionCut(); }
  else if (S.tab === "montage" && mod && (k === "z" || k === "Z")) { e.preventDefault(); montageOp({ type: e.shiftKey ? "redo" : "undo" }); }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("#stage").requestFullscreen?.().catch(() => toast("Plein écran refusé par le navigateur."));
}

// ====================================================================== divers

let settingsTimer = null;
function saveSettingsSoon() { clearTimeout(settingsTimer); settingsTimer = setTimeout(saveSettingsNow, 800); }
function saveSettingsNow() {
  if (!S.project || !S.version) return;
  writeHash();
  const body = JSON.stringify({ lastVersionId: S.version.id, lastTime: S.time, knownVersionIds: S.versions.map((v) => v.id) });
  navigator.sendBeacon?.(`/api/projects/${encodeURIComponent(S.project.id)}/settings`, new Blob([body], { type: "application/json" }))
    || api.saveSettings(S.project.id, JSON.parse(body)).catch(() => {});
}

function parseHash() {
  const m = /^#\/p\/([^/]+)(?:\/v\/([^/?]+))?(?:\?t=([\d.]+))?/.exec(location.hash);
  return m ? { pid: decodeURIComponent(m[1]), vid: m[2] && decodeURIComponent(m[2]), t: m[3] && Number(m[3]) } : {};
}
function writeHash() {
  if (!S.project || !S.version) return;
  history.replaceState(null, "", `#/p/${encodeURIComponent(S.project.id)}/v/${encodeURIComponent(S.version.id)}?t=${S.time.toFixed(3)}`);
}

function toast(msg, { error = false, action, onAction } = {}) {
  const t = document.createElement("div");
  t.className = `toast ${error ? "error" : ""}`;
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ""}`;
  if (action) t.querySelector("button").onclick = () => { t.remove(); onAction(); };
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), action ? 7000 : 3500);
}
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

window.__loktake = { S, player, timeline, seek }; // utile au débogage et aux tests
init().catch((e) => { console.error(e); toast(e.message, { error: true }); });
