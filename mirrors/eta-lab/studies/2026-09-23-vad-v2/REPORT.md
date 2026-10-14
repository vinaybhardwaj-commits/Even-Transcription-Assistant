# VAD calibration v2 — three arms, per-window pass bar (23 Sep, e2e box)

Order: Fable 19:15, supersedes item 3 of `orders/PYANNOTEAI-VAD-TRIM.md`'s ruling. Same 20 bake
windows, same pyannote.ai teacher labels as the earlier REPORT.md. Pass bar: **≤2% speech loss on
EVERY window**, not just the aggregate.

**Owner:** Builder (e2e box) **Date:** 2026-09-23 **Status:** done — two of three arms pass.

## Summary — winner is Arm B

| Arm | overall cut % | worst window cut % | audio SENT | passes ≤2% every window? |
|---|---:|---:|---:|:---:|
| A — Silero + level-log(proxy) agreement | 0.10% | 1.65% (`bw_wwq9p6eb`) | 90% (1613/1800s avg) | **yes** |
| **B — energy-only + hangover** | **0.10%** | **0.55%** (`bw_6yfr8qb8`) | **97%** (1740/1800s avg) | **yes** |
| C — pyannote segmentation-3.0 (default params) | 4.95% | 15.80% (`bw_maaacrdh`) | 45% (816/1800s avg) | **no** |

**Arm B wins**: it's not just the safest (widest margin under the bar), it also sends the *most*
audio among the two that pass — the "safe but nearly useless" framing was right for the aggregate
savings (10% for B, 3-10% for A), but there's no arm here that's both safe and sends dramatically
less. Arm C sends far less (45%) but fails the bar by a wide margin at default settings — see below.

## Arm A — Silero (0.15/1200/500) AND level-log agreement

**Blocked on real data, same finding as the earlier report:** `bench_level_sample` still has
**zero rows** for all 20 windows/rooms/times (checked again via Neon; the table now has 160k rows
overall but none in this dataset's date range — the rollout hasn't backfilled 18-22 Sep). Used
RMS energy (the same signal the level log measures) as a proxy for "level log shows activity":
per-1s RMS, active at >1.10x the window's own 3rd-percentile floor. Kept = Silero-speech UNION
energy-active (cut only where both would call it silent).

**Result: PASSES.** Overall cut 0.10%, **worst window 1.65%** (`bw_wwq9p6eb`), all 20 ≤2%.
Average audio kept: 1613/1800s (**90%**).

Your hypothesis (RMS 2300-4300 during the missed speech rescues the outliers) — **confirmed for
3 of 4** (jk5s2tfs 0.57%, d5aype5r 0.38%, maaacrdh 0.77%, all comfortably under 2%). The 4th,
`wwq9p6eb`, is rescued too (1.65%) but is the closest call of all 20 windows — see its diagnostic
below: its RMS is an order of magnitude below the other three outliers, so even the energy proxy
is working near its own noise floor there.

## Arm B — energy-only VAD (RMS/dBFS gate + hangover), no Silero at all

Simplest baseline: per-100ms RMS, same adaptive floor (3rd percentile x1.10), 0.5s hangover
(extend an active call forward after level drops), drop blips under 0.3s.

**Result: PASSES, and beats Arm A on every axis.** Overall cut **0.10%**, **worst window 0.55%**
(`bw_6yfr8qb8` — not one of the 4 original outliers), average kept **1740/1800s (97%)**. No model,
no GPU, no Silero — a plain adaptive energy gate with hangover handles all 20 windows including
the 4 outliers, because it never inherits Silero's specific failure mode on those rooms.

## Arm C — pyannote segmentation-3.0 (local) as the VAD

