// Wave Builder window: write math line by line to build a sound from scratch.
// Synthesis runs in its own background worker.

import { WaveformView } from './waveform-view.js';
import { createControl } from './controls.js';
import { SYNTH_TEMPLATES } from './dsp/synth.js';

const DURATION = { id: 'duration', label: 'Length', min: 0.1, max: 30, default: 2, scale: 'log', step: 0.01, unit: ' s', control: 'slider' };
const KNOB = (id) => ({ id, label: id, min: 0, max: 1, default: 0.5, step: 0.001, control: 'knob' });

export function createBuilder(root, viewRoot, { sampleRate, makeBuffer, onBuilt, onUse, openHelp }) {
  root.innerHTML = `
    <div class="builder-head">
      <h2>Wave Builder</h2>
      <span class="hint">Build a sound from math, one line at a time. The sound starts silent; each line receives
        <code>y</code> (the result of the lines above) and returns the new <code>y</code>.
        The result shows in the <b style="color:#c6ff4f">Built wave</b> display above.</span>
      <select class="select tmpl" title="Start from a template"><option value="">Templates…</option></select>
      <button class="link-btn guide">📖 Builder guide</button>
    </div>
    <div class="builder-grid">
      <div class="builder-editor">
        <div class="lines"></div>
        <div class="builder-row">
          <button class="btn add-line">+ Add line</button>
          <span class="spacer"></span>
          <button class="btn primary use" disabled title="Load the built wave into the Original panel so the effects chain can process it">Use as Original ↑</button>
        </div>
      </div>
      <div class="builder-settings"></div>
    </div>`;

  // The Built wave display lives in the top row, next to Original and Processed.
  const view = new WaveformView(viewRoot, {
    title: 'Built wave', accentVar: '--build', emptyText: 'Your wave appears here',
    palette: ['#c6ff4f', '#3ee8d0', '#2f9bff'], // lime center → teal → blue peaks
  });

  const state = { lines: [], duration: 2, stereo: false, normalize: true, a: 0.5, b: 0.5, c: 0.5 };
  let nextId = 1;
  let buffer = null;
  let lastDuration = null;

  const linesEl = root.querySelector('.lines');
  const settingsEl = root.querySelector('.builder-settings');
  const useBtn = root.querySelector('.use');
  const tmplSel = root.querySelector('.tmpl');

  // ---------- worker ----------
  const worker = new Worker(new URL('./dsp-worker.js', import.meta.url), { type: 'module' });
  let jobId = 0, busy = false, dirty = false;

  function build() {
    if (busy) { dirty = true; return; }
    busy = true;
    view.setBusy(true);
    worker.postMessage({
      type: 'synth', id: ++jobId,
      spec: { ...state, sampleRate, lines: state.lines.map(({ id, expr, enabled }) => ({ id, expr, enabled })) },
    });
  }

  let timer = 0;
  const scheduleBuild = (delay = 120) => { clearTimeout(timer); timer = setTimeout(build, delay); };

  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type !== 'synth-result') return;
    busy = false;
    for (const line of state.lines) {
      line.error = m.errors[line.id] ?? null;
      if (line.errEl) line.errEl.textContent = line.error ? `⚠ ${line.error}` : '';
      line.rowEl?.classList.toggle('has-error', !!line.error);
    }
    buffer = makeBuffer(m.channels, sampleRate);
    const keepView = lastDuration === state.duration;
    lastDuration = state.duration;
    view.setBuffer(buffer, keepView);
    useBtn.disabled = false;
    onBuilt(buffer);
    if (dirty) { dirty = false; build(); } else view.setBusy(false);
  };
  worker.onerror = (e) => { busy = false; view.setBusy(false); console.error(e); };

  // ---------- lines ----------
  function addLine(expr = 'y', { rebuild = true } = {}) {
    state.lines.push({ id: nextId++, expr, enabled: true, error: null });
    if (rebuild) { renderLines(); scheduleBuild(); }
  }

  function renderLines() {
    linesEl.innerHTML = '';
    state.lines.forEach((line, idx) => {
      const row = document.createElement('div');
      row.className = `line-row${line.enabled ? '' : ' off'}`;
      row.innerHTML = `
        <span class="line-num">${idx + 1}</span>
        <input type="checkbox" class="line-on" title="Turn this line on/off" ${line.enabled ? 'checked' : ''}>
        <span class="line-prefix">y =</span>
        <input type="text" class="line-input" spellcheck="false" autocomplete="off">
        <button class="icon-btn up" title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn down" title="Move down" ${idx === state.lines.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="icon-btn remove" title="Delete line">✕</button>
        <div class="line-error"></div>`;
      const input = row.querySelector('.line-input');
      input.value = line.expr;
      input.addEventListener('input', () => { line.expr = input.value; scheduleBuild(350); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { // Enter adds a new line below and focuses it
          e.preventDefault();
          state.lines.splice(idx + 1, 0, { id: nextId++, expr: 'y', enabled: true, error: null });
          renderLines();
          linesEl.querySelectorAll('.line-input')[idx + 1]?.select();
          scheduleBuild();
        }
      });
      row.querySelector('.line-on').addEventListener('change', (e) => {
        line.enabled = e.target.checked;
        row.classList.toggle('off', !line.enabled);
        scheduleBuild();
      });
      const move = (d) => {
        [state.lines[idx], state.lines[idx + d]] = [state.lines[idx + d], state.lines[idx]];
        renderLines();
        scheduleBuild();
      };
      row.querySelector('.up').addEventListener('click', () => move(-1));
      row.querySelector('.down').addEventListener('click', () => move(1));
      row.querySelector('.remove').addEventListener('click', () => {
        state.lines = state.lines.filter((l) => l !== line);
        renderLines();
        scheduleBuild();
      });
      line.rowEl = row;
      line.errEl = row.querySelector('.line-error');
      line.errEl.textContent = line.error ? `⚠ ${line.error}` : '';
      row.classList.toggle('has-error', !!line.error);
      linesEl.append(row);
    });
    if (!state.lines.length) linesEl.innerHTML = `<div class="chain-empty">No lines. Click “+ Add line” or pick a template.</div>`;
  }

  // ---------- settings ----------
  function renderSettings() {
    settingsEl.innerHTML = '';
    settingsEl.append(createControl({ ...DURATION, default: 2 }, state.duration, (v) => { state.duration = v; scheduleBuild(250); }));
    const toggles = document.createElement('div');
    toggles.className = 'builder-toggles';
    toggles.innerHTML = `
      <label title="Two channels; use ch (0 = left, 1 = right) to make them differ"><input type="checkbox" class="stereo"> Stereo</label>
      <label title="Scale the result so its loudest point is −1 dB"><input type="checkbox" class="normalize"> Auto-normalize</label>`;
    const st = toggles.querySelector('.stereo'), no = toggles.querySelector('.normalize');
    st.checked = state.stereo;
    no.checked = state.normalize;
    st.addEventListener('change', () => { state.stereo = st.checked; scheduleBuild(); });
    no.addEventListener('change', () => { state.normalize = no.checked; scheduleBuild(); });
    settingsEl.append(toggles);
    const knobs = document.createElement('div');
    knobs.className = 'fx-controls';
    for (const k of ['a', 'b', 'c']) knobs.append(createControl(KNOB(k), state[k], (v) => { state[k] = v; scheduleBuild(30); }));
    settingsEl.append(knobs);
  }

  // ---------- templates ----------
  SYNTH_TEMPLATES.forEach((t, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = t.name;
    tmplSel.append(o);
  });
  function loadTemplate(t) {
    Object.assign(state, { duration: t.duration, stereo: t.stereo, a: t.a, b: t.b, c: t.c, normalize: true });
    state.lines = [];
    t.lines.forEach((l) => addLine(l, { rebuild: false }));
    renderLines();
    renderSettings();
    build();
  }
  tmplSel.addEventListener('change', () => {
    const t = SYNTH_TEMPLATES[tmplSel.value];
    tmplSel.value = '';
    if (t) loadTemplate(t);
  });

  root.querySelector('.add-line').addEventListener('click', () => {
    addLine('y');
    linesEl.querySelector('.line-row:last-child .line-input')?.select();
  });
  useBtn.addEventListener('click', () => buffer && onUse(buffer));
  root.querySelector('.guide').addEventListener('click', () => openHelp('builder'));

  loadTemplate(SYNTH_TEMPLATES[0]);

  return {
    view,
    getBuffer: () => buffer,
    addLine: (expr) => {
      addLine(expr);
      root.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
  };
}
