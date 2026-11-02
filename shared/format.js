// Formatage partagé (navigateur + Node). Aucune dépendance.

/** Index de l'image affichée à l'instant t (vidéo à cadence constante). */
export function frameAt(t, fps) {
  return Math.max(0, Math.floor(t * fps + 1e-6));
}

/** Instant où viser pour afficher l'image n de façon certaine (milieu de l'image). */
export function timeOfFrame(n, fps) {
  return (n + 0.5) / fps;
}

/** Début exact de l'image n (frontière). */
export function frameStart(n, fps) {
  return n / fps;
}

/** Arrondit un temps à la frontière d'image la plus proche. */
export function snapToFrame(t, fps) {
  return Math.round(t * fps) / fps;
}

/** 83.456 -> "01:23.45" ; avec heures si besoin. */
export function formatTime(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const cs = Math.floor(t * 100 + 1e-6);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  return (h ? `${h}:${pad(m)}` : pad(m)) + `:${pad(s)}.${pad(c)}`;
}

/** Libellé court d'un temps avec image : "00:02.10 · f063". */
export function formatTimecode(t, fps) {
  const f = frameAt(t, fps);
  return `${formatTime(t)} · f${String(f).padStart(3, "0")}`;
}

/** Libellé d'une annotation (instant ou plage). */
export function formatAnnotationTime(a, fps) {
  if (a.kind === "range") {
    return `${formatTime(a.start)} → ${formatTime(a.end)}` +
      (fps ? ` (f${frameAt(a.start, fps)}–f${Math.max(frameAt(a.start, fps), Math.ceil(a.end * fps - 1e-6) - 1)})` : "");
  }
  return formatTime(a.time) + (fps ? ` (f${frameAt(a.time, fps)})` : "");
}

export const STATUSES = [
  { id: "a_traiter", label: "À traiter" },
  { id: "a_verifier", label: "À vérifier" },
  { id: "valide", label: "Validé" },
];

export function statusLabel(id) {
  return STATUSES.find((s) => s.id === id)?.label ?? id;
}
