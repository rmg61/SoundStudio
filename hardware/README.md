# SoundStudio Pedal: hardware mockup

A digital guitar pedal that SoundStudio (the web app) programs. You design a
sound in the browser (effects chain, equations, FFT effects), then send it to
the pedal over USB. The pedal runs it live on your guitar signal.

The full parts list is in **[BOM.csv](BOM.csv)** (opens in Excel or Google
Sheets, or upload it to a supplier's BOM tool).

**Estimated cost:** about **$160** for the core mockup, **$175** with the
optional mic, speaker and headphone jack. Prices are rough estimates from
November 2026. Check each supplier before you buy.

## Block diagram

```
 Guitar ──► [1/4" IN] ──► Input buffer ──► ┌────────────────────┐ ──► Output buffer ──► [1/4" OUT] ──► Amp
           (1 MΩ, TL072 A)                 │   Daisy Seed       │    (TL072 B)
                                           │  STM32H750 480 MHz │
 9 V DC ──► [DC jack] ─► diode ─► VIN ───► │  24-bit codec      │ ◄── USB ──► PC running SoundStudio
                                           │  64 MB SDRAM       │           (Chrome / Edge)
 6 knobs + 2 sliders ──► ADC 0–7 ────────► │                    │
 Encoder, 2 footswitches, 2 toggles ─────► │  GPIO              │ ──► OLED 128×64 (SPI/I²C)
                                           └────────────────────┘ ──► Bypass + tap LEDs
```

## Why the Daisy Seed

| Need | Daisy Seed |
|---|---|
| Enough power for the app's effects | 480 MHz Cortex-M7 with floating point. Filters, echo, distortion and equations run easily, and STFT/FFT effects run in framed mode |
| Good audio | Built-in 24-bit, 96 kHz stereo codec |
| Long delays and samples | 64 MB SDRAM (about 5 minutes of mono audio at 48 kHz) |
| Knobs and sliders | 12 analog inputs; this design uses 8 |
| Programming from a browser | The official **Daisy Web Programmer** flashes firmware from Chrome over USB (WebUSB). No toolchain needed to update it |
| Community | Many open-source pedal projects, plus the DaisySP DSP library |

Alternatives considered:
- **Teensy 4.1 + Audio Shield:** similar power, but no built-in way to flash from a browser.
- **Raspberry Pi + audio HAT:** could run the JavaScript as-is, but it boots slowly, has more latency, and needs more power.

## How SoundStudio will talk to the pedal

1. **Firmware (once, occasionally):** a C++ "SoundStudio engine" is flashed with the
   Daisy Web Programmer, either the official page or one built into SoundStudio later.
2. **Patches (every time you tweak):** SoundStudio sends the effects chain and
   parameter values over USB using **Web Serial** or **Web MIDI** (Chrome and Edge).
   The pedal stores up to N presets in flash.
3. **Equations:** the browser compiles each formula into a small *bytecode*. The pedal
   runs it with a tiny interpreter, so new formulas don't need new firmware.
4. **Knobs:** the physical knobs and sliders map to `a`, `b`, `c` and effect
   parameters, just like the on-screen knobs.

This is why `js/dsp/` has no browser code: each effect there maps directly to a C++
version on the pedal.

**Limits on the pedal:**
- FFT effects must use framed mode (256–4096). "Whole sound" mode needs the entire
  recording in advance, so it can't run live.
- Effects that look ahead in time, like `X(i + …)` or Reverse, need a buffer and add delay.

## Build in two phases

### Phase 1: bench mockup (breadboard, no soldering except headers)
1. Put the Daisy Seed on a breadboard. Flash the "Blink" example from the Web
   Programmer to check that USB and Chrome work.
2. Add the input/output buffer (TL072, section *Audio I/O* in the BOM) and the two
   1/4" jacks. Flash a pass-through program: guitar in, amp out.
3. Wire the 6 pots and 2 slide pots:
   - Outer legs go to **3V3 analog** and **AGND**, never 5 V or 9 V.
   - The middle leg (wiper) goes to an ADC pin.
4. Add the OLED, encoder, footswitches and LEDs.

### Phase 2: pedal-box mockup
1. Move the circuit to perfboard, with the Daisy Seed on female headers so you can remove it.
2. Drill the enclosure. A **Hammond 1590XX** leaves room for the display and sliders.
   Tayda sells pre-drilled and UV-printed enclosures from a drawing.
3. Panel layout (top view, sliders on the right):
   ```
   ┌───────────────────────────────────────────┐
   │  [ OLED 128×64 ]     (ENC)       ▐  ▐     │
   │                                  ▐  ▐     │  ← 2 sliders
   │  (K1)  (K2)  (K3)                ▐  ▐     │
   │  (K4)  (K5)  (K6)     T1  T2              │  ← toggles
   │                                           │
   │   ● LED                     ● LED         │
   │   ( BYPASS )               ( TAP )        │  ← footswitches
   └───────────────────────────────────────────┘
       IN ◄─ side jacks ─► OUT     DC + USB on top edge
   ```

## Wiring notes and safety
- **Power:** standard **9 V, center-negative** pedal supply. The 1N5817 diode protects
  against reversed polarity. The Daisy Seed regulates its own 3.3 V.
- **Pot voltage:** the Daisy's analog inputs are **3.3 V maximum**. Never connect pots to 9 V.
- **Guitar input:** guitar pickups need about **1 MΩ** input impedance. The TL072 input
  buffer (biased at 4.5 V from the 9 V rail) provides that, and the codec alone would
  dull the tone.
- **Grounds:** keep audio ground (AGND) and digital ground (DGND) separate, and join them
  at one point near the Daisy to avoid noise.
- **USB and 9 V together:** this is fine on the Daisy Seed. For first power-up, use
  USB only, with no 9 V connected.

## Not in the BOM
Tools: soldering iron, solder, wire strippers, multimeter, step drill bit (for the
enclosure), and hand drill.
