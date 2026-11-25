// Knob and slider controls. Values are mapped through a normalized 0..1
// position so log-scaled params (like frequency) feel natural.

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function toNorm(p, v) {
  if (p.scale === 'log') return clamp01(Math.log(v / p.min) / Math.log(p.max / p.min));
  return clamp01((v - p.min) / (p.max - p.min));
}

export function fromNorm(p, n) {
  n = clamp01(n);
  let v = p.scale === 'log' ? p.min * Math.pow(p.max / p.min, n) : p.min + n * (p.max - p.min);
  if (p.step) v = Math.round(v / p.step) * p.step;
  v = Math.min(p.max, Math.max(p.min, v));
  return +v.toFixed(6);
}

export function formatValue(p, v) {
  if (p.format) return p.format(v);
  const decimals = p.step ? Math.max(0, Math.min(3, -Math.floor(Math.log10(p.step)))) : 2;
  return `${v.toFixed(decimals)}${p.unit ?? ''}`;
}

export function createControl(p, value, onChange) {
  if (p.control === 'select') return createSelect(p, value, onChange);
  return p.control === 'slider' ? createSlider(p, value, onChange) : createKnob(p, value, onChange);
}

function createSelect(p, value, onChange) {
  const el = document.createElement('label');
  el.className = 'ctl select-ctl';
  el.innerHTML = `<span class="ctl-label">${p.label}</span><select class="select"></select>`;
  const sel = el.querySelector('select');
  for (const [v, text] of p.options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = text;
    sel.append(o);
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(Number(sel.value)));
  return el;
}

function createKnob(p, value, onChange) {
  const el = document.createElement('div');
  el.className = 'ctl knob-ctl';
  el.innerHTML = `
    <div class="knob" tabindex="0" role="slider" aria-label="${p.label}">
      <div class="knob-cap"><div class="knob-ptr"></div></div>
    </div>
    <div class="ctl-value"></div>
    <div class="ctl-label">${p.label}</div>`;
  const knob = el.querySelector('.knob');
  const valEl = el.querySelector('.ctl-value');
  let n = toNorm(p, value);
  let last = value;

  const set = (nn, fire = true) => {
    n = clamp01(nn);
    const v = fromNorm(p, n);
    knob.style.setProperty('--n', n);
    valEl.textContent = formatValue(p, v);
    knob.setAttribute('aria-valuetext', valEl.textContent);
    if (fire && v !== last) { last = v; onChange(v); }
  };
  set(n, false);

  let drag = null;
  knob.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    knob.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, n };
    knob.classList.add('dragging');
    e.preventDefault();
  });
  knob.addEventListener('pointermove', (e) => {
    if (!drag) return;
    // Up or right turns it up; down or left turns it down.
    const range = e.shiftKey ? 1000 : 250; // px for a full sweep
    const moved = (drag.y - e.clientY) + (e.clientX - drag.x);
    set(drag.n + moved / range);
  });
  const end = () => { drag = null; knob.classList.remove('dragging'); };
  knob.addEventListener('pointerup', end);
  knob.addEventListener('pointercancel', end);
  knob.addEventListener('wheel', (e) => {
    e.preventDefault();
    set(n + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.005 : 0.025));
  }, { passive: false });
  knob.addEventListener('dblclick', () => set(toNorm(p, p.default)));
  knob.addEventListener('keydown', (e) => {
    const d = e.shiftKey ? 0.1 : 0.01;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { set(n + d); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { set(n - d); e.preventDefault(); }
  });
  return el;
}

function createSlider(p, value, onChange) {
  const el = document.createElement('div');
  el.className = 'ctl slider-ctl';
  el.innerHTML = `
    <div class="slider-top"><span class="ctl-label">${p.label}</span><span class="ctl-value"></span></div>
    <input type="range" min="0" max="1000" step="1" aria-label="${p.label}">`;
  const input = el.querySelector('input');
  const valEl = el.querySelector('.ctl-value');
  let last = value;
  const show = (v) => { valEl.textContent = formatValue(p, v); };
  input.value = Math.round(toNorm(p, value) * 1000);
  show(value);
  input.addEventListener('input', () => {
    const v = fromNorm(p, input.value / 1000);
    show(v);
    if (v !== last) { last = v; onChange(v); }
  });
  input.addEventListener('dblclick', () => {
    input.value = Math.round(toNorm(p, p.default) * 1000);
    input.dispatchEvent(new Event('input'));
  });
  return el;
}
