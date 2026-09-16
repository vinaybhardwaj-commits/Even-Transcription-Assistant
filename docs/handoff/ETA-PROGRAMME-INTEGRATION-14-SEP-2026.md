# ETA — PROGRAMME INTEGRATION: Enable-Everything PRD + VAD PRD + work in flight
**14 September 2026 · Orchestrator · supersedes nothing; it places three plans against each other**

Two documents arrived while `scribe` was mid-merge: the **ENABLE EVERYTHING** PRD v1.0, and
**Even-Scribe-Architecture PR #2**, `operator-mcp/ETA-VAD-SILENCE-GATE-PRD-14-SEP-2026.md` (416 lines).
Nothing in flight changes. This document says where each lands, what collides, and what is already done.

---

## 0. WORK IN FLIGHT — UNCHANGED, DO NOT DISTURB

| Session | Doing | Status |
|---|---|---|
| `scribe` | `ETA-S1-MERGE-CC-KICKOFF-14-SEP-2026.md` — comment fix, push, preview, **cron count (G11)**, migrations 0091+0092, promotion, per-room eligible-window counts | **IN FLIGHT** |
| `scribe3` | M7 (route vs whisper on ten real 13 Sep windows) | queued, starts when the Mini is free |
| `ETA-Refuter` | idle | next: whatever the merge reports |

**S1 auto-drain is FINISHED and twice refuted.** `d5c65fa`, FIX4 PASS, X1 closed, 2590 tests.

---

## 1. THE ENABLE-EVERYTHING PRD — its rulings stand, its slice list does not

Its **rulings are adopted whole and are not reopened**: R1 multi-centroid in-scope · R2 flags plus make
them work · R3 nothing stays dormant · D1 never average across microphones (best-of) · D2 the threshold is
**derived, never typed** · D3 emotion **capture** on, **interpretation** gated · D4 a re-run leaves window
and segment rows agreeing · D5 a refusal changes state or releases the slot · D6 the seventh cron is a
watch.

Four problems, all created by time passing rather than by the document.

### 1.1 NAME COLLISION — fix before any paste

The PRD numbers its slices **S1–S6**. Our in-flight auto-drain work is also **S1**, and the CI round is
**S2-CI**. A builder reading "S1" gets either multi-centroid or auto-drain depending on which document is
open. **Renumber the PRD's slices E1–E6** (E for Enable) everywhere, and never say "S1" to mean
multi-centroid again:

| PRD said | Now | Subject |
|---|---|---|
| S1 | **E1** | multi-centroid voice identity |
| S2 | **E2** | threshold calibration |
| S3 | **E3** | the three stubs |
| S4 | **E4** | auto-drain correctness |
| S5 | **E5** | health probes |
| S6 | **E6** | flip every flag |

### 1.2 E4 IS ALREADY BUILT — this is the dangerous one

**A fresh builder running E4 as written would rebuild finished, twice-refuted work and could only regress
it.** Every named finding is closed:

| PRD item | State | Where |
|---|---|---|
| **N1** `finish()` records `ok` while segment rows say `failed` | **FIXED** — counts and state derive from one statement | C5, FIX2 |
| **N2 / D5** refusal returns before the claim, starves the slot | **FIXED** — `auto_drain_refused_at` + cooldown, **migration 0092** | C6, FIX2 |
| **N4** tests green against broken code; misspelt env name | **FIXED** — env names spelled literally, non-default values, **env-name mutations in the mutation check** (11 of 11) | FIX3b |
| **D4 / G2** re-run leaves window and segment rows disagreeing | **FIXED, then fixed again** — write-iff-changed (C9), then **X1**: the tuple omitted `model`/`model_key`/`subfolder`/`cap_s`/`room_day_id` | C9 + C16, FIX4 PASS |
| **N3** throughput arithmetic on daily totals | **CORRECTED** — six rooms make 24 windows/hour, the cron drains 12 | round 3 |

