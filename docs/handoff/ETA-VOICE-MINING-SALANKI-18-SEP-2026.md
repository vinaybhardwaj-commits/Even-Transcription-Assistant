# ETA — Salanki voice mining, and what the drain is actually producing

**18 Sep 2026. MEASURED, not estimated.** Two independent results in one document: a mined voiceprint
that verifies against Salanki's own enrolment, and the drain throughput arithmetic.

## VERDICT — CANDIDATE FOUND, AND IT VERIFIES

A single speaker is present on all four Salanki room-days. Its mined centroid scores **0.930 against
Dr. Prabhudev Salanki's enrolled voiceprint** and **0.383 against the next-nearest of the seven**
(Darshan Gowda) — a margin of **+0.546**. The enrolled print was never used to find the candidate; it was
only used to check it afterwards, so this is a genuine out-of-sample confirmation, not a circular one.
The negative control holds: no speaker in any of Dr. Vishal Naik's three room-days exceeds **0.335**
against the mined centroid, while the weakest Salanki day reaches **0.817** — a separation of **+0.482**.

**Method works. It can be run for every clinician who has enough room audio.**

### Two cautions on the numbers below

1. **Cross-day cosines for the SAME speaker fall as low as 0.616.** The 11-Sep day is the weak member —
   0.616-0.669 against the other three, which sit at 0.753-0.834 among themselves, and it has the least
   speech (356 s vs 1198/780/1643). This matters for the threshold work: **a 0.65 cosine applied
   speaker-to-speaker across days would have rejected a true match twice out of three.** Window-to-print
   is a different and much easier comparison (0.930 here). The two must not share a threshold.
2. **The picked speaker is `idx 0` on every day.** pyannote orders by talk time, and the dominant speaker
   in a doctor's own OPD room is usually the doctor, so this method would tend to pick the dominant
   speaker by construction. The cross-day agreement and the 0.930 hit against an independent enrolment are
   what make the result evidence rather than an artefact.

---

# Salanki voice mining — cross-day result

Diarization: 6 concatenated day-files, pyannote-3.1 + ecapa on the Mini (port 8001), finished 14:42Z 18 Sep.

## 1. The matched speaker, per day

| day | speakers in day | picked idx | speech (s) | cosine vs 11-Sep anchor |
|---|---|---|---|---|
| salanki_11sep | 18 | 0 | 356.1 | 1.000 |
| salanki_12sep | 23 | 0 | 1198.0 | 0.621 |
| salanki_16sep | 11 | 0 | 780.5 | 0.616 |
| salanki_18sep | 10 | 0 | 1643.1 | 0.669 |

Total speech across the four days: **3978 s (66.3 min)**.

## 2. Separation from the runner-up on each day

| day | best cosine | 2nd-best cosine | margin |
|---|---|---|---|
| salanki_12sep | 0.621 | 0.424 | +0.197 |
| salanki_16sep | 0.616 | 0.115 | +0.501 |
| salanki_18sep | 0.669 | 0.575 | +0.094 |

## 3. 4x4 cross-day matrix (the picked speaker against itself across days)

| | 11sep | 12sep | 16sep | 18sep |
|---|---|---|---|---|
| **11sep** | 1.000 | 0.621 | 0.616 | 0.669 |
| **12sep** | 0.621 | 1.000 | 0.753 | 0.834 |
| **16sep** | 0.616 | 0.753 | 1.000 | 0.826 |
| **18sep** | 0.669 | 0.834 | 0.826 | 1.000 |

Off-diagonal: min 0.616, mean 0.720, max 0.834.

## 4. Mined centroid

L2-normalised mean of the four day embeddings, dim 192. Written to `work/mined_centroid.json`.

| day | cosine of that day vs the centroid |
|---|---|
| salanki_11sep | 0.817 |
| salanki_12sep | 0.902 |
| salanki_16sep | 0.899 |
| salanki_18sep | 0.936 |

## 5. Negative control — Dr. Vishal Naik's room-days

Every speaker in the Naik day-files scored against the mined centroid. If the centroid is Salanki, nothing here should come close.

