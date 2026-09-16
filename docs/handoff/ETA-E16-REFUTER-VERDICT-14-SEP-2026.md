**NOT MERGE-READY.** The `segments_json` re-run hazard is reachable through a door built for it. MCP `scribe_job_submit` offers `diarize_window` as "operator-submitted by design", and the diarize kind never checks for an existing `ok` row. On a re-run the new speaker numbers meet the old intervals, and `speech_ms` goes silently wrong or silently to zero. Your stated condition was "if you can show it is reachable, this blocks the merge". Separately, with Docker up the waived `c2-e2e-runner` is **red, 9 of 48**, on E16's own emotion path.

# ETA-E16 — REFUTER VERDICT · 14 Sep 2026 · pane `ETA-Refuter`
Commit `f4f51c6ab76814717f52e5459529cdb54c7ae0d6`, worktree `-e16`, clean before and after. Throwaway clones of `ccd12b0` and `f4f51c6` live in session scratch. Nothing fixed, pushed, merged or applied. Raw: `scratch/E16-REFUTER-evidence-14-SEP-2026.log`, `…-mutate-14-SEP-2026.py.txt`, `…-reverse-and-straddle-probe.test.ts.txt`.

## 1. Gate, rerun by me
- **Docker down, as the Builder ran it:** typecheck 0; `npm test` `4 failed | 2547 passed | 98 skipped`; with the skip set, `2551 passed`; check:silent the accepted 9; build 0. All identical to the Builder.
- **`swift build`:** complete. **`swift test`:** `600 tests … failed … with 1 issue`: `archiveKeyUnavailable` in `RetainedArchiveRecoveryTests.swift:60`. That is a keychain-backed key, **UNPROVEN, not failed** (repo rule). E16 touches no Swift.
- **I started Docker (the brief invites it), ran everything below, then quit it.**

| Suite, Docker up, no skip | Result |
|---|---|
| `s1-emotion-zero-scored` | **25/25** |
| `s1-auto-drain` | 48/48 |
| `s1-fix2-migrations` | 8/8 |
| **`c2-e2e-runner`** | **9 of 48 FAILED** |

- **Cause:** it applies migrations only through 0090, so the runner-driven emotion job throws `column "segments_unscorable" of relation "room_emotion_window" does not exist`, 27 times. **With 0097 added to its harness: still 7 failed**, 3 × `health_min_speech_unreadable` (its `/health` fake has no `min_speech_s`).
- **With `min_speech_s` added as well: still 7 failed.** The suite seeds `segments_json '[]'` beside speaker-attributed turns. Every span measures 0 ms, nothing is sent, and the window ends `done`: **including its "SERVICE DOWN → failed" case.**
- **So E16 has never run end to end through the job runner on Postgres**, and "the 4 guards are the only reds" is not true with Docker up.

## 2. Attacks
**1 — the two SQL mutations: UPHELD, now behaviourally.** With Docker up, E15 (refused spans not subtracted) and E16 (never-sent rows subtracted) each fail the real-Postgres suite (1 failure each), not only the text check. What the waiver actually concealed is §1's `c2-e2e-runner`.

**2 — the reverse refusal: UPHELD for every real shape; two latent shapes swallow.** Real client, only `fetch` faked, real Postgres, each case separately:

| Case | Result |
|---|---|
| per-span `inference_failed` | window `failed/emotion_zero_scored`, failed 2; the retry is attempt 2 |
| timeout (`TimeoutError`) | `failed/emotion_unavailable`; the retry is attempt 2 |
| partial labels | `malformed_scores`, `failed` |
| result-count mismatch | `failed` |
| HTTP 503 | `failed` |
| **LATENT: `ok:true, labels:{}` with no `unscorable` flag** | **window `ok`, 0 scored, 0 failed, no attempt; rows `unscorable/unscorable_unnamed`** |
| **LATENT: `unscorable:true` beside seven valid labels** | **the scores are discarded as unscorable** |

- Today's `app.py` cannot emit either latent shape: labels come from `model.config.id2label`, and every gate refusal carries the flag. But `client.ts`'s `|| isEmptyObject(r.labels)` arm is exactly the model-fault shape you warned about, and only the reason string tells it apart.

**3 — `/health` without `min_speech_s`: UPHELD for restart; a regression on rollback.**
- **Restart is safe.** `health()` returns `min_speech_s` and `max_duration_s` as module constants whether or not the model is loaded (`~/eta-emotion/app.py:724-758`). A restart gives an unreachable service (the old behaviour) or a full body. Live: `ok true, loaded true, min_speech_s 1.5, wavlm_load_mode lazy`.
- **Rollback is not.** **All five `app.py.bak-*` lack `min_speech_s`.** Restoring any of them to the unversioned service makes every window fail `health_min_speech_unreadable` and spend an attempt, so windows exhaust in three ticks where pre-E16 code would have scored.

**4 — `NOT NULL DEFAULT 'pre_speech_fraction'`: UPHELD, with one hole.**
- **Old code on the new schema works.** Pre-E16 code (`ccd12b0`) ran its whole real-Postgres suite on a database with 0097 applied: **21/21**. All 28 rows it wrote read `pre_speech_fraction` with `speech_ms` NULL, and `segments_unscorable` NULL on every window. The only in-repo reader of these tables is `enqueue.ts`, with explicit columns.
- **The hole: a job straddling the deploy.** One whose `prepare` ran on old code and whose `score` runs on new code writes `scored` rows with **`speech_basis 'diarize_segments'` and `speech_ms` NULL** (probe 4b). That is a post-fix label with no speech measure. It is narrow (in-flight jobs only) and NULL, not wrong.

