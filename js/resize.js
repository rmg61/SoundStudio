// Drag-to-resize helpers. Sizes are remembered per browser (localStorage);
// double-click a handle to reset it.

const load = (key) => { try { return JSON.parse(localStorage.getItem(`ss.size.${key}`)); } catch { return null; } };
const save = (key, v) => { try { localStorage.setItem(`ss.size.${key}`, JSON.stringify(v)); } catch { /* storage unavailable */ } };
const forget = (key) => { try { localStorage.removeItem(`ss.size.${key}`); } catch { /* ignore */ } };

function drag(handle, { onStart, onMove, onEnd, onReset, cursorClass }) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add(cursorClass, 'resizing');
    const start = onStart(e);
    const move = (ev) => onMove(ev, start);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove(cursorClass, 'resizing');
      onEnd?.();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) onReset(); });
}

// Adds a horizontal grip bar right below `el` that changes its height.
export function makeHeightResizable(el, key, { min = 80, max = 900 } = {}) {
  const handle = document.createElement('div');
  handle.className = 'resize-y';
  handle.title = 'Drag to resize · double-click to reset';
  el.after(handle);
  const saved = load(key);
  if (saved) el.style.height = `${saved}px`;
  drag(handle, {
    cursorClass: 'resizing-y',
    onStart: (e) => ({ y: e.clientY, h: el.getBoundingClientRect().height }),
    onMove: (e, s) => { el.style.height = `${Math.min(max, Math.max(min, s.h + e.clientY - s.y))}px`; },
    onEnd: () => save(key, Math.round(el.getBoundingClientRect().height)),
    onReset: () => { el.style.height = ''; forget(key); },
  });
}

// Several columns separated by dividers. handles[i] sits between column i and i+1.
// apply(fractions) must set the layout; fractions sum to 1.
export function makeMultiSplit(container, handles, key, apply, { min = 0.12 } = {}) {
  const n = handles.length + 1;
  const even = Array(n).fill(1 / n);
  let fr = load(key);
  if (!Array.isArray(fr) || fr.length !== n) fr = even.slice();
  apply(fr);
  handles.forEach((handle, i) => {
    handle.classList.add('splitter');
    if (!handle.title) handle.title = 'Drag to resize · double-click to make all equal';
    drag(handle, {
      cursorClass: 'resizing-x',
      onStart: () => ({ rect: container.getBoundingClientRect(), fr: fr.slice() }),
      onMove: (e, s) => {
        // move the boundary between column i and i+1; other columns keep their size
        const before = s.fr.slice(0, i).reduce((a, b) => a + b, 0);
        const pair = s.fr[i] + s.fr[i + 1];
        const pos = (e.clientX - s.rect.left) / s.rect.width - before;
        const left = Math.min(pair - min, Math.max(min, pos));
        fr = s.fr.slice();
        fr[i] = left;
        fr[i + 1] = pair - left;
        apply(fr);
      },
      onEnd: () => save(key, fr),
      onReset: () => { fr = even.slice(); apply(fr); forget(key); },
    });
  });
}

// Makes `handle` a vertical divider that sets the left/right share of `container`.
// apply(ratio) must set the layout; ratio is the left side's share (0…1).
export function makeSplitter(container, handle, key, apply, { min = 0.2, max = 0.8, initial = 0.5 } = {}) {
  handle.classList.add('splitter');
  if (!handle.title) handle.title = 'Drag to resize · double-click to reset';
  apply(load(key) ?? initial);
  let ratio = load(key) ?? initial;
  drag(handle, {
    cursorClass: 'resizing-x',
    onStart: () => container.getBoundingClientRect(),
    onMove: (e, rect) => {
      ratio = Math.min(max, Math.max(min, (e.clientX - rect.left) / rect.width));
      apply(ratio);
    },
    onEnd: () => save(key, ratio),
    onReset: () => { ratio = initial; apply(initial); forget(key); },
  });
}
