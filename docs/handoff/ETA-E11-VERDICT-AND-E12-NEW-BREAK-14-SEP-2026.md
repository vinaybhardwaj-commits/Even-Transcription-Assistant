# ETA-E11 VERDICT + E12 — the pipeline completed, and what broke next · 14 Sep 2026 · Orchestrator

## 0. THE PIPELINE COMPLETED END TO END, 20:16:32 IST

For the first time in this system's life, a room window went drain → diarize → emotion → scored rows.

```
job  done  finish  20:15:17 → 20:16:32
room_emotion_window  bw_6jwz5r79_1789289100000_primary  state=ok  wavlm
  segments_planned 13 · scored 2 · skipped 0 · failed 11
room_span_emotion    scored 2  (happiness 1, neutral 1) · failed 13 · skipped 166
```

`room_emotion_window` held **0 rows all time** at 18:53 tonight. It now holds an `ok`.

**The secret rotation is confirmed by behaviour, not by a health check.** The 20:00 job failed
`unauthorised`; after `bootout`+`bootstrap` made launchd re-read the plist, 20:05 and 20:10 got past
auth and failed on scoring, and 20:15 completed. Auth is fixed. Break 2 is closed.

---

## 1. E11 — the silent-window fix: ACCEPTED. Commit.

**V6: 9 of 9 mutations caught**, including the two that matter most — swapping the exact-match check
for a substring, and for `!full.ok`. Every file restored to its original sha256.

The Builder's own note on M1 is the best line in the report: the substring mutation was caught by **one
crafted case, `http_502: empty_transcript`**. Without that single row a substring version would have
passed every other test. That is testing rule 14 applied by hand — a mutation that discriminates,
because someone built the case that separates the two behaviours.

**Decision 1 — COMMIT, do not push, do not merge.**
I accept the E2E skip, explicitly, as the person `ETA_ALLOW_SKIP_E2E`'s own text requires — the Builder
was right to refuse to accept it on its own authority (rule 8), and right not to call the run green.
The two red lines are environmental and neither touches this change:
- the 4 REQUIRED PROOF suites need Docker, which is down; with the skip, **2,513 pass**;
- `swift test` fails 1 of 600 on `lockFailed(errno 35)` in an archive test, in Swift this diff does not
  touch, and the filtered re-run could not even build (toolchain macro error), so flake status is
  unknown and unknowable tonight.
Commit the three files by name. **The Refuter reviews the diff before anything is pushed** — the loop
is Fable → Builder → Refuter → Fable and it does not get skipped because the day was long.

**Decision 2 — the 7 parked windows stay parked, and the real finding is the reason why.**
`drainRoomWindow` accepts a `failed` window **only with `force: true`** (`room-drain.ts:464-466`), and
auto-drain never passes it. Only the admin route `POST /api/admin/bench/drain {window_id, force:true}`
does.

> **So no unattended path can ever recover a window that has exhausted its attempts.** E11 stops future
> windows parking. It does not un-park these, and it would not un-park any window that parks for a
> genuine reason later.

That is a design hole, not a bug in this diff. Logged, not fixed tonight. The 7 are Home Office
silence and worth nothing in themselves; the hole is worth a lot.

**Decision 3 — two follow-ups the Builder surfaced, neither for tonight.**
- `room-reads.ts:94,103` counts a silent window as transcribed **and adds its full 900 s to
  `words_ms`**. A window with no speech contributing 900 seconds of "words" will overstate every
  speech figure built on it. Fix the metric, not the state.
- A silent window still costs **2 Whisper calls**, because the language probe runs before the full
  window. On tonight's real data that is 21 of 25 windows paying twice for nothing.

**Decision 4 — the shared helper stays a follow-up**, as ruled in the kickoff. The Builder's insight
strengthens that ruling: a table of known paths confirms those paths agree but **cannot notice a new
one**; it is the sweep of every caller, paired with the table, that fails when a fourth path appears.
Build the sweep with the extraction, not before it.

---

## 2. E12 — the new break: segment scoring fails 11 of 13

Emotion now runs. It mostly does not score.

| window | planned | scored | failed | skipped |
|---|---|---|---|---|
| `bw_6jwz5r79_…89100000` | 13 | **2** | **11** | 0 |
| `bw_6jwz5r79_…83700000` | 1 | 0 | 1 | 0 |
| `bw_6jwz5r79_…81900000` | 1 | 0 | 1 | 0 |
| `bw_z3gpbh6e_…56600000` | 54 | 0 | 0 | 166 (the auth failure) |

Totals across all time: **2 scored, 13 failed, 166 skipped.**

Two windows failed `emotion_zero_scored: 1 of 1 segment(s) failed` — and per
`emotion-window.ts:191-193`, **zero scored is a failure**, so those consumed attempts against the
3-attempt bound. At this rate most windows will exhaust.

Note the shape: the one window that produced anything planned 13 segments and scored 2. The two that
produced nothing planned **1 segment each**. A window whose diarization yields a single short span is
a different case from one yielding thirteen, and it is worth knowing whether the single-segment
windows fail for the same reason as the eleven.

Also unexplained and worth one look: window `bw_z3gpbh6e` planned **54** segments but recorded **166**
skipped. Those two numbers cannot both be right about the same run. That is testing rule 15's
territory — a count that disagrees with the rows it is supposed to describe.

**This is the next debugging round, not tonight's.** Brief to be written as `ETA-E12`.

---

## 3. Standing after tonight

- Break 1 (`whisper_unavailable`) — **root-caused and fixed in code**, committed, awaiting Refuter.
- Break 2 (emotion never enqueued) — **root-caused and fixed in config**, proven by a completed job.
- Break 3 (segment scoring fails 11/13) — **new, open, E12.**
- `ROOM_AUTO_DRAIN_ENABLED=0`, `AUTO_DRAIN_MAX_AGE_HOURS=6`. Clinic tomorrow is safe.
- `EMOTION_SEGMENTS_SECRET` rotated on both sides, fingerprint `60823aced8ee`. **The leak debt from
  this afternoon is discharged.**
- Deployment `dpl_3KgFAxELdKDz2DbzaQekTiYaNzmi`, commit `fe021a3`, serving production.
- New rule earned tonight — **rule 17**, in `ETA-CARRYOVER-14-SEP-2026-NIGHT-MASTER.md`.

Orchestrator.
