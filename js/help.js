// Content and behavior of the Help guide for writing equations.

const TIME_VARS = [
  ['x', 'The current input sample: the height of the waveform right now.', '−1 … 1'],
  ['t', 'Time since the start of the sound, in seconds.', '0 … length'],
  ['i', 'Sample index (sample number). t = i / sr.', '0 … n−1'],
  ['n', 'Total number of samples in the sound.', 'e.g. 661 500'],
  ['sr', 'Sample rate: samples per second.', '44 100 or 48 000'],
  ['ch', 'Channel number: 0 = left (or mono), 1 = right.', '0, 1'],
  ['a  b  c', 'The three knobs on the effect card.', '0 … 1'],
  ['y1', 'The previous OUTPUT sample (what your formula returned one sample ago). Lets you build feedback and filters.', '−1 … 1'],
  ['X(k)', 'Input sample at any index k. X(i − sr) is the sample one second ago. Outside the sound it returns 0.', '−1 … 1'],
  ['Y(k)', 'An earlier OUTPUT sample at index k (only k < i). Y(i − 100) is your output 100 samples ago.', '−1 … 1'],
];

const SPEC_VARS = [
  ['mag', 'Strength (magnitude) of this frequency bin. A full-volume sine wave reads about 1.', '0 … ~1'],
  ['db', 'The same strength in decibels: 20·log10(mag). 0 dB = full scale, −60 dB = very quiet.', '−240 … 0'],
  ['phase', 'Phase angle of this bin, in radians: where in its cycle this frequency is.', '−π … π'],
  ['re  im', 'Real and imaginary parts of the bin (another way of writing mag and phase).', '−1 … 1'],
  ['f', 'Frequency of this bin, in Hz.', '0 … sr/2'],
  ['k', 'Bin index. f = k · sr / N.', '0 … N/2'],
  ['N', 'FFT size (samples per frame), chosen with the FFT size menu.', '256 … 16384'],
  ['bins', 'Number of bins per frame = N/2 + 1.', ''],
  ['t', 'Time of the center of the current frame, in seconds.', '0 … length'],
  ['j', 'Frame number.', '0, 1, 2 …'],
  ['sr', 'Sample rate.', '44 100 …'],
  ['ch', 'Channel: 0 = left, 1 = right.', '0, 1'],
  ['a  b  c', 'The three knobs on the effect card.', '0 … 1'],
  ['M(k)', 'Magnitude of ANY bin k in this frame. M(k+1) is the next bin up. Lets you move or blend frequencies.', '0 … ~1'],
  ['P(k)', 'Phase of any bin k in this frame.', '−π … π'],
];

const TIME_EXAMPLES = [
  ['Make it quieter', 'Multiply every sample by a number below 1. Knob a sets the volume.', { expr: 'x * a' }],
  ['Add a 440 Hz tone', 'sin(2·π·f·t) is a pure tone at f Hz. 0.3 keeps it from being too loud.', { expr: 'x + 0.3 * sin(2*PI*440*t)' }],
  ['Tremolo', 'Volume wobbles with a slow sine wave. b sets the speed (1–16 Hz), a the depth.', { expr: 'x * (1 - a * 0.5 * (1 + sin(2*PI*(1 + b*15)*t)))' }],
  ['Fade out over the whole sound', '1 − i/n goes from 1 at the start to 0 at the end.', { expr: 'x * (1 - i/n)' }],
  ['Distort only when loud', 'A condition: if |x| is above a, squash it; otherwise leave it alone.', { expr: 'abs(x) > a ? sign(x) * a : x' }],
  ['Echo', 'Add the sample from b × 0.6 s ago, at volume a.', { expr: 'x + a * X(i - sr*(0.05 + b*0.6))' }],
  ['Simple low-pass filter', 'Each output moves part-way from the last output toward the input. Small a = darker.', { expr: 'y1 + (0.005 + a*a) * (x - y1)' }],
  ['Left/right ping-pong', 'Left channel loud on even half-seconds, right on odd ones.', { expr: 'x * ((floor(t*2) % 2) == ch ? 1 : 0.15)' }],
];

