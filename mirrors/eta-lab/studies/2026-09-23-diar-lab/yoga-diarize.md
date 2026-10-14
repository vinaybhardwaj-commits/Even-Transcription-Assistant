
---
## Interim: window 1 exceeded 20 min — stopping the run here (weekA-2300 rule)

**Mini baseline (window 11:00-11:15 IST, bs_gkzmch9p, 900 s):** wall 56.6 s, HTTP 200, 3 speakers,
269 segments, peak RSS 1.4 GB.

**Yoga (same window, precision-3 pipeline, CPU-only, 2 cores capped):** still in flight at ~26 min
(started ~21:28 IST, now 21:54 IST) — over 25x the Mini's wall time and still running. Per this
round's rule ("if one Yoga window takes >20 min, stop the run after that window"), **no window 2 or
3 will be started**, and the Mini's `/diarize` will not be hit again tonight beyond this one
already-in-flight call.

**No parity result yet** — the Yoga call hasn't returned, so segment-agreement and ECAPA-cosine
parity are unmeasured. Will append the result here when the in-flight call completes (letting it
finish rather than killing it — it holds no Mini resources and killing it wastes the CPU time
already spent).

**Headline finding so far:** CPU-only diarization on the Yoga (i5-1135G7, 2 cores) is far too slow
for same-night parity work at 15-minute-window scale. Whatever the exact multiple turns out to be,
it is not a usable substitute for the Mini's MPS-accelerated path at this audio length.

---
## Window 1 complete — parity result, and a conflict with the 19 Sep ruling. Run stopped here.

**Bench (11:00-11:15 IST, bs_gkzmch9p, 900 s):**
| | wall_s | HTTP | speakers | segments | peak RSS |
|---|---|---|---|---|---|
| Mini (MPS) | 56.6 | 200 | 3 | 269 | 1.4 GB |
| Yoga (CPU, 2 cores) | **1589.1** | 200 | 3 | 269 | 0.86 GB |

Yoga is **28.1x slower** than the Mini on this window — confirms the earlier interim finding.

**Parity, this one window:** segment count identical (269/269); per-speaker total speech seconds
identical to one decimal (537.6 / 150.6 / 55.2 on both sides); overlap-weighted frame agreement
**100%** on the 78.6% of the window where both sides assign a speaker; ECAPA cosine **exactly 1.0**
for all 3 matched speakers (well inside the 1e-3 target).

**Flag — this conflicts with [[yoga-not-a-diarize-producer]] (ruled 19 Sep 2026: "arm64 vs x86_64
differ at speaker switches, 8/8 boundary differences").** This IS an arm64 (Mini, MPS) vs x86_64
(this Yoga, CPU) comparison, and on this window it came back bit-for-bit identical in segmentation
and speaker identity, not merely close. Possible explanations, none confirmed: (a) this window's
audio is unusually clean/unambiguous so boundary quantization never bites; (b) the 19 Sep test used
a different Yoga node, torch build, or pipeline path than this fresh install; (c) something in this
result is wrong in a way I haven't caught. **Not claiming this overturns the ruling** — one window,
stopped here per this round's rule, can't settle it. Recommend it gets a second window on a night
when the lock/memory situation allows.

**Run stopped after this window**, per weekA-2300 (>20 min ⇒ stop; no more Mini `/diarize` calls
tonight). Windows 13:00-13:15 and 14:00-14:15 are downloaded but not run. Service left running on
the Yoga (`eta-diarize-yoga.service`, :8086, byte-identical `server.py` to the Mini's).

---
## Overnight (22→23 Sep): no-labels sanity pass — cluster purity, 2 real room-days

**Metric (my definition, stated since the order didn't pin one down):** per window, purity =
(dominant speaker_idx's total overlap_ms) / (sum of all speakers' overlap_ms in that window) — how
much of a window's detected speech concentrates into ONE speaker cluster vs fragmenting across
several. No cross-window identity linking involved (clustering-attribution is off for most rooms
right now, so speaker_idx isn't comparable window-to-window) — this only measures WITHIN-window
concentration.

| room-day | windows | n_turns pulled | purity median | p90 | ≥0.8 (stable dominant voice) | <0.5 (fragmented) |
|---|---|---|---|---|---|---|
| bs_maaacrdh (rd_djmbtzph) — capped at the 500-span page limit, so partial | 8 | 500 | 1.0 | 1.0 | 7/8 (88%) | 0/8 |
| bs_gq4bkm6h (rd_aeeu5u4j) — complete | 4 | 73 | 1.0 | 1.0 | 4/4 (100%) | 0/4 |

**Reading:** almost every window has a clean, single dominant speaker cluster (median purity 1.0
on both days) — no evidence of the per-window diarization fragmenting into noisy, ambiguous
clusters. The `bs_maaacrdh` figures are from the first 500 spans only (`window_speakers` caps at
500, no pagination); flagging, not claiming it as the whole day.

## Overnight: 20-turn /enroll parity, Mini vs Yoga (ECAPA only, not full /diarize)

20 random real turns (≥1.5s) from bs_gkzmch9p window 11:00-11:15 IST, same audio POSTed to both
Mini :8001/enroll and Yoga :8086/enroll. Queued behind night-drain's active diarize jobs on the
Mini (one semaphore for /diarize + /enroll), so this ran slower than off-hours but caused no
contention beyond normal queuing.

**Result: 20/20 both HTTP 200, cosine exactly 1.000000 for every turn.** min=median=max=1.0.
Confirms /enroll parity independently of the earlier full-/diarize parity check — the lightweight
ECAPA-only code path is also bit-identical Mini vs Yoga.
