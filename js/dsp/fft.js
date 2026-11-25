// Fast Fourier Transform, inverse FFT, and short-time (windowed) versions.
// Pure math, no browser APIs, so it ports directly to hardware later.
//
// Conventions
//   fft(re, im)   forward transform in place:  X[k] = Σ x[n]·e^(−2πi·kn/N)
//   ifft(re, im)  inverse transform in place:  x[n] = (1/N)·Σ X[k]·e^(+2πi·kn/N)
//   N must be a power of two.

const plans = new Map();

export const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;
export const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

function plan(n) {
  let p = plans.get(n);
  if (p) return p;
  if (!isPow2(n)) throw new Error(`FFT size must be a power of two (got ${n})`);
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = Math.sin((2 * Math.PI * k) / n);
  }
  p = { rev, cos, sin };
  plans.set(n, p);
  if (plans.size > 16) plans.delete(plans.keys().next().value);
  return p;
}

// Iterative radix-2 Cooley–Tukey, in place.
export function fft(re, im, inverse = false) {
  const n = re.length;
  if (n <= 1) return;
  const { rev, cos, sin } = plan(n);

  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cos[k];
        const wi = sign * sin[k];
        const a = start + j;
        const b = a + half;
        const tr = wr * re[b] - wi * im[b];
        const ti = wr * im[b] + wi * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr;        im[a] += ti;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

export const ifft = (re, im) => fft(re, im, true);

// Periodic Hann window (sums to a constant under 75% overlap).
export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// Make the spectrum of a real signal consistent: bins above N/2 are the
// complex conjugates of the bins below, and DC / Nyquist are real.
export function mirrorSpectrum(re, im) {
  const n = re.length;
  const h = n >> 1;
  im[0] = 0;
  im[h] = 0;
  for (let k = 1; k < h; k++) { re[n - k] = re[k]; im[n - k] = -im[k]; }
}

/**
 * Analyze → modify → resynthesize.
 *
 * x        input samples (not modified)
 * size     FFT size (power of two), or 0 for ONE FFT over the whole signal
 * editBins callback(re, im, frame) that changes bins 0..N/2 in place.
 *          frame = { index, N, centerSample, scale }
 *          scale converts |X[k]| to linear amplitude (a full-scale sine ≈ 1).
 * returns  new Float32Array, same length as x
 */
export function spectralProcess(x, size, editBins) {
  const len = x.length;
  if (len === 0) return new Float32Array(0);

  // Whole-signal mode: one big FFT, no window, no overlap.
  if (!size) {
    const N = nextPow2(len);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    re.set(x);
    fft(re, im);
    editBins(re, im, { index: 0, N, centerSample: len / 2, scale: 2 / len });
    mirrorSpectrum(re, im);
    ifft(re, im);
    return Float32Array.from(re.subarray(0, len));
  }

  // STFT with Hann analysis + synthesis windows, 75% overlap, overlap-add.
  const N = size;
  const hop = N / 4;
  const win = hann(N);
  const winSum = win.reduce((s, v) => s + v, 0);
  const padded = len + 2 * N;
  const xp = new Float64Array(padded);
  xp.set(x, N);
  const out = new Float64Array(padded);
  const norm = new Float64Array(padded);
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  for (let s = 0, index = 0; s + N <= padded; s += hop, index++) {
    for (let i = 0; i < N; i++) { re[i] = xp[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    editBins(re, im, { index, N, centerSample: s + N / 2 - N, scale: 2 / winSum });
    mirrorSpectrum(re, im);
    ifft(re, im);
    for (let i = 0; i < N; i++) {
      out[s + i] += re[i] * win[i];
      norm[s + i] += win[i] * win[i];
    }
  }

  const y = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const w = norm[i + N];
    y[i] = w > 1e-9 ? out[i + N] / w : 0;
  }
  return y;
}

/**
 * Average magnitude spectrum (Welch's method) of channels[*][start..end),
 * mixed to mono. Returns { db: Float64Array(N/2+1), N } where 0 dB is a
 * full-scale sine.
 */
export function averageSpectrum(channels, start, end, maxN = 8192, maxFrames = 48) {
  start = Math.max(0, Math.floor(start));
  end = Math.min(channels[0].length, Math.ceil(end));
  const range = Math.max(0, end - start);
  const N = Math.max(256, Math.min(maxN, nextPow2(range)));
  const frameLen = Math.min(N, Math.max(1, range));
  const win = hann(frameLen);
  const winSum = win.reduce((s, v) => s + v, 0) || 1;
  const bins = N / 2 + 1;
  const power = new Float64Array(bins);
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  const span = Math.max(0, range - frameLen);
  const frames = Math.max(1, Math.min(maxFrames, Math.floor(span / (frameLen / 2)) + 1));
  const nch = channels.length;

  for (let f = 0; f < frames; f++) {
    const s0 = start + (frames > 1 ? Math.round((span * f) / (frames - 1)) : 0);
    re.fill(0); im.fill(0);
    for (let i = 0; i < frameLen; i++) {
      let v = 0;
      for (let c = 0; c < nch; c++) v += channels[c][s0 + i] || 0;
      re[i] = (v / nch) * win[i];
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) power[k] += re[k] * re[k] + im[k] * im[k];
  }

  const db = new Float64Array(bins);
  const scale = 2 / winSum;
  for (let k = 0; k < bins; k++) {
    const mag = Math.sqrt(power[k] / frames) * scale;
    db[k] = 20 * Math.log10(mag + 1e-12);
  }
  return { db, N };
}
