# ETA BUILD QUEUE — the single running list

> **RECONCILED 17 Sep 2026 close. READ `ETA-CARRYOVER.md` FIRST — it supersedes anything below that
> disagrees with it.** Since this file was last written: E32+E32b, E31 batch 2 round 1 (B1/B2, `ace9ff3`)
> and E31 C6/C7 (`de92359`) all SHIPPED TO PRODUCTION. Lane 2 fleet queue items 1–2 are DONE: OPD 4 and
> OPD 1 are off 0.1.8, all 8 clinic Macs run 0.1.24, and the release shipped as **0.1.24, not 0.1.23**.
> Fleet item 3 (revert the C270 workaround on Cardiology and OPD 3) is STILL OUTSTANDING and now actionable.
> The line "IGNORE OT 3 — not ready" is STALE: that room was renamed **Home Office Ubuntu**, is enrolled and
> healthy on the Linux line, and a second Linux box **ORB3 / ORBOX3** now exists. Fleet access for all ten
> machines is documented in `ETA-FLEET-ACCESS-AND-STATE.md`.

**DATELESS. UPDATED IN PLACE.** This is the queue the orchestrator re-reads rather than remembers.
Two lanes run in parallel and must not be confused: **LANE 1 the web build** (Vercel/Neon/Next.js, the tmux
panes, worktrees) and **LANE 2 the clinic fleet** (Swift recorder, macOS CoreAudio, room Minis, OPS).
A fault in one lane is almost never fixed by work in the other.

---

## LANE 1 — THE WEB BUILD

### SHIPPED TO PRODUCTION
- **E16** emotion speech fraction, `segments_run_id`, the stale-segments cure.
- **E18** silence is a named, evidenced, re-adjudicable state; a bound that fails closed and cannot be minted.
  Production `64ce357` (`dpl_2ZX5Ew6kx`). Migrations **0097, 0099, 0101 applied**, live shape verified.
