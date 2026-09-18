# ETA — MASTER STATE, ROADMAP AND SPIN-UP · 15 Sep 2026, 12:45 IST

**This file replaces the carryover chain as the single entry point.** A cleared pane reads *this file
only* and is productive. Do not make anyone read eight documents to start work — that is where the
tokens go.

---

## 1. GIT STATE — verified 12:45, not remembered

| worktree | branch | HEAD | state |
|---|---|---|---|
| `Even-Transcription-Assistant` (main) | `vinay/s1-auto-drain` | **`3aa75c9`** | E11 (e)(f) committed on top of `e925901` (E17). Only `CLAUDE.md` modified — **unexplained, nobody reported changing it.** |
| `…-e16` | `vinay/e16-emotion-speech-fraction` | **`f4f51c6`** | **6 files DIRTY** — E16's fix items (i)(ii)(iii) built but **not committed** |
| `…-e20` | `vinay/e20-losing-score` | **`c041ea8`** | clean. E20 + unique Docker container names, both committed |

**Pushed:** only `vinay/s1-auto-drain` through `ccd12b0`. Everything after that is local.
**Merged:** nothing. **Deployed:** nothing. **Migration 0096 / 0097: not applied.**
`ROOM_AUTO_DRAIN_ENABLED=0`. Production runs `fe021a3` + the two flags + the rotated secret.

---

## 2. WHAT IS DONE

