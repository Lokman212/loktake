// Client HTTP du serveur local.
async function req(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? `Erreur ${r.status}`);
  return data;
}
const P = (pid) => `/api/projects/${encodeURIComponent(pid)}`;
const V = (pid, vid) => `${P(pid)}/versions/${encodeURIComponent(vid)}`;

export const api = {
  state: () => req("GET", "/api/state"),
  project: (pid) => req("GET", P(pid)),
  saveSettings: (pid, s) => req("PUT", `${P(pid)}/settings`, s),
  refreshTimeline: (pid, vid) => req("POST", `${V(pid, vid)}/timeline`),
  deleteVersion: (pid, vid) => req("DELETE", V(pid, vid)),
  mediaUrl: (pid, v) => `${V(pid, v.id)}/media?h=${v.fingerprint.hash}`,
  peaks: (pid, vid) => req("GET", `${V(pid, vid)}/peaks`),
  filmstripMeta: (pid, vid) => req("GET", `${V(pid, vid)}/filmstrip?meta=1`),
  filmstripUrl: (pid, vid) => `${V(pid, vid)}/filmstrip`,
  montageFileUrl: (pid, rel) => `${P(pid)}/montage-file?path=${encodeURIComponent(rel)}`,
  annotations: (pid) => req("GET", `${P(pid)}/annotations`),
  createAnnotation: (pid, a) => req("POST", `${P(pid)}/annotations`, a),
  restoreAnnotation: (pid, a) => req("POST", `${P(pid)}/annotations/restore`, a),
  updateAnnotation: (pid, id, patch) => req("PATCH", `${P(pid)}/annotations/${encodeURIComponent(id)}`, patch),
  deleteAnnotation: (pid, id) => req("DELETE", `${P(pid)}/annotations/${encodeURIComponent(id)}`),
  carry: (pid, body) => req("POST", `${P(pid)}/carry`, body),
  draft: (pid, vid) => req("GET", `${P(pid)}/edits/${encodeURIComponent(vid)}`),
  draftOp: (pid, vid, op) => req("POST", `${P(pid)}/edits/${encodeURIComponent(vid)}`, op),
  renderMontage: (pid, vid) => req("POST", `${P(pid)}/edits/${encodeURIComponent(vid)}/render`),
  job: (id) => req("GET", `/api/jobs/${id}`),
};
