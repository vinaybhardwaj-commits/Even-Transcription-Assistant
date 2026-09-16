# Conversion specification: 48 kHz S16_LE, any channel count → 16 kHz mono S16_LE

**Design id `eta-u1-dec3-fir121-kaiser8-q16-phase2/1`. Normative.** A second implementation must reproduce the
C9 fixture output byte for byte from this document and the taps file alone. Where this document and code
differ, the code is wrong.

All arithmetic is exact integer arithmetic. No floating point is used anywhere in the conversion.

## 1. Input

`S16_LE`, **C channels interleaved**, 48 000 Hz, where C is the channel count the capture device offers — 1 for a
TONOR TM20, 2 for the Yoga's DMIC. One frame is `2C` bytes, channel `c` occupying bytes `2c` and `2c + 1`, each a
signed 16-bit little-endian integer. Input frames are numbered `n = 0, 1, 2, …` from the start of the stream. **C is a
property of the device and is never requested** (U1 spec §12); it is not recorded in the tape (see §8).

## 2. Downmix — the mean over the channel count

    C == 1:  m[n] = s[n]                       a copy
    C > 1:   m[n] = (Σ_c s_c[n]) / C           the arithmetic mean

**The Mac** (`AudioRing.swift:296-309`) copies a single channel and otherwise takes the mean over `channelCount`,
computed in **Float32**, with no scaling afterwards.

**Here** the mean is exact, and its division is deferred to the output stage so that no rounding happens twice:

    m[n] = Σ_{c=0}^{C−1} s_c[n]

computed exactly in a **signed 32-bit integer** (range −32 768·C … 32 767·C), and the division by C is folded into the
output divisor (§5). For a given C the two formulations agree exactly; deferring the division means the only rounding
in the whole conversion is the single one at §5. **There is no halving and no rounding at this step**, so the negative
half-step does not arise: `C = 2, s = (−1, 0)` gives `m = −1` exactly and, in steady state, output 0.

**This replaces the earlier wording `m = L + R`,** which named the sum as the rule and hid the ÷2 in the output shift.
For C = 2 the arithmetic is unchanged and every existing C9 output stays bit-identical; for C = 1 the earlier wording
had no rule at all, and a mono device run through the C = 2 divisor would have been attenuated by 6 dB.

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

    divisor = C · 2¹⁶                            (C = 1 → 65 536;  C = 2 → 131 072)
    y[k] = floor( (acc[3k + 2] + divisor / 2) / divisor )

This divides by C (the downmix mean) and by 2¹⁶ (Q16) in one step and **rounds exact halves toward +∞**. For C = 2 it
is exactly `(acc + 65 536) >> 17`, the previous rule, which is why no existing fixture output changes.
**This is floor division, never truncation toward zero**; the two differ for every negative accumulator that is not an
exact multiple, so a port that uses `/` on a signed integer (or a C right shift of a negative value,
implementation-defined before C++20) is non-conforming. Examples at C = 2: `acc = 65 536` (+0.5) → 1;
`acc = −65 536` (−0.5) → 0; `acc = −196 608` (−1.5) → −1. In steady state a DC input `s = (−1, 0)` therefore converts
to 0, `(0, 1)` to 1, and `(−3, −2)` to −2. At C = 1 the same rule applies with divisor 65 536: DC `s = −1` converts to
−1 (a mono copy is unity gain, not half).

Then clip: `y > 32 767 → 32 767`; `y < −32 768 → −32 768`. Written as `S16_LE`, 1 channel, 16 000 Hz.

Because the mean, not the sum, is the rule, a C-channel input at full scale on every channel converts to full scale,
not to C times it: the conversion has unity gain at DC for every channel count.

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

## 7. Where this differs from the Mac, deliberately

Two differences, both consequences of rulings, not of convenience:

- **Float32 versus exact integer.** The Mac's mean is Float32 and its resampling is `AVAudioConverter`; ours is exact
  integer throughout. U0 spec §4 rules the audio content deterministic and specified per platform, not bit-identical.
- **The reset at a discontinuity** (§6), which the Mac does not do (U1 spec §11.4).

Everything else about the downmix — copy at C = 1, mean at C > 1, no scaling afterwards — is the Mac's rule as read at
`AudioRing.swift:296-309`.

## 8. What the tape does not say

The fifteen index keys (`TapeFormat.swift:34-49`) hold no channel field, on either platform, so **no tape can tell you
what channel count its downmix used**. `input_sample_rate` is recorded; C is not. That is the Mac's gap and it is
inherited deliberately: the format is not ours to extend. See `spec/RECORDER-RECORDS-LINUX.md`.

## 9. The fixture (C9)

`fixtures/good/c9-resample-tones`: `input-48k.pcm` (2 channels: synthesised tones, DC and square waves, 134 402 frames,
≡ 2 mod 3 so the leftover rule is exercised), `expected-16k-mono.pcm` (44 800 samples),
`expected-16k-mono-regions.pcm` (resets before frames 52 801 and 100 800; 44 799 samples, one frame of an incomplete
group dropped at 52 801), and a copy of the taps file. `fixtures/good/c9-resample-mono` runs a 1-channel input through
the copy path. `fixtures/good/c9-direction-probe` runs the 2-channel input with the asymmetric probe taps. Each manifest
carries this specification field by field, including its `channel_count`, and the negative controls include a downmix
that sums instead of averaging and a mono input attenuated as if C were 2.