const SPEC_EXAMPLES = [
  ['Remove everything above 1 kHz', 'Keep a bin only if its frequency is below 1000 Hz.', { mag: 'f < 1000 ? mag : 0', phase: 'phase' }],
  ['Remove the bass', 'Keep only frequencies above 300 Hz.', { mag: 'f > 300 ? mag : 0', phase: 'phase' }],
  ['Denoise', 'Quiet bins are usually noise. Drop any bin quieter than a threshold set by knob a.', { mag: 'db > -90 + a*70 ? mag : 0', phase: 'phase' }],
  ['Robot voice', 'Setting every phase to 0 removes natural pitch movement.', { mag: 'mag', phase: '0' }],
  ['Whisper', 'Random phases keep the tone color but destroy the pitch.', { mag: 'mag', phase: 'random() * tau' }],
  ['Boost the treble', 'Multiply bins above 3 kHz by up to 4× (knob a).', { mag: 'f > 3000 ? mag * (1 + a*3) : mag', phase: 'phase' }],
  ['Shift pitch up an octave', 'Bin k takes its value from bin k/2, so every frequency doubles.', { mag: 'M(k/2)', phase: 'P(k/2)' }],
];

const BUILDER_VARS = [
  ['y', 'The wave so far: the result of all the lines above this one at this moment. On the first line it is 0 (silence).', '−1 … 1 (ish)'],
  ['t', 'Time in seconds since the start.', '0 … length'],
  ['i', 'Sample index. t = i / sr.', '0 … n−1'],
  ['n', 'Total number of samples. n / sr is the length in seconds.', ''],
  ['sr', 'Sample rate (samples per second).', '44 100 / 48 000'],
  ['ch', 'Channel: 0 = left, 1 = right (when Stereo is on).', '0, 1'],
  ['a  b  c', 'The three Wave Builder knobs.', '0 … 1'],
  ['y1', 'This line’s own previous output sample. Use it for smoothing / filters.', ''],
  ['Y(k)', 'The wave from the lines above at ANY index k. Y(i − sr/4) is a quarter second ago (echo).', ''],
  ['O(k)', 'This line’s own EARLIER output at index k (k < i). Lets a line feed back into itself (plucked strings, resonators).', ''],
];

const BUILDER_EXAMPLES = [
  ['Sine tone', 'A pure tone at 220 Hz. tau = 2π, so tau·f·t goes round f times a second.', { expr: 'y + 0.5 * sin(tau * 220 * t)' }],
  ['Sawtooth', 'saw(p) is a bright buzzy wave. Its argument is the phase in cycles: f·t.', { expr: 'y + 0.3 * saw(110 * t)' }],
  ['Square', 'square(p, duty) jumps between +1 and −1. duty = 0.5 is a perfect square.', { expr: 'y + 0.3 * square(220 * t)' }],
  ['Triangle', 'tri(p) is soft and flute-like.', { expr: 'y + 0.4 * tri(330 * t)' }],
  ['Fade out (decay)', 'Multiply by a falling curve. Bigger number = faster fade.', { expr: 'y * exp(-3 * t)' }],
  ['Fade in (attack)', 'Ramp from 0 to 1 over the first 0.05 s.', { expr: 'y * min(1, t / 0.05)' }],
  ['Echo', 'Add the wave from a quarter second ago, half as loud.', { expr: 'y + 0.5 * Y(i - sr / 4)' }],
  ['Soft clip', 'tanh squashes loud parts smoothly: warm distortion.', { expr: 'tanh(2 * y)' }],
  ['Low-pass (smooth)', 'Move part-way toward the input each sample. Smaller number = darker.', { expr: 'y1 + 0.05 * (y - y1)' }],
  ['Tremolo', 'Wobble the volume 6 times a second.', { expr: 'y * (0.6 + 0.4 * sin(tau * 6 * t))' }],
  ['Pitch from a knob', 'Knob a sets the pitch from 100 to 1000 Hz.', { expr: 'y + 0.5 * sin(tau * (100 + a * 900) * t)' }],
];

