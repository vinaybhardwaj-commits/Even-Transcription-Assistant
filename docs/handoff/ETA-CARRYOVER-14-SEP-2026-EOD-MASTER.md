# ETA — CARRYOVER & STATE OF PLAY · 14 September 2026
**Written 15:35 IST · Orchestrator · this is the spin-up document. Read §1, §2 and §9 before anything.**

---

## 1. WHERE PRODUCTION IS, RIGHT NOW

| | |
|---|---|
| Production sha | **`fe021a3`** (deployment `6isfFDkXY`, redeployed 13:20 after env change) |
| Branch | **`vinay/s1-auto-drain`** — pushed. `main` untouched and stale. |
| Migrations applied | through **0093** |
| Region | `bom1` · `/api/health` → `ok: true` on db, kb, llm, whisper, resend, r2 |
| Crons | **seven**, including the new `/api/jobs/run` at `* * * * *` |
| Bus | `docs/handoff/` **in the repo**. Scratch in `docs/handoff/scratch/`. |

**Health is green for the first time since 13 September.** Every STT engine probes ok — whisper 89 ms,
sarvam 33 ms, route 327 ms, indicconformer 217 ms. Route's probe had been red for over a day and it was
the probe's fault, not the router's.

---

## 2. WHAT SHIPPED TODAY

**S1 auto-drain — built, twice refuted, migrated, promoted.** Four build rounds (FIX1→FIX4), two full
Refuter rounds, 2,590 tests green, 43 mutations verified. Final commit `d5c65fa`, merged at `fe021a3`.

**Migrations applied:** 0091 (disable gemini engine row) · 0092 (`auto_drain_refused_at`,
`auto_drain_refused_reason`) · 0093 (close the paid engines).

**The paid engines are closed and genuinely silent.** `deepgram`, `elevenlabs`, `elevenlabs_scribe`,
`ekascribe`, `gemini` — all `enabled=false`, `fanout_enabled=false`. **`sarvam` stays on: it is the one
paid API.** `DEEPGRAM_API_KEY` and `ELEVENLABS_API_KEY` **deleted from Vercel** and production redeployed.
Probes now return `deepgram_key_missing` / `elevenlabs_key_missing` rather than a green tick.

⭐ **Why the migration alone was not enough:** four Deepgram call paths and both health probes ignore the
`enabled` column entirely — the browser live-consult hook mints a token straight from the env key,
`process/route.ts:623` calls the batch API directly, both `transcribe-window` routes use the key, and the
MCP's paid guard checks name and duration but **not** `enabled`. **A database flag only controls the
callers that read it.** The env key was the real switch.

**A router crash found and fixed.** `router_server.py:550` sized `results` by `len(seg_jobs)` but indexed
it by the **original span index**, so any window with a skipped silent span before the last span raised
`IndexError` → HTTP 500; the `except` at `:559` wrote to the same bad index and re-raised. Fixed to
`len(spans)`, restarted, verified. Backup `router_server.py.bak-idxfix-20260914`.

**Two OPD kiosks stopped.** OPD 7 and OPD 4 – Ortho had been capturing into sessions ended days earlier.
`end_day` at 13:05 (`cmd_nhqfwqj2`, `cmd_tvrv8mq4`) worked — no window with a grid start ≥ 13:15.

---

## 3. THE ENGINE QUESTION IS ANSWERED

**Route is the slow lane's decode. Whisper-alone is not.** Measured on ten real 300 s OPD windows:

| | whisper alone | route |
|---|---|---|
| repeat_ratio | **0.370** | **0.0176** |
| M4 collapse fraction | 0.418 | 0.0193 |
| windows containing loops | 7 of 10 | 1 of 10 |
| native script | **none, all Latin** | **7 of 9 windows** (Kannada, Devanagari, 246 Gujarati tokens) |
| realtime factor | 0.025× | 0.220× |

**37% of whisper's output on real room audio is redundant text.** Route costs 9.29× the wall-clock, but on
Mini hardware that is free compute: a 900 s window ≈ 200 s, six rooms × 9 hours ≈ 12.6 h — it fits a night.
**PRD v1.2 S22 is no longer provisional.**

