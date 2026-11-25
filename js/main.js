import { WaveformView } from './waveform-view.js';
import { EFFECTS } from './dsp/effects.js';

// Each effect category gets its own color (card border, knobs, sliders).
const CATEGORY_COLORS = {
  Filters: '#3ee8d0',
  Level: '#7ddc6f',
  Time: '#b98cff',
  Color: '#ff6fae',
  Math: '#ffb547',
  Spectral: '#5fb3ff',
};
import { createControl } from './controls.js';
import { encodeWav } from './wav.js';
import { EXAMPLES } from './examples.js';
import { initHelp } from './help.js';
import { createBuilder } from './builder.js';
import { makeHeightResizable, makeMultiSplit } from './resize.js';

const $ = (id) => document.getElementById(id);

// ---------- audio context ----------
let ctx = null;
const audio = () => (ctx ??= new (window.AudioContext || window.webkitAudioContext)());

// ---------- state ----------
const state = {
  original: null,   // AudioBuffer, never modified
  processed: null,  // AudioBuffer, rebuilt from original + chain
  built: null,      // AudioBuffer from the Wave Builder
  name: '',
  chain: [],        // [{ id, type, enabled, params, error }]
  sync: false,
  active: 'proc',   // panel that Space bar plays
};
let nextFxId = 1;
let recordCount = 0;

// ---------- views ----------
const views = {
  orig: new WaveformView($('originalPanel'), {
    title: 'Original', accentVar: '--orig', emptyText: 'Open a file, record, or pick an example',
    palette: ['#3ee8d0', '#4f8bff', '#d35cff'],   // teal center → blue → violet peaks
  }),
  proc: new WaveformView($('processedPanel'), {
    title: 'Processed', accentVar: '--proc', emptyText: 'The processed sound appears here',
    palette: ['#ffe14f', '#ff8a1f', '#ff3b6b'],   // yellow center → orange → hot pink peaks
  }),
};
const other = (key) => (key === 'orig' ? 'proc' : 'orig');

// Third window: Wave Builder
const builder = createBuilder($('builderSection'), $('builtPanel'), {
  sampleRate: audio().sampleRate,
  makeBuffer: (channels, sr) => {
    const buf = audio().createBuffer(channels.length, Math.max(1, channels[0].length), sr);
    channels.forEach((d, c) => buf.copyToChannel(d, c));
    return buf;
  },
  onBuilt: (buf) => {
    state.built = buf;
    if (player?.which === 'build') play('build', Math.min(playPosition(), buf.duration));
  },
  onUse: (buf) => {
    const copy = audio().createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) copy.copyToChannel(buf.getChannelData(c), c);
    setSound(copy, `Built wave ${++builtCount}`);
    toast('Built wave loaded into the Original panel. Add effects to process it.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  openHelp: (page) => help.open(page),
});
views.build = builder.view;
let builtCount = 0;

// ---------- resizable windows ----------
for (const [key, v] of Object.entries(views)) {
  makeHeightResizable(v.wrap, `wave-${key}`, { min: 100, max: 900 });
  makeHeightResizable(v.specWrap, `spec-${key}`, { min: 60, max: 600 });
}
// Original | Processed | Built wave on one row, with two draggable dividers
const panelsEl = document.querySelector('.panels');
makeMultiSplit(panelsEl, [document.querySelector('.sync-strip'), document.querySelector('.build-split')], 'split-row3',
  (fr) => fr.forEach((f, i) => panelsEl.style.setProperty(`--c${i + 1}`, `${f}fr`)));

for (const key of ['orig', 'proc', 'build']) {
  const v = views[key];
  v.onPlayToggle = () => { state.active = key; player?.which === key ? stop() : play(key); };
  v.onViewChange = (t0, spp) => { if (state.sync && key !== 'build') views[other(key)].setView(t0, spp); };
  v.onFocus = () => { state.active = key; };
  v.onCursor = (t) => { if (player?.which === key) play(key, t); };
  v.onPopupBlocked = () =>
    toast('Your browser blocked the pop-out window. Allow pop-ups for this site and try again.', true);
}

$('syncBtn').addEventListener('click', () => {
  state.sync = !state.sync;
  $('syncBtn').setAttribute('aria-pressed', String(state.sync));
  if (state.sync) {
    const src = views[state.active];
    views[other(state.active)].setView(src.t0, src.spp);
  }
});

// ---------- playback ----------
let player = null; // { which, source, startTime, offset }
let tickGen = 0;

function play(which, from) {
  const view = views[which];
  const buf = { orig: state.original, proc: state.processed, build: state.built }[which];
  if (!buf) return;
  stop();
  const ac = audio();
  ac.resume();
  let offset = from ?? view.cursor;
  if (offset >= buf.duration - 0.001) offset = 0;
  const source = ac.createBufferSource();
  source.buffer = buf;
  source.connect(ac.destination);
  source.start(0, offset);
  player = { which, source, startTime: ac.currentTime, offset };
  source.onended = () => { if (player?.source === source) stop(); };
  view.setPlaying(true);
  tick(++tickGen);
}

function stop() {
  if (!player) return;
  const p = player;
  player = null;
  try { p.source.stop(); } catch { /* already stopped */ }
  p.source.disconnect();
  views[p.which].setPlaying(false);
  tickGen++; // stops the running animation loop
}

function playPosition() {
  return player.offset + (ctx.currentTime - player.startTime);
}

// Animation loop for the playhead. It runs on the window that shows the panel
// (which may be a pop-out), and each play() starts a new generation.
function tick(gen) {
  if (!player || gen !== tickGen) return;
  const t = playPosition();
  const v = views[player.which];
  v.setPlayhead(t);
  v.follow(t);
  v.win.requestAnimationFrame(() => tick(gen));
}

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag)) return;
  e.preventDefault();
  views[state.active].onPlayToggle();
});

