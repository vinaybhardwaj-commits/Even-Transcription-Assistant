# ETA — CARRYOVER & STATE OF PLAY · 14 Sep 2026, night · Orchestrator

Supersedes `ETA-CARRYOVER-14-SEP-2026-EOD-MASTER.md` (written 16:00, before the live run).
Read this first, then §9's reading list in order.

---

## 1. THE HEADLINE

**At 20:16:32 IST tonight the pipeline completed end to end for the first time ever** — a room window
went drain → diarize → emotion → scored rows in the database. `room_emotion_window` held zero rows,
all time, three hours earlier.

Getting there cost three separate breaks, two of which are now fixed. The third is open.

---

## 2. WHAT IS LIVE RIGHT NOW

| | |
|---|---|
| Production deployment | `dpl_3KgFAxELdKDz2DbzaQekTiYaNzmi`, commit `fe021a3`, branch `vinay/s1-auto-drain`, serving www.evenscribe.app |
| `ROOM_AUTO_DRAIN_ENABLED` | **`0`** — deliberately off. Clinic-safe. |
| `AUTO_DRAIN_MAX_AGE_HOURS` | `6` (restored from the experiment's 240) |
| `AUTO_DRAIN_BATCH_LIMIT` | **not set** — deliberately. Code default 1 is what we measure. |
| `ROOM_DIARIZE_ENABLED` · `EMOTION_ENABLED` | `1` · `1`, both live and working |
| `EMOTION_SEGMENTS_SECRET` | **rotated today**, both sides, fingerprint `60823aced8ee`. Secret type. The afternoon's leak debt is discharged. |
| Rooms with Transcript on | **2 of 13** (`room_ymch4bxu` 113 windows, `room_2qe955hy` 76, named "Home Office") |
| Mini services | all nine healthy. Emotion restarted tonight, PID 85074. Router `/healthz` on 8083. |
| Docker on the Mini | **down** — the 4 REQUIRED PROOF suites cannot run |

**Uncommitted/unpushed:** E11's three-file fix is committed to `vinay/s1-auto-drain` (if `scribe` has
acted on Decision 1) but **not pushed and not merged** — the Refuter has not reviewed the diff.

---

## 3. THE THREE BREAKS