### Why whisper loops — located
**Context carry-over between 30-second decode windows inside one long request.** A 300 s request decodes as
~ten consecutive passes and each inherits the previous one's loop through the prompt. `max_context=0`
cuts redundant characters by 76% (5,300 fewer — **3.2× the measured noise floor**).

**`max_context` is a no-op under 30 s** (0 of 5 slices affected). Route already asks in 1.7–29.8 s
segments, so **the fix belongs on the app's long-audio whisper callers**, not the router: room-drain,
encounter processing, whisper-chunk, the STT adapter, the Mini's `stt-drain`.

**But request length explains only part of route's advantage.** On W07: full request ~0.37, sliced to 30 s
**0.24–0.32**, route **0.00–0.14**. The rest is VAD-shaped segments versus hard cuts, the English guard,
and engine choice — **unseparated, and the next question.**

### The loop pattern is a band
Whisper loops in **every window between 0.047 and 0.512 speech ratio and in none at 0.006, 0.627 or
0.726.** Not silence — **sparse, intermittent speech**, which is what a consultation sounds like.

---

## 4. ⭐ `temperature=0.0` IS NOT DETERMINISTIC — the method that saved us

whisper.cpp retries a failed decode at higher temperatures and samples randomly. Across three identical
passes, **6 of 10 windows were identical and 4 were not**; most noise sat in two windows whose repeat ratio
swung 0.000–0.623 and 0.346–0.741. **A single noisy window moves a ten-window pooled ratio by several
points.**

**This prevented a false positive.** A raw default-vs-off comparison on short requests showed 6 of 10
slices identical, reading as "`max_context` still does something." Once the varying slices were excluded:
**0 of 5.** Without the noise floor we would have adopted a setting that does nothing.

**Standing rule: every adoption test reports per-window spread and uses more than one pass per setting.
Pooled numbers are quoted only alongside that spread.**

---

## 5. OPEN DEFECTS

**K1b — the server accepts chunks for an `ended` session.** It opened a `room_day`, created windows and
closed them under sessions marked finished days before. **This is the containment**; fix it and the data
stops appearing even if a kiosk misbehaves. *(K1a — "the kiosk won't stop" — was refuted: `end_day` to a
listening kiosk works. What ended those sessions on 11/13 Sep without reaching the device is unexplained;
prime suspect is `close_orphaned_session`, which is a **server-side repair that queues no command**.)*

**No trustworthy answer to "is this room recording?"** Three views disagreed and all were honest:
`scribe_diff_room` counts a **session** with status recording; `scribe_day_report` counts sessions
**started** today; only windows count **chunks**. **A liveness signal must count chunks, not sessions.**
This invalidated two Orchestrator rulings in one afternoon.

**CI cannot go green.** `ci.yml`'s last step is `check:silent`, which exits 1 by design on the 9 accepted
handlers — red since 25 Aug, and it fires only on push/PR to `main`. **`main` is unprotected**: no required
checks, no rulesets, no git hooks. Fix: baseline the nine, same shape as `SYNTHETIC_CLINICIAN_IDS`.

**The router's silence gate collapses two states.** A silent skip and an engine failure both become `None`
and both vanish at the `:560` filter — contrary to PR #2's own rule that `stt_silence (gate: vad)` and
`stt_degraded` stay distinct. Also `n_skipped_silent` counts both short spans and silent spans.

**The app's whisper callers are English-forced.** Room-drain, encounter processing, whisper-chunk, the STT
adapter and the Mini's `stt-drain` send no language. **Two defects, not one:** "English-forced" (no
language sent) and "language never read back" (the router's JSON response has no language field, so
`w_lang` is always empty and every English-won segment is re-decoded with `en`). Fixing either alone is a
half-fix.

**Rotate `EMOTION_SEGMENTS_SECRET`** — its value was exposed in tool output this morning.

---

## 6. FLAG STATE, AND WHAT "ENABLE EVERYTHING" CAN AND CANNOT MEAN TODAY

V's R3 stands: nothing stays dormant. But the six flags are **not** in the same condition.