// ---------- loading ----------
function setSound(buffer, name) {
  stop();
  state.original = buffer;
  state.name = name;
  views.orig.setBuffer(buffer, false);
  loadIntoWorker(buffer);
  renderProcessed(false);
  $('soundInfo').textContent = name;
  $('soundInfo').title = name;
  $('exportBtn').disabled = false;
}

async function decode(arrayBuffer, name) {
  try {
    const buf = await audio().decodeAudioData(arrayBuffer);
    setSound(buf, name);
  } catch (err) {
    toast(`Couldn't decode "${name}". Your browser may not support this format ` +
          `(WAV, MP3, FLAC, OGG and M4A usually work).`, true);
    console.error(err);
  }
}

async function loadFile(file) {
  if (!file) return;
  await decode(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, ''));
}

$('fileInput').addEventListener('change', (e) => {
  loadFile(e.target.files[0]);
  e.target.value = '';
});

// Drag & drop anywhere on the page
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  $('dropOverlay').hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('dropOverlay').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  loadFile(e.dataTransfer.files[0]);
});

// Examples
for (const ex of EXAMPLES) {
  const opt = document.createElement('option');
  opt.value = ex.file;
  opt.textContent = ex.name;
  $('exampleSelect').append(opt);
}
$('exampleSelect').addEventListener('change', async (e) => {
  const ex = EXAMPLES.find((x) => x.file === e.target.value);
  e.target.value = '';
  if (!ex) return;
  try {
    const res = await fetch(`samples/${ex.file}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await decode(await res.arrayBuffer(), ex.name);
  } catch (err) {
    toast(`Couldn't load example "${ex.name}" (${err.message}). ` +
          `Are you running a local web server? See README.`, true);
  }
});

// ---------- recording ----------
let recorder = null;
let recordTimer = 0;