**What genuinely remains of E4 — one item:** *"Model 6 rooms × 9 hours with one Transcript-off room: the
other rooms' drained windows must not fall below the all-rooms-on baseline. **Prove it, do not assert
it.**"* That model was never run **after** the fix. It is the acceptance evidence for C6 and it is owed.
**E4 reduces to that model.** Nothing else in E4 may be touched without a new ruling.

### 1.3 STALE CONTEXT in §4 — a fresh thread will trust these

- "Migrations written, **NOT applied**: 0091, 0092" — **being applied right now** by the merge round.
- D6 "the seventh Vercel cron stays an open watch" — **being counted right now** (G11). The merge stops
  before promotion if the count is not seven.
- "Production `14a4f38`" — **about to change**.
- "**THE TESTING RULES — ELEVEN NOW**" — **there are FIFTEEN.** Rules 12–15 were earned today: a refusal
  that does not become data is re-offered forever · a guard whose scope is a mutable property must run
  after that property is fixed · **a mutation only proves something if the test can tell the two sides
  apart** (a symmetric signing key changes both sides at once) · **"write only if it changed" is only as
  good as the definition of "changed"**.
- Two facts the PRD does not have: **CI cannot go green** — `ci.yml`'s last step is `check:silent`, which
  exits 1 by design on the 9 accepted handlers, red since 25 Aug — and **`main` is unprotected**, no
  required checks, no rulesets, no git hooks. See `ETA-CI-IS-DECORATIVE-FINDING-14-SEP-2026.md`.

### 1.4 R3 vs the one-room rollout — reconciled, not contradicted

R3 says no flag stays off. The merge round stops before enabling `ROOM_AUTO_DRAIN_ENABLED` and reports
per-room eligible-window counts instead. These agree: **one room → prove on real windows → all rooms**.
R3 is the destination, not the first step. A flag turned on before its slice is proven is exactly what R2
forbids.

---

## 2. PR #2 — THE VAD / SILENCE GATE, AND WHY IT REORDERS THE ENGINE WORK

PR #2 adds `operator-mcp/ETA-VAD-SILENCE-GATE-PRD-14-SEP-2026.md`: pre-decode gating (skip when speech
probability < 0.5 or speech ratio < 0.05 of frames, or ≤ −40 dBFS with low speech ratio),
`condition_on_previous_text=false`, post-decode collapse of near-identical segments at Levenshtein ≥ 0.92,
a repeat-ratio tripwire at modal dominance ≥ 0.60 or an identical run ≥ 8, three output markers
(`stt_silence` with `gate: vad`, `stt_degraded`, real turns), and a master kill-switch
`ETA_STT_SILENCE_GATE`.

Its measured claim: **of eight effectively quiet 15-minute windows, only one came back as true silence.**
*"Quiet rooms do not come back empty. They come back as words."*

### 2.1 This reconciles three measurements that did not fit together

| Audio | Whisper's loop behaviour |
|---|---|
| Real room windows, 13 Sep corpus | **~44% of non-empty jobs** looped (1,126 jobs, 4,363 repeat segments) |
| PR #2's eight quiet windows | 7 of 8 returned filler or loops instead of silence |
| M4's synthetic clip, continuous speech | **3 doubled sentences, 51 characters** — essentially none |

**The reconciliation, and it is load-bearing: whisper's loop pathology is driven by silence, not by
speech.** The measured envelope says **1.95% of a 900 s room window is speech** — a real window is ~98%
near-silence, and that is what whisper turns into words. The synthetic clip was continuous speech, so it
barely looped. **This is why the synthetic clip could never decide the engine question**, and I now know
the mechanism rather than just the fact.

### 2.2 The consequence: the VAD gate must land BEFORE the engine bake-off