| Flag | State | Blocker |
|---|---|---|
| migrations 0091/0092/0093 | ✅ **applied** | — |
| `EMOTION_ENABLED` | **ready to flip** | none — health green; N1/D4/X1 all fixed and twice refuted today |
| `ROOM_DIARIZE_ENABLED` | **ready to flip** | none — health green |
| `ROOM_AUTO_DRAIN_ENABLED` | **one proof away** | the 6-room × 9-hour starvation model, post-fix. Never run **after** the C6 fix. |
| `SPEAKER_MATCH_THRESHOLD` | ⛔ **cannot be flipped** | **D2: it is DERIVED, never typed.** Deriving it *is* slice S2. |
| the three stub kinds | ⛔ **cannot be flipped** | no implementation exists — that is slice S3. |

**On the threshold, the reason matters.** At 0.65 a live match clears by 0.058 and *the same person on a
different microphone* clears by **0.001**. Turning naming on at a guessed number puts **the wrong doctor's
name on a clinical turn** — worse than `named:0`, which is at least honestly empty. That is V's own D2 and
the PRD's §3.1. Enabling it is blocked by arithmetic, not by caution.

---

## 7. THE TESTING RULES ARE FIFTEEN, NOT ELEVEN

The Enable-Everything PRD's §7 lists eleven. Four more were earned 14 Sep:

12. **A refusal that does not become data will be re-offered forever** — with bounded slots that is
    starvation, not inefficiency.
13. **A guard whose scope is a mutable property must run after that property is fixed** — scan the
    *staged* tree; a placeholder must never wear the shape of the thing it stands for.
14. **A mutation only proves something if the test can tell the two sides apart** — corrupting a
    *symmetric* signing key changes both sides at once and can never fail.
15. **"Write only if it changed" is only as good as the definition of "changed"** — a column left out of
    the comparison is a place the row goes stale silently.

---

## 8. PRD CORRECTIONS — read before handing it to anyone

The **ENABLE EVERYTHING** PRD's rulings (R1–R3, D1–D6) stand. Its slice list has drifted:

- **Rename its slices S1–S6 → E1–E6.** "S1" already means the auto-drain work.
- **Its S4 is ~90% built.** N1, N2/D5, N4 and D4/G2 are all closed by FIX2/FIX3b/FIX4, twice refuted.
  **What remains is the 6-room starvation model only.** A fresh builder running E4 as written would
  rebuild finished work and could only regress it.
- §4 says 0091/0092 unapplied (applied), production `14a4f38` (now `fe021a3`), eleven testing rules
  (fifteen), and does not know CI is structurally red or that `main` is unprotected.
- Its §3.2 N3 arithmetic was already corrected: six rooms make 24 windows/hour, the cron drains 12.
- **Its line "this PRD has no open issues" was true when written.** It has acquired several by time
  passing. A fresh thread will trust that line.

---

## 9. WHAT TO DO NEXT, IN ORDER

1. **Flip `EMOTION_ENABLED` and `ROOM_DIARIZE_ENABLED`** (Vercel env → redeploy → verify a real window).
2. **Run the 6-room starvation model** → unblocks `ROOM_AUTO_DRAIN_ENABLED`. `ETA-Refuter` is idle and
   this is its queued job.
3. **E1 + E2 — multi-centroid, then derive the threshold.** E1 before E2, always. This is the only route
   to naming.
4. **E3 — the three stubs.**
5. **Scope check before the whisper-caller fix:** rooms route to `route` (0084/0086), so some of those
   five long-audio callers may be secondary. **Answer that before spending a build round.**
6. **Route's own noise floor**, same method as W3 — no route-side delta is readable without it.
7. **A second room and a second day** before anything measured today generalises past OPD-7.

## 10. SESSIONS
`scribe`, `scribe3`, `ETA-Refuter` on the Mini. **Never run two test suites at once** — the Postgres
helper uses a fixed Docker container name and vitest parallelises; two suites delete each other's
database. `scribe3` holds the Mini for measurement work by standing order.

**Every GitHub action and every database migration runs through Claude Code, never V's terminal.**
`APP_DATABASE_URL` reaches a session by `read -rs` or command substitution from a file **outside the
repo** — never as a command argument, never in shell history. Env var **NAMES only, never values**.
