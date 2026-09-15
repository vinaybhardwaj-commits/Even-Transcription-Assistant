# Conversion specification: 48 kHz stereo S16_LE → 16 kHz mono S16_LE

**Design id `eta-u1-dec3-fir121-kaiser8-q16-phase2/1`. Normative.** A second implementation must reproduce the
C9 fixture output byte for byte from this document and the taps file alone. Where this document and code
differ, the code is wrong.

All arithmetic is exact integer arithmetic. No floating point is used anywhere in the conversion.

## 1. Input

`S16_LE`, 2 channels interleaved `L, R, L, R, …`, 48 000 Hz. One frame is 4 bytes: `L` = bytes 0–1, `R` = bytes 2–3,
each a signed 16-bit little-endian integer. Input frames are numbered `n = 0, 1, 2, …` from the start of the stream.

## 2. Downmix

    m[n] = L[n] + R[n]

computed exactly in a **signed 32-bit integer**. Range −65 536 … 65 534. There is **no halving and no rounding at
this step**; the factor ½ is applied once, in the output shift (§5). The negative half-step therefore does not
arise here: `L = −1, R = 0` gives `m = −1` exactly.

## 3. Low-pass FIR

- **Taps:** the 121 signed integers in `fir-48k-to-16k-121tap-q16.taps`, one decimal integer per line, each line
  terminated by `\n`, in order `h[0] … h[120]`. SHA-256 of the file:
  `fca3925aba6ed89851da0169ba2b09f471b11badd1259e5b77d11eb6f9ff146f`.
  The integers are normative. They are symmetric (`h[i] = h[120 − i]`), sum to exactly **65 536** (Q16, unity
  DC gain), centre tap `h[60] = 19 120`, sum of absolute values 127 528.
- **Design (provenance, not normative):** windowed sinc, cut-off **7 000 Hz** (the −6 dB point) at 48 000 Hz,
  **Kaiser window, β = 8.0**, scaled by 2¹⁶, each tap rounded half away from zero, residual added to the centre tap
  so the sum is exactly 65 536. Tool: `tools/design_fir.py 121 7000 8.0 16`. Response of the integer taps:
  0–6 000 Hz within ±0.002 dB; −6.02 dB at 7 000 Hz; ≤ −69.1 dB at every frequency from 8 000 Hz to 24 000 Hz.
- **Accumulator:** a **signed 64-bit integer**:

      acc[n] = Σ_{i=0}^{120} h[i] · m[n − i],   with m[j] = 0 for every j < 0

  **Index direction:** `h[0]` multiplies the newest sample `m[n]` and `h[120]` the oldest, `m[n − 120]`. Because
  the production taps are symmetric this cannot be seen in their output, so C9 also runs a deliberately asymmetric
  direction-probe tap set (`h[0]=32768, h[1]=16384, h[2]=8192, h[120]=8192`, others 0) through the same arithmetic;
  an implementation that reads the index backwards fails it.

  Filter history is zero at stream start and at every discontinuity (§6). |acc| ≤ 65 536 × 127 528 = 8 357 675 008, which exceeds the 32-bit
  range, so a 32-bit accumulator is non-conforming.

## 4. Decimation

Factor **3**, phase **2**. Output sample `k = 0, 1, 2, …` is computed from `acc[3k + 2]`. An output sample is
produced only when the complete group of input frames `3k, 3k+1, 3k+2` has arrived. For `F` input frames the
output holds exactly `floor(F / 3)` samples; up to two trailing frames produce no output. Samples below index 2 are
never emitted, so output 0 already includes frames 0, 1 and 2.

## 5. Output rounding and clipping

    y[k] = (acc[3k + 2] + 65 536) >> 17          (arithmetic shift right, i.e. floor division by 131 072)

This divides by 2 (the downmix) and by 2¹⁶ (Q16) in one step and **rounds exact halves toward +∞**.
**`>> 17` here means floor division of `acc + 65 536` by 131 072, never truncation toward zero**; the two differ
for every negative accumulator that is not an exact multiple, so a port that uses `/` on a signed integer (or a C
right shift of a negative value, implementation-defined before C++20) is non-conforming. Examples:
`acc = 65 536` (+0.5) → 1; `acc = −65 536` (−0.5) → 0; `acc = −196 608` (−1.5) → −1. In steady state a DC input
`L = −1, R = 0` therefore converts to 0, `L = 0, R = 1` to 1, and `L = −3, R = −2` to −2.

Then clip: `y > 32 767 → 32 767`; `y < −32 768 → −32 768`. Written as `S16_LE`, 1 channel, 16 000 Hz.

## 6. Streaming, stream start and discontinuities

Output is independent of how input frames are split across calls: the FIR history and the position within the
current 3-frame group carry across calls.

**At stream start and at every discontinuity the converter resets** (U1 spec §11.4): history becomes zero, and the
next input frame is frame 0 of a new group. Frames of an incomplete group buffered before the reset — at most two —
produce no output. Each region therefore converts exactly as if it were a stream of its own, and a region replayed
in isolation gives identical bytes. (The Mac's `AVAudioConverter` does not reset; that difference is deliberate.)

**Cost, a known characteristic of every region, not a defect.** Output `k` of a region reads input frames
`3k+2−120 … 3k+2`, so it depends on the zero history while `3k + 2 < 120`: the first **40 output samples, 2.5 ms**, at
most. Measured against a carried-history conversion: 40 samples differ for a 1 kHz tone, 35 for DC.

## 7. The fixture (C9)

`fixtures/good/c9-resample-tones`: `input-48k-stereo.pcm` (synthesised tones, DC and square waves, 134 402 frames,
≡ 2 mod 3 so the leftover rule is exercised), `expected-16k-mono.pcm` (44 800 samples, sha256 `49de9022…`),
`expected-16k-mono-regions.pcm` (resets before frames 52 801 and 100 800; 44 799 samples, one frame of an incomplete
group dropped at 52 801), and a copy of the taps file. `fixtures/good/c9-direction-probe` runs the same input with
the asymmetric probe taps. Each manifest carries this specification field by field.