| round | what | evidence |
|---|---|---|
| **E11** | a quiet room is not a failed read — silent windows finish clean, no attempt burned | 24/25 then the two rewrites killed; sweep reads every tracked file, `ADAPTERS` as 6th signal |
| **E16** | an emotion score records how much of its span was its speaker speaking | A9 now reads 2,280 ms / 29,070 ms = 0.078; **22/22** on the fix round |
| **E17** | the drain must not starve a room — least-recently-served room first | 8/8; ranks on recorder slot time, so fairness no longer depends on kiosks crashing |
| **E20** | record the score that lost, recomputed under a control | 11/11; control agrees to 3 dp (the service's own rounding) |
| **infra** | Docker test containers named per worktree | 4/4; **only `-e20` is protected until `c041ea8` is carried to the other branches** |

## 3. WHAT IS BLOCKED, AND ON WHAT

1. **E16's fix items are uncommitted** and wait on two suites that need Docker:
   `npx vitest run tests/unit/c2-e2e-runner.test.ts`, then `tests/unit/s1-emotion-zero-scored.test.ts`,
   **one at a time**. Docker's socket was answering 500s; that is why they were excluded by name rather
   than run.
2. **E20's Docker proofs need rerunning** — the 22:06, 22:2x and 22:3x runs are untrustworthy
   (container collision). Its unit tests, 11/11 mutations and live 13/0 control **stand**; only the
   0096 migration proofs and three Docker suites wait.
3. **`swift test` keeps failing to build** (`TestingMacros` plugin not found) **per worktree**, and a
   clean `.build` fixes it — 476 MB in `-e20`. **The E21 note must read "clear `.build` in every
   worktree", not just the main tree.**
4. **Nothing is refuted since:** E17 has **never** been refuted, and E16's fix round and E20 have not
   either. The E11 (e)(f) pass is ready to start the moment it gets the sha.

## 4. ROADMAP

**Now:** E11 final Refuter pass on `3aa75c9` → then E17's first refutation → merge both.
**Then:** commit E16's items once Docker allows → Refuter → merge. E20 rerun → Refuter → merge.
**Then, specs already written and waiting:**
- **E18** silent-window housekeeping (`0095`) — diarize skips silent windows; `words_ms` stops counting silence
- **E19** one Whisper-result classifier — *three agents reached this independently; it is the only durable answer to name-hunting sweeps*
- **E21** native recorder: audio levels **+** the resampler reset at discontinuities (one Swift round, one fleet update)

**Open design items, none started:**
- **Run identity for diarize** — a stale window cannot be fixed by re-running diarize; the writer never
  replaces `segments_json` on an `ok` row, so a stale window burns three attempts and stops. This is
  the root fix behind E16's guard.
- **Three signals disagree about what speech is** — diarizer vs Whisper VAD vs the emotion service's
  amplitude gate, by up to 125×. Upstream of everything.
- **Whisper's turn-bound timestamp mapping** — why a 29 s turn holds 2 s of speech.
- **Two services owe us a contract** — emotion should return its speech estimate on scored results;
  diarize should return the losing candidate. Both unversioned, both outside the repo. Do them together.
- **Threshold unification** (0.65 / 0.70 / 0.78) — needs E20's distribution first.
- **1,442-window backlog** — process or archive. V's call.
- **`stt_subject_job`: 229 `asr` rows queued**, drained by nothing anyone has identified.

## 5. STANDING CONSTRAINTS

- **`ROOM_AUTO_DRAIN_ENABLED` stays `0`** until E17 is merged and refuted.
- Commit on green; **push only on my word; merge only after a Refuter pass.**
- **Every spec names its branch AND its worktree.** Four worktrees share this repo.
- **One Docker suite at a time** across all panes until `c041ea8` reaches main and `-e16`.
- Never restart a Mini service; never touch `app.py` or `server.py` without an explicit order.
- Env var **names** only, never values. No transcript text, speaker names or clinical content in reports.
- Mutation check mandatory, count reported. A surviving mutant may be an **equivalent mutant** — say
  which, rather than chasing a test that cannot exist.
- Tailscale bridge: ~60 s ceiling, one `python3` heredoc, absolute paths.
- Neon string at `/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf` — read, use, never print.

## 6. TOKEN DISCIPLINE — the rule that matters

> **Clear a pane at a report boundary: once it has written its report to `docs/handoff/` and committed
> its work, its context is redundant. The bus is the memory; the pane's context is scratch.**

Never clear a pane holding uncommitted work it hasn't described — the files survive, the *reasoning*
does not, and the commit message is where the waivers get recorded.

Keep briefs pointing at **one** document. Every extra file a pane must read is paid for on every turn
of its session, not once.

---

## 7. RE-ENTRY PROMPTS

### `ETA-Refuter` — safe to clear now (idle, nothing running)

```
You are the Refuter on the Even Transcription Assistant. Read docs/handoff/ETA-MASTER-STATE-AND-SPINUP-15-SEP-2026.md, then docs/handoff/ETA-E11-FINAL-TWO-ITEMS-BEFORE-MERGE-14-SEP-2026.md and docs/handoff/ETA-E11-EF-REPORT-14-SEP-2026.md. Refute commit 3aa75c9 on vinay/s1-auto-drain in the MAIN worktree: items (e) and (f). Rerun the gate and all 25 mutations yourself. Give the two rewrites that survived last round their own results by name, and check whether turn_write_error is genuinely equivalent across every shape writeWindowCues returns. Then try the new sweep against the evasions it claims to catch and the ones it admits it cannot. Do not start Docker. Verdict MERGE or DO NOT MERGE on line 1, to docs/handoff/ETA-E11-EF-REFUTER-VERDICT-15-SEP-2026.md.
```

### `scribe3` — safe to clear now (committed, clean, blocked on Docker)

```
You are a Builder on the Even Transcription Assistant. Read docs/handoff/ETA-MASTER-STATE-AND-SPINUP-15-SEP-2026.md. Your worktree is Even-Transcription-Assistant-e20 on vinay/e20-losing-score at c041ea8, clean. Two jobs. First: carry the unique-container-name change from c041ea8 to the main worktree and to -e16, so all four worktrees are protected — that lifts the "one Docker suite at a time" constraint. Second: when docker version answers, rerun the untrustworthy E20 proofs listed in your last report, one suite at a time, without ETA_ALLOW_SKIP_E2E so a skipped suite fails loudly. Report to docs/handoff/ETA-E20-RERUN-REPORT-15-SEP-2026.md.
```

### `scribe` — do NOT clear yet

It holds **six uncommitted files** in `-e16`. Let it commit first — the files survive a clear, the
reasoning and the commit message do not.

```
Finish E16: run npx vitest run tests/unit/c2-e2e-runner.test.ts and then tests/unit/s1-emotion-zero-scored.test.ts, one at a time, once scribe3 confirms unique container names in -e16. If both pass, commit the six files by name in the -e16 worktree with the waiver qualifications in the message, and stop. Do not push, do not merge, do not apply migration 0097. Then you may be cleared.
```

---

## 8. WHAT I GOT WRONG, SO NOBODY REBUILDS ON IT

- "A retry can never succeed" (emotion `ON CONFLICT`) — disproved; `clearWindowSegments` prevents it.
- "Phase is stable per day" — wrong cut; the unit is the kiosk run, and the per-run sd is **0.0**.
- "The cap to fix is auto-drain's" — wrong queue; it is emotion's, and it is structural.
- "The flags were dormant by absence" — incomplete; the pipeline had no head, and my own R1 removed it.
- "Levels stopped around 10 Sep" — they never started on the native recorder: 0 of 4,405, ever.
- **"The `segments_json` re-run hazard is out of scope"** — reachable through `scribe_job_submit`,
  which offers `diarize_window` as operator-submitted by design. **Reversed; it blocked the merge.**
- **The Docker waiver** — granted against E11's diff after a real check, then carried into E16 without
  re-checking. `c2-e2e-runner` was red on E16's own path. **A waiver does not transfer between diffs.**
- The three-path sweep I substituted for the classifier caught **1 of 5** realistic evasions.