$('recordBtn').addEventListener('click', async () => {
  if (recorder) { recorder.stop(); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    toast(`Microphone not available: ${err.message}`, true);
    return;
  }
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(recordTimer);
    recorder = null;
    $('recordBtn').classList.remove('recording');
    $('recordLabel').textContent = 'Record';
    const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
    await decode(await blob.arrayBuffer(), `Recording ${++recordCount}`);
  };
  recorder.start();
  const started = performance.now();
  $('recordBtn').classList.add('recording');
  const update = () => {
    const s = (performance.now() - started) / 1000;
    $('recordLabel').textContent = `Stop ${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };
  update();
  recordTimer = setInterval(update, 250);
});

// ---------- processing ----------
let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; renderProcessed(true); });
}

// Processing runs in a background worker. Only one job is in flight at a time;
// changes made meanwhile are coalesced into one follow-up job.
const worker = new Worker(new URL('./dsp-worker.js', import.meta.url), { type: 'module' });
let soundGen = 0;
let jobId = 0;
let busy = false;
let dirty = false;
let dirtyKeepView = true;

function loadIntoWorker(buffer) {
  soundGen++;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
  worker.postMessage({ type: 'load', gen: soundGen, channels, sampleRate: buffer.sampleRate });
}

function renderProcessed(keepView) {
  if (!state.original) return;
  if (busy) {
    dirty = true;
    dirtyKeepView = dirtyKeepView && keepView;
    return;
  }
  busy = true;
  views.proc.setBusy(true);
  const chain = state.chain.map(({ id, type, enabled, params }) => ({ id, type, enabled, params: { ...params } }));
  worker.postMessage({ type: 'render', id: ++jobId, gen: soundGen, keepView, chain });
}

worker.onmessage = (e) => {
  const m = e.data;
  busy = false;
  if (m.gen === soundGen && state.original) {
    for (const fx of state.chain) fx.error = m.errors[fx.id] ?? null;
    updateErrors();

    const sr = state.original.sampleRate;
    const len = Math.max(1, m.channels[0]?.length ?? 1);
    const out = audio().createBuffer(m.channels.length, len, sr);
    m.channels.forEach((d, c) => out.copyToChannel(d, c));
    state.processed = out;

    const v = views.proc;
    v.setBuffer(out, m.keepView);
    if (!m.keepView && state.sync) v.setView(views.orig.t0, views.orig.spp);

    // Hear changes live: restart processed playback at the same spot
    if (player?.which === 'proc') play('proc', Math.min(playPosition(), out.duration));
  }
  if (dirty) {
    const kv = dirtyKeepView;
    dirty = false;
    dirtyKeepView = true;
    renderProcessed(kv);
  } else {
    views.proc.setBusy(false);
  }
};

worker.onerror = (e) => {
  busy = false;
  views.proc.setBusy(false);
  toast(`Processing error: ${e.message}`, true);
};

// ---------- effects chain UI ----------
const chainEl = $('chain');

{
  const groups = {};
  for (const [type, def] of Object.entries(EFFECTS)) (groups[def.category] ??= []).push([type, def]);
  for (const [cat, items] of Object.entries(groups)) {
    const og = document.createElement('optgroup');
    og.label = cat;
    for (const [type, def] of items) {
      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = def.name;
      og.append(opt);
    }
    $('addEffect').append(og);
  }
}

$('addEffect').addEventListener('change', (e) => {
  const type = e.target.value;
  e.target.value = '';
  if (type) addEffect(type);
});

$('clearChain').addEventListener('click', () => {
  state.chain = [];
  buildChainUI();
  scheduleRender();
});

function addEffect(type, values = {}) {
  const fx = { id: nextFxId++, type, enabled: true, params: {}, error: null };
  for (const p of EFFECTS[type].params) fx.params[p.id] = p.default;
  Object.assign(fx.params, values);
  state.chain.push(fx);
  buildChainUI();
  scheduleRender();
  if (!state.original) toast('Effect added. Load or record a sound to hear it.');
}

function buildChainUI() {
  chainEl.innerHTML = '';
  if (!state.chain.length) {
    chainEl.innerHTML = `<div class="chain-empty">No effects yet. Choose “+ Add effect…” to start shaping the sound.</div>`;
    return;
  }
  state.chain.forEach((fx, idx) => chainEl.append(buildCard(fx, idx)));
}

function buildCard(fx, idx) {
  const def = EFFECTS[fx.type];
  const hasText = def.params.some((p) => p.type === 'text');
  const card = document.createElement('div');
  card.className = `fx-card${fx.enabled ? '' : ' off'}${hasText ? ' wide' : ''}`;
  card.style.setProperty('--accent', CATEGORY_COLORS[def.category] ?? 'var(--proc)');
  card.innerHTML = `
    <div class="fx-head">
      <span class="fx-num">${idx + 1}</span>
      <span class="fx-name">${def.name}</span>
      <label class="fx-toggle" title="Bypass this effect"><input type="checkbox" ${fx.enabled ? 'checked' : ''}> On</label>
      <button class="icon-btn reset" title="Reset this effect's settings to their defaults">↺</button>
      <button class="icon-btn up" title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
      <button class="icon-btn down" title="Move down" ${idx === state.chain.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="icon-btn remove" title="Remove">✕</button>
    </div>
    <div class="fx-body"></div>
    <div class="fx-error"></div>`;

  card.querySelector('.fx-toggle input').addEventListener('change', (e) => {
    fx.enabled = e.target.checked;
    card.classList.toggle('off', !fx.enabled);
    scheduleRender();
  });
  const move = (d) => {
    const i = state.chain.indexOf(fx);
    const j = i + d;
    [state.chain[i], state.chain[j]] = [state.chain[j], state.chain[i]];
    buildChainUI();
    scheduleRender();
  };
  card.querySelector('.reset').addEventListener('click', () => {
    for (const p of def.params) fx.params[p.id] = p.default;
    const fresh = buildCard(fx, state.chain.indexOf(fx));
    card.replaceWith(fresh);
    fresh.classList.add('flash');
    scheduleRender();
  });
  card.querySelector('.up').addEventListener('click', () => move(-1));
  card.querySelector('.down').addEventListener('click', () => move(1));
  card.querySelector('.remove').addEventListener('click', () => {
    state.chain = state.chain.filter((f) => f !== fx);
    buildChainUI();
    scheduleRender();
  });

  const body = card.querySelector('.fx-body');
  if (hasText) body.append(buildFormulaEditor(fx, def));
  const knobs = document.createElement('div');
  knobs.className = 'fx-controls';
  for (const p of def.params) {
    if (p.type === 'text') continue;
    knobs.append(createControl(p, fx.params[p.id], (v) => { fx.params[p.id] = v; scheduleRender(); }));
  }
  if (!def.params.length) knobs.innerHTML = `<span class="muted">No settings.</span>`;
  body.append(knobs);

  fx.errEl = card.querySelector('.fx-error');
  fx.errEl.textContent = fx.error ?? '';
  return card;
}

// Formula fields (one per text param), a presets menu and a help panel.
function buildFormulaEditor(fx, def) {
  const wrap = document.createElement('div');
  wrap.className = 'eq-editor';
  const inputs = {};

  for (const p of def.params.filter((q) => q.type === 'text')) {
    const row = document.createElement('div');
    row.className = 'eq-row';
    row.innerHTML = `<span class="eq-prefix"></span><textarea class="eq-input" rows="1" spellcheck="false"></textarea>`;
    row.querySelector('.eq-prefix').textContent = p.prefix;
    const input = row.querySelector('.eq-input');
    input.value = fx.params[p.id];
    let timer = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { fx.params[p.id] = input.value; scheduleRender(); }, 350);
    });
    inputs[p.id] = input;
    wrap.append(row);
  }

  const tools = document.createElement('div');
  tools.className = 'eq-row eq-tools';
  tools.innerHTML = `
    <select class="select eq-presets"><option value="">Presets…</option></select>
    <button class="link-btn guide-btn">📖 Equation guide</button>
    <details class="eq-help"><summary>Quick reference</summary><div></div></details>`;
  tools.querySelector('.eq-help div').innerHTML = def.help ?? '';
  tools.querySelector('.guide-btn').addEventListener('click', () =>
    help.open(fx.type === 'spectral' ? 'fft' : 'time'));
  const presets = tools.querySelector('.eq-presets');
  (def.presets ?? []).forEach((p, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = p.name;
    presets.append(o);
  });
  presets.addEventListener('change', () => {
    const p = def.presets[presets.value];
    presets.value = '';
    if (!p) return;
    for (const [id, v] of Object.entries(p.values)) {
      fx.params[id] = v;
      if (inputs[id]) inputs[id].value = v;
    }
    scheduleRender();
  });
  wrap.append(tools);
  return wrap;
}

function updateErrors() {
  for (const fx of state.chain) if (fx.errEl) fx.errEl.textContent = fx.error ? `⚠ ${fx.error}` : '';
}

// ---------- export ----------
$('exportBtn').addEventListener('click', () => {
  if (!state.processed) return;
  const blob = encodeWav(state.processed);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(state.name || 'sound').replace(/[^\w\- ]+/g, '').trim() || 'sound'}-processed.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  if (views.proc.peak > 1) toast('Note: some samples were above 0 dB and were clipped in the WAV. Try a Normalize or Gain effect.');
});

// ---------- toast ----------
let toastTimer = 0;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 7000 : 4000);
}

const help = initHelp({
  onTry: (type, values) => {
    if (type === 'builder') { builder.addLine(values.expr); return; }
    addEffect(type, values);
    chainEl.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },
});

buildChainUI();