Route's only measured advantage over whisper is loop suppression. **If near-silent slices never reach the
decoder, most of that advantage disappears** — and what remains is M6's finding that route emits **nothing**
for Indic passages (625 characters whisper at least romanised; 0 of 32 segments reached IndicConformer,
because the override at `router_server.py:439–443` requires the Indic result to be ≥ `max(24, 1.8 × whole
segment's whisper chars)`).

**So a bake-off run before the gate measures a problem the gate is about to delete.** Sequence the gate
first. This also revises **M7**: it must record **speech ratio per window**, or its result cannot be read.

### 2.3 Three definitions of repeat-ratio now exist — converge to one

PR #1 locked sanitize + repeat-ratio. M5 defined rules A/B/C (loops, identical/near-identical runs,
cross-segment). PR #2 adds modal dominance ≥ 0.60 and identical run ≥ 8. **Three documents, one metric.**
That is the drift that has cost this programme before. **One definition, in code, with fixtures; the PRDs
cite it.** Owed before any gate ships.

### 2.4 Compatible with the K5 rule

PR #1's K5 — a hallucinated non-empty 200 is not `stt_silence` — survives: PR #2's `gate: vad` marks a
**pre-decode** skip, `stt_degraded` marks post-decode filler. The distinction is exactly right and must not
be collapsed into one marker.

---

## 3. THE MERGED SEQUENCE

Nothing here starts before the merge round reports.

| # | Work | Depends on | Session |
|---|---|---|---|
| 0 | **S1 merge** (in flight) | — | `scribe` |
| 1 | **M7** — route vs whisper, ten real windows, **plus speech ratio and per-segment engine** | Mini free | `scribe3` |
| 2 | **V1 — the VAD / silence gate** (PR #2), with the **single** repeat-ratio definition | M7's speech ratios | new thread |
| 3 | **E4-residual** — the 6-room × 9-hour starvation model, post-fix | S1 merge | `ETA-Refuter` |
| 4 | **E5** — health probes (route → `/healthz`; pyannote budget; capture the Mini's real failure reason) | — | new thread |
| 5 | **E1 + E2** — multi-centroid, then derive the threshold | E1 before E2, always | new thread |
| 6 | **E3** — the three stubs | — | new thread |
| 7 | **E6** — flip the flags in order | all of the above | `scribe` |
| 8 | **S2-CI** — baseline `check:silent` so CI can go green | — | any |
| 9 | **Router fix** — the override's wrong unit (per passage, not per segment) | M7 | new thread |

**E5's route probe is already half-solved:** M1 moved the Mini's blocking model work off the FastAPI event
loop with `asyncio.to_thread` behind a `Semaphore(1)` — diarize `/health` went 3067 ms → ≤1.4 ms and the
router's three 15 s timeouts → ≤4.9 ms. What remains is pointing the app's probe at `/healthz` and raising
the pyannote budget.

---

## 4. THE SESSION CONSTRAINT — hard

**A fourth thread must not run the test suite while `scribe` or `ETA-Refuter` is running one.** The repo's
Postgres test helper uses a **fixed Docker container name** and vitest runs files in parallel, so two
suites at once delete each other's database mid-run. This has bitten the Builder once and the Refuter
worked around it by naming every throwaway container `eta-refuter-*`.

A new thread may read, plan, write documents and commit **at any time**. It may run `npm test` only when
the other sessions are idle. State this in its kickoff.

---

## 5. WHAT I AM NOT CHANGING

The Enable-Everything PRD's §8 non-goals stand: bulk STT of the 350.78 h backlog, emotion interpretation
(D3), closing `deepgram`/`elevenlabs`/`elevenlabs_scribe` pending V's bill check, the eight unversioned
Mini services, self-enrol accepting a disabled doctor's token, and the room hardware items.

Added to that list, from today: **rotate `EMOTION_SEGMENTS_SECRET`** — I printed its value in tool output
this morning and it is in a session transcript. Plist edit plus a `launchctl` reload.
