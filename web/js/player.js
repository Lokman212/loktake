// Adaptateur de lecture. Réutilise le composant officiel <hyperframes-player> en mode
// vidéo (type="video/mp4") ; si le composant n'est pas disponible ou ne devient pas prêt,
// on bascule sur un <video> natif avec la même interface.
export class Player extends EventTarget {
  constructor(host) {
    super();
    this.host = host;
    this.el = null;
    this.kind = null; // "hyperframes" | "native"
    this._rate = 1;
  }

  async load(url, { width, height } = {}) {
    this.destroy();
    this._loaded = false;
    let ok = false;
    if (customElements.get("hyperframes-player") || (await waitDefined("hyperframes-player", 3000))) {
      ok = await this._mount(() => {
        const el = document.createElement("hyperframes-player");
        el.setAttribute("type", "video/mp4");
        el.setAttribute("disable-click-to-play", "");
        el.setAttribute("assets-loading-ui", "none");
        if (width) el.setAttribute("width", width);
        if (height) el.setAttribute("height", height);
        el.setAttribute("src", url);
        return el;
      }, "hyperframes");
    }
    if (!ok) {
      ok = await this._mount(() => {
        const v = document.createElement("video");
        v.preload = "auto"; v.playsInline = true; v.src = url;
        return v;
      }, "native");
    }
    if (!ok) throw new Error("La vidéo ne peut pas être lue par le navigateur.");
    this._loaded = true;
    this.playbackRate = this._rate;
    return this;
  }

  _mount(make, kind) {
    return new Promise((resolve) => {
      const el = make();
      this.el = el; this.kind = kind;
      this.host.appendChild(el);
      const readyEvt = kind === "native" ? "loadeddata" : "ready";
      const done = (good) => {
        clearTimeout(timer);
        el.removeEventListener(readyEvt, onReady); el.removeEventListener("error", onErr);
        if (!good) { el.remove(); this.el = null; }
        resolve(good);
      };
      const onReady = () => done(true);
      const onErr = () => done(false);
      el.addEventListener(readyEvt, onReady);
      el.addEventListener("error", onErr);
      const timer = setTimeout(() => done(kind === "native" ? el.readyState >= 2 : el.ready), 10000);
      for (const e of ["play", "pause", "ended"]) el.addEventListener(e, () => this.dispatchEvent(new Event(e)));
    });
  }

  destroy() { this._loaded = false; if (this.el) { try { this.el.pause(); } catch {} this.el.remove(); this.el = null; } }

  get ready() { return Boolean(this.el) && this._loaded; }
  get paused() { return this.el ? this.el.paused : true; }
  get currentTime() { return this.el ? this.el.currentTime : 0; }
  get duration() { return this.el ? this.el.duration : 0; }
  play() { const p = this.el?.play(); if (p?.catch) p.catch(() => {}); }
  pause() { this.el?.pause(); }
  /** @param {{keepPlaying?: boolean}} o  le composant HyperFrames se met en pause sur seek() : on peut relancer. */
  seek(t, { keepPlaying = false } = {}) {
    if (!this.el) return;
    const playing = !this.el.paused;
    if (this.kind === "hyperframes") this.el.seek(t); else this.el.currentTime = t;
    if (keepPlaying && playing && this.el.paused) this.play();
  }
  get playbackRate() { return this._rate; }
  set playbackRate(r) { this._rate = r; if (this.el) this.el.playbackRate = r; }
}

function waitDefined(name, ms) {
  return Promise.race([customElements.whenDefined(name).then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);
}