**Break 1 — `whisper_unavailable`: FIXED IN CODE, awaiting Refuter.**
Whisper was never broken. It answered all 25 drains with HTTP 200; **21 windows contained no speech**,
and `room-drain.ts:737-744` mapped every `!full.ok` to `whisper_unavailable`. 7 windows × 3 attempts =
21. Two other paths (`bench.ts:1786-1795`, `transcribe-range.ts:205-224` — "A QUIET ROOM IS NOT A
FAILED READ") already had the rule; the newest path did not inherit it. Fix: one branch on exactly
`EMPTY_TRANSCRIPT` + a step skip. 9 of 9 mutations caught.

**Break 2 — emotion never enqueued: FIXED IN CONFIG, proven by a completed job.**
`EMOTION_SEGMENTS_SECRET` was never set on Vercel. The cron fired 59 times and returned **HTTP 500
every time**; a missing flag would have returned 200, which is what discriminated the two causes.
Rotated and set on both sides; endpoint went 500 → 200 → `[emotion] enqueued 1`.

**Break 3 — segment scoring fails 11 of 13: OPEN. This is where a new session starts.**
All-time totals: **2 scored, 13 failed, 166 skipped.** Two windows failed
`emotion_zero_scored: 1 of 1 segment(s) failed`, and zero-scored is a failure, so it burns attempts
against the 3-attempt bound. Also unexplained: one window planned **54** segments and recorded **166**
skipped — two numbers that cannot both describe the same run.

---

## 4. WHAT THE LIVE RUN PROVED (16:40–18:53, 2 h 13 m, then switched off)

- **The drain fires reliably**: 25 attempts, 11.5/h against a `*/5` cron at cap 1.
- **Diarize works**: 6 jobs, 6 done, p50 47.6 s, p90 65.5 s, max 70.9 s.
- **The starvation is real and was watched happening.** Two rooms eligible; **all 25 slots went to
  `room_2qe955hy`; `room_ymch4bxu`, holding 113 windows, got zero** for the entire run. `closed_at DESC`
  ranks rooms against each other and the loser stays the loser.
- **The structural ceiling is emotion, not the drain.** Emotion enqueues one job system-wide per `*/5`
  tick → **12 windows/hour maximum, ever**. Diarize does 48/h, drain 12/h. Demand is 28–32/h.

---

## 5. THE BIG OPEN DESIGN QUESTIONS (mine to rule, none urgent)

1. **No unattended path recovers an exhausted window.** `drainRoomWindow` takes a `failed` window only
   with `force:true`, which only the admin route passes. 7 windows are parked there now and nothing
   automatic will ever pick them up.
2. **Fairness (R5).** Round-robin by room, newest-first within a room. Explicitly not oldest-first.
   Urgent because — see §6 — the only thing currently sharing capacity fairly is kiosk instability.
3. **Emotion's cap (R3′).** Cannot be derived until scoring works. Break 3 blocks it.
4. **The 1,378-window backlog (R7).** V's decision: process or archive. Not a build decision.
5. **`stt_subject_job` holds 229 `asr` rows queued.** Nobody has established what drains it.
6. **Metric defect**: `room-reads.ts:94,103` counts a silent window as transcribed and adds its full
   900 s to `words_ms`.

---

## 6. THE FINDING MOST LIKELY TO BE FORGOTTEN

**Phase is rigid per kiosk *run*, not per day.** Inside a run, close-lag `sd_phase` is **0.0 exactly**;
between runs the median jumps the full width of the 15-minute grid. A losing room loses *every* tick
until something restarts its kiosk.

> **So the only thing currently distributing drain capacity fairly is kiosk instability. Stabilise the
> kiosks — which we want — and starvation gets worse, not better. Fairness must be built before
> reliability improves.**

---

## 7. TESTING RULE 17, EARNED TONIGHT

> **17. Restarting a process is not reloading its configuration, and a health check cannot tell you
> which one happened.** `launchctl kickstart` relaunched the emotion service after its plist was
> rewritten: new PID, `/healthz` 200, and the **old** secret still in its environment — launchd re-reads
> a plist only on `bootout` + `bootstrap`. The check that would have caught it is the one that exercises
> the thing that changed: a call that actually uses the secret. This is rule 6 in a new place — the
> probe passed, for the wrong reason, and the cost was one wasted attempt on a real window.

Rule 16 was earned earlier today (an aggregate over a span longer than the mechanism's cycle hides the
mechanism). Both are in project memory `testing-rules-guards-fakes-and-probes.md`.

---

## 8. HOW THE SESSION RUNS

Three tmux panes on the Mini: **`scribe`**, **`scribe3`**, **`ETA-Refuter`**. The bus is
`docs/handoff/` **inside the repo**. Every paste to a pane must name the pane, state its order, and sit
in its own fenced code block; any idle pane is named and told to stay idle.

Hard constraints, unchanged:
- Env var **names** only, never values. Secrets never pass through this conversation.
- GitHub actions and database migrations go through Claude Code, never V's terminal.
- **You do not deploy.** Never quote transcript text from real room audio.
- All browser work delegates to a Sonnet-class subagent.
- Anything asked of V is written as clicks and plain sentences — codenames are for the build panes.
- The Tailscale bridge has a hard **~60 s ceiling** regardless of `timeout_ms`, eats `cd` and some
  pipes: use one `/usr/bin/python3 - <<'PY'` heredoc with absolute paths, never `$HOME`.
- Neon read-only work from this thread: the connection string is at
  `/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf`, outside the repo. Read it, use it,
  never print it. **`CREATE TEMP VIEW` fails in a read-only transaction** — inline as a CTE.
- Vercel MCP: team `team_yu1wWpsKdjsf90haai1ETJDG`, project `prj_8nVH2HdbeDy6aJ8oeWqfkhYijM9Z`.
  Runtime-log full-text queries time out; `group_by` and a narrow `since` work.
- `scribe`'s permission layer blocks production DB reads and `UPDATE room …` ("Modify Shared
  Resources"). It stops rather than working around it, which is correct. Plan around it.

---

## 9. NEXT, IN ORDER

1. **Refuter reviews the E11 diff** — the loop does not get skipped because the day was long.
2. **E12: root-cause segment scoring** (Break 3). Brief not yet written.
3. Rule R5 (fairness) and build it.
4. E1 multi-centroid — all seven forks ruled in `ETA-E1-RULINGS-14-SEP-2026.md`; **R-F3b goes first**
   (record the losing match score — the system currently discards the only number that would let us set
   the speaker threshold).
5. E7 voice harvest — blocked on V supplying a roster (which doctor, which room, which day). Room audio
   yields **0** candidate samples per doctor without it; encounters yield ~10–20 for one doctor, ~10 for
   another, ~1 for a third, 0 for the other four.

## 10. READING LIST

`ETA-E11-VERDICT-AND-E12-NEW-BREAK-14-SEP-2026.md` · `ETA-E10-ROOTCAUSE-14-SEP-2026.md` ·
`ETA-E9-VERDICT-FIRST-LIVE-RUN-14-SEP-2026.md` (incl. §9) · `ETA-E8-CONSOLIDATED-RULING-14-SEP-2026.md` ·
`ETA-E6-REFUTATION-14-SEP-2026.md` · `ETA-E1-RULINGS-14-SEP-2026.md` ·
`ETA-E-RETRY-COLLISION-VERDICT-14-SEP-2026.md` · `ETA-PROGRAMME-INTEGRATION-14-SEP-2026.md`

## 11. WHERE I WAS WRONG TODAY, SO NOBODY REBUILDS ON IT

- "A retry can never succeed" (emotion `ON CONFLICT`) — **disproved**; `clearWindowSegments` prevents it.
- "Phase is stable per day" — **wrong cut**; the unit is the kiosk run, and rule 16 was mine to eat.
- "The cap to fix is auto-drain's" — **wrong queue**; it is emotion's, and it is structural, not an env var.
- "The flags were dormant by absence" — **incomplete**; the pipeline had no head, and my own R1 was
  what removed it.
- "The `last_run_id` hypothesis for Break 2" — **killed by one query**, before it reached a brief.
- I left a contradiction on the bus (E8 §6.1 vs the E9 kickoff) and an agent spent its permission
  budget discovering it. **When a later brief reverses an earlier ruling, the reversal belongs in the
  ruling document.**

---

## 12. LATE EVENING UPDATE (20:20 → 21:00) — supersedes §2 and §9 where they differ

**E11 is pushed.** Commit `6e68462f2d92277d8048faf74d5f68bebc63a386` on `vinay/s1-auto-drain`, three
files, now on origin. **Not merged.** The Refuter's verdict was **PUSH (branch only)**: it rebuilt the
test with the Whisper mock removed and only `fetch` faked, and proved a real outage still fails loudly
— 500, 500-with-`empty_transcript`-body, timeout and network error, each separately, each one attempt
and zero engine calls.

**Three mutations survived, all test gaps, one of them mine.** R1/R2: the `===` comparison is pinned by
a single hand-typed fixture, and `.startsWith()` survives even with it present. R3: deleting the silent
branch's `cueWriteFailed` check is invisible to every test. And the three-path sweep I ordered *instead
of* the shared-helper extraction catches only **1 of 5** realistic evasions — so the substitute does not
do the job I claimed, and the extraction moves to the next round.

**Four mandatory items before merge** (`ETA-E11-FINAL-RULINGS-AND-SCRIBE-ORDER-14-SEP-2026.md` §2):
(a) real-client 500-with-body test; (b) pin the cue-write failure; (c) `silent_window: false` on the
speech branch — I made this mandatory, not optional; (d) rebuild the sweep to classify **call sites**,
not files.

**Two costs of E11 nobody had priced**, both found by the Refuter from source:
1. **Silence now flows into diarize.** A silent window is `transcribed` with a clip, which is exactly
   the diarize scan's predicate. At 21-of-25 silence, most of the Mini's diarize queue would be spent
   on nothing at 47–71 s each. Own round: the scan must exclude known-silent windows, which needs
   `silent_window` as a durable fact on the window — hence (c).
2. **Silence is now final**, which is where E13 arrived independently from the data.

**In flight at 21:00:** `scribe` on (a)–(d) · `ETA-Refuter` on `ETA-E14` (emotion scoring root cause) ·
`scribe3` on `ETA-E15` (the `for-tests-` VAD model's identity, and why audio levels stopped).

**Break 3 evidence (`ETA-E12-SCORING-EVIDENCE-…`):** the clean retry gave **24 scored, 30 failed (all
`malformed_scores`), 166 skipped**. Failures cluster short — 12 under 1.5 s, median 1.85 s — and **no
scored segment is under 1.5 s**, against the service's own `min_speech_s 1.5`. But **11 failures were
~29 s** and do not fit. The service answered every request 200 with no tracebacks, so the client
dislikes the answer rather than the service erroring. `app.py` was modified **today at 11:46**, so
there is no known-good "before".

**Recorded and deliberately not acted on: `ETA-SEC1-ELEVEN-TUNNELS-OPEN-TO-THE-INTERNET-14-SEP-2026.md`.**
Eleven of twelve `llmvinayminihome.uk` tunnel hostnames answer unauthenticated from the open internet;
`inbox` is the only one behind Cloudflare Access. V's decision on 14 Sep was to leave it. The document
stands as the record; **do not re-raise it unprompted.**

---

## 13. WAVE 2 UPDATE (21:00 → 22:00) — supersedes §12 where they differ

### Committed tonight, none of it pushed or merged

| what | commit | branch / worktree |
|---|---|---|
| E11 pre-merge (4 items) | `ccd12b0` | `vinay/s1-auto-drain`, **pushed** |
| **E17 drain fairness** | `e925901` | `vinay/s1-auto-drain`, main worktree |
| **E16 speech fraction** | `f4f51c6` | `vinay/e16-emotion-speech-fraction`, `-e16` worktree |

**In flight at 22:00:** `ETA-Refuter` refuting E16 · `scribe` on E11 items (e)+(f) in the main tree ·
`scribe3` on E20 in a new `-e20` worktree.

### E16 — the number exists now

`room_span_emotion` carries `speech_ms` and `speech_basis`. **A9 reads 2,280 ms of speech across
29,070 ms — 0.078 — and is still scored.** E14's exhausted-window shape (one 0.50 s span) now ends
`no_segments`: nothing sent, no attempt consumed. 16 of 16 mutations, **two of them caught only by a
statement-text check** whose behavioural proof sits in the unrun Docker suite — that qualification is in
the commit message and must not be dropped.

**Ruled: the diarizer's per-speaker intervals, not the service's amplitude gate.** Not a compromise —
the service's `speech_s_est` is peak amplitude over 20 ms frames and counts a door or a chair; the
diarizer's segments are speech attributed to a speaker, which is the question a reader of an emotion
label actually asks. This **partly withdrew my 21:05 amendment**, which had put the service change in
scope. The service change (option D) returns to its own round.

**No cutoff was set, deliberately.** n=26 scored rows, p10 0.295, p50 0.755, the two known-bad spans at
0.078 and 0.181. A 0.25 floor separates exactly those two — fitting a threshold to two points from one
room's Home Office audio. Emit the fraction; set the floor when a clinic week is behind it.

### E17 — fairness no longer depends on kiosks crashing

8 of 8 mutations; one survived the first pass and the Builder wrote the test that kills it rather than
reporting 7 of 8. Every behaviour test runs **the old order as a control that must fail.**

> *"`closed_at` looked like 'newest', but its spread within a kiosk run was exactly 0.0 s. The more
> stable the kiosks became, the more reliably the same room won."*

Ranking on the recorder's own slot time plus last-served removes that dependence entirely — which
closes §6, the finding I marked most likely to be forgotten.

### E11 is NOT merged: gap (b) was not closed

The Refuter found **two tidy rewrites that survive every E11 test** — `!counts.window_recorded` and
`counts.failed > 1`. On the real data shape each finishes a silent window `transcribed` and `done` with
no record in the day: exactly what (b) existed to prevent. Items **(e)** (test against the real brain
shapes so both rewrites die) and **(f)** (`ADAPTERS` as a sixth sweep signal, sweep every tracked file)
are in flight. Then one Refuter pass over E11 **and** E17 together, then merge.

### Two new open items

1. **`segments_json` re-run hazard.** A diarize re-run of an `ok` window keeps the old `segments_json`
   but moves turns to the new run; if speaker numbers change, `speech_ms` is measured against the wrong
   speaker. **A wrong speech fraction is worse than none.** I ruled it out of scope and have explicitly
   asked the Refuter to attack that ruling — **if a re-run is reachable on an `ok` window, it blocks the
   E16 merge and I reverse myself.**
2. **`/health` without `min_speech_s` now fails the window** — a failure mode E16 introduces. The
   service was restarted at 20:07 and returned `loaded:false` while lazily loading. If a restart can
   fail windows that would previously have scored, that is a regression inside a correctness fix.

### E21 now carries two workstreams

A second team found the Mac `TapeWriter` rebuilds its `PCMResampler` only on a **sample-rate** change,
so every other discontinuity (`device_lost`→`resumed`, `capture_discontinuity`, `ring_overflow`,
`day_rollover`) keeps the converter's filter history and bleeds pre-gap audio past the seam.

**Severity: not grave, and I said so.** Its own finders rated it low and said no action tonight; on
impact they are right — a few milliseconds at a discontinuity changes no transcript and no decision.
**The reason to fix it is testability**: it makes a region's output depend on everything captured
before it, so no fixture can pin one region and no test can check it alone. That is the same class of
defect that cost the whole evening.

Folded into E21 with the audio levels — one Swift round, one fleet update. **Measure the bleed before
quoting it**; the Ubuntu build's 121-tap / 3.75 ms figure is theirs, not the Mac's. The platform
divergence is permitted (format and index byte-identical; audio content deterministic per platform) and
should be recorded, not resolved.

### Migration numbers, current

0094 reserved (E1) · **0095 free** (E18) · **0096 → E20** · **0097 → E16, applied? NO — runs before the
E16 deploy, at my call** · 0098 free (E17 needed none).

### Standing rule added tonight

**Every build spec names its branch AND its worktree.** Three worktrees share this repo (`main`,
`-e16`, `-slice-e`, plus `-e20` now). I left it to inference and it drifted twice in one evening —
`scribe` invented the right answer for E16, `scribe3` reasonably committed E17 onto
`vinay/s1-auto-drain` while E11 was under review there. Not unpicked; the rule is written down now.

### Resolved

`swift test` passes all 600 in a fresh worktree — E11's F5 `TestingMacros` failure was the main clone's
corrupted `.build`, not a real break. Clear `apps/room-recorder/.build` tomorrow.

### Two testing rules earned since §7

**18. A fake can be wrong about the SHAPE of the data, not just the algorithm.** E11's cue-write test
used a fake returning a shape the real `writeWindowCues` cannot produce for a silence, so the test
proved the guard existed and never once exercised its real failure. Two rewrites of the check survived
every test. **Ask what shapes the real dependency can actually emit, and build the fixture from those.**

**19. A guard that enumerates cannot see what it was not told about.** The call-site sweep listed five
signal names; `ADAPTERS[key]` is an ordinary lookup that evades all of them, and four of five realistic
evasions passed. **The durable version checks a property — every Whisper result goes through one
classifier — not a list of names.** Three agents reached this independently tonight, which is why E19
moved from tidy-up to the only durable answer.