const FUNCTION_GROUPS = [
  ['Oscillators (p = phase in cycles, e.g. 220*t)', [['sin(tau * p)', 'sine'], ['saw(p)', 'sawtooth −1…1'], ['square(p, duty)', 'square / pulse, duty 0…1 (default 0.5)'], ['tri(p)', 'triangle −1…1']]],
  ['Basic', [['abs(v)', 'absolute value'], ['sign(v)', '−1, 0 or 1'], ['min(a, b, …)', 'smallest'], ['max(a, b, …)', 'largest'], ['clamp(v, lo, hi)', 'limit v to lo…hi']]],
  ['Powers & roots', [['pow(v, p)', 'v to the power p (same as v ** p)'], ['sqrt(v)', 'square root'], ['cbrt(v)', 'cube root'], ['exp(v)', 'e to the power v'], ['hypot(a, b)', '√(a² + b²)']]],
  ['Logarithms', [['log(v)', 'natural log'], ['log2(v)', 'log base 2 (octaves)'], ['log10(v)', 'log base 10 (decibels)']]],
  ['Trigonometry (radians)', [['sin(v)  cos(v)  tan(v)', ''], ['asin  acos  atan', 'inverse'], ['atan2(y, x)', 'angle of a point'], ['sinh  cosh  tanh', 'tanh is a smooth soft-clipper']]],
  ['Rounding', [['floor(v)', 'round down'], ['ceil(v)', 'round up'], ['round(v)', 'nearest whole number'], ['trunc(v)', 'drop the decimals']]],
  ['Randomness & blending', [['random()', '0 … 1'], ['noise()', '−1 … 1 white noise'], ['lerp(a, b, t)', 'blend: a when t = 0, b when t = 1']]],
  ['Constants', [['PI  (or pi)', '3.14159…'], ['tau', '2π = one full cycle'], ['E', '2.71828…']]],
];

const SYNTAX = [
  ['+  −  *  /', 'add, subtract, multiply, divide', 'x * 0.5'],
  ['%', 'remainder (useful for repeating patterns)', 't % 1'],
  ['**', 'power', 'x ** 3'],
  ['( )', 'grouping: what is inside is worked out first', '(x + 1) / 2'],
  ['<  >  <=  >=  ==  !=', 'comparisons (true or false)', 'f < 1000'],
  ['&&  ||  !', 'and, or, not', 't > 1 && t < 2'],
  ['cond ? A : B', 'if cond is true use A, otherwise B', 'x > 0 ? x : 0'],
];

