# ETA Build 3 corrective report — 26 August 2026

**Status: ACCEPTED by V on 26 August 2026. Build 3 is closed.**

## Candidate

- Pre-checkpoint base: `3d4139e1d6a630814d88a932676a62b37172584a`.
- The accepted source checkpoint is the commit containing this report. The production deployment
  preceded that checkpoint, so its health endpoint reports the base SHA above; its immutable
  deployment provenance is `dpl_497Ns1qzVnTvZ7N7YgTt61UgMUX2`.
- Production URL: `https://even-transcription-assistant-n9xigbpoj.vercel.app`.
- Production aliases include `https://www.evenscribe.app`.
- Migration `0069_build3_corrective` applied at `2026-08-26 01:33:47.117796+00`.
- Migration `0070_clear_unreported_spare_levels` applied at
  `2026-08-26 01:39:10.287565+00`.

## Corrections

1. Added one browser-safe strict number/level parser in `lib/bench-levels.ts`.
2. Preserved genuine `0/0`, while rejecting absent, null, empty, boolean, partial, non-finite,
   out-of-range, and impossible `avg > peak` pairs.
3. Applied that parser to command and chunk ingestion, listener output, MCP output, and both
   D36/D37 piece readers.
4. Made chunk level pairs atomic, so complementary partial retries cannot manufacture a reading.
5. Suppressed and stopped persisting spare levels unless a second device was explicitly reported.
6. Released only Cardiology repair jobs with no evidence of an attempt: queued, zero attempts, no
   start, finish, error, or transcription run. Existing attempted history is preserved.
7. Covered both the natural-key winner ID and migration `0068`'s synthesized candidate ID.
8. Cleared legacy listener spare values only where `spare_device IS DISTINCT FROM TRUE`. No tape,
   chunk, window, cue, run, or R2 object was changed by that cleanup.
9. Made the manual recovery control's count scan all clinic days with the same closed, aligned,
   day-bound, no-job predicate as the paid action. Today's transcript and stranded-audio lanes
   remain day-scoped.

## Automated gates

- Focused corrective suite: 162 tests passed.
- Full unit suite: 49 files, 1,115 tests passed.
- `npm run typecheck`: passed when run after the build. One parallel invocation raced Next's rewrite
  of `.next/types`; the sequential rerun passed.
- `npm run build`: passed locally and in the final Vercel deployment.
- `git diff --check`: passed.
- `npm run check:silent`: still reports nine pre-existing handlers, all outside this corrective
  diff. No new silent handler was added.

## Live evidence

### Strict levels and P8

Before correction, the operator door reported stale Cardiology levels and Home Office's unreported
spare as `{"peak":0,"avg":0}`. After the final deployment:

- Stale Cardiology: `mic_level:null`, `spare_level:null`, `levels_at:null`.
- Home Office: main level remains measured; `spare_level:null`, `spare_exists:false`.
- No spare lane, spare vital, or spare alarm is justified for Home Office.
- V's authenticated Home Office screenshot shows exactly one rendered `Main mic` bar and no spare
  lane, vital or alarm. The listener response and operator door agree exactly at
  `levels_at='2026-08-26T01:34:57.966Z'`: main `peak=0.0075`, `avg=0.0075`, spare `null`, and
  `spare_device`/`spare_exists=false`.
- The browser still wrote one tiny backup piece during the D39 test. This is expected under the
  ratified P8 server-only erratum: stopping browser backup capture belongs to the native app build.

### D39 desk-only start and stop

- Start command: `cmd_p2rkvqmu`, acknowledged at `2026-08-26T01:34:26.104Z`.
- Session: `bs_qk9pnsrz`.
- Stop command: `cmd_32wrex5j`, acknowledged at `2026-08-26T01:34:56.856Z`.
- Session status: ended; one verified primary piece; no gaps; no mic events.
- Room-day: `rd_2tawhkrv`, IST date `2026-08-26`.
- Consult marks: zero.
- The successful `start_day` acknowledgement opened the day; the first verified piece then found
  the same idempotent day record.

## Cardiology repair identities

Migration `0068` did not retain the deleted backup row IDs in a separate audit column, and the
post-delete production readers cannot recover them. The IDs below are reconstructed from the
writer's deterministic key (`session + start_ms + source`) and the sixteen verified repair spans.
This limitation is recorded rather than presenting a post-delete reconstruction as a query result.