| naik day | speakers | top cosine vs mined centroid | that speaker's speech (s) |
|---|---|---|---|
| naik_11sep | 14 | 0.335 | 191.4 |
| naik_12sep | 8 | 0.262 | 1294.8 |
| naik_16sep | 6 | 0.118 | 26.3 |

Highest cosine any Naik-room speaker reaches against the mined centroid: **0.335**.
Lowest cosine a Salanki day reaches against it: **0.817**.
Separation: **+0.482**.

## 6. Seven-way ranking — mined centroid vs every enrolled voiceprint

| rank | clinician | samples | dim | cosine vs mined centroid |
|---|---|---|---|---|
| 1 | Dr. Prabhudev Salanki | 1 | 192 | 0.930 |
| 2 | Darshan Gowda | 6 | 192 | 0.383 |
| 3 | Ankit Bhojani | 1 | 192 | 0.288 |
| 4 | Dr Dibyendu Majumdar | 1 | 192 | 0.164 |
| 5 | Poornima Parasuraman | 1 | 192 | 0.137 |
| 6 | Vinay Bhardwaj | 6 | 192 | 0.134 |
| 7 | Dr Animesh Banerjee | 1 | 192 | 0.015 |

Nearest: **Dr. Prabhudev Salanki** at 0.930. Runner-up Darshan Gowda at 0.383, margin **+0.546**.

## 7. Thresholds, for reference

Current unratified cosines: room 0.65, encounter 0.70, phone 0.78. Nothing below has been ratified.


---

## 8. What the drain is actually producing (measured 14:50Z, drain restarted ~13:30Z)

**Since 13:30Z**, 33 `bench_window` rows were created across the six enabled rooms, and **8 windows were
transcribed** — 6 `activity=speech`, 2 `thin`, 0 silent-at-run. Five more windows short-circuited to
`state='silent'` before transcription. Per room: OPD 4 Ortho 3 (all speech), Home Office 3 (2 speech,
1 thin), Cardiology OPD 2 (1 speech, 1 thin). Three of the six enabled rooms produced nothing.

**THE TWO NUMBERS THAT MATTER.**

**1. The historical backlog is unreachable by the auto-drain, at any legal setting.**
2,236 windows sit in `state='closed'`. **2,135 of them are already older than
`AUTO_DRAIN_MAX_AGE_HOURS`** (default 6, clamped 1..48) — and most are days old, so even the maximum 48 h
does not reach them. Only **101 closed windows are inside the age cap.** Roughly 450 h of recorded room
audio is therefore invisible to the automatic path. It is **not lost** — the clips are in R2 and a
deliberate backfill (`scribe_transcribe_range` / a range drain) can reach them — but nothing will happen
to it on its own. Anyone reading "the drain is on" as "the archive is being processed" is wrong.

**2. The live rate is under-provisioned, by about 3x.**
Measured 8 runs in ~75 min = **~6.4 windows/hour** total. Six enabled rooms producing 15-minute windows
generate **~24 windows/hour**. The drain does one window per room per tick with
`AUTO_DRAIN_BATCH_LIMIT` at its default of 1. **It falls behind by roughly 18 windows/hour during clinic
hours**, and the shortfall ages out of the 6 h cap and joins the unreachable pile above.

**RULED: do not raise the limits tonight.** The Mini has CPU headroom (66% idle, load 5.5) but **not
memory** — 23 G used, 169 M unused, 4.4 G compressor, with a long swap history; the router is already the
known serialised bottleneck. Raising `AUTO_DRAIN_BATCH_LIMIT` multiplies concurrent router work against
that constraint, and both limits are Vercel env vars, so changing either costs a redeploy. More
importantly, draining faster into a surface nobody can read buys nothing: **S1, the room-day output
surface, comes first.** After S1 is up, raise `AUTO_DRAIN_BATCH_LIMIT` 1 -> 3 (not 10) and measure the
Mini before going further, and plan the historical backfill as its own job rather than as a config change.

---

*Raw artefacts on the Mini: `~/scribe-mining/salanki/` — `work/diarize_*.json` (6 day-files),
`work/mined_centroid.json`, `work/candidates.json`, `work/analyze.py`, `work/analyze2.py`, `REPORT.md`.*