const TIPS = [
  'Write the formula for <b>one</b> sample (or one frequency bin); the app runs it for every one.',
  'Keep time-domain output roughly between −1 and 1. Louder values clip when exported; wrap with <code>clamp(…, -1, 1)</code> or add a Normalize effect after.',
  'Angles are in <b>radians</b>. A tone at f Hz is <code>sin(2*PI*f*t)</code>.',
  'Names are case-sensitive: <code>sin</code>, not <code>Sin</code>; <code>PI</code> (or <code>pi</code>), not <code>Pi</code>.',
  'Use the knobs: write <code>a</code>, <code>b</code> or <code>c</code> where you want a value you can turn live. Scale them: <code>200 + a*2000</code> turns a 0…1 knob into 200…2200.',
  'If something is wrong, the effect card shows the error in red and the sound passes through unchanged.',
  'Bigger FFT sizes give finer frequency detail but smear sharp sounds in time; smaller sizes do the opposite. "Whole sound" gives the finest detail of all.',
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function varTable(rows) {
  return `<table class="help-table"><thead><tr><th>Name</th><th>Meaning</th><th>Range</th></tr></thead><tbody>${
    rows.map(([n, m, r]) => `<tr><td><code>${esc(n)}</code></td><td>${m}</td><td class="muted">${r}</td></tr>`).join('')
  }</tbody></table>`;
}

function examples(rows, type) {
  return `<div class="help-examples">${rows.map(([title, desc, values], idx) => `
    <div class="help-ex">
      <div class="help-ex-head"><b>${title}</b>
        <button class="btn try-btn" data-type="${type}" data-idx="${idx}">Try it</button></div>
      ${Object.entries(values).filter(([, v]) => v !== 'phase' && v !== 'mag')
        .map(([k, v]) => `<code class="help-formula">${k === 'expr' ? 'y' : k === 'mag' ? '|X|' : '∠X'} = ${esc(v)}</code>`).join('')}
      <div class="muted">${desc}</div>
    </div>`).join('')}</div>`;
}

const PAGES = {
  time: () => `
    <p class="help-lead">The <b style="color:#ffb547">Equation</b> effect runs your formula once for
      <b>every sample</b> of the sound. Whatever the formula gives back becomes the new sample <code>y</code>.
      A 10-second sound at 44.1 kHz runs it 441 000 times per channel.</p>
    <div class="help-callout">Start simple: <code>y = x</code> changes nothing, <code>y = x * 0.5</code> halves the volume, <code>y = -x</code> flips the wave upside down.</div>
    <h3>Variables</h3>${varTable(TIME_VARS)}
    <h3>Examples</h3>${examples(TIME_EXAMPLES, 'time')}`,
  fft: () => `
    <p class="help-lead">The <b style="color:#5fb3ff">FFT → Equation → IFFT</b> effect works on <b>frequencies</b>
      instead of samples. It cuts the sound into short overlapping frames, turns each frame into a list of
      frequency <b>bins</b> (the FFT), runs your two formulas on every bin, then turns the result back into sound (the inverse FFT).</p>
    <div class="help-callout">Each bin has a <b>magnitude</b> (how loud that frequency is) and a <b>phase</b>
      (where it is in its cycle). <code>|X| =</code> sets the new magnitude, <code>∠X =</code> sets the new phase.
      Leave them as <code>mag</code> and <code>phase</code> to change nothing.</div>
    <h3>Variables</h3>${varTable(SPEC_VARS)}
    <h3>Examples</h3>${examples(SPEC_EXAMPLES, 'fft')}`,
  builder: () => `
    <p class="help-lead">The <b style="color:#c6ff4f">Wave Builder</b> makes a sound from nothing but math.
      It starts with silence, then runs your lines <b>top to bottom</b>. Each line receives <code>y</code>
      (the wave built by the lines above) and returns the new <code>y</code>.</p>
    <div class="help-callout">Line 1: <code>y = sin(tau * 220 * t)</code> makes a tone.
      Line 2: <code>y = y + 0.5 * sin(tau * 440 * t)</code> adds a second tone on top.
      Line 3: <code>y = y * exp(-2 * t)</code> makes it fade out.<br>
      Press <b>Enter</b> in a line to add a new one below. Add notes after <code>//</code>.
      Use <b>Use as Original →</b> to send the result to the effects chain.</div>
    <h3>Variables</h3>${varTable(BUILDER_VARS)}
    <h3>Examples (Try it adds the line to the bottom)</h3>${examples(BUILDER_EXAMPLES, 'builder')}`,
  syntax: () => `
    <h3>Operators</h3>
    <table class="help-table"><thead><tr><th>Write</th><th>Meaning</th><th>Example</th></tr></thead><tbody>${
      SYNTAX.map(([w, m, e]) => `<tr><td><code>${esc(w)}</code></td><td>${m}</td><td><code>${esc(e)}</code></td></tr>`).join('')
    }</tbody></table>
    <h3>Functions</h3>
    <div class="help-funcs">${FUNCTION_GROUPS.map(([g, fs]) => `
      <div class="help-func-group"><h4>${g}</h4>${fs.map(([f, d]) =>
        `<div><code>${esc(f)}</code> <span class="muted">${d}</span></div>`).join('')}</div>`).join('')}
    </div>
    <h3>Tips</h3><ul class="help-tips">${TIPS.map((t) => `<li>${t}</li>`).join('')}</ul>`,
};

export function initHelp({ onTry }) {
  const dlg = document.getElementById('helpDialog');
  const body = dlg.querySelector('.help-body');
  const tabs = dlg.querySelectorAll('.help-tab');

  const show = (page) => {
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.page === page)));
    body.innerHTML = PAGES[page]();
    body.scrollTop = 0;
  };
  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.page)));
  dlg.querySelector('.help-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // click backdrop

  body.addEventListener('click', (e) => {
    const btn = e.target.closest('.try-btn');
    if (!btn) return;
    const kind = btn.dataset.type;
    const list = { time: TIME_EXAMPLES, fft: SPEC_EXAMPLES, builder: BUILDER_EXAMPLES }[kind];
    const [, , values] = list[Number(btn.dataset.idx)];
    onTry({ time: 'equation', fft: 'spectral', builder: 'builder' }[kind], values);
    dlg.close();
  });

  const open = (page = 'time') => { show(page); if (!dlg.open) dlg.showModal(); };
  document.getElementById('helpBtn').addEventListener('click', () => open('time'));
  return { open };
}
