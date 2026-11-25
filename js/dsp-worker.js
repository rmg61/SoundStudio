// Background thread that runs the effects chain so the page stays responsive.
// Messages in:
//   { type: 'load', gen, channels: Float32Array[], sampleRate }
//   { type: 'render', id, gen, keepView, chain: [{ id, type, enabled, params }] }
// Message out:
//   { type: 'result', id, gen, keepView, channels, errors: { [fxId]: message }, ms }

import { EFFECTS } from './dsp/effects.js';
import { synthesize } from './dsp/synth.js';

let original = [];
let sampleRate = 48000;
let loadedGen = -1;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'synth') {
    const t0 = performance.now();
    const r = synthesize(m.spec);
    self.postMessage({ type: 'synth-result', id: m.id, ...r, ms: performance.now() - t0 }, r.channels.map((c) => c.buffer));
    return;
  }
  if (m.type === 'load') {
    original = m.channels;
    sampleRate = m.sampleRate;
    loadedGen = m.gen;
    return;
  }
  if (m.type !== 'render') return;

  const t0 = performance.now();
  const errors = {};
  let chans = original;
  if (m.gen === loadedGen) {
    for (const fx of m.chain) {
      if (!fx.enabled) continue;
      try {
        chans = EFFECTS[fx.type].process(chans, sampleRate, fx.params);
      } catch (err) {
        errors[fx.id] = err.message;
      }
    }
  }

  // Never transfer (detach) the stored original; copy if nothing changed it.
  const out = chans.map((c) =>
    original.includes(c) ? c.slice() : c instanceof Float32Array ? c : Float32Array.from(c)
  );
  self.postMessage(
    { type: 'result', id: m.id, gen: m.gen, keepView: m.keepView, channels: out, errors, ms: performance.now() - t0 },
    out.map((c) => c.buffer)
  );
};