- **E31 BATCH 1** — 7 of the 19 sites that read as success when half-written: A1, A2, A4, A7, A12, D3, D1.
  Two sites were deliberately **un-collapsed** rather than made atomic (D3, A12), hence the merge message
  *atomicity where it is honest, separation where it is not*. Production **`c8ffc12`**
  (`dpl_BC2eKYJRdht4USB6AnNHhdBm66j6`, target production, READY, serving evenscribe.app — verified from
  Vercel's own record, not from a pane). Final gate **118 files / 2,818 tests**. No migration in this batch.

### IN FLIGHT
| id | what | where | state |
|---|---|---|---|
| E32 | no session while NEITHER the lockout counter NOR the rate limiter is recording | `vinay/e32-pin-bound` @ `c87196e` in `-e32` | **REFUTED: SOUND WITH FINDINGS.** No finding rises to UNSOUND. |
| E32b | the two refusals made symmetric in work, not just in bytes | `vinay/e32b-refusal-symmetry` in `-e32b`, off `c87196e` | built; follow-up round in flight |
| RR-0.1.23 | room-recorder version bump + PR #3 FD-leak fix | `vinay/rr-0.1.23` @ `b0c898d` in `-rr23` | **BUILT AND SIGNED**, not pushed, not uploaded |

### E32 — THE TWO OPEN ITEMS, RULED BY THE ORCHESTRATOR
The builder flagged two rather than deciding them. Both were mine, and both are decided:

- **ITEM 11 — THE TIMING ORACLE. REAL, AND FIXED IN E32b.** Under total write failure the correct-pin path
  attempted **three** writes (`pin_attempt`, `clinician`, `audit_log`) and the wrong-pin path **two** (no audit
  row — verified by reading `recordFailedAttempt`). A refusal that costs an extra round trip for the right pin
  announces the right pin. **The cure was symmetry, not deletion:** the wrong-pin unrecorded path got its own
  audit write under `auth.pin_attempt_refused_unrecorded`. Deleting the correct-pin audit row instead would
  have bought symmetry by destroying the only operator evidence that a session was refused — refused, and
  pinned by mutant M5. **Measured after the fix: 6 round trips each side, 3 writes each side, counted at the
  driver AND from the server log (`log_statement=all`), the two counts agreeing.** The fix also closes a gap
  that stood on its own: before it, a brute force during a write outage left **no audit trail at all**.
- **ITEM 12 — THE FAULT-CLEARS-MID-WALK CASE. REAL, ACCEPTED, OPENED AS E33.** Bounds are checked only when
  the correct pin arrives, so guesses made during the outage are forgiven once writes return. The Refuter
  confirmed it: **40 guesses in a read-only window, all uncounted, session issued the instant writes came
  back.** Not fixable without a durable pre-write bound. The only bound surviving a total write outage is one
  needing no write — an in-memory per-doctor count — which on serverless is per-instance and partial.

### E32 — WHAT IT MAY AND MAY NOT CLAIM (scope limit, do not let this travel unqualified)
**The indistinguishability property holds in the TOTAL failure case ONLY.** Under a **counter-only** fault
R63 deliberately allows the login, so a correct pin returns 200 and a wrong pin 500 — distinguishable, and
lockout escalation is disarmed (the hard lock at 30 never fires while the clinician table is degraded);
guessing is then bounded only by the 60/hr limiter. That is the accepted cost of not locking clinicians out
mid-clinic, not an oversight. Related, and the reason the timing oracle was cheap to exercise:
`preAttemptCheck` counts `pin_attempt` rows, so **under total write failure no row is ever written, the 1/sec
and 60/hr gates see zero rows, and nothing throttles** — guesses fly at full network speed. Folded into E33.

### E32b — REFUTED SOUND WITH FINDINGS. RULINGS MADE, READY TO MERGE.
Round-trip symmetry measured after the fix: **6 round trips and 3 writes on each side**, counted at the driver
and again from the server log with `log_statement=all`, the two agreeing. 9 of 9 mutants RED, including **M5,
"symmetry by deletion"** — removing BOTH audit writes also equalises the counts, and 9 tests catch it. That
mutant is what stops a later reader "simplifying" this back into the defect.

- **F1 AUDIT-LOG AMPLIFICATION — ACCEPTED, no code change.** Every wrong pin against a degraded
  clinician/pin_attempt with audit_log writable now forces one `auth.pin_attempt_refused_unrecorded` INSERT, and
  nothing throttles (no `pin_attempt` row → `preAttemptCheck` counts zero). **Measured: 150 guesses → 150 rows,
  network-bound.** Rejected the obvious cures: **sampling or rate-limiting the wrong-pin audit write reopens the
  timing oracle** — sample 1-in-10 and nine wrong pins in ten make two writes while the correct pin makes three.
  A cap is admissible only if evaluated IDENTICALLY on both paths on pin-independent inputs, which is in-memory
  per-instance state — E33's territory, not a pre-merge patch.
  **Severity bounded by a fact I checked rather than reasoned:** `clinician`, `pin_attempt` and `audit_log` all
  go through `lib/db.ts`'s single `APP_DATABASE_URL` — one database, one storage. So if the outage cause is
  storage quota (the first cause E32's own comment names), audit_log fails with them and NO rows are written.
  The amplifying case needs audit_log writable while the other two are not: table locks, a permissions change, a
  bad index, a failing trigger — never storage. What remains is an audit reader drowned in attacker noise, and
  against that, **before E32b a brute force during a write outage left no trace at all.** The cure for the noise
  is a reader that aggregates, not a writer that stays quiet. → see OPEN LINES.
- **F2 `pin_attempt.success` UNVERIFIED — being fixed.** A mutant flipping the wrong-pin INSERT to
  `success = true` survived the whole suite; nothing in-repo reads the column beyond `COUNT(*)`, but a wrong
  guess recorded as a success would mislead any external analytics or SIEM consumer. Test-only assertion.
- **F3 dead `??` fallback at `lib/lockout.ts:253` — ACCEPTED as a latent trap, queued not fixed.**
  `counterMiss` is set on every `not_recorded` exit so the branch is unreachable today; a future return that
  forgets to set it would silently mislabel itself `zero_rows`. One line, for the next round that touches
  `lib/lockout.ts`. **Do not let this one rot.**

### THE 8 UNPINNED ORDER-DEPENDENT SITES — SURVEYED
The question here is not what a half-written state claims but **what holds the order** — an order that is
enforced is not a defect; an order that is merely habitual is.
- **One mechanical pass: A3, A6, C6, C7, D6.** A6 is held by data flow (one write's `RETURNING` feeds the
  next), B7 in step mode by a read-gate, B8 by a guarded claim, **A3 by nothing at all**.
- **Cannot go in that pass: B6, B7, B8** — all three live in the file the B1/B2 builder is editing, and no test
  executes that route yet. **B6 cannot run in parallel with B1/B2** (the PRD has the builder editing `:867` and
  `:875`, either side of B6's `:872`). After B1/B2 merge, B6 is small and independent.
- **C6/C7 is a real finding:** the delete's `error IS NOT NULL` predicate matches the errored row the same call
  just inserted, so **failures delete themselves**, and the leaderboard's reliability figure
  (`leaderboard.ts:61-62`) therefore **overstates every engine**. One pattern, two call sites, no test.
- **D6:** the recompute reads, computes and writes with no lock, so two concurrent recomputes produce the same
  stale centroid. The right order is not enough. The sample-delete route has the same shape and is not on the list.
- **A live concurrency hazard that is not an ordering problem at all:** the claim TTL equals `maxDuration`
  (300 s), and neither the release nor the step's own writes check who holds the claim, **so a slow step can
  clear a newer claim and overlapping steps are possible today.** Its own item.
- **No test bites any of the eight.** In those words.
- **B6 corrected the survey the way D9 did:** the earlier read trusted an out-of-date comment (`:869-871`) while
  the `CASE` at `:789` says otherwise. Two sites now where a comment lied and the code told the truth.

### LANE 1A — THE SIGNAL LANE. **THIS IS THE PRIORITY. V, 18 Sep 2026.**

> *"We're not building a platform that is attackproof, this is a demo. I'm more interested in getting the
> Speech to text, analysis and voice identification working."* — V, 18 Sep.
> *"There is no doctor portal in the app now... The passive recording with zero doctor input is the way we
> are taking this app's development."* — V, 18 Sep.
>
> **`QUEUED, IN ORDER` below is the hardening lane and is now SECOND.** It is not cancelled — E32b is built
> and owed a merge, and the E31 sites are real — but nothing in it outranks an item here. Anything that
> assumes a per-doctor portal surface is **dead**, including `ETA-OVERLAPPING-WRITERS-PRD-18-SEP-2026.md`
> and the parked commit `bbcdca3` (built against the defunct surface, never merged, do not resurrect).

| # | item | state | why here |
|---|---|---|---|
| S1 | **The room-day output surface.** `/admin/rooms` → room → date → the tape: every 15-min slot down the day, transcript, turns, voice match, the losing score, emotion, and gaps rendered as gaps. | **SHIPPED TO PRODUCTION 18 Sep** — merge `ba2368a`, production `dpl_EtyefU2wnpNuykGFawrHkbr2BDJr`, gate 129 files / 2,969 tests / 0 failures. Refuted UNSOUND on round 1 (slot grid anchored to `session.started_at`, off-by-one on all 74 room-days, first window of every day falsely rendered "not recording"); fixed and re-verified against live production rows, 49/49 windows placed in both test rooms. | Everything below was unreadable without it. |
| S2 | **~~Voice thresholds set from evidence~~ → ROOT-CAUSED 19 Sep: THERE IS NOTHING TO CALIBRATE ON.** `room_turn_speaker` holds 3,456 rows with **`clinician_id` non-null = 0** and **`match_confidence` non-null = 0** — the room path has never matched anyone, ever. All 2,225 losing scores top out at **0.556**. A negatives-only distribution; calibrating on it is fitting to impostors. | **BLOCKED, and not on threshold work.** | See S2a/S2b below — the threshold is not wrong, it was never asked a question. |
| S2a | **Drain and diarize OPD 5 (Salanki's room).** The one room with a provably-matchable enrolled speaker. It has **256 `bench_window` rows, 1 clip, 0 diarized windows, 0 turn cues** — find why 256 windows produced one clip, then process it. | **NEXT after S1.** | Probe proved the matcher works on production-shaped windows of this room's audio: 5 of 8 matched, **0.780–0.908**, no false positive against 7 centroids. It has simply never been asked. |
| S2b | **Re-enrol the May/June cohort from room audio** using the mining method proved on Salanki. Vinay speaks 592 s in his own Home Office with a 31.4 s segment and reaches only **0.535** against his own May print — a channel mismatch that caps the 27 Home Office windows, half the diarized corpus. | after S2a | Without it, half the corpus can never match regardless of threshold. |
| S2c | **Then** set the thresholds, on genuine positives. | after S2a+S2b | This is the original S2, in the only order that can work. |
| S3 | **Emotion floor set from evidence.** `EMOTION_ENABLED` computes and stores; `EMOTION_SURFACE_ENABLED` shows. Nothing reads emotion rows for a clinician yet, and a test asserts that. The job queue stopped 14 Sep; rows resume from 18 Sep. | blocked on rows | Same shape as S2: the number must come from data, not from me. |
| S4 | **Voice mining / centroids** (Salanki first: 7/7 days inside 11:30–14:15, ~7.5 h in Metabase-confirmed windows over 4 days). | running in `scribe3` | Produces the labelled voice truth S2 needs. |
| **JEV** | **Jev is now a standing development tool, not only a product component.** `even-jev` MCP installed and keyed on the Mini. `jev_review` joins the Refuter (after its own read and test rerun, as leads never as a verdict); question wording is trialled on fixtures before it is hard-coded; every Jev signal is benched offline before it is wired. | **IN FORCE 19 Sep.** | `ETA-JEV-INTEGRATION.md`. **D1 split: D1a (non-PHI dev use) OPEN; D1b (real consult transcripts) still V's and still closed.** |
| **J0** | **English window text** — `jev_window_text` + job `jev-english`. | **NEW, 18 Sep. Not started. Unblocks J2.** | See below. Jev is English-primary and the skill says *translate first* — J0 is that step, and it runs on the Mini, so it needs nothing from the vendor. |
| J1 | Jev provider client, mock-only, no SDK. | not started | No vendor contact; D1 not engaged. |
| J2 | **Arm D (`jev`)** — window signals → DraftVisits. | not started, needs J0 | First text-derived visit boundary signal. Today boundaries come only from typed cues with constant confidences. |
| J3 | Text role signal for diarized clusters. | not started, **ordered AFTER S2** | Its composite rule is *"acoustic wins if `clinician_id` is set"* — that defers to a signal S2 has not calibrated yet. Building J3 first would bake an uncalibrated arbiter into the composite. |
| J4 | The Jev bench on real room-days. | **blocked on D1 (V), and on truth volume** | See the volume finding below. |

**Spec:** `ETA-JEV-ARM-D-SPEC-v1.0-18-SEP-2026.md`, **now at v1.1** — read the amendment banner first.

**THE FINDING THAT ADDED J0 (measured 18 Sep, not assumed).** Arm D's declared input,
`transcription_run.transcript_english` for `subject_type='bench_window'`, is **NULL on every window that has
ever existed.** `lib/stt/room-drain.ts:1235` submits with `translate: false`, so `asr.english` is NULL at the
insert (`room-drain.ts:1066`). The spec's fallback — use `transcript_original` when `detected_language='en'` —
**cannot fire either**, because `detected_language` is NULL on every bench_window run too (the router never
reads a language code back). Checked on `bw_bxcb9drz_1789739100000_primary` (today) and
`bw_6jwz5r79_1789290000000_primary` (13 Sep). **Arm D as specced would have skipped 100% of windows and
emitted nothing, silently, and looked like a model failure.** The English signal does exist — in
`metrics_json` (`full_window_language`, `sarvam_language`, `language_timeline.language_mix`) — just not in
the column the spec read. J0 reads it from there and translates the rest **on the Mini**.

**RULED (D4): J0 derives English in its own job; the drain is NOT flipped to `translate: true` yet.**
Flipping the drain is the right end state but the wrong first move — it pays an Ollama call per non-English
span for every window in every room, in a drain live for hours and unmeasured, to serve an arm nobody has
shown is worth wiring, and it backfills none of the ~450 h already recorded. Revisit after J4. `room-drain.ts`
stays on the spec's forbidden list so no builder "helpfully" fixes this the other way.

**J4 VOLUME FINDING.** Truth today is **37 `consult_mark` cues across 17 room-days**, against **48 room-days
carrying audio** (5,414 chunks, ~450 h). The spec's ≥10 room-day gate is met; the statistics are not. On ~37
positives a recall estimate carries a 95% interval of about ±0.13, so the ≥0.80 acceptance bar **cannot be
accepted or rejected on run 1**. v1.1 therefore requires every metric to be reported with its CI and
denominator, makes run 1 directional, and holds the verdict until ≥100 truth opens exist. More marks come from
clinic use, not from building.

---

### QUEUED, IN ORDER — **HARDENING LANE, SECOND to LANE 1A above (V, 18 Sep)**
1. **Rule on the Refuter's E32 verdict**, then **E32b**: the item-11 symmetry write (`scribe3`, narrow).
2. **Re-refute E32b**, merge to `vinay/s1-auto-drain`, gate the merge commit, push, **PROMOTE** (a push alone
   is only a preview on this project).
3. **Apply 0100** (perf index, correctness-neutral) at any convenient point.
4. **E31 BATCH 2** — 12 remaining coupled sites. **Recommendation: B + D first (5 sites, one round).**
   - *Encounter pipeline* — B1, B2. Roster/transcript disagreement; `diarize_status` stuck `running` because
     the failure write is swallowed.
   - *Brain / support* — D2, D5, D9. Cue delivered while its row says `failed`; route answer disagrees with
     the database; orphan scratch rooms.
   - *STT lab scoring* — C1, C2, C3a/b/c, C4, C5. Engine-selection quality, not patient data. Deserves its
     own justification before it is started.
   - Plus **8 unpinned order-dependent sites** (A3, A6, B6, B7, B8, C6/C7, D5, D6) — one mechanical R52-style pass.
   - **Carried into batch 2 in writing:** the `diarize_stale` narrow write; drift-test coverage outside
     `segments_*`; the harness gaps; delete-side injection; the missing R62 builder report.
5. **E33** — the memory-resident brute-force bound (from item 12 above).

### ORPHAN COMMITS — unmerged, not lost
- `vinay/e20-losing-score` @ `c041ea8` — **2 commits ahead.**
- `vinay/tier2-c3` @ `9877494` — **1 commit ahead.**
Every other branch is 0 ahead, i.e. already in production.

### OPEN LINES (web), none blocking
E13 (dead-mic detection — now has E18's evidence rows to work from) · E15 · E19 · E21 · E27a (SwiftPM macro
planner fault, concurrency) · E28 (the NULL-mark cure never runs through the diarize job) · R28
(`validateKeywrap` relabels every error, including I/O, as `keywrapMismatch` — destroys diagnostics) ·
F5 option 3 · the **1,442-window backlog** (needs a sized cron run, not a build).

### STANDING RULES EARNED
- **D-5 coupling scope** — before collapsing two writes into one statement: *who else reads these rows, and do
  they want the same failure domain?* (`pin_attempt` served the lockout AND the rate limiter; collapsing it
  disarmed the limiter with every test green: 12 wrong pins, 0 rows, nothing throttled.)
- **Failure scope** — a write that records a failure must not depend on anything the failing write depended on.
- **Login asymmetry** — an unrecorded FAILURE must not be ignored; an unrecorded SUCCESS must not be punished.
- **Refusals must be indistinguishable** — including in how long they take. A security refusal that varies by
  case leaks the case. (E32 item 11.)
- **Deploy order** — migration to production BEFORE the code, never after.
- **Promotion** — pushing the branch builds a PREVIEW. Production requires an explicit promote.
- Every commit runs the full gate. Reports land on the real bus. **Verify with git, not with pane output.**
- Neon's HTTP `sql.transaction()` is NON-INTERACTIVE — a fixed array of queries, no application logic between
  them. 36 of 40 coupled sites use that handle. This is why the cures are one-statement CTEs, not transactions.

---

## LANE 2 — THE CLINIC FLEET

Source: `EvenScribe-Clinic-Day-Bugs-2026-09-15.md`, nine faults S1-S9 across nine rooms.
**These are Swift recorder / CoreAudio / OPS faults. None of them is fixed by Lane 1 work.**

### THE ROOT CAUSE, FOUND BY MEASUREMENT — **0.1.21 CANNOT CAPTURE FROM THE TONOR TM20**

**This supersedes the earlier "the doctor is muting between encounters" conclusion, which was wrong.**
That reading was reasonable and it was refuted by V and then by measurement: V confirmed Cardiology was in
intermittent use all day, so patients were seen outside the captured window. Recorded here so the corrected
finding is the one that survives.

**Method:** every byte of the live tapes read over Tailscale, read-only, amplitude statistics only. No audio
retained, none transcribed.

| Room | App | Device | Audio captured |
|---|---|---|---|
| Cardiology | 0.1.21 | TONOR | **1.86%** (7.2 min in 6.5 h) |
| OPD 3 | 0.1.21 | TONOR | **1.14%** (6.2 min in 9.07 h) |
| OPD 6 | 0.1.21 | C270 | **77.97%** |
| Home Office | 0.1.22 | TONOR | working |

The app version, not the room and not the operator, is what separates these. **0.1.22 fixes it.**

**THE DECISIVE OBSERVATION: the silence is BIT-EXACT ZERO, not low-level noise.** A live analog input in a real
room always yields some nonzero samples — room tone, HVAC, electrical. Hours of exact zeros is a **null
stream**. That is also why this read as operator mute for days: **a deliberate mute and a dead capture path are
currently the same observable.**

**MITIGATION EXECUTED AND VERIFIED (V authorised):** both TONOR rooms switched to the C270.
Cardiology **77.41%**, OPD 3 **84.25%**. **REVERT THIS once 0.1.23 is on those rooms.**

**Three hypotheses killed by measurement, so nobody re-opens them:** default-input mismatch (FALSE — TONOR is
default on every silent room); wrong-device binding (FALSE — bound by UID, correctly); "OPD 7 is a retired
install" (FALSE — one install, `retired_at: null`; the room's name in the database really is `"OPD 7 -"`).

### CLUSTER 3 — THE BOOTSTRAP TRAP. **NO PIPELINE CHANGE CAN REACH OPD 1 AND OPD 4.**
0.1.8's updater requires `anchor trusted` as well as our certificate leaf. 0.1.18 fixed the check, but only for
builds that already contain it. No release we publish can satisfy 0.1.8 on those two Macs, so each gets **one
bootstrap paste by hand**. Separately, **PR #3 is versioned 0.1.22** and the updater only offers a version whose
string differs, so Home Office would never be offered its own leak fix — which is why it ships as **0.1.23**.

### STANDING AUTHORISATION FROM V — 17 Sep 2026
V authorised shipping **0.1.23** and authorised the orchestrator to run **both** release stages (test, then
stable) rather than handing him commands. **Scope: this build only.** Push, merge, promote and production
migrations remain V's decision for everything else, and two panes wrote themselves `push` commands unprompted
this morning — check the prompt line before every dispatch.
**Stable is gated on two things, not on the authorisation:** the Home Office PIPE count flat over 10 minutes
while recording, and a source-settled answer to whether a self-update can stop a recorder mid-encounter. If it
can, the promotion waits for the clinic day to end — V is in the OPD today.

### FLEET QUEUE
1. **TODAY, ON SITE — OPD 4 and OPD 1** off 0.1.8, onto the tailnet, onto 0.1.21 by bootstrap paste.
   Runbook: `ETA-FLEET-OPD-DAY-KIT.md`. Rulings applied: bootstrap paste only, no per-Mac certificate trust;
   a new install id is accepted; PR #3 ships as 0.1.23, `test` channel first then `stable`.
   Also worth C1 while on site: **OPD 5** (`DEVICE_MISSING` + `ENCODER_STALLED`, `input_devices: []` — check
   the C270's USB) and **OPD 7** (no poll since 10:53Z; may be asleep or at the login window).
2. **Ship 0.1.23** — `test` channel, verify on Home Office (PIPE count flat over 10 min while recording),
   then promote to `stable`. Rooms on 0.1.21 take it within 6 h. **No second visit.**
3. **Revert the C270 workaround** on Cardiology and OPD 3 once 0.1.23 is on them.
4. **Rebind-on-device-change** in the recorder, and refuse to write zeros silently. This is the device-side
   half of **E13**; E18 already ships the field to record it (`audio_level_source='absent'`).
   Two discriminators, neither needing new plumbing: `zero_ratio == 1.0` EXACTLY is a null stream, not a quiet
   room; and read the device's own mute state (CoreAudio `kAudioDevicePropertyMute`) so
   `SILENT_WHILE_RECORDING` splits into **MUTED_AT_DEVICE** / **SILENT_UNEXPLAINED** / **DEVICE_GONE**, of
   which only the middle one is an alert.
5. Remaining on-site items: OPD 6 DNS + sleep (S4), HO TONOR reseat (S9).

### IGNORE
OT 3 (`ot-3-x79h`) — not ready.
