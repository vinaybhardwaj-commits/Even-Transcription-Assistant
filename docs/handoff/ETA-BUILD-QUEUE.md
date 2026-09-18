# ETA BUILD QUEUE — the single running list

**DATELESS. UPDATED IN PLACE.** This is the queue the orchestrator re-reads rather than remembers.
Two lanes run in parallel and must not be confused: **LANE 1 the web build** (Vercel/Neon/Next.js, the three
tmux panes, worktrees) and **LANE 2 the clinic fleet** (Swift recorder, macOS CoreAudio, room Minis, OPS).
A fault in one lane is almost never fixed by work in the other.

---

## LANE 1 — THE WEB BUILD

### SHIPPED TO PRODUCTION (16 Sep 2026)
- **E16** emotion speech fraction, `segments_run_id`, the stale-segments cure.
- **E18** silence is a named, evidenced, re-adjudicable state; a bound that fails closed and cannot be minted.
- Production `64ce357` (`dpl_2ZX5Ew6kx`). Migrations **0097, 0099, 0101 applied**, live shape verified.

### IN FLIGHT
| id | what | where | state |
|---|---|---|---|
| E31-A-fix | R60 (A2 assertion pins `diarize_run_id`) + R61 (drift test over the 3 copies of the window-row conflict rule) | `scribe3` → `-e31a` | building |

### QUEUED, IN ORDER
1. **Re-refute half A** after the fix (ETA-Refuter, narrow: R60/R61 only).
2. **Merge batch 1**: `vinay/e31-atomicity-a` + `-b` + `vinay/e31-harness` → `vinay/s1-auto-drain`. merge-tree probe, `--no-ff`, gate the merge commit. **No migration in this batch.**
3. **Deploy**: push, then PROMOTE in Vercel (a push alone is only a preview on this project).
4. **Apply 0100** (perf index, correctness-neutral) at any convenient point.

### E31 BATCH 2 — SCOPED, NOT STARTED (V's decision to start)
Of 40 coupled write sites, 19 read as success when half-written. Batch 1 fixed 7. **12 remain:**
- **Encounter pipeline** — B1, B2. Roster/transcript disagreement; `diarize_status` stuck `running` because the failure write is swallowed.
- **STT lab scoring** — C1, C2, C3a/b/c, C4, C5. Bake-off permanently missing an engine; every run `is_winner=false`; stale WER against a deleted reference.
- **Brain / support** — D2, D5, D9. Cue delivered while its row says `failed`; route answer disagrees with the database; orphan scratch rooms.
- **ORCHESTRATOR'S RECOMMENDATION:** do **B + D (5 sites, one round)**. C is engine-selection quality, not patient data — it deserves its own justification.
- Plus **8 unpinned order-dependent sites** (A3, A6, B6, B7, B8, C6/C7, D5, D6) — one mechanical pass, R52-style.

### OPEN LINES (web), none blocking
E28 (the NULL-mark cure never runs through the diarize job) · R28 (`validateKeywrap` relabels every error,
including I/O, as `keywrapMismatch` — destroys diagnostics) · E27a (SwiftPM macro planner fault, concurrency)
· E20 (half-built branch `c041ea8`) · E13 · E15 · E19 · E21 · F5 option 3 · the **1,442-window backlog**
(needs a sized cron run, not a build).

### STANDING RULES EARNED TODAY
- **D-5 coupling scope** — before collapsing two writes into one statement: *who else reads these rows, and do
  they want the same failure domain?* (`pin_attempt` served the lockout AND the rate limiter; collapsing it
  disarmed the limiter with every test green.)
- **Failure scope** — a write that records a failure must not depend on anything the failing write depended on.
- **Deploy order** — migration to production BEFORE the code, never after.
- **Promotion** — pushing the branch builds a PREVIEW. Production requires an explicit promote.
- Every commit runs the full gate. Reports land on the real bus. Verify with git, not with pane output.

---

## LANE 2 — THE CLINIC FLEET (see ETA-FLEET-FAULTS for the analysis)

Source: `EvenScribe-Clinic-Day-Bugs-2026-09-15.md`. Nine numbered faults S1–S9 across nine rooms.
**These are Swift recorder / CoreAudio / OPS faults. None of them is fixed by Lane 1 work.**

### THE ROOT CLUSTERS (not nine bugs — four)
1. **STALE DEVICE BINDING PRODUCES ZEROS, NOT ERRORS** — S3, S7, S8, S2. The recorder resolves the input
   device once and holds it for the life of a long-lived tapewriter. When CoreAudio's graph changes under it
   the binding goes stale and yields **digital silence that reads as a quiet room**. Same defect class as the
   whole E31 programme: a half-failed state indistinguishable from success.
2. **LONG-LIVED PROCESSES NEVER RELEASE STATE** — S1 (PIPE FDs, ~6 per 1.5s poll → EMFILE), S8 (a tapewriter
   surviving unplug/replug then returning `Bad file descriptor`).
