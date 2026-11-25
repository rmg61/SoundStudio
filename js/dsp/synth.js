// Wave Builder: build a sound from math, one line at a time.
// Pure math, no browser APIs (portable to hardware later).
//
// The sound starts as silence. Each enabled line is evaluated for every
// sample; it receives y (the output of the lines above) and returns the new y.

import { compileExpr } from './effects.js';

export const SYNTH_ARGS = ['y', 't', 'i', 'n', 'sr', 'ch', 'a', 'b', 'c', 'y1', 'Y', 'O'];

// Allow "// notes" at the end of a line.
export const stripComment = (s) => {
  const k = String(s ?? '').indexOf('//');
  return (k >= 0 ? s.slice(0, k) : String(s ?? '')).trim();
};

/**
 * spec = { lines: [{ id, expr, enabled }], duration, sampleRate, stereo, normalize, a, b, c }
 * returns { channels: Float32Array[], errors: { [lineId]: message }, peak }
 */
export function synthesize(spec) {
  const sr = spec.sampleRate;
  const n = Math.max(1, Math.round(spec.duration * sr));
  const nch = spec.stereo ? 2 : 1;
  const { a, b, c } = spec;
  const errors = {};

  const compiled = [];
  for (const line of spec.lines) {
    if (!line.enabled) continue;
    const src = stripComment(line.expr);
    if (!src) continue;
    try {
      compiled.push([line.id, compileExpr(src, SYNTH_ARGS)]);
    } catch (err) {
      errors[line.id] = err.message;
    }
  }

  const channels = [];
  for (let ch = 0; ch < nch; ch++) {
    let buf = new Float32Array(n);
    for (const [id, fn] of compiled) {
      if (errors[id]) continue;
      const inp = buf;
      const out = new Float32Array(n);
      let i = 0;
      let y1 = 0;
      const Y = (k) => { k = Math.floor(k); return k >= 0 && k < n ? inp[k] : 0; }; // lines above, any index
      const O = (k) => { k = Math.floor(k); return k >= 0 && k < i ? out[k] : 0; };  // this line's earlier output
      try {
        for (i = 0; i < n; i++) {
          let v = fn(inp[i], i / sr, i, n, sr, ch, a, b, c, y1, Y, O);
          if (typeof v !== 'number' || !Number.isFinite(v)) v = 0;
          out[i] = v;
          y1 = v;
        }
        buf = out;
      } catch (err) {
        errors[id] = err.message; // skip this line, keep going
      }
    }
    channels.push(buf);
  }

  let peak = 0;
  for (const d of channels) for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (spec.normalize && peak > 0) {
    const g = Math.pow(10, -1 / 20) / peak;
    for (const d of channels) for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return { channels, errors, peak };
}

const T = (name, duration, lines, extra = {}) => ({ name, duration, lines, stereo: false, a: 0.5, b: 0.5, c: 0.5, ...extra });

export const SYNTH_TEMPLATES = [
  T('Tone with harmonics', 2, [
    'sin(tau * 220 * t)            // start with a 220 Hz sine',
    'y + 0.5 * sin(tau * 440 * t)  // add the octave',
    'y + 0.25 * sin(tau * 660 * t) // add a fifth above that',
    'y * exp(-1.5 * t)             // fade it out',
  ]),
  T('Additive square wave', 2, [
    'sin(tau * 110 * t)',
    'y + sin(tau * 330 * t) / 3',
    'y + sin(tau * 550 * t) / 5',
    'y + sin(tau * 770 * t) / 7',
    'y + sin(tau * 990 * t) / 9   // odd harmonics at 1/n build a square',
    'y * min(1, t * 20) * exp(-t)',
  ]),
  T('Bell', 3, [
    'sin(tau * 400 * t) * exp(-1.2 * t)',
    'y + 0.6 * sin(tau * 400 * 2.76 * t) * exp(-2 * t)   // inharmonic partials',
    'y + 0.4 * sin(tau * 400 * 5.40 * t) * exp(-3 * t)',
    'y + 0.25 * sin(tau * 400 * 8.93 * t) * exp(-4.5 * t)',
  ]),
  T('Kick drum', 0.8, [
    'sin(tau * (45 * t + 120 * (1 - exp(-35 * t)) / 35))  // pitch falls fast',
    'y * exp(-6 * t)                                      // short decay',
    'tanh(3 * y)                                          // punch',
  ]),
  T('Plucked string (Karplus–Strong)', 2.5, [
    'i < sr / 196 ? noise() : 0                               // a tiny burst of noise',
    'y + 0.996 * (O(i - sr/196) + O(i - sr/196 - 1)) / 2     // feed it back, averaged',
  ]),
  T('Laser zap', 0.6, [
    'square(1500 * (1 - exp(-8 * t)) / 8) * 0.5   // pitch sweeps down',
    'y * exp(-5 * t)',
  ]),
  T('Wind', 6, [
    'noise()',
    'y1 + (0.01 + 0.03 * (0.5 + 0.5 * sin(tau * 0.3 * t))) * (y - y1)  // moving low-pass',
    'y * min(1, t) * min(1, (n/sr - t))',
  ], { stereo: true }),
  T('Siren', 4, [
    'sin(tau * (600 * t + 200 * sin(tau * 0.5 * t) / (tau * 0.5)))  // pitch swings 400–800 Hz',
    'y * 0.8',
  ]),
  T('Chord with vibrato (a = vibrato)', 3, [
    'sin(tau * 261.6 * t + a * 3 * sin(tau * 5 * t))   // C',
    'y + sin(tau * 329.6 * t + a * 3 * sin(tau * 5 * t)) // E',
    'y + sin(tau * 392.0 * t + a * 3 * sin(tau * 5 * t)) // G',
    'y * min(1, t * 4) * min(1, (n/sr - t) * 4)         // smooth start and end',
  ]),
  T('Stereo ping-pong', 3, [
    'sin(tau * (ch ? 660 : 440) * t)   // different pitch left and right',
    'y * exp(-8 * (t % 0.25))           // retrigger every quarter second',
    'y * ((floor(t * 4) % 2) == ch ? 1 : 0.1)',
  ], { stereo: true }),
];
