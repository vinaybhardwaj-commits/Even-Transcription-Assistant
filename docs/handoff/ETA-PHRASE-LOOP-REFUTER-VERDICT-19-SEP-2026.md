# Refutation — vinay/phrase-loop-guard @ 862868d, 19 Sep 2026

Refuter: scribe (did not build this). Read and run only; nothing edited, committed, applied or run
against production. No transcript text, label or identifier appears here — counts, ids and timings only.

## Verdict
SOUND WITH FINDINGS. This REVISES an earlier verdict of mine in the same session, which called the
branch UNSOUND on the Unicode-mark defect (finding 1). The defect is real and confirmed in code; what
changed is that I have now MEASURED its effect on the corpus this backfill will touch, and it is zero
today. It is a latent trap, not an active one, so it does not block the backfill — it blocks the first
day Indic text reaches an stt_turn cue.

## Migration 0104 — against the live database, not the file

- ALREADY APPLIED. `schema_migrations` holds `(104, '0104_room_turn_repeat_run')`, applied_at
  2026-09-19 04:09:59.403+00. `room_turn_repeat_run` exists with exactly the migration's seven columns
  and types (window_id text NOT NULL, source_ref text NOT NULL, in_run boolean NOT NULL, run_id text
  NULL, run_length integer NOT NULL, run_rank integer NOT NULL, measured_at timestamptz NOT NULL).
  It holds 0 rows, so the backfill has not run.
- Idempotent if applied again: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS + INSERT ...
  ON CONFLICT DO NOTHING. It is also unreachable a second time: the runner skips by version number
  (app/api/run-migrations/route.ts:151,171).
- Unique across every ref: scanning all refs/heads and refs/remotes, exactly one tree carries a
  db/migrations/0104*.sql — phrase-loop-guard's. vinay/jev-j0-english carries 0105_jev_window_text.sql
  and inserts VALUES (105). No other migration inserts version 104.
- Additive: one new table and one partial index. No ALTER, no CHECK, no existing object touched.
- Columns the new code reads exist with the assumed types: bench_window.id/session_id text NOT NULL,
  start_ms/end_ms bigint NOT NULL; cue.type text NOT NULL, session_id text NULL, source_ref text NULL,
  payload jsonb NULL. The backfill's `(payload->'window'->>'start_ms')::bigint = bw.start_ms` compares
  bigint to bigint.

## What the guard does to legitimate clinical repetition

Nothing is deleted or rewritten anywhere. The diff contains no UPDATE, DELETE or TRUNCATE against cue,
room_turn_speaker or room_span_emotion; the only write in the branch is the upsert into the new table
(repeat-runs-store.ts:19-37). The tape still renders a flagged turn, with a label (RoomDayTapeClient.tsx
:77-81, admin.ts:389-399).

