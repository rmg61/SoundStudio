# SoundStudio

A browser-based workbench for capturing sounds and reshaping their waveforms
with knobs, sliders, filters and your own math equations.

**Version 0.1** — plain HTML/CSS/JavaScript, no build step, no dependencies.

## Features

- **Get a sound:** open a file (WAV, MP3, FLAC, OGG, M4A… anything your browser
  can decode), drag and drop one onto the page, record from your microphone,
  or pick one of 7 bundled examples.
- **Original stays intact:** the left panel always shows the untouched original;
  the right panel shows the processed result.
- **Waveform view:** time axis, amplitude grid, min/max envelope when zoomed out,
  individual sample points when zoomed in. Mouse wheel zooms at the pointer,
  drag (or Shift + wheel) scrolls, click sets the play cursor.
- **Zoom Sync:** each panel zooms on its own unless Zoom Sync is on.
- **Effects chain:** low-pass, high-pass, band-pass, notch, peak EQ, gain,
  normalize, fade in/out, reverse, echo, distortion, bit crusher and a custom
  **Equation** effect (`y = f(x, t, i, …)` with knobs `a`, `b`, `c`).
  Effects can be reordered, bypassed and removed.
- **FFT → Equation → IFFT:** transform to the frequency domain, rewrite every
  bin's magnitude and phase with formulas (`|X| = …`, `∠X = …`), and transform
  back. Frame size 256–16384 (overlap-add STFT) or one FFT of the whole sound.
  Presets include brick-wall filters, denoise, robot voice, whisper,
  spectral pitch shift, tilt, comb and blur.
- **Spectrum view:** a rainbow FFT plot under each waveform shows the
  frequency content of the visible time range; hover for frequency/level.
- **Wave Builder:** build a sound from math, line by line. Each line takes `y`
  (the result of the lines above) and returns a new `y`. Oscillators
  `saw()`, `square()`, `tri()`, feedback (`O(k)`), delays (`Y(k)`), stereo,
  10 templates (bell, kick, plucked string, wind…), and **Use as Original →**
  to send the result through the effects chain.
- **Three displays on one row:** Original | Processed | Built wave, each with
  a **⧉ Pop out** button that moves it into its own window (e.g. another
  monitor). Close that window or click *Bring back* to dock it again.
- **Resizable windows:** drag the grips under any waveform or spectrum, and
  the dividers between panels. Double-click to reset; sizes are remembered.
- **Help → Equation guide:** how to write formulas, every variable explained,
  operators and functions, tips, and examples with a "Try it" button.
- Processing runs in a background Web Worker, so the page stays smooth.
- **Export** the processed sound as a 16-bit WAV.

## Running it locally

Browsers block JavaScript modules and microphone access on `file://` pages,
so serve the folder with a local web server. With Python installed:

```bash
python serve.py
```

(`serve.py` is `python -m http.server` with browser caching turned off, so a
normal refresh always shows your latest changes.)

Then open <http://localhost:8000>.

## Hosting on GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo, go to **Settings → Pages**, choose **Deploy from a branch**,
   pick `main` and `/ (root)`, and save.
3. The site appears at `https://<your-username>.github.io/<repo-name>/`.

GitHub Pages serves over HTTPS, so microphone recording works there.

## Project layout

```
index.html            page structure
css/style.css         styling
js/main.js            app wiring: loading, recording, playback, effects UI, export
js/dsp-worker.js      background thread that runs the effects chain
js/help.js            the Equation guide (Help menu)
js/builder.js         the Wave Builder window
js/resize.js          drag-to-resize grips and dividers
js/dsp/synth.js       line-by-line synthesis + templates (no browser APIs)
js/dsp/fft.js         FFT, inverse FFT, STFT/overlap-add, spectrum analysis
js/waveform-view.js   zoomable waveform panel
js/controls.js        knob & slider controls
js/wav.js             WAV encoder
js/examples.js        list of bundled example sounds
js/dsp/biquad.js      filter math (no browser APIs)
js/dsp/effects.js     effect definitions (no browser APIs)
samples/              example sounds + CREDITS.md
```

The `js/dsp/` code is plain math with no browser dependencies, so it can be
ported to future hardware (an MCU or small computer with physical knobs).
