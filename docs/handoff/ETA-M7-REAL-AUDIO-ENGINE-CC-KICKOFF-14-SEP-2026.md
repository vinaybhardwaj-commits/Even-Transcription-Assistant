# ETA — M7: ROUTE vs WHISPER ON REAL ROOM AUDIO — CC KICKOFF
**14 September 2026 · Session: `scribe3` · Mini work, ~57 min · read-only on the repo · no git, no commit, no deploy**

## 0. Why this exists, and what changed since it was scoped

M5 and M6 settled what they could on a synthetic clip and then hit a wall: **the clip has almost no
silence, and silence is where whisper fails.** The measured envelope says **1.95% of a 900 s room window is
speech**. PR #2 (`ETA-VAD-SILENCE-GATE-PRD-14-SEP-2026.md`) reports that of **eight effectively quiet
15-minute windows, only one came back as true silence** — *"quiet rooms do not come back empty, they come
back as words."* On the 13 Sep corpus whisper looped in **~44% of non-empty jobs** (1,126 jobs, 4,363
repeat segments, 404 in-segment loops). On M4's continuous-speech clip it looped **3 times, 51 characters**.

Those three numbers only reconcile one way: **whisper's loop pathology is driven by silence, not speech.**
That is a hypothesis, not yet a measurement. **M7 is where it gets measured**, which is why §3.1 (speech
ratio) is not optional garnish — without it the rest of this report cannot be interpreted.

## 1. Goal

On **the same ten real room windows** whisper already ran on 13 September, measure route, and report the
two arms side by side. The audio is held constant; that is the whole point.

## 2. Scope and inputs

- **Pick the ten windows from the 13 Sep drain corpus** — jobs with `.prerepair` backups intact, so
  whisper's **pre-repair** text is available. That raw text, not the repaired text, is whisper's arm.
- Choose windows spanning a **range of speech density** — some busy, some quiet. Say how you chose. If you
  cannot tell density before running, pick at random and report the spread you got.
- Route each window through `POST /route` on the Mini exactly as M3 did: same parameters, `translate=false`,
  so M3's timings remain comparable.
- **The Mini is free today** (holiday, nothing recording). Nothing else may use it while this runs.
- Repo access is **read-only**. No git, no commit, no branch, no deploy, no flag, no migration.

## 3. What to measure, per window

**3.1 — Speech ratio. Do this first and report it for every window.**
The fraction of the window that is speech, by VAD or energy, using one stated method. Report it for all
ten. **Every other number in this report is read against this one.** A window at 2% speech and a window at
40% speech are not the same experiment.

**3.2 — Repeat metrics, both arms, three definitions.** We currently have **three** definitions of
repeat-ratio in three documents and that is a drift risk, so compute all three on the same data and let
them be compared:
- **M5's rules A/B/C** (in-segment loops; identical and near-identical consecutive runs; cross-segment
  repeats), exactly as `M5-MEASURE-14-SEP-2026.py.txt` implements them. Reuse that code unchanged.
- **PR #2's tripwire**: modal dominance ≥ 0.60, and longest consecutive identical run ≥ 8.
- **Chars removed by collapse**, as M4 reported it.
Report each per window per arm. **Do not pick a winner between the definitions** — that is a ruling, and
it is mine.

**3.3 — Per-segment engine and language, route only.** For every segment: winning engine, detected
language, segment duration. Then the totals: how many segments went to **IndicConformer**, whisper and
SraVaani. On the synthetic clip IndicConformer won **0 of 32**. This is the number that says whether the
override defect at `router_server.py:439–443` fires on real speech.

**3.4 — Script census, both arms.** M6's method **unchanged** — first word of each letter/mark character's
Unicode name; predominance by characters of script-bearing tokens — so M6 and M7 are directly comparable.
Report tokens and characters per script per arm per window.

**3.5 — Volume and time.** Characters produced per arm per window. Wall-clock per window for route, and
the realtime factor. M3 measured route at **0.326–0.342× realtime**; say whether real audio agrees.

## 4. What NOT to do

- **Do not draw the engine verdict.** Not in the report, not in the insight block. That is mine.
- Do not run the two arms concurrently, and do not run anything else on the Mini — M3 showed
  `ETA_MAX_INFLIGHT=1` serialises anyway, and contention would corrupt §3.5.
- Do not re-run whisper. Its arm already exists; re-running it changes the comparison.
- Do not repair, sanitize or clean whisper's text before measuring. The `.prerepair` text is the arm.
- Do not touch `~/eta-router` or restart any service.
- **Do not quote room audio.** This is real patient and clinician speech, unlike the synthetic clip. Report
  counts, ratios, scripts and language labels — **never transcript text**, not even a fragment, not even to
  illustrate a repeat. Where M5 and M6 quoted the synthetic clip freely, here you describe instead.
- No git, no commit, no deploy, no flags, no migrations.

## 5. Known facts

- Route: VAD → per-segment whisper `large-v3-turbo` + IndicConformer 600M + SraVaani, `looks_real_english()`
  guard, `SEG_SEC=30`, `ETA_MAX_INFLIGHT=1`, `ETA_MAX_WINDOWS_INFLIGHT=1`.
- The override (`:439–443`): an Indic result replaces whisper's English only if it contains Indic script
  **and** is ≥ `max(24, 1.8 × the whole segment's whisper chars)`. Segments run to ~30 s.
- The language timeline is built at `:504–505` **after** each segment's engine is chosen. It is an output,
  not an input — do not treat it as ground truth for anything.
- Losing engines' text is discarded and is not in the route JSON. If you find the bug firing, say so; a
  follow-up round will capture the losing outputs.
- The router has **no `/health`**; it serves `/healthz`, `POST /route`, `/route/job`, `/route/job/{id}`.
- Tailscale has a ~60 s bridge ceiling: background-and-poll for anything long, single
  `/usr/bin/python3 - <<'PY'` heredoc, absolute paths, never `$HOME`.

## 6. Output

`docs/handoff/ETA-M7-REAL-AUDIO-ENGINE-14-SEP-2026.md`, **cap 110 lines**. Per-window and per-segment
tables to `docs/handoff/scratch/M7-MEASURE-OUT-14-SEP-2026.json`; the script, with its self-tests, to
`docs/handoff/scratch/M7-MEASURE-14-SEP-2026.py.txt`.

Lead with three sentences, in this order:
1. The ten windows' **speech ratios**, as a range.
2. How many segments reached **IndicConformer**, out of how many.
3. Whisper's **repeat rate** on these windows against route's, under M5's definition.

Everything else after. Flags at the end, as usual.