| IST slot | Superseded backup ID | Re-bound primary ID |
|---|---|---|
| 12:15-12:30 | `bw_z3gpbh6e_1787553900000_backup` | `bw_z3gpbh6e_1787553900000_primary` |
| 12:30-12:45 | `bw_z3gpbh6e_1787554800000_backup` | `bw_z3gpbh6e_1787554800000_primary` |
| 12:45-13:00 | `bw_z3gpbh6e_1787555700000_backup` | `bw_z3gpbh6e_1787555700000_primary` |
| 13:00-13:15 | `bw_z3gpbh6e_1787556600000_backup` | `bw_z3gpbh6e_1787556600000_primary` |
| 13:15-13:30 | `bw_z3gpbh6e_1787557500000_backup` | `bw_z3gpbh6e_1787557500000_primary` |
| 13:30-13:45 | `bw_z3gpbh6e_1787558400000_backup` | `bw_z3gpbh6e_1787558400000_primary` |
| 13:45-14:00 | `bw_z3gpbh6e_1787559300000_backup` | `bw_z3gpbh6e_1787559300000_primary` |
| 14:00-14:15 | `bw_z3gpbh6e_1787560200000_backup` | `bw_z3gpbh6e_1787560200000_primary` |
| 14:15-14:30 | `bw_z3gpbh6e_1787561100000_backup` | `bw_z3gpbh6e_1787561100000_primary` |
| 14:30-14:45 | `bw_z3gpbh6e_1787562000000_backup` | `bw_z3gpbh6e_1787562000000_primary` |
| 14:45-15:00 | `bw_z3gpbh6e_1787562900000_backup` | `bw_z3gpbh6e_1787562900000_primary` |
| 15:00-15:15 | `bw_z3gpbh6e_1787563800000_backup` | `bw_z3gpbh6e_1787563800000_primary` |
| 15:15-15:30 | `bw_z3gpbh6e_1787564700000_backup` | `bw_z3gpbh6e_1787564700000_primary` |
| 15:30-15:45 | `bw_z3gpbh6e_1787565600000_backup` | `bw_z3gpbh6e_1787565600000_primary` |
| 15:45-16:00 | `bw_z3gpbh6e_1787566500000_backup` | `bw_z3gpbh6e_1787566500000_primary` |
| 16:00-16:15 | `bw_z3gpbh6e_1787567400000_backup` | `bw_z3gpbh6e_1787567400000_primary` |

Every primary repair row records `rebound_from='backup'` and the D34 reason written by migration
`0068`. Migration `0069` changes no repair window; it only removes a provably untouched queue row
so the existing manual control can select the window.

## Cardiology paid-run truth

The production read after the all-history count deployment showed twelve, not sixteen. That is the
correct no-job count: the first four repaired primary windows already have successful batch runs and
are `transcribed`. Migration `0069` correctly preserved their job and run evidence rather than
deleting it to manufacture a larger waiting number.

| IST slot | Engine | Source | Audio seconds | Characters | Latency | Result |
|---|---|---|---:|---:|---:|---|
| 12:15-12:30 | Sarvam | primary | 900.00 | 5,724 | 21.671 s | success |
| 12:30-12:45 | Sarvam | primary | 900.00 | 5,521 | 18.428 s | success |
| 12:45-13:00 | Sarvam | primary | 899.99 | 7,310 | 17.384 s | success |
| 13:00-13:15 | Sarvam | primary | 900.00 | 7,767 | 21.984 s | success |

The separate 12:00-12:15 primary run is the hand-recovery control, not one of the sixteen repaired
slots. Its current Sarvam result is 5,446 characters from 900 seconds in 22.949 seconds, versus the
prior 5,468-character result in approximately 23 seconds: a difference of only 22 characters, with
matching latency. The control comparison therefore passes strongly. Sarvam's adapter reports no
per-call dollar value (`costUsd:null`); that is an unreported cost, not zero.

The twelve windows shown by the card are the untouched 13:15-16:15 repair slots. Do not run them
without V's explicit continuation.

## Field acceptance

V supplied authenticated screenshots and accepted Build 3 on 26 August 2026. They show:

1. Cardiology's recovery control with twelve untouched repaired windows remaining.
2. Home Office with one main microphone bar and no spare surface.
3. The listener API values cited above, matching the operator door at the same `levels_at`.
4. The four repaired Sarvam outputs at 12:15-13:15 and the 12:00-12:15 control output in STT Lab.

The raw mixed-language outputs are coherent enough for the recovery gate, with ordinary raw-ASR
errors remaining a separate STT-quality concern. The twelve remaining Cardiology windows and Home
Office's historical waiting audio were not run. No new paid transcription was triggered while
collecting or checking this evidence.

Build 3 is corrected, deployed and field-verified. Its gate on App Build B is open.
