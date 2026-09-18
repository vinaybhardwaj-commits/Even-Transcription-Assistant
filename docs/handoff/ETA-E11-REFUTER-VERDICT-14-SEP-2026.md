# ETA-E11 — REFUTER VERDICT · 14 Sep 2026 · pane `ETA-Refuter`

**PUSH (the branch only; not merge).** The deciding reason: a real Whisper outage, driven through the **real** client, still fails loudly with one attempt and no engine call. Each of a 500, a 500 whose body is `empty_transcript`, a timeout and a network error does. The silent path cannot reach the engine. What survived are **test gaps, not defects in the code**. Close the two named in §5 before merge.

**The diff is still uncommitted.** I reviewed the working tree, three files, sha256 at start and unchanged at end:
- `7144f83f…4646` `lib/jobs/kinds/room-window.ts`
- `41f47b08…9b30` `lib/stt/room-drain.ts`
- `6f4afce3…591f` `tests/unit/e11-silent-room-window.test.ts`

The commit must carry exactly these. Everything I ran was in an isolated `git clone --shared` of `f798edf` with those three files copied in. The working tree was never touched.

## 1. Gate, rerun by me (raw: `scratch/E11-REFUTER-gate-and-mutations-14-SEP-2026.log`)
- `npm run typecheck` → exit 0.
- `npm test` → **exit 1**, `Tests 4 failed | 2509 passed | 94 skipped (2607)`. The 4 are the Docker REQUIRED PROOF guards, identical to the Builder's.
- `ETA_ALLOW_SKIP_E2E=1 npm test` → exit 0, `Tests 2513 passed | 94 skipped (2607)`.
- `npm run check:silent` → exit 1. 9 findings, all in `app/[slug]/api/encounters/**` and `NoteComposerClient.tsx`; none in a changed file.
- `npm run build` → exit 0.
- E11 file alone → `16 passed (16)`.
- **Not run by me:** `swift build` / `swift test` (the diff has no Swift, §3), and the 4 real-Postgres suites (§3).

## 2. Attacks
**1 — the exact-match comparison: BROKEN (as a guard; the code is right).**
- **R1:** deleted the `http_502: ${EMPTY_TRANSCRIPT}` row and applied `===` → `.includes()`. **SURVIVED, 0 of 15.** The control, the row deleted with no mutation, is 15/15.
- **R2:** `===` → `.startsWith()` **SURVIVES with the row present**, 0 of 16.
- So the rule is pinned by one hand-typed fixture that nobody will recognise as load-bearing. `startsWith` is harmless for the strings `lib/whisper.ts` emits today, and unguarded for any future `empty_transcript…` string.
- **What should guard it:** a test through the **real** client whose server returns HTTP 500 with body `empty_transcript`. That is a realistic input, and the client itself produces `http_500: empty_transcript`. My probe does this: it catches `.includes()` (1 failed), `.endsWith()` (1) and `!full.ok` (4). `startsWith` needs one more case: every error the client can emit, asserting only the bare constant is silent.

**2 — the reverse refusal: UPHELD, each case separately, through the REAL client** (`scratch/E11-REFUTER-real-client-probe.test.ts.txt`)
- **Method:** the E11 scaffolding with the whisper mock **removed** and only `fetch` faked; `last_error` captured off `recordFailure`'s bound value.
- **Results:**

| Case | `last_error` | fetch calls |
|---|---|---|
| HTTP 500 | `whisper_unavailable: http_500: upstream exploded` | 4 (probe + full, each retried) |
| HTTP 500, body `empty_transcript` | `whisper_unavailable: http_500: empty_transcript` | 4 |
| Timeout (abort fires) | `whisper_unavailable: timeout_180000ms` | 2 (not retried) |
| Network (`fetch` throws) | `whisper_unavailable: network: fetch failed` | 4 |

- **Every outage case:** job `room_window_failed: whisper_unavailable`, steps `prepare → segment`, exactly 1 attempt write, 0 cues, 0 router/routing/run.
- **Control:** a real 200 with empty text → `prepare → segment → finish`, 0 attempts. 5/5.

**3 — no attempt consumed: UPHELD, with an untested guard.**
- **No attempt:** two consecutive silent drains write 0 attempts, and M3 is caught. In production a second silent drain of one window needs `force`: the first leaves it `transcribed`, and auto-drain selects only `closed`.
- **The silence write failing is reachable.** `writeWindowCues` returns `complete:false` whenever the brain batch POST fails (`brain_timeout`, `brain_unreachable`, permission; `lib/mcp/tools/bench.ts:1484-1555`), and `cueWriteFailed` is `complete !== true` (`room-drain.ts:80-82`).
- **Consuming an attempt there is right.** A silence that did not land is not a finished read. It mirrors the speech path (`:961-965`) and is bounded; not consuming would loop two Whisper calls a tick for the length of a brain outage.
- **But no test pins it. R3: removing the silent branch's `cueWriteFailed` check SURVIVES, 0 of 16.** With that deletion, a brain outage finishes a silent window `transcribed` + subject `done` with no record in the day. The window is never re-picked. That is the K5 violation exactly, invisible and permanent.