**5 — the measures are not assumed to agree: UPHELD, with one assumption.**
- **The run-B case is handled.** A service `unscorable` on a planner-scorable span is its own outcome: row `unscorable` with both numbers, subtracted from `planned`, window `ok` (pg case, and my probe).
- **The assumption.** The pre-filter compares the **diarizer's** milliseconds against a threshold defined on the **service's** amplitude-frame quantity. So the direction "diarizer under 1.5 s, but the service would score" is dropped by construction. It is recorded `unscorable` with `speech_ms`, so recoverable by query. None of A9's 9 unsent spans had ever scored; this is unmeasured elsewhere.
- **A silent shape.** An `ok` row whose `segments_json` has no interval for a speaker that holds turns is read as "never spoke". The E13 guard catches only a non-array (§1: the `'[]'` seed ends `done`).

**6 — the `segments_json` re-run hazard: BROKEN. The out-of-scope ruling does not survive.**
- **The hazard is in the code:** `recordDiarizeWindow` keeps `segments_json` on a non-failed row but always moves `last_run_id` (`lib/stt/diarize-window.ts:285,297`).
- **Reachable, from source:**
  - (a) `scribe_job_submit`'s kind enum is `JOB_KIND_NAMES`, and its own comment calls `diarize_window` "operator-submitted by design" (`lib/mcp/tools/jobs.ts:64-74`).
  - (b) The kind checks only that the window exists, has a room_day and a clip, never the diarize row's state (`lib/jobs/kinds/diarize-window.ts:34-45`).
  - (c) `enqueueEmotionWindows` re-scores a window whose run moved (`enqueue.ts:62`).
  - (d) Unattended too: a runner lease replay of the single `diarize` step re-runs it with a new run id (the runner contract, `runner.ts:71,117`).
- **Renumbering is plausible.** `speaker_idx` is each cluster's **rank by total talk seconds**, from pyannote 3.1 on MPS, in a service with no version control (`~/eta-diarize/server.py:182-185`). A near-tie, or a new noise cluster, reorders it.
- **How wrong, on the real A9 fixture:**
  - If its one speaker comes back as index 1, **all four sent spans measure 0 ms, nothing is sent, and the window ends `no_segments`**: four scores lost, no attempt, no failure, final.
  - In a two-speaker window, a rank swap gives each span **the other person's speech as a confident number**.
- **A cheap detector exists:** within one run a turn is bound to a speaker *by overlap with that speaker's intervals*, so "a turn attributed to X with no X-interval over it" cannot happen. It is exactly the stale-segments signature, and it is checkable in `prepare`.

**7 — the mutation count: 16 of 16 caught.** Rebuilt from report §4 V7, each run against the E16 unit file · `c3-emotion` · the real-Postgres suite, restored against `git show HEAD`, worktree clean:

| Mutant | Failed (e16 / c3 / pg) |
|---|---|
| E1 | 6 / 0 / 1 |
| E2 | 1 / 0 / 0 |
| E3 | 1 / 0 / 0 |
| E4 | 3 / 0 / 0 |
| E5 | 1 / 0 / 0 |
| E6 | 1 / 1 / 0 |
| E7 | 2 / 0 / 2 |
| E8 | 1 / 0 / 0 |
| E9 | 1 / 0 / 0 |
| E10 | 1 / 0 / 1 |
| E11 | 0 / 0 / 1 |
| E12 | 1 / 0 / 0 |
| E13 | 1 / 0 / 0 |
| E14 | 1 / 0 / 0 |
| **E15** | **1 / 0 / 1** |
| **E16** | **1 / 0 / 1** |

My E11 (`SPEECH_BASIS` set to the default value) differs in form from the Builder's; the rest match their descriptions.

## 3. Before merge — for `scribe`
1. **Guard the hazard by name.** In `prepare`, if any planned run's speaker has no diarized interval overlapping its own turns, fail `diarize_segments_stale` (with a window row, attempt bound). This also catches the `'[]'` silent shape. The run-id-carried design stays the end state.
2. **Make `c2-e2e-runner` real for E16:** 0097, `min_speech_s`, a `segments_json` that covers its turns, and the C3 cases whose premise E16 deliberately changed. Rerun with Docker up.
3. **Smaller:** derive `speech_basis` from `speech_ms` being present (closes the deploy straddle); treat `labels:{}` **without** the flag as a named model fault, not unscorable; write the rollback hazard into 0097's runbook.

## 4. What this brief should have told me
- **Other panes run suites.** A full `npm test` in a new worktree **`-e20`** ran while my Docker was up. Both use the fixed container names `eta-c2-e2e` and `eta-s1-emotion`. Two of my `c2` runs that overlapped it reported `48 skipped` and are discarded. **`-e20`'s Docker-suite results from ~22:25 IST are not trustworthy: rerun them.** I waited for its run to end before my last one, then quit Docker.
- **Where E16 is tested end to end.** Its emotion path also lives in `c2-e2e-runner`, not only in the two files named.

Subagents: none.