Adversarial cases I constructed and ran (not the builder's fixtures):
- a dose read back 3 times, back to back            -> NOT flagged (threshold is 4)
- a confirmation repeated 3 times inside other speech -> NOT flagged
- 4 identical confirmations back to back            -> flagged, run_length 4, text untouched
- case/whitespace variants of one phrase            -> one run (canonical normalisation)
- punctuation-differing repeat ("okay" vs "okay.")  -> NOT one run, per the 14 Sep correction
- an interrupted loop A A A B A A A                 -> nothing flagged (two sub-threshold runs)
- turns that normalise to empty                     -> never a run

On the live corpus the backfill would flag 3,247 of 10,831 measured turns (30%), every one of them a
mark, zero deletions.

## Findings

1. NON-BLOCKING FOR THIS BACKFILL, BLOCKING BEFORE INDIC TEXT LANDS. normalizeTurnText
   (lib/transcript/repeat-runs.ts:55) keeps only \p{L}\p{N}\s.?! , and Indic vowel signs are combining
   marks (\p{M}), so they are stripped: four DIFFERENT Hindi phrases normalise to one key and are
   returned in_run=true with run_length 4. Kannada and Tamil lose their vowel signs the same way;
   English is untouched, so the damage is language-asymmetric. It also silently implements the
   "near-identical" matching the 14 Sep report says is no longer defined.
   MEASURED IMPACT TODAY: 0. Of 10,831 turns the backfill would measure, 0 contain any Devanagari,
   Kannada, Tamil or Telugu character, and the flag set is byte-identical under a mark-preserving
   normalisation (3,247 flagged either way; 0 turns flagged only because marks were stripped).
2. NON-BLOCKING. The brief's premise "the migration is not yet applied" is false — see above. Nothing
   is harmed by that, but the plan should be "run the backfill", not "apply then backfill".
3. NON-BLOCKING, not this branch's doing. Version 103 (0103_room_alert_state) is NOT in
   schema_migrations and room_alert_state does not exist in the live database: production went
   102 -> 104. "Rolls forward from head 0103" is true of the repo and false of production.
4. NON-BLOCKING. A stale untracked db/migrations/0104_jev_window_text.sql still sits in the main
   clone's working tree. discoverMigrations() reads the filesystem and takes the version from the
   FILENAME (route.ts:28-42), so a migration run from this checkout would apply that file as version
   104 and the real 0104 would then be skipped for ever by number. Branch trees are clean; this is a
   working-tree hazard only.
5. NON-BLOCKING. Coverage: 12,994 stt_turn cues exist; the backfill's window join matches 10,831 of
   them across 75 windows. The other 2,163 (16.6%) get no row and stay "never measured" — correct
   under the table's own semantics, but the backfill is not a census of the corpus.
6. NON-BLOCKING. Determinism: 84 turns share (session_id, window, start_ms) with a sibling, and the
   backfill orders only by start_ms (repeat-runs-backfill.ts:51), so their relative order — and any
   run boundary that falls between them — is whatever Postgres returns that day.
7. NON-BLOCKING. A clean row cannot distinguish a 3-run from a singleton: both persist run_length 1
   (repeat-runs.ts:88). Lowering the threshold later means re-running the backfill, which is cheap
   and idempotent, so this is recoverable rather than lost.
8. NON-BLOCKING. The migration comment (0104:18) says a row is written "by the backfill or the live
   drain path". No live path exists: the only caller of the detector in the branch is
   scripts/backfill-repeat-runs.ts. Turns written after this ships stay unmeasured.
9. NIT. admin.ts:389 does repeatRunRows.find() per turn where every sibling lookup uses a prebuilt
   Map — O(turns x rows) on a day that can hold 2,030 turns.

## Backfill against the corpus (question 4)

- Transaction: none, and none is attempted. The branch contains no transaction(), BEGIN, COMMIT or
  sql.unsafe() — verified by grep over lib/transcript and scripts. Each window is ONE statement
  (INSERT ... SELECT FROM unnest(...) ON CONFLICT DO UPDATE), which is exactly what the Neon HTTP
  driver can serve.
- Idempotent: yes. Re-running replaces each row by (window_id, source_ref) and recomputes the same
  flags from the same turns.
- If it dies halfway: windows already written keep their rows; the rest have none, which reads as
  "never measured" rather than as clean. Nothing is left half-written within a window, because a
  window is one statement.
- Resumable: only by re-running the whole pass. listCandidateWindows() has no skip list and no
  ordering by progress, so a resumed run redoes all 75 windows. At this size that is seconds of work,
  not a problem; at ten times the size it would be.
- Largest single statement: 524 turns in one window, five arrays of 524 elements.

## The rebase question

Independent, and declining it hid nothing. The branch's nine files include neither lib/stt/room-drain.ts
nor lib/jobs/kinds/room-window.ts, the two files 843e7b2 changed. `git merge-tree --write-tree 843e7b2
vinay/phrase-loop-guard` exits 0 with no conflict. The only consequence of not rebasing is that the
branch's suite does not include the four test files the merge changed.

## Tests — my own runs, at 862868d

    npx vitest run tests/unit/repeat-runs.test.ts tests/unit/room-day-tape.test.ts
      -> 2 files, 33 passed, 0 failed
    npm test
      -> 131 files, 3013 passed, 0 failed, exit 0

Docker was up and ETA_ALLOW_SKIP_E2E was unset, so the Postgres-backed proof ran rather than being
skipped. In an earlier pass this session I mutation-tested that proof by making the backfill rewrite
payload->text: it failed as it should ('[deduped]' vs the seeded text), and I reverted the mutation.

What each test is holding up:
- "the real window shape: 358 turns ... only runs >= 4 are flagged" — breaks if the threshold moves, if
  runs merge across intervening speech, or if maximal-run detection loses a boundary.
- "a phrase legitimately repeated exactly 3 times must NOT be flagged" — breaks the moment the
  threshold drops to 3, which is the false-positive V cares about.
- "runs separated by other speech are two separate runs, never merged" — breaks if run_id stops being
  the first turn's source_ref, or if the scan joins non-adjacent runs.
- "normalizeTurnText ... keeps . ? ! per the canonical doc's §1" — breaks if normalisation starts
  stripping terminal punctuation, which would make "you." and "you" one loop.
- "flags pre-existing rows without touching their text ..." (real Postgres) — breaks if any write
  reaches cue, or if a measured-clean row stops being distinguishable from a never-measured one.
- "assembleTape — surfaces repeat_run on the tape" — breaks if a flagged turn is filtered out of the
  tape instead of labelled.

## Canonical definition — a note on the brief

The brief says the canonical repeat-ratio definitions live in a project memory note
`eta-repeat-ratio-definition-14-sep` (v2). That note does not exist: the memory directory for this
project holds only MEMORY.md and rr-0-1-23-withdrawn.md, and nothing under ~/.claude matches
*repeat-ratio*. I therefore checked the implementation against the repo's own sources —
docs/handoff/ETA-M4-WHISPER-VS-ROUTE-QUALITY-CC-KICKOFF-14-SEP-2026.md §1 (measures A, B, C) and the
correction in docs/handoff/ETA-M4-WHISPER-VS-ROUTE-QUALITY-14-SEP-2026.md, choice 3, which is the
"keeps . ? ! so you. != you" rule. The implementation honours that correction. It departs from §1 on
unit (whole turn, not a 3-12 word n-gram) and threshold (4, not 3), and says so at
repeat-runs.ts:10-28 rather than quietly.

## Mini discipline, reported against myself

Twice in this session I printed the watchdog line inside the same command as the work, so the work ran
while the verdict already read STOP_ (once STOP_sustained_pressure at the full suite, once
STOP_heavy_swap_now at the corpus measurement). Both completed and the box recovered, but the gate has
to be a separate step that blocks. The runs reported above were taken after an uncapped wait that
returned GO (WARN_spike, diarize 130 ms; then ok, 23 ms).