**4 — no routed-engine call: UPHELD.**
- **Tests:** M4 (kind always → engine), M5 (flag not set) and M7 (branch removed) each fail 4 tests, including V4's 0 routing reads / 0 router submits / 0 runs.
- **Can the flag be set the other way?** No.
  - `scribe_job.progress` has exactly three writers: `insertJob` (no progress), the runner's `saveStep` (step and progress in one UPDATE, `lib/jobs/store.ts:132-136`), and the runner's `recordFailure` (re-saves the same progress, `:247-259`).
  - `silent_window: true` is written only at `room-drain.ts:801`, and arrives only together with `step=finish`.
  - `prepare`'s `next_progress` (`:680`) is built fresh.
  - No MCP tool writes progress.
- **Latent, not live.** The speech branch's `next_progress` spreads `...progress` and never sets `silent_window: false` (`:970-980`). Any future step order that re-enters `segment` after a silent result, within one job, would carry `true` into a spoken window and skip its engine. A one-token hardening for `scribe`: `silent_window: false` there.

**5 — the three-path test notices a fourth: BROKEN beyond one shape.** Run empirically in the clone, only the sweep test each time, each file removed after:
- (a) new `lib/` file calling `transcribeWithWhisper` → **FAILS (caught)**.
- (b) new window reader via `whisperAdapter` (`lib/stt/adapters/whisper.ts`, classified "not a window reader") → **passes**.
- (c) a new window reader added **inside an already-classified file** (`lib/stt/measure-job.ts`) → **passes**. The table classifies files, not call sites.
- (d) a new caller under `services/` (source root outside `lib app scripts`) → **passes**.
- (e) a new caller POSTing to `${WHISPER_BASE_URL}/inference` directly → **passes**.
- **What would catch them:** classify **call sites**, not files. Sweep every tracked source root (`lib app scripts services components`), include importers of the adapter and literal `/inference` / `WHISPER_BASE_URL`, and fail on a new call site inside a classified file. The durable version is the ruled follow-up: one classifier of a Whisper result, plus a sweep that every read of `.error` on it goes through that classifier.

**6 — the mutation count: 9 of 9 reproduced.** Same mutations, applied by exact string (each matched exactly once), restored with a sha256 check (`scratch/E11-REFUTER-mutate-14-SEP-2026.py.txt`):
- M1 → 1 failed; M2 → 6; M3 → 1; M4 → 4; M5 → 4; M6 → 1; M7 → 4; M8 → 1; M9 → 1. The Builder's per-mutation counts match mine exactly.
- **Plus mine:** R1, R2 and R3 survive (above). The real-client probe catches `.includes()`, `.endsWith()` and `!full.ok`.
- **My count: the E11 suite catches 9 of 12 (all 9 of the Builder's; R1, R2, R3 survive). My real-client probe catches 3 of 3.**

## 3. The two waivers
- **E2E skip: SOUND.** None of `c2-e2e-runner`, `s1-auto-drain`, `s1-emotion-zero-scored` or `s1-fix2-migrations` drives `roomWindowSegment` or the room_window kind. The one source-text assertion inside a Docker-skipped block that reads `room-drain.ts` (`s1-auto-drain.test.ts:415`, the `flag_off` line) still matches exactly once in the diffed file.
- **I did not start Docker — it is not cheap tonight.** 20% memory free of 24 GB, ollama resident at 9.6 GB, and the Mini hosting whisper, diarize, emotion and `scribe3`'s evidence work. The 4 suites remain **UNRUN**, not green (rule 8).
- **Swift: SOUND.** `git status --porcelain -- apps` is empty, and the diff is exactly the three files above. I did not rerun `swift test`.

## 4. What the brief should have told me to check
1. **Silence now flows into diarize.** A silent window ends `transcribed` holding a clip, which is exactly the diarize scan's predicate (`lib/stt/diarize-job.ts:128-131`). The diarize job downloads the clip and calls the service **without looking for turns** (`lib/jobs/kinds/diarize-window.ts:52-63`), then records `no_speakers`. Before E11 these windows sat `failed` and were never eligible. At tonight's 21-of-25 silence, most diarize runs (47–71 s of Mini each) would be spent on silence. It is not money, but it is the Mini's queue. A turn-count precheck in diarize is a separate decision.
2. **Silence is now final.** `transcribed` is never re-picked, so a window Whisper's VAD calls empty is settled for good. Before, it parked and could be looked at. A dead mic and a quiet room now end in the same state. That makes E10 §4.4 (VAD loaded from `for-tests-silero-v6.2.0-ggml.bin`) more important than it was.
3. **The kickoff said commit on green, and the verdict ordered commit.** Neither happened: the tree is uncommitted. Hence the sha256 pin above.
4. **Already raised by the Builder, not re-litigated:** F3 (`words_ms` counts 900 s of silence), F4 (2 Whisper calls per silent window).

## 5. Before merge (not before push) — for `scribe`
- **(a)** A real-client test with a 500 whose body is `empty_transcript`, replacing the lone hand fixture as the guard of `===` (§2 attack 1).
- **(b)** A test that the silent branch's cue-write failure costs one attempt and leaves the window `closed` (kills R3).
- Optional: `silent_window: false` on the speech branch (attack 4); the call-site sweep (attack 5).

Nothing fixed, pushed, merged or deployed. `lib/emotion/` untouched. No window re-drained. The clone and probe files live in session scratch; the evidence files are in `docs/handoff/scratch/E11-REFUTER-*`. Subagents: none.
