// A zoomable, scrollable waveform panel with playback controls.
// View state is kept in seconds (t0 = left edge, spp = seconds per pixel)
// so two panels can be synced even if their lengths differ.

import { averageSpectrum } from './dsp/fft.js';

const BLOCK = 256;             // samples per block in the peak cache
const MAX_PX_PER_SAMPLE = 40;   // deepest zoom
const AXIS_H = 20;

function niceStep(target) {
  const p = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 2, 5, 10]) if (m * p >= target) return m * p;
  return 10 * p;
}

export function fmtClock(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function fmtTick(t, step) {
  const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  if (t >= 60) {
    const m = Math.floor(t / 60);
    const s = (t - m * 60).toFixed(dec);
    return `${m}:${s.padStart(dec ? 3 + dec : 2, '0')}`;
  }
  return `${t.toFixed(dec)}s`;
}

function fmtSpan(sec) {
  if (sec >= 1) return `${sec.toFixed(2)} s`;
  if (sec >= 0.001) return `${(sec * 1000).toFixed(1)} ms`;
  return `${(sec * 1e6).toFixed(0)} µs`;
}

export class WaveformView {
  constructor(root, { title, accentVar, emptyText, palette }) {
    this.root = root;
    this.title = title;
    this.accentVar = accentVar;
    this.popup = null;       // separate window when popped out
    this.placeholder = null; // stand-in left in the main page
    this.palette = palette; // [center color, mid color, peak color]
    this.showSpectrum = true;
    this.yZoom = 1; // vertical (amplitude) zoom
    this.spectrum = null;
    this.specHover = null;
    this.emptyText = emptyText;
    this.buffer = null;
    this.channels = [];
    this.peaks = [];
    this.peak = 0;
    this.t0 = 0;
    this.spp = 0.01;
    this.cursor = 0;
    this.playhead = null;
    this.colors = null;

    root.innerHTML = `
      <div class="panel-head">
        <h2>${title}</h2>
        <span class="panel-meta"></span>
        <span class="busy" hidden>processing…</span>
        <button class="pop-btn" title="Open this display in its own window">⧉ Pop out</button>
      </div>
      <div class="wave-wrap" tabindex="0">
        <canvas class="wave"></canvas>
        <canvas class="overlay"></canvas>
      </div>
      <div class="panel-controls">
        <button class="btn play" disabled>▶ Play</button>
        <span class="time">0:00.000</span>
        <span class="spacer"></span>
        <span class="zoom-label"></span>
        <span class="amp-group" title="Vertical (amplitude) zoom: Ctrl + mouse wheel also works. Click the value to reset.">
          <button class="btn icon amp-out" disabled>↕−</button>
          <button class="amp-label" disabled>amp ×1</button>
          <button class="btn icon amp-in" disabled>↕+</button>
        </span>
        <button class="btn icon zoom-out" title="Zoom out" disabled>−</button>
        <button class="btn icon zoom-in" title="Zoom in" disabled>+</button>
        <button class="btn zoom-fit" title="Show the whole sound" disabled>Fit</button>
      </div>
      <div class="spec-head">
        <button class="spec-toggle" aria-pressed="true" title="Show or hide the frequency spectrum">▾ Spectrum (FFT)</button>
        <span class="spec-info"></span>
      </div>
      <div class="spec-wrap"><canvas class="spec"></canvas></div>`;

    this.wrap = root.querySelector('.wave-wrap');
    this.waveCanvas = root.querySelector('canvas.wave');
    this.overlayCanvas = root.querySelector('canvas.overlay');
    this.playBtn = root.querySelector('.play');
    this.timeEl = root.querySelector('.time');
    this.zoomLabel = root.querySelector('.zoom-label');
    this.metaEl = root.querySelector('.panel-meta');
    this.buttons = root.querySelectorAll('.panel-controls .btn, .panel-controls .amp-label');

    this.playBtn.addEventListener('click', () => this.onPlayToggle?.());
    root.querySelector('.zoom-in').addEventListener('click', () => this.zoomBy(0.5, this.width / 2));
    root.querySelector('.zoom-out').addEventListener('click', () => this.zoomBy(2, this.width / 2));
    root.querySelector('.zoom-fit').addEventListener('click', () => this.fit(true));
    this.ampLabel = root.querySelector('.amp-label');
    root.querySelector('.amp-in').addEventListener('click', () => this.setYZoom(this.yZoom * 2));
    root.querySelector('.amp-out').addEventListener('click', () => this.setYZoom(this.yZoom / 2));
    this.ampLabel.addEventListener('click', () => this.setYZoom(1));
    this.popBtn = root.querySelector('.pop-btn');
    this.popBtn.addEventListener('click', () => (this.popup ? this.dockBack() : this.popOut()));
    window.addEventListener('pagehide', () => this.popup?.close());

    this.specWrap = root.querySelector('.spec-wrap');
    this.specCanvas = root.querySelector('canvas.spec');
    this.specInfo = root.querySelector('.spec-info');
    const specToggle = root.querySelector('.spec-toggle');
    specToggle.addEventListener('click', () => {
      this.showSpectrum = !this.showSpectrum;
      specToggle.setAttribute('aria-pressed', String(this.showSpectrum));
      specToggle.textContent = `${this.showSpectrum ? '▾' : '▸'} Spectrum (FFT)`;
      this.specWrap.hidden = !this.showSpectrum;
      this.specInfo.hidden = !this.showSpectrum;
      this.scheduleSpectrum();
    });
    this.specCanvas.addEventListener('pointermove', (e) => {
      const r = this.specCanvas.getBoundingClientRect();
      this.specHover = e.clientX - r.left;
      this.drawSpectrum();
    });
    this.specCanvas.addEventListener('pointerleave', () => { this.specHover = null; this.drawSpectrum(); });

    new ResizeObserver(() => { this.clampView(); this.render(); }).observe(this.wrap);
    new ResizeObserver(() => this.drawSpectrum()).observe(this.specWrap);
    this.bindPointer();
  }

  // The window currently showing this panel (main page or its pop-out).
  get win() { return this.root.ownerDocument.defaultView || window; }

  refresh() {
    this.colors = null;
    this.clampView();
    this.render();
  }

  // ---------- pop out into a separate window ----------
  popOut() {
    const w = Math.max(900, Math.round(this.root.offsetWidth * 1.3));
    const h = Math.max(560, Math.round(this.root.offsetHeight * 1.2));
    const pop = window.open('', `soundstudio-${this.title.replace(/\W+/g, '-')}`, `popup,width=${w},height=${h}`);
    if (!pop) { this.onPopupBlocked?.(); return; }
    const doc = pop.document;
    doc.head.innerHTML = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title></title>';
    doc.title = `${this.title} · SoundStudio`;
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      const l = doc.createElement('link');
      l.rel = 'stylesheet';
      l.href = link.href;
      l.onload = () => this.refresh();
      doc.head.append(l);
    }
    doc.body.className = 'popout-body';
    doc.body.innerHTML = '';

    this.placeholder = document.createElement('div');
    this.placeholder.className = 'panel popped-placeholder';
    this.placeholder.innerHTML = `
      <div class="popped-msg"><span class="popped-icon">⧉</span>
        <b></b> is open in its own window.</div>
      <button class="btn">Bring it back</button>`;
    this.placeholder.querySelector('b').textContent = this.title;
    this.placeholder.querySelector('button').addEventListener('click', () => this.dockBack());
    this.root.before(this.placeholder);
    doc.body.append(this.root); // moves the live panel (with all its listeners)

    this.popup = pop;
    this.popBtn.textContent = '⧉ Bring back';
    this.popBtn.title = 'Put this display back into the main page';
    pop.addEventListener('resize', () => this.refresh());
    pop.addEventListener('pagehide', () => this.dockBack(true));
    pop.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target.tagName)) return;
      e.preventDefault();
      this.onPlayToggle?.();
    });
    new pop.ResizeObserver(() => this.refresh()).observe(this.wrap);
    setTimeout(() => this.refresh(), 50);
    pop.focus();
  }

  dockBack(windowClosing = false) {
    if (!this.placeholder) return;
    const pop = this.popup;
    this.popup = null;
    this.placeholder.replaceWith(this.root);
    this.placeholder = null;
    this.popBtn.textContent = '⧉ Pop out';
    this.popBtn.title = 'Open this display in its own window';
    if (!windowClosing && pop && !pop.closed) pop.close();
    requestAnimationFrame(() => this.refresh());
  }

  get width() { return this.wrap.clientWidth || 1; }
  get height() { return this.wrap.clientHeight || 1; }
  get duration() { return this.buffer ? this.buffer.duration : 0; }

  // ---------- data ----------
  setBuffer(buffer, keepView = false) {
    const hadBuffer = !!this.buffer;
    this.buffer = buffer;
    this.channels = buffer
      ? Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
      : [];
    this.buildPeaks();
    if (!keepView || !hadBuffer) {
      this.cursor = 0;
      this.spp = this.limits().maxSpp;
      this.t0 = 0;
    }
    this.clampView();
    if (this.cursor > this.duration) this.cursor = 0;
    this.buttons.forEach((b) => (b.disabled = !buffer));
    this.updateMeta();
    this.updateTime();
    this.render();
  }

  buildPeaks() {
    this.peak = 0;
    this.peaks = this.channels.map((d) => {
      const nb = Math.ceil(d.length / BLOCK);
      const mn = new Float32Array(nb);
      const mx = new Float32Array(nb);
      const sq = new Float64Array(nb); // sum of squares, for RMS
      for (let b = 0; b < nb; b++) {
        let lo = Infinity, hi = -Infinity, s2 = 0;
        const end = Math.min(d.length, (b + 1) * BLOCK);
        for (let s = b * BLOCK; s < end; s++) {
          const v = d[s];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
          s2 += v * v;
        }
        mn[b] = lo; mx[b] = hi; sq[b] = s2;
        this.peak = Math.max(this.peak, Math.abs(lo), Math.abs(hi));
      }
      return { mn, mx, sq };
    });
  }

  updateMeta() {
    if (!this.buffer) { this.metaEl.textContent = ''; return; }
    const b = this.buffer;
    const ch = b.numberOfChannels === 1 ? 'mono' : b.numberOfChannels === 2 ? 'stereo' : `${b.numberOfChannels} ch`;
    const peakDb = this.peak > 0 ? 20 * Math.log10(this.peak) : -Infinity;
    const clip = this.peak > 1;
    this.metaEl.innerHTML =
      `${b.duration.toFixed(2)} s · ${(b.sampleRate / 1000).toFixed(1)} kHz · ${ch} · ` +
      `<span class="${clip ? 'clip' : ''}" title="${clip ? 'Peaks above 0 dB will be clipped on export' : 'Loudest sample'}">` +
      `peak ${Number.isFinite(peakDb) ? peakDb.toFixed(1) : '−∞'} dB${clip ? ' CLIP' : ''}</span>`;
  }

  // ---------- view ----------
  limits() {
    const sr = this.buffer?.sampleRate || 48000;
    const minSpp = 1 / (sr * MAX_PX_PER_SAMPLE);
    const maxSpp = Math.max(this.duration / this.width, minSpp);
    return { minSpp, maxSpp };
  }

  clampView() {
    if (!this.buffer) return;
    const { minSpp, maxSpp } = this.limits();
    this.spp = Math.min(Math.max(this.spp, minSpp), maxSpp);
    const maxT0 = Math.max(0, this.duration - this.spp * this.width);
    this.t0 = Math.min(Math.max(this.t0, 0), maxT0);
  }

  fit(emit) {
    if (!this.buffer) return;
    this.spp = this.limits().maxSpp;
    this.t0 = 0;
    this.clampView();
    this.render();
    if (emit) this.emitView();
  }

  zoomBy(factor, anchorPx) {
    if (!this.buffer) return;
    const tAnchor = this.t0 + anchorPx * this.spp;
    this.spp *= factor;
    this.clampView();
    this.t0 = tAnchor - anchorPx * this.spp;
    this.clampView();
    this.render();
    this.emitView();
  }

  setView(t0, spp) {
    if (!this.buffer) return;
    this.t0 = t0;
    this.spp = spp;
    this.clampView();
    this.render();
  }

  emitView() { this.onViewChange?.(this.t0, this.spp); }

  setYZoom(z) {
    this.yZoom = Math.min(256, Math.max(1, z));
    const zz = this.yZoom;
    this.ampLabel.textContent = `amp ×${zz < 10 ? +zz.toFixed(1) : Math.round(zz)}`;
    this.renderWave();
  }

  // Keep the playhead visible while playing (page along).
  follow(t) {
    const vis = this.spp * this.width;
    if (t > this.t0 + vis || t < this.t0) {
      this.t0 = t - vis * 0.02;
      this.clampView();
      this.render();
      this.emitView();
    }
  }

  setBusy(b) {
    this.root.querySelector('.busy').hidden = !b;
  }

  // ---------- playback UI ----------
  setPlaying(playing) {
    this.playBtn.textContent = playing ? '■ Stop' : '▶ Play';
    this.playBtn.classList.toggle('active', playing);
    if (!playing) {
      this.playhead = null;
      this.renderOverlay();
      this.updateTime();
    }
  }

  setPlayhead(t) {
    this.playhead = t;
    this.renderOverlay();
    this.updateTime();
  }

  updateTime() {
    this.timeEl.textContent = fmtClock(this.playhead ?? this.cursor);
  }

  // ---------- interaction ----------
  bindPointer() {
    const el = this.wrap;
    let drag = null;

    el.addEventListener('wheel', (e) => {
      if (!this.buffer) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 30 : e.deltaMode === 2 ? 300 : 1;
      const x = e.clientX - el.getBoundingClientRect().left;
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (e.ctrlKey || e.metaKey) {
        this.setYZoom(this.yZoom * Math.exp(-e.deltaY * unit * 0.002));
      } else if (horizontal || e.shiftKey) {
        const d = (horizontal ? e.deltaX : e.deltaY) * unit;
        this.t0 += d * this.spp;
        this.clampView();
        this.render();
        this.emitView();
      } else {
        this.zoomBy(Math.exp(e.deltaY * unit * 0.002), x);
      }
    }, { passive: false });

    el.addEventListener('pointerdown', (e) => {
      this.onFocus?.();
      if (e.button !== 0 || !this.buffer) return;
      el.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, t0: this.t0, moved: false };
    });

    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) { drag.moved = true; el.classList.add('panning'); }
      if (drag.moved) {
        this.t0 = drag.t0 - dx * this.spp;
        this.clampView();
        this.render();
        this.emitView();
      }
    });

    const end = (e) => {
      if (drag && !drag.moved && this.buffer && e.type === 'pointerup') {
        const x = e.clientX - el.getBoundingClientRect().left;
        this.cursor = Math.min(Math.max(this.t0 + x * this.spp, 0), this.duration);
        this.renderOverlay();
        this.updateTime();
        this.onCursor?.(this.cursor);
      }
      drag = null;
      el.classList.remove('panning');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // ---------- drawing ----------
  getColors() {
    if (!this.colors) {
      const css = this.win.getComputedStyle(this.root);
      const v = (n) => css.getPropertyValue(n).trim();
      this.colors = {
        accent: v(this.accentVar), grid: v('--grid'), gridStrong: v('--grid-strong'),
        text: v('--text-dim'), axisBg: v('--axis-bg'), cursor: v('--cursor'), playhead: v('--playhead'),
      };
    }
    return this.colors;
  }

  prep(canvas) {
    const dpr = this.win.devicePixelRatio || 1;
    const w = this.width, h = this.height;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g, w, h };
  }

  render() {
    this.renderWave();
    this.renderOverlay();
    this.updateZoomLabel();
    this.scheduleSpectrum();
  }

  // ---------- spectrum (FFT of the visible time range) ----------
  scheduleSpectrum() {
    if (this.specPending) return;
    this.specPending = true;
    this.win.requestAnimationFrame(() => {
      this.specPending = false;
      this.computeSpectrum();
      this.drawSpectrum();
    });
  }

  computeSpectrum() {
    if (!this.buffer || !this.showSpectrum) { this.spectrum = null; this.specInfo.textContent = ''; return; }
    const sr = this.buffer.sampleRate;
    const t1 = Math.min(this.duration, this.t0 + this.spp * this.width);
    const { db, N } = averageSpectrum(this.channels, this.t0 * sr, t1 * sr);
    this.spectrum = { db, N, sr };
    const frames = N >= (t1 - this.t0) * sr ? 'one FFT' : `averaged ${N}-point FFTs`;
    this.specInfo.textContent = `of the ${fmtSpan(t1 - this.t0)} visible · ${frames} · ${(sr / N).toFixed(1)} Hz/bin`;
  }

  drawSpectrum() {
    if (!this.showSpectrum) return;
    const dpr = this.win.devicePixelRatio || 1;
    const w = this.specWrap.clientWidth || 1, h = this.specWrap.clientHeight || 1;
    const c = this.specCanvas;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const col = this.getColors();
    if (!this.spectrum) return;

    const { db, N, sr } = this.spectrum;
    const nyq = sr / 2, fMin = 20, DB_MIN = -100, DB_MAX = 0;
    const AX = 16; // bottom axis
    const ph = h - AX;
    const xOf = (f) => (Math.log(f / fMin) / Math.log(nyq / fMin)) * w;
    const fOf = (x) => fMin * Math.pow(nyq / fMin, x / w);
    const yOf = (d) => ((DB_MAX - Math.min(DB_MAX, Math.max(DB_MIN, d))) / (DB_MAX - DB_MIN)) * ph;
    const binHz = sr / N;

    // dB grid
    g.font = '10px ui-monospace, Consolas, monospace';
    g.textBaseline = 'middle';
    for (let d = -20; d > DB_MIN; d -= 20) {
      const y = Math.round(yOf(d)) + 0.5;
      g.fillStyle = col.grid; g.fillRect(0, y, w, 1);
      g.fillStyle = col.text; g.textAlign = 'right'; g.fillText(`${d}`, w - 3, y - 6);
    }
    // frequency grid
    g.textAlign = 'center';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      if (f >= nyq) break;
      const x = Math.round(xOf(f)) + 0.5;
      g.fillStyle = col.grid; g.fillRect(x, 0, 1, ph);
      g.fillStyle = col.text; g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, ph + AX / 2);
    }

    // value per pixel column: max over the bins that fall in it
    const vals = new Float64Array(w);
    for (let x = 0; x < w; x++) {
      const b0 = fOf(x) / binHz, b1 = fOf(x + 1) / binHz;
      let v;
      if (b1 - b0 < 1) {
        const i = Math.min(db.length - 2, Math.floor(b0)), fr = b0 - i;
        v = db[i] * (1 - fr) + db[i + 1] * fr;
      } else {
        v = -Infinity;
        for (let k = Math.floor(b0); k <= Math.min(db.length - 1, Math.ceil(b1)); k++) v = Math.max(v, db[k]);
      }
      vals[x] = v;
    }

    // rainbow fill: red (bass) → violet (treble), fading toward the bottom
    const rainbow = g.createLinearGradient(0, 0, w, 0);
    ['#ff3b3b', '#ff8a1f', '#ffe14f', '#4fe36b', '#2fd4ff', '#5a7bff', '#c45cff'].forEach((cc, i, a) =>
      rainbow.addColorStop(i / (a.length - 1), cc));
    g.beginPath();
    g.moveTo(0, ph);
    for (let x = 0; x < w; x++) g.lineTo(x, yOf(vals[x]));
    g.lineTo(w, ph);
    g.closePath();
    g.globalAlpha = 0.55;
    g.fillStyle = rainbow;
    g.fill();
    g.globalAlpha = 1;
    const fade = g.createLinearGradient(0, 0, 0, ph);
    fade.addColorStop(0, 'rgba(13,15,18,0)');
    fade.addColorStop(1, 'rgba(13,15,18,0.75)');
    g.fillStyle = fade;
    g.fill();
    // outline
    g.beginPath();
    for (let x = 0; x < w; x++) x ? g.lineTo(x, yOf(vals[x])) : g.moveTo(x, yOf(vals[x]));
    g.lineWidth = 1.5;
    g.strokeStyle = rainbow;
    g.stroke();

    // hover readout
    if (this.specHover != null && this.specHover >= 0 && this.specHover < w) {
      const x = this.specHover, f = fOf(x), v = vals[Math.floor(x)];
      g.fillStyle = col.cursor; g.fillRect(Math.round(x), 0, 1, ph);
      const label = `${f >= 1000 ? (f / 1000).toFixed(2) + ' kHz' : Math.round(f) + ' Hz'}  ${v.toFixed(1)} dB`;
      g.font = '11px ui-monospace, Consolas, monospace';
      const tw = g.measureText(label).width + 10;
      const lx = Math.min(w - tw - 2, x + 6);
      g.fillStyle = 'rgba(20,22,27,0.9)'; g.fillRect(lx, 4, tw, 18);
      g.fillStyle = '#e6e8eb'; g.textAlign = 'left'; g.fillText(label, lx + 5, 13);
    }
  }

  // Vertical gradient for a lane: cool near zero, hot at the peaks.
  laneGradient(g, mid, amp) {
    const [center, midC, peak] = this.palette;
    const grad = g.createLinearGradient(0, mid - amp, 0, mid + amp);
    grad.addColorStop(0, peak);
    grad.addColorStop(0.28, midC);
    grad.addColorStop(0.5, center);
    grad.addColorStop(0.72, midC);
    grad.addColorStop(1, peak);
    return grad;
  }

  updateZoomLabel() {
    if (!this.buffer) { this.zoomLabel.textContent = ''; return; }
    const zoom = this.limits().maxSpp / this.spp;
    const span = Math.min(this.duration, this.spp * this.width);
    this.zoomLabel.textContent = `×${zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)} · ${fmtSpan(span)} visible`;
  }

  renderWave() {
    const { g, w, h } = this.prep(this.waveCanvas);
    const col = this.getColors();

    if (!this.buffer) {
      g.fillStyle = col.text;
      g.font = '13px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(this.emptyText, w / 2, h / 2);
      return;
    }

    const sr = this.buffer.sampleRate;
    const tEnd = this.t0 + w * this.spp;

    // Time axis
    g.fillStyle = col.axisBg;
    g.fillRect(0, 0, w, AXIS_H);
    const step = niceStep(this.spp * 90);
    g.font = '11px ui-monospace, Consolas, monospace';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (let k = Math.ceil(this.t0 / step); k * step <= tEnd; k++) {
      const t = k * step;
      const x = Math.round((t - this.t0) / this.spp) + 0.5;
      g.fillStyle = col.grid;
      g.fillRect(x - 0.5, AXIS_H, 1, h - AXIS_H);
      g.fillStyle = col.gridStrong;
      g.fillRect(x - 0.5, AXIS_H - 5, 1, 5);
      g.fillStyle = col.text;
      g.fillText(fmtTick(t, step), x + 3, AXIS_H / 2);
    }

    // Channel lanes. The waveform itself is drawn in DEVICE pixels (one column
    // per physical screen pixel) for the sharpest possible detail.
    const nch = this.channels.length;
    const laneH = (h - AXIS_H) / nch;
    const dpr = this.win.devicePixelRatio || 1;
    const W = Math.round(w * dpr);
    const sppD = this.spp / dpr;          // seconds per device pixel
    const samplesPerDev = sppD * sr;
    const yz = this.yZoom;

    for (let c = 0; c < nch; c++) {
      const top = AXIS_H + c * laneH;
      const mid = top + laneH / 2;
      const amp = (laneH / 2) * 0.9;
      const d = this.channels[c];
      const len = d.length;

      // amplitude grid (CSS pixels), labelled in the first lane
      const aStep = niceStep(0.3 / yz);
      g.font = '10px ui-monospace, Consolas, monospace';
      for (let k = -Math.floor(1 / yz / aStep); k <= Math.floor(1 / yz / aStep); k++) {
        if (k === 0) continue;
        const y = Math.round(mid - k * aStep * yz * amp);
        g.fillStyle = col.grid;
        g.fillRect(0, y, w, 1);
        if (c === 0 || nch === 1) {
          g.fillStyle = col.text;
          g.textAlign = 'right';
          g.textBaseline = 'middle';
          g.fillText(`${+(k * aStep).toFixed(4)}`, w - 4, y + (k > 0 ? 7 : -7));
        }
      }
      g.fillStyle = col.gridStrong;
      g.fillRect(0, Math.round(mid), w, 1);
      if (c > 0) g.fillRect(0, Math.round(top), w, 1);
      if (nch > 1) {
        g.fillStyle = col.text;
        g.textAlign = 'left';
        g.textBaseline = 'top';
        g.fillText(nch === 2 ? (c === 0 ? 'L' : 'R') : `${c + 1}`, 4, top + 4);
      }

      // switch to device pixels
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      const topD = top * dpr, midD = mid * dpr, ampD = amp * dpr * yz, laneD = laneH * dpr;
      g.beginPath();
      g.rect(0, topD, W, laneD);
      g.clip();
      const grad = this.laneGradient(g, midD, amp * dpr);

      if (samplesPerDev >= 1) {
        // Per-column min/max envelope, plus RMS (average loudness) core.
        const { mn, mx, sq } = this.peaks[c];
        const rmsY = new Float32Array(W);
        let prevHi = null, prevLo = null;
        g.fillStyle = grad;
        let x = 0;
        for (; x < W; x++) {
          const s0 = Math.floor((this.t0 + x * sppD) * sr);
          if (s0 >= len) break;
          const s1 = Math.min(len, Math.max(s0 + 1, Math.floor((this.t0 + (x + 1) * sppD) * sr)));
          let lo = Infinity, hi = -Infinity, sum = 0;
          if (s1 - s0 > BLOCK * 4) {
            const b0 = Math.floor(s0 / BLOCK), b1 = Math.min(mn.length, Math.ceil(s1 / BLOCK));
            for (let b = b0; b < b1; b++) { if (mn[b] < lo) lo = mn[b]; if (mx[b] > hi) hi = mx[b]; sum += sq[b]; }
            sum /= (b1 - b0) * BLOCK;
          } else {
            for (let s = s0; s < s1; s++) { const v = d[s]; if (v < lo) lo = v; if (v > hi) hi = v; sum += v * v; }
            sum /= s1 - s0;
          }
          // join to the previous column so the outline has no gaps
          if (prevHi !== null) { if (prevLo > hi) hi = prevLo; if (prevHi < lo) lo = prevHi; }
          prevHi = hi; prevLo = lo;
          const yTop = midD - hi * ampD;
          g.fillRect(x, yTop, 1, Math.max(1, (hi - lo) * ampD));
          rmsY[x] = Math.sqrt(sum) * ampD;
        }
        // RMS core, a brighter band inside the envelope
        g.fillStyle = 'rgba(255, 255, 255, 0.30)';
        for (let i = 0; i < x; i++) if (rmsY[i] > 0.5) g.fillRect(i, midD - rmsY[i], 1, 2 * rmsY[i]);
      } else {
        // Zoomed in past 1 sample per pixel: draw the actual sample curve
        const sA = Math.max(0, Math.floor(this.t0 * sr) - 1);
        const sB = Math.min(len - 1, Math.ceil(tEnd * sr) + 1);
        const xOf = (s) => (s / sr - this.t0) / sppD;
        g.strokeStyle = grad;
        g.lineWidth = 1.75 * dpr;
        g.lineJoin = 'round';
        g.beginPath();
        for (let s = sA; s <= sB; s++) {
          const px = xOf(s), py = midD - d[s] * ampD;
          if (s === sA) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.stroke();
        const pxPerSample = 1 / (this.spp * sr);
        if (pxPerSample >= 6) {
          g.fillStyle = grad;
          for (let s = sA; s <= sB; s++) {
            g.beginPath();
            g.arc(xOf(s), midD - d[s] * ampD, 2.5 * dpr, 0, Math.PI * 2);
            g.fill();
          }
        }
      }
      g.restore();
    }
  }

  renderOverlay() {
    const { g, w, h } = this.prep(this.overlayCanvas);
    if (!this.buffer) return;
    const col = this.getColors();

    const cx = (this.cursor - this.t0) / this.spp;
    if (cx >= 0 && cx <= w) {
      g.strokeStyle = col.cursor;
      g.lineWidth = 1;
      g.setLineDash([4, 4]);
      g.beginPath();
      g.moveTo(Math.round(cx) + 0.5, AXIS_H);
      g.lineTo(Math.round(cx) + 0.5, h);
      g.stroke();
      g.setLineDash([]);
    }

    if (this.playhead != null) {
      const px = (this.playhead - this.t0) / this.spp;
      if (px >= 0 && px <= w) {
        g.fillStyle = col.playhead;
        g.fillRect(Math.round(px) - 1, 0, 2, h);
      }
    }
  }
}