3. **THE FLEET CANNOT BE UPDATED, SO FIXES CANNOT LAND** — S5, S6. `signature_mismatch` blocks 0.1.8 → 0.1.21;
   S1's Fix PR #3 is written and not on any Mini. **This multiplies every other fault and is the top priority.**
4. **NETWORK / IDENTITY** — S4 (`NSURLErrorDomain -1003`, DNS), OPD 7 falling back to the sign-in page.

### FLEET QUEUE
1. **Unblock the update path** (`signature_mismatch`) — nothing else scales until this works.
2. **Ship Fix PR #3** to the HO channel (S1).
3. **Rebind-on-device-change** in the recorder, and refuse to write zeros silently (S3/S7/S8 root).
4. On-site: OPD 7 USB re-seat / `coreaudiod` (S8) · HO TONOR reseat (S9) · OPD 6 DNS + sleep (S4) · OPD 4
   bring-up, Tailscale + SSH (S5).
5. **E13** (dead-mic detection) is the web-side half of cluster 1 and now has E18's evidence rows to work from.

### IGNORE
OT 3 (`ot-3-x79h`) — not ready.


---

## LANE 2 — MEASURED FINDING, 16 Sep 18:31 IST. **THE SILENCE CLUSTER WAS MIS-DIAGNOSED.**

**Method:** Cardiology (`echo`, `100.74.103.103`) over Tailscale, read-only. Every byte of the live tape read
(744 MB, 6.48 h, session `bs_s8jxd6mj`) — not sampled. Amplitude statistics only; no audio retained, none
transcribed.

**Three hypotheses killed by measurement:**
1. *"TONOR selected but Default Input is C270"* — FALSE. TONOR is default on every silent room.
2. *"The recorder binds the wrong one of two USB mics"* — FALSE. `tapewriter` args carry
   `--device AppleUSBAudioEngine:FuZhou Kingwayinfo CO.,LTD:TONOR TM20 Audio Device:20200918:1` — bound by
   **UID**, correctly, to the TONOR.
3. *"Two physical mics correlates with silence"* — collapsed. OPD 3 is the doctor muting between encounters
   (V), leaving one case, and that case is explained below.

**What the tape actually says (12:03 → 18:31):**

| window | nonzero bytes | frac |
|---|---|---|
| 12:03–15:02 | **0** | 0.0000 |
| 15:03–15:17 | 1,977,091 | 0.0686 |
| 15:18–15:32 | 11,864,177 | 0.4120 |
| 15:33–18:31 | **0** | 0.0000 |
| **whole tape** | 13,841,268 / 746,016,000 | **1.86% ≈ 7.2 minutes of audio in 6.5 hours** |

**THE DECISIVE OBSERVATION: the silence is BIT-EXACT ZERO, not low-level noise.** A live analog input in a real
room always yields some nonzero samples — room tone, HVAC, electrical noise. Six hours of exact zeros is a
**null stream**, not a quiet room. And the 15:03–15:33 window proves the capture path works end to end.

**CONCLUSION: Cardiology's recorder is not broken.** It is faithfully recording a microphone that is muted at
the device, with one encounter's worth of audio unmuted around 15:03–15:33. `SILENT_WHILE_RECORDING` is firing
on normal clinical behaviour, which is why fleet alerts have been unusable: **a deliberate mute and a dead
capture path are currently the same observable.**

**THE REAL FAULT SET SPLITS IN TWO:**
- **NOT faults** — S3 (OPD 3) and S7 (Cardiology): mute between encounters.
- **Real faults** — S8 (OPD 7: `physical_fallback_required` on BOTH mics, tapewriter exit 1, `tape.pcm=0`),
  S2 (Room 4.1, same class), S1 (HO FD leak), OPD 5 right now (`DEVICE_MISSING` + `ENCODER_STALLED`, tape not
  advancing), S4/S5/S6 (network, bring-up, update).

**THE CURE — two parts, neither needing new plumbing:**
1. **`zero_ratio == 1.0` EXACTLY is a null stream, not a quiet room.** The recorder already computes
   `zero_ratio` and `peak`. Exact 1.0 over a sustained window means no analog path is attached. A quiet room
   gives `zero_ratio` below 1 with a small `peak`. That one discriminator separates muted/dead from quiet
   **today**, with no new API.
2. **Read the device's own mute state** (CoreAudio `kAudioDevicePropertyMute` / volume scalar) alongside the
   samples and record it, so `SILENT_WHILE_RECORDING` splits into **MUTED_AT_DEVICE** / **SILENT_UNEXPLAINED** /
   **DEVICE_GONE**. Only the middle one is an alert.
3. This is the device-side half of **E13**, and E18 (shipped today) already carries the field to record it:
   `audio_level_source='absent'`. We now know what belongs there.

**OPERATIONAL, FOR V:** Cardiology captured **7.2 minutes of audio today**. If patients were seen outside
15:03–15:33, that audio does not exist. Only V can say whether they were.

**CORRECTED, OPD 7:** not a retired install — one install, `retired_at: null`. It has simply not polled since
10:53 while the row still says `session_open: true, tape_advancing: true`. And the room's name in the database
really is `"OPD 7 -"`, so the kiosk label is not a render bug.