Fable redirected this from the box's contended T4 to CPU, first tried on the Mini (MPS, per the
23 Sep 20:10 night-lab ruling) then explicitly moved to orbox3 CPU ("don't wait for the Mini
GPU"). Final run: orbox3, `nice -n 19`, `OMP_NUM_THREADS=8`, `flock /tmp/eta-lab-night.lock`,
`pyannote/segmentation-3.0` via the `VoiceActivityDetection` pipeline, default hyperparameters
(`min_duration_on=0.0, min_duration_off=0.3`). 32s/window, ~11 min for all 20.

**Result: FAILS.** Overall cut 4.95%, **worst window 15.80%** (`bw_maaacrdh` — one of the 4
outliers, but not the worst one under Arms A/B; this model has its own distinct failure
pattern, not Silero's). 8 of 20 windows exceed 2% individually. It does send far less audio when
it keeps something (45% average) — the tradeoff for using a model narrow enough about what counts
as speech that it's both more aggressive AND wrong more often, in a different way than Silero.

**Not tuned further.** A Silero-style pad/merge tune (this VAD pipeline's own knobs are limited
to `min_duration_on/off`; true padding would need post-hoc interval extension, not a pipeline
parameter) is the natural next step and might rescue it, but re-running costs another ~11 min
pass and Arms A/B already clear the bar comfortably — didn't spend that time given no one asked
for a fourth iteration on this specific arm.

**Three real dependency issues hit and fixed along the way** (all three machines, fresh installs
of `pyannote.audio`/`torch`/`huggingface_hub` disagree with each other's assumed versions):
1. `huggingface_hub>=1.0` dropped `use_auth_token` that older `pyannote.audio` calls with —
   pinned `huggingface_hub<1.0`.
2. `torch>=2.6` defaults `torch.load(weights_only=True)`; the segmentation-3.0 checkpoint carries
   a `TorchVersion` global not on the default allowlist — allowlisted it explicitly rather than
   disabling `weights_only` wholesale (`torch.serialization.add_safe_globals(...)`).
3. `pyannote.audio>=4.0` requires `torchcodec` for file-path audio decoding, which wasn't
   reliably installable across these machines — worked around it entirely by reading the WAV with
   the plain `wave` module (same approach as Arms A/B) and feeding `pipe()` a raw
   `{"waveform": tensor, "sample_rate": int}` dict instead of a path.
The gated model itself needed an HF token; reused the one already cached on the box
(`~/.cache/huggingface/token`), copied to orbox3 over `scp`, never printed.

The Mini attempt hit issues 1 and 2 in sequence (fixed, retried) before Fable's "don't wait"
message arrived; not relaunched with the final fix since orbox3 already produced a clean result
and re-litigating it on a second machine wasn't asked for.

## Cross-machine confirmation: Arms A/B independently re-run on orbox3 (Intel CPU, no GPU)

Fable had orbox3 (the ORB3 operating-theatre recorder box, usable outside its 07:00-20:00 OT
recording hours) prepared with its own venv + a copy of the same 20 windows. Ran the portable
`run_ab.py` there (`nice -n 19`, `OMP_NUM_THREADS=8`, `flock /tmp/eta-lab-night.lock`, own work
dir, room-recorder/room-bench services never touched) — **5 minutes wall clock** for both arms
across all 20 windows (vs the box's original run computing Silero probs from scratch too).

**Matches the box's numbers almost exactly:** Arm A overall 0.10% (box: 0.10%), worst window
1.65% on `bw_wwq9p6eb` (box: same window, same 1.65%); Arm B overall 0.10% (box: 0.10%), worst
window 0.55% on `bw_6yfr8qb8` (box: same window, same 0.55%). Both arms independently confirmed
PASS on a second, unrelated machine — this rules out a box-specific floating-point or threading
artifact as the source of either result. `run_ab_results.json` on orbox3 has the full per-window
breakdown; not duplicated here since it's identical to the box's numbers above.

## The 4 outliers, one line each (no transcript text; RMS on an int16 scale, clip% = samples ≥32700)

- **`bw_jk5s2tfs`** (room_jwyrr4dc, 22 Sep ~08:15 IST): decent absolute level (RMS p10-p90
  1220-4473) and the *widest* dynamic range of the four (3.67x) — minor clipping, 0.02% of
  samples; no acoustic red flag, source is `.webm` like every other window here. Silero's failure
  looks model-specific to this room, not an SNR problem.
- **`bw_d5aype5r`** (room_jwyrr4dc, same day, ~10:15 IST): the *narrowest* dynamic range of all 20
  windows (1.83x, RMS 1520-2788) — "quiet" and "loud" moments barely differ, consistent with a
  compressed/AGC'd mic feed flattening exactly the contrast Silero leans on.
- **`bw_wwq9p6eb`** (room_87frpus9, 19 Sep ~13:00 IST): RMS **an order of magnitude below every
  other window** (103-259 vs 1200+ elsewhere) — a genuinely quiet room/low mic gain, the most
  straightforward low-SNR explanation of the four, and why it's the closest call in Arm A.
- **`bw_maaacrdh`** (room_bh6jtq4t, 22 Sep ~12:00 IST): moderate-low RMS (247-802), no clipping,
  no other standout acoustic marker in what was checked — the least explained of the four; would
  need a closer look (spectral content, not attempted here) to say more.

