# ETA-E20 — record the score that lost · REPORT · 14 Sep 2026 · Builder (`scribe3`)

**SHA `24e48aa`** on `vinay/e20-losing-score`, parent `e925901`, in worktree `…/Even-Transcription-Assistant-e20`. Committed, **not pushed**. **Migration 0096** (live `schema_migrations` ends at 93). No threshold changed, `role` stays NULL, no Mini service restarted.

## The finding that forced the ruling — it stands on its own
- **The service discards the losing candidate.** It scores every speaker cluster against every centroid sent and keeps the best (`server.py:186-198`). It **responds with `clinician_id` and `confidence` only when `best_score >= batch_threshold`** (`:209-216`).
- **What the app does receive:** each speaker's raw ECAPA embedding (`embedding_base64`, `:205`).
- **Greedy exclusion:** the best candidate excludes clinicians already assigned to a louder speaker in the same window (`used_clinician_ids`, `:187,193-194,217`).
- **So** option 2 (the service returns the losing candidate itself) is the end state. This round is option 1, per `ETA-E20-RULING-SHADOW-WITH-A-CONTROL`.
- **Side fact:** diarize PID 84377 runs the `server.py` modified 08:51 (the M1 edit), which is the file read here (E1 assumption #1).

## Diff (`git show --numstat 24e48aa`)
| file | + / − |
|---|---|
| `db/migrations/0096_room_turn_speaker_losing_score.sql` (new) | 92 / 0 |
| `lib/stt/losing-score.ts` (new) — `shadowMatch`, the control | 126 / 0 |
| `lib/stt/diarize-window.ts` — write only on an exclusive no_match turn, when the control is clean | 41 / 4 |
| `tests/unit/e20-losing-score.test.ts` (new) | 208 / 0 |
| `tests/unit/c2-e2e-runner.test.ts` — 0096 in the harness, plus its postgres proof | 37 / 0 |

Nothing else moved: thresholds, `speaker-clusters.ts`, centroids, loaders and the readers of `match_confidence` are untouched.

## The columns, and why not `match_confidence`
- **`losing_clinician_id`, `losing_score`, `score_basis`** — new, nullable, no DEFAULT, no backfill.
- **Why not reuse `match_confidence` / `clinician_id`:** they mean *the name assigned and its confidence*, and NULL there means unnamed. 0085's `room_turn_speaker_identity_ck` already forbids them on any row without `role='clinician'`, so reusing them would be refused by the schema as well as ambiguous.
- **`score_basis`:** `'app_recomputed'` is written by this round. `'service_reported'` is **reserved in the CHECK for the option-2 round, unwritten**, commented as 0097 did. Rows with no losing candidate keep basis NULL: all three columns travel together.
- **CHECKs:** losing values only on `role IS NULL AND no_role_reason = 'no_match'`; all three set or none; score in [0,1]; basis vocabulary closed.

## The control — the ruling's number
**Live, against the real diarize service**, with synthetic `say` voices (no patient audio). Centroids came from the service's own `/enroll` on separate sentences. There were **8 `/diarize` calls**: 2- and 3-voice clips, centroid order swapped, one voice unenrolled, and threshold 0.97 so nobody clears. Every response went through the **real** `shadowMatch`.
- **Result:** **matched speakers recomputed: 13. Disagreements: 0.** Unmatched speakers at or above threshold: 0. Unrecomputable: 0.
- **Rounding:** the recomputed score rounds to the service's 3-dp confidence in **13 / 13**, under both half-up and Python's half-to-even.
- **Differences:** min 0.0000196, median 0.000303, mean 0.000232, max 0.000444. That is the service's own 3-dp rounding residue, inside the 0.0005 tolerance.
- **Losing candidates recorded:** 6, including S7/S8 at threshold 0.97: 0.9071 / 0.9093 / 0.9110 / 0.9034, consistent with the same voices' 0.907 / 0.909 / 0.911 / 0.903 when matched.
- **Greedy exclusion, live:** in S5 the unenrolled voice had **no** candidate, because both clinicians were taken by louder speakers.
- **Evidence:** `scratch/E20-SHADOW-CONTROL-*`. Embeddings are not copied into the repo.
- **At runtime:** each window computes the same control. A window with any disagreement writes **no** losing scores and warns (`outcome.shadow.trusted = false`).

## Verify
- **V1 PASS.** The exclusive unmatched turn gets `losing_clinician_id` and `losing_score`, basis `'app_recomputed'`, with `role` NULL, `no_role_reason 'no_match'` and `match_confidence` NULL.
- **V2 PASS.** The named turn's row is today's row, with NULL in the three new columns. C2's existing "an EXCLUSIVE turn still gets its name" fixture passes unchanged, as do all 48 `c2-diarize-roles` + `room-diarize-job` tests.
- **V3 PASS.** The straddle turn gets nothing, even though its bound speaker has a losing candidate; the same speaker's exclusive turn does (control).
- **Greedy case, tested explicitly:** two speakers, one centroid both would match. The louder is matched and the quieter has **no** losing candidate. With a second centroid, the quieter's candidate is the other clinician, never the taken one.
- **V4 PASS, against real postgres** (Docker was up at gate time, see flags). `c2-e2e-runner`:
  - 0096 applied **twice**, no error; recorded once.
  - A pre-existing named row keeps every value, with NULL in the new columns.
  - Refused: a losing candidate beside a name, on a straddle, split across columns, blank id, out of range, unknown basis, or a losing value in `match_confidence`.
  - `'service_reported'` is accepted as reserved.
  - No reader of `match_confidence` changed.
- **V5 PASS — 11 of 11 mutations killed.** Each applied by exact string; both files restored by sha256. Evidence: `scratch/E20-MUTATIONS-*`.
  - **M1** losing score into `match_confidence` (named path's column): 1 test;
  - **M2** losing columns on a **named** row: 2;
  - **M3** straddle guard removed: 1;
  - **M4** greedy exclusion removed: 4;
  - **M5** control ignored: 1;
  - **M6** tolerance ×10: 1;
  - **M7** clinician not compared: 1;
  - **M8** unmatched above threshold uncounted: 1;
  - **M9** array order instead of service order: 1;
  - **M10** tie to last centroid: 1;
  - **M11** wrong basis: 1.
  - **Two survived on the first pass, both fixed:** M3 was equivalent (the straddle is guarded twice), so it now removes both guards. M11's test had compared against the module's own constant; it now asserts the literal.

## Gate (worktree, `node_modules` symlinked to the main tree as E16's worktree does)
- `typecheck` 0.
- **`npm test` plain:** 1 failed, 2622 passed, 51 skipped. **Both causes environmental:**
  - `c2-e2e-runner` `beforeAll` hit the fixed container name `eta-c2-e2e` already holding a schema — another pane running the suite concurrently;
  - `diarize-dispatch` B4 is a timing assertion (`wall_ms` 79, expected ≥ 80), in a file this round did not touch.
  - **Plain re-run of those files alone: 82 / 82 passed**, c2-e2e 51 / 51 including the three 0096 tests.
- **`ETA_ALLOW_SKIP_E2E=1`: 111 files, 2674 / 2674 passed, 0 skipped.**
- `build` 0. `check:silent` — the 9 pre-existing findings, none in these files. `swift build` complete. `swift test` — 600 tests in 48 suites passed.

## Flags
1. **Docker was UP during this gate** (server 29.7.2), against tonight's "Docker is down". The REQUIRED PROOF suites therefore **ran and passed** here. I did not start it.
2. **Vacuous control in the room today:** with 0 named room turns so far, a room window's control has no matched speaker to check and is clean by default. The live 13 / 0 above is what this round's trust rests on until real matches occur.
3. **The losing score's resolution** is the service's 3-dp contract; the tolerance cannot be tighter than 0.0005.
4. **Live control load:** 8 `/diarize` and 3 `/enroll` calls on the Mini, all synthetic, while room diarize is live; nothing restarted.
5. **No subagents.** Bus documents are not committed.
