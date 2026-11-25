// Effect definitions. Each effect is pure math:
//   process(channels: Float32Array[], sampleRate, params) -> Float32Array[]
// Inputs are never modified (the original sound stays intact).
// No browser APIs here, so the DSP can be ported to hardware later.

import { biquadCoeffs, biquadFilter } from './biquad.js';
import { spectralProcess } from './fft.js';

// ---------- formatting helpers ----------
const fmtHz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`);
const fmtPct = (v) => `${Math.round(v * 100)}%`;

const freqParam = (def, label = 'Frequency') => ({
  id: 'freq', label, min: 20, max: 20000, default: def, scale: 'log', format: fmtHz, control: 'knob',
});
const qParam = (def = 0.707) => ({
  id: 'q', label: 'Resonance (Q)', min: 0.1, max: 20, default: def, scale: 'log', step: 0.01, control: 'knob',
});

const mapChannels = (chans, fn) => chans.map((x, c) => fn(x, c));

function filterEffect(type, name, defFreq) {
  return {
    name,
    category: 'Filters',
    params: [freqParam(defFreq), qParam()],
    process: (chans, sr, p) => {
      const c = biquadCoeffs(type, p.freq, p.q, sr);
      return mapChannels(chans, (x) => biquadFilter(x, c));
    },
  };
}

// ---------- equation support ----------
const MATH_NAMES = Object.getOwnPropertyNames(Math);
const EQUATION_ENV = {
  M: Math,
  clamp: (v, lo, hi) => Math.min(Math.max(v, lo), hi),
  lerp: (a, b, t) => a + (b - a) * t,
  noise: () => Math.random() * 2 - 1,
  // Oscillators: p is the phase in cycles (e.g. saw(220*t) is a 220 Hz sawtooth). Output −1…1.
  saw: (p) => 2 * (p - Math.floor(p + 0.5)),
  square: (p, duty = 0.5) => (p - Math.floor(p) < duty ? 1 : -1),
  tri: (p) => 1 - 4 * Math.abs(p - Math.floor(p + 0.5)),
};
const eqCache = new Map();

// Compile a user expression into a fast function with the given argument names.
// All Math functions/constants are available unprefixed (sin, PI, ...).
export function compileExpr(expr, argNames) {
  const src = String(expr ?? '').trim();
  if (!src) throw new Error('Equation is empty');
  const key = `${argNames.join(',')}|${src}`;
  if (eqCache.has(key)) return eqCache.get(key);
  const factory = new Function(
    'env',
    `"use strict";
     const { ${MATH_NAMES.join(', ')} } = env.M;
     const pi = PI, tau = 2 * PI;
     const { clamp, lerp, noise, saw, square, tri } = env;
     return function (${argNames.join(', ')}) { return (${src}); };`
  );
  const fn = factory(EQUATION_ENV);
  eqCache.set(key, fn);
  if (eqCache.size > 200) eqCache.delete(eqCache.keys().next().value);
  return fn;
}

const TIME_ARGS = ['x', 't', 'i', 'n', 'sr', 'ch', 'a', 'b', 'c', 'y1', 'X', 'Y'];
const SPEC_ARGS = ['mag', 'phase', 'db', 'f', 'k', 'N', 'bins', 't', 'j', 'sr', 'ch', 'a', 'b', 'c', 'M', 'P', 're', 'im'];

const preset = (name, values) => ({ name, values });

export const EQUATION_PRESETS = [
  preset('Pass-through', { expr: 'x' }),
  preset('Tremolo (a = depth, b = speed)', { expr: 'x * (1 - a * 0.5 * (1 + sin(2*PI*(1 + b*15)*t)))' }),
  preset('Ring modulator (b = carrier freq)', { expr: 'x * sin(2*PI*(30 + b*2000)*t)' }),
  preset('Wave folder (a = amount)', { expr: 'sin(x * PI * (1 + a*10)) * 0.8' }),
  preset('Hard clip (a = drive)', { expr: 'clamp(x * (1 + a*20), -1, 1) * 0.7' }),
  preset('Quantize (a = coarseness)', { expr: 'round(x * (2 + (1-a)*60)) / (2 + (1-a)*60)' }),
  preset('Echo by formula (a = level, b = delay)', { expr: 'x + a * X(i - sr*(0.05 + b*0.6))' }),
  preset('Recursive low-pass (a = brightness)', { expr: 'y1 + (0.005 + a*a*0.995) * (x - y1)' }),
  preset('Speed / pitch (a = speed)', { expr: 'X(i * (0.5 + a*1.5))' }),
  preset('Add sine tone (a = mix, b = pitch)', { expr: 'x*(1-a) + a*0.5*sin(2*PI*(100 + b*900)*t)' }),
  preset('Bit of noise (a = amount)', { expr: 'x + a * 0.2 * noise()' }),
];

export const SPECTRAL_PRESETS = [
  preset('Pass-through', { mag: 'mag', phase: 'phase' }),
  preset('Brick-wall low-pass (a = cutoff)', { mag: 'f < 20*pow(1000, a) ? mag : 0', phase: 'phase' }),
  preset('Brick-wall high-pass (a = cutoff)', { mag: 'f > 20*pow(1000, a) ? mag : 0', phase: 'phase' }),
  preset('Keep one band (a = center, b = width)', { mag: 'abs(log2(f / (20*pow(1000, a)))) < 0.05 + b*2 ? mag : 0', phase: 'phase' }),
  preset('Noise gate / denoise (a = threshold)', { mag: 'db > -90 + a*70 ? mag : 0', phase: 'phase' }),
  preset('Robot voice (zero phase)', { mag: 'mag', phase: '0' }),
  preset('Whisper (random phase)', { mag: 'mag', phase: 'random() * tau' }),
  preset('Spectral pitch shift (a = ratio)', { mag: 'M(k / (0.5 + a*1.5))', phase: 'P(k / (0.5 + a*1.5))' }),
  preset('Tilt: darker ↔ brighter (a)', { mag: 'mag * pow((f + 20) / 1000, (a - 0.5) * 2)', phase: 'phase' }),
  preset('Spectral comb (b = spacing)', { mag: 'mag * (0.5 + 0.5*cos(tau * f / (20 + b*480)))', phase: 'phase' }),
  preset('Spectral blur (smear neighbours)', { mag: '(M(k-2) + M(k-1) + mag + M(k+1) + M(k+2)) / 5', phase: 'phase' }),
];

const MATH_HELP = `All of <code>Math</code> without the prefix: <code>sin cos tan abs sign pow sqrt exp log log2 log10 floor round min max random PI E</code>… plus
  <code>clamp(v,lo,hi)</code> <code>lerp(a,b,t)</code> <code>noise()</code> <code>tau</code>
  <code>saw(p)</code> <code>square(p)</code> <code>tri(p)</code>`;

const EQUATION_HELP = `<code>x</code> current sample (−1…1) · <code>t</code> time in seconds · <code>i</code> sample index ·
  <code>n</code> total samples · <code>sr</code> sample rate · <code>ch</code> channel (0 = left) ·
  <code>a b c</code> the knobs (0…1) · <code>y1</code> previous output sample ·
  <code>X(k)</code> input sample at index k · <code>Y(k)</code> earlier output sample at index k<br>${MATH_HELP}`;

const SPECTRAL_HELP = `The sound is cut into overlapping frames, each frame is FFT'd, your formulas set every
  frequency bin's new <b>magnitude</b> and <b>phase</b>, then the inverse FFT rebuilds the sound.
  "Whole sound" does one FFT of the entire sound.<br>
  <code>mag</code> bin magnitude (a full-scale sine ≈ 1) · <code>db</code> magnitude in dB · <code>phase</code> bin phase (radians) ·
  <code>re im</code> real/imaginary parts · <code>f</code> bin frequency in Hz · <code>k</code> bin index ·
  <code>N</code> FFT size · <code>bins</code> = N/2+1 · <code>t</code> frame time (s) · <code>j</code> frame index ·
  <code>sr</code> sample rate · <code>ch</code> channel · <code>a b c</code> knobs (0…1) ·
  <code>M(k)</code> / <code>P(k)</code> magnitude / phase of any bin in this frame<br>${MATH_HELP}`;

// ---------- effect registry ----------
export const EFFECTS = {
  lowpass: filterEffect('lowpass', 'Low-pass filter', 2000),
  highpass: filterEffect('highpass', 'High-pass filter', 300),
  bandpass: filterEffect('bandpass', 'Band-pass filter', 1000),
  notch: filterEffect('notch', 'Notch filter', 1000),

  peak: {
    name: 'Peak EQ',
    category: 'Filters',
    params: [
      freqParam(1000),
      { id: 'gain', label: 'Boost / cut', min: -24, max: 24, default: 6, step: 0.1, unit: ' dB', control: 'knob' },
      qParam(1),
    ],
    process: (chans, sr, p) => {
      const c = biquadCoeffs('peak', p.freq, p.q, sr, p.gain);
      return mapChannels(chans, (x) => biquadFilter(x, c));
    },
  },

  gain: {
    name: 'Gain',
    category: 'Level',
    params: [{ id: 'db', label: 'Gain', min: -36, max: 24, default: 0, step: 0.1, unit: ' dB', control: 'slider' }],
    process: (chans, sr, p) => {
      const g = Math.pow(10, p.db / 20);
      return mapChannels(chans, (x) => x.map((v) => v * g));
    },
  },

  normalize: {
    name: 'Normalize',
    category: 'Level',
    params: [{ id: 'target', label: 'Peak level', min: -24, max: 0, default: -1, step: 0.1, unit: ' dB', control: 'slider' }],
    process: (chans, sr, p) => {
      let peak = 0;
      for (const x of chans) for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
      if (peak === 0) return chans.map((x) => x.slice());
      const g = Math.pow(10, p.target / 20) / peak;
      return mapChannels(chans, (x) => x.map((v) => v * g));
    },
  },

  fade: {
    name: 'Fade in / out',
    category: 'Level',
    params: [
      { id: 'inMs', label: 'Fade in', min: 0, max: 5000, default: 50, step: 1, unit: ' ms', control: 'slider' },
      { id: 'outMs', label: 'Fade out', min: 0, max: 5000, default: 300, step: 1, unit: ' ms', control: 'slider' },
    ],
    process: (chans, sr, p) =>
      mapChannels(chans, (x) => {
        const y = x.slice();
        const n = y.length;
        const nIn = Math.min(n, Math.round((p.inMs / 1000) * sr));
        const nOut = Math.min(n, Math.round((p.outMs / 1000) * sr));
        for (let i = 0; i < nIn; i++) y[i] *= i / nIn;
        for (let i = 0; i < nOut; i++) y[n - 1 - i] *= i / nOut;
        return y;
      }),
  },

  reverse: {
    name: 'Reverse',
    category: 'Time',
    params: [],
    process: (chans) => mapChannels(chans, (x) => x.slice().reverse()),
  },

  echo: {
    name: 'Echo / delay',
    category: 'Time',
    params: [
      { id: 'time', label: 'Delay', min: 10, max: 2000, default: 300, scale: 'log', step: 1, unit: ' ms', control: 'knob' },
      { id: 'feedback', label: 'Feedback', min: 0, max: 0.95, default: 0.4, step: 0.01, format: fmtPct, control: 'knob' },
      { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.5, step: 0.01, format: fmtPct, control: 'knob' },
    ],
    process: (chans, sr, p) =>
      mapChannels(chans, (x) => {
        const d = Math.max(1, Math.round((p.time / 1000) * sr));
        const n = x.length;
        const wet = new Float32Array(n);
        for (let i = d; i < n; i++) wet[i] = x[i - d] + p.feedback * wet[i - d];
        const y = new Float32Array(n);
        for (let i = 0; i < n; i++) y[i] = x[i] + p.mix * wet[i];
        return y;
      }),
  },

  distortion: {
    name: 'Distortion',
    category: 'Color',
    params: [
      { id: 'drive', label: 'Drive', min: 1, max: 50, default: 5, scale: 'log', step: 0.1, control: 'knob' },
      { id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, step: 0.01, format: fmtPct, control: 'knob' },
    ],
    process: (chans, sr, p) => {
      const norm = Math.tanh(p.drive);
      return mapChannels(chans, (x) =>
        x.map((v) => (1 - p.mix) * v + (p.mix * Math.tanh(p.drive * v)) / norm)
      );
    },
  },

  bitcrush: {
    name: 'Bit crusher',
    category: 'Color',
    params: [
      { id: 'bits', label: 'Bits', min: 1, max: 16, default: 6, step: 1, control: 'knob' },
      { id: 'down', label: 'Downsample', min: 1, max: 64, default: 4, step: 1, scale: 'log', format: (v) => `÷${v}`, control: 'knob' },
    ],
    process: (chans, sr, p) => {
      const levels = Math.pow(2, p.bits - 1);
      const hold = Math.max(1, Math.round(p.down));
      return mapChannels(chans, (x) => {
        const y = new Float32Array(x.length);
        let held = 0;
        for (let i = 0; i < x.length; i++) {
          if (i % hold === 0) held = Math.round(x[i] * levels) / levels;
          y[i] = held;
        }
        return y;
      });
    },
  },

  equation: {
    name: 'Equation',
    category: 'Math',
    presets: EQUATION_PRESETS,
    help: EQUATION_HELP,
    params: [
      { id: 'expr', type: 'text', prefix: 'y =', default: EQUATION_PRESETS[1].values.expr },
      ...abcKnobs(0.5, 0.3, 0.5),
    ],
    process: (chans, sr, p) => {
      const fn = compileExpr(p.expr, TIME_ARGS);
      return chans.map((inp, ch) => {
        const n = inp.length;
        const out = new Float32Array(n);
        let i = 0;
        let y1 = 0;
        const X = (k) => { k = Math.floor(k); return k >= 0 && k < n ? inp[k] : 0; };
        const Y = (k) => { k = Math.floor(k); return k >= 0 && k < i ? out[k] : 0; };
        for (i = 0; i < n; i++) {
          let v = fn(inp[i], i / sr, i, n, sr, ch, p.a, p.b, p.c, y1, X, Y);
          if (typeof v !== 'number' || !Number.isFinite(v)) v = 0;
          out[i] = v;
          y1 = v;
        }
        return out;
      });
    },
  },

  spectral: {
    name: 'FFT → Equation → IFFT',
    category: 'Spectral',
    presets: SPECTRAL_PRESETS,
    help: SPECTRAL_HELP,
    params: [
      { id: 'mag', type: 'text', prefix: '|X| =', default: SPECTRAL_PRESETS[1].values.mag },
      { id: 'phase', type: 'text', prefix: '∠X =', default: 'phase' },
      {
        id: 'size', label: 'FFT size', control: 'select', default: 2048,
        options: [[256, '256'], [512, '512'], [1024, '1024'], [2048, '2048'], [4096, '4096'],
                  [8192, '8192'], [16384, '16384'], [0, 'Whole sound']],
      },
      ...abcKnobs(0.5, 0.3, 0.5),
    ],
    process: (chans, sr, p) => {
      const fm = compileExpr(p.mag, SPEC_ARGS);
      const fp = compileExpr(p.phase, SPEC_ARGS);
      const keepPhase = p.phase.trim() === 'phase';
      const { a, b, c } = p;
      let mags = null, phs = null, bins = 0;
      const M = (k) => { k = Math.round(k); return k >= 0 && k < bins ? mags[k] : 0; };
      const P = (k) => { k = Math.round(k); return k >= 0 && k < bins ? phs[k] : 0; };
      return chans.map((x, ch) =>
        spectralProcess(x, Number(p.size), (re, im, fr) => {
          bins = fr.N / 2 + 1;
          if (!mags || mags.length !== bins) { mags = new Float64Array(bins); phs = new Float64Array(bins); }
          const binHz = sr / fr.N;
          const t = fr.centerSample / sr;
          const N = fr.N, j = fr.index, sc = fr.scale;
          for (let k = 0; k < bins; k++) {
            mags[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * sc;
            phs[k] = Math.atan2(im[k], re[k]);
          }
          for (let k = 0; k < bins; k++) {
            const mg = mags[k], ph = phs[k], db = 20 * Math.log10(mg + 1e-12), f = k * binHz;
            const rk = re[k] * sc, ik = im[k] * sc;
            let m = fm(mg, ph, db, f, k, N, bins, t, j, sr, ch, a, b, c, M, P, rk, ik);
            let q = keepPhase ? ph : fp(mg, ph, db, f, k, N, bins, t, j, sr, ch, a, b, c, M, P, rk, ik);
            if (typeof m !== 'number' || !Number.isFinite(m)) m = 0;
            if (typeof q !== 'number' || !Number.isFinite(q)) q = ph;
            m /= fr.scale;
            re[k] = m * Math.cos(q);
            im[k] = m * Math.sin(q);
          }
        })
      );
    },
  },
};

function abcKnobs(a, b, c) {
  return [
    { id: 'a', label: 'a', min: 0, max: 1, default: a, step: 0.001, control: 'knob' },
    { id: 'b', label: 'b', min: 0, max: 1, default: b, step: 0.001, control: 'knob' },
    { id: 'c', label: 'c', min: 0, max: 1, default: c, step: 0.001, control: 'knob' },
  ];
}
