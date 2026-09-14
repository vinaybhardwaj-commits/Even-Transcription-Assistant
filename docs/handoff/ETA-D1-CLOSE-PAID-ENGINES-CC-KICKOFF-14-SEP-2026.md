# ETA — D1: CLOSE THE PAID ENGINES — CC KICKOFF
**14 September 2026 · Session: `scribe` (run AFTER P4 reports) · branch `vinay/s1-auto-drain` · DB env present**

## 0. V's ruling, 14 September, verbatim in substance

> *"Disable all of these and stop the fanout. Sarvam will be the only Paid API we use and our free
> mini-based whisper stack + diarize stack + emotion stack is our workhorse. The rest are closed off and
> silent from now on."*

This executes **S8**, ratified 11 September and outstanding since. It is the **disable** half only.
**No code is deleted this round** — that is a separate, larger round (D2), and mixing them would put a
reversible one-row change and a multi-file deletion behind the same verdict.

## 1. The target state

| Engine id | Action | Why |
|---|---|---|
| `deepgram` | **disable + fanout off** | paid, currently both on |
| `elevenlabs` | **disable + fanout off** | paid, currently both on |
| `elevenlabs_scribe` | **disable + fanout off** | paid, currently both on |
| `ekascribe` | assert off | already off; assert so the record is complete |
| `gemini` | leave | already disabled by 0091 |
| `sarvam` | **LEAVE ON** | the one paid engine V keeps |
| `whisper`, `indicconformer`, `indicconformer_scribe`, `route`, `even_pipeline` | **LEAVE ON** | free, Mini-based; this is the workhorse |

**Name every engine by id explicitly. Do not write a blanket "disable where is_paid" predicate** — that
would catch `sarvam` today and anything paid added later, silently. The list is the decision; encode the
list.

## 2. C26 — the pre-check, BEFORE the migration

Report, from the code, **every path that reads these three engines**, and what happens to each when the
engine row is disabled:
- the browser live-consult path (`deepgram` was its live English engine),
- the four-parallel-engine browser path,
- `lib/stt/fanout.ts` and the STT Lab,
- `stt_routing` rows naming them in any stage,
- anything in `lib/mcp/**` that enumerates engines.

For each: does it fail closed (skips the engine), fail loudly (errors), or fail open (calls it anyway)?
**A path that calls a disabled engine anyway is the finding that matters** — it would mean the row is not
the control and the spend does not stop.

**If you find such a path, report it and STOP before the migration.** Otherwise continue to §3 and note in
your report what each path does.

## 3. C27 — migration 0093

Write `db/migrations/0093_disable_paid_engines_except_sarvam.sql`. Idempotent, same shape as 0091.
It sets `enabled = false` **and** `fanout_enabled = false` for the four ids in §1, by id, and touches
nothing else. Record the migration version as the others do.

Apply it from this session:
```
psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET lock_timeout = '3s';" -f db/migrations/0093_disable_paid_engines_except_sarvam.sql
```
**Verify by reading back the whole engine table** — id, enabled, fanout_enabled, is_paid — and quote it.
The row that proves the round: `sarvam` still `enabled = true`. If `sarvam` is off, you have made a
mistake; stop and say so.

## 4. C28 — confirm it is actually silent

After the migration, call the health probe over all engines and report each engine's `ok` and its reason.
Expect the three newly-disabled engines to report disabled rather than healthy, the way `gemini` reports
`gemini_stt_disabled` after 0091. **If a disabled engine still probes healthy, that is a finding** — it
means the probe does not read the enabled flag, and the probe would keep calling a paid API.

## 5. What NOT to do

**Do not delete any adapter, route, test or registry entry.** Do not touch `lib/stt/registry.ts`.
Do not modify `stt_routing` rows. Do not change `sarvam`, `whisper`, `route`, `indicconformer`,
`indicconformer_scribe` or `even_pipeline`. Do not enable anything. Do not promote or deploy — **no
application code changes in this round**, so production needs no new deployment; the migration acts
directly on the database.

Commit and push the migration file and this kickoff for the record. `APP_DATABASE_URL` is for §3 only;
never echo it. Env var **NAMES only, never values**. Never reproduce the banned id shape.

`scribe3` holds the Mini for M7 — no Mini work, no test suite.

## 6. Report

`docs/handoff/ETA-D1-CLOSE-PAID-ENGINES-REPORT-14-SEP-2026.md`, **cap 60 lines**: the §2 path table, the
migration SQL verbatim, the applied output, the full engine read-back, the §4 probe results, and flags.

## 7. What comes after, so you do not start it

**D2 — the deletion round.** Adapters, the browser four-parallel-engine path, the `stt_routing` live and
note stages, and the registry entries. That is the V0 deletion build from the PRD and it needs its own
gate, its own Refuter pass and a clean test run. **Not today, not in this round.**

## 8. Known facts

- Current state, read at 12:55 IST: `deepgram` enabled+fanout, latency 944 ms · `elevenlabs`
  enabled+fanout, 360 ms · `elevenlabs_scribe` enabled+fanout, 372 ms · `ekascribe` disabled ·
  `gemini` disabled, reports `gemini_stt_disabled` · `sarvam` enabled+fanout, 33 ms · `whisper` 70 ms ·
  `route` enabled, fanout **off**, 426 ms · `indicconformer` 141 ms.
- Room windows route through `resolveRouting("room", bucket)` to Sarvam and do **not** go through fanout,
  so this change does not alter the room path. Say so in your report if you confirm it; correct me if not.
- Migrations 0091 and 0092 are applied. 0093 is the next number.
