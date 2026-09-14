# ETA — S1 FIX2 — CC KICKOFF (supersedes FIX1, which was correctly halted)
**14 September 2026 · Session: `scribe` · Same branch `vinay/s1-auto-drain`, NEW COMMIT on `d852127`.**

Read `docs/handoff/ETA-S1-ROUND2-RULINGS-14-SEP-2026.md` first — it rules every open item. Nothing below
is open. Your FIX1 stop was right and its §4 premise checks are accepted as read; do not redo them.

## 0. Machine, repo, branch, push policy

Mac Mini · `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant` · branch `vinay/s1-auto-drain` at
`d852127`. **Commit on the branch. DO NOT push. DO NOT touch `main`. Never amend `d852127`.**

## 1. Pre-flight
```
git rev-parse --abbrev-ref HEAD    # vinay/s1-auto-drain
git rev-parse HEAD                 # d852127
git status --porcelain | grep -v '^??'   # empty
```

## 2. The changes

**C1 (as written in FIX1).** Before calling `drainRoomWindow`, ensure the legacy queue row exists via
`enqueueSubject("bench_window", <window_id>, "asr")` (`lib/stt/fanout.ts:55`, ON CONFLICT DO NOTHING).

**C2 — RULED (c): POST is cookie-only.** Resolve the admin id exactly as
`app/api/admin/bench/drain/route.ts` does, including `admin_id_missing_from_token`; actor is that id with
`via: "admin_route"`. A POST carrying only `MIGRATION_SECRET` is refused `AUTH_REQUIRED` with a message
saying a manual drain records spend against a person and requires a signed-in admin. **GET is unchanged**
(`CRON_SECRET`/`MIGRATION_SECRET`, `SYSTEM_ACTOR`/`"cron"`). **Invent no actor string.**

**C3 (as written).** `join_failed` + `join_service_not_configured` (`room-drain.ts:481`) ⇒ HTTP 500.
Every other step keeps its current status.

**C4 (as written).** `db/migrations/0091_disable_gemini_stt_engine.sql` — `enabled = false` on the
`gemini` `stt_engine` row (seeded `true` by 0073). Idempotent. Must carry
`INSERT INTO schema_migrations (version, name) VALUES (91, '0091_disable_gemini_stt_engine')` for
`tests/unit/migrations-self-record.test.ts`. Header comment: disabled because `GEMINI_STT` gates the engine
off while the row said enabled, so `lib/mcp/tools/health.ts:116` counted a permanently failing engine
(`lib/stt/adapters/gemini.ts:345`); re-enable the row **and** the env gate together, never one alone.

**C5 — N1, the zero-scored retry.** Two parts, both required:
1. **Window-as-unit replace.** Each `emotion_window` attempt deletes that window's existing segment rows
   before writing its own. No merge, no ON CONFLICT DO NOTHING across attempts.
2. **`finish()` derives its counts from the persisted rows**, in the same statement that writes the window
   record — not from `p.scored` / `p.failed` in memory. The `planned = 0` ⇒ `no_segments` path
   (`emotion-window.ts:116`) stays exactly as it is.

**C6 — N2, the refusal cooldown.** New migration
`db/migrations/0092_bench_window_auto_drain_refusal.sql` adding to `bench_window`:
`auto_drain_refused_at timestamptz NULL`, `auto_drain_refused_reason text NULL`. Idempotent, self-records
`(92, '0092_bench_window_auto_drain_refusal')`.
- The auto-drain sets both whenever `drainRoomWindow` returns **any step other than `enqueued`**, with the
  step name as the reason.
- It clears both on a successful enqueue.
- The selector excludes rows whose `auto_drain_refused_at` is within
  `AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES` — default **60**, env override, clamp **5..1440**, using the same
  `clampedIntEnv` helper as the existing tunables.

**C7 — N4, the tests.**
- Every tunable (`AUTO_DRAIN_BATCH_LIMIT`, `AUTO_DRAIN_MAX_AGE_HOURS`,
  `AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES`) is exercised at a **non-default** value, so a misspelt env name or
  an ignored value fails a test.
- Fixtures derive from the constants, never raw minutes (`seedScrambled`).
- The POST admin-cookie door is exercised **succeeding**, not only failing.
- The test SQL helper uses bind parameters, not inlined literals.
- Extend your mutation check to **env reads**: mutate each env name and each default and confirm a test
  fails. Report the count, as you did on S1.

## 3. Commit the bus documents

`git add` by exact filename and commit, alongside your code: the S1 kickoff and report, the S1+D1 verdict,
the FIX1 kickoff and its stop report, this kickoff, the round-2 rulings, the D1 brief and root-cause report,
the M1 kickoff and report, the S1 Refuter verdict, and your own FIX2 report.
**Do not `git add .`** — the pre-existing untracked bus files from earlier slices are not yours to commit.

## 4. File contract

**Edit:** `lib/stt/auto-drain.ts` · `app/api/admin/drain-windows/route.ts` · `lib/emotion/store.ts` ·
`lib/jobs/kinds/emotion-window.ts` · the S1 test files.
**Create:** `db/migrations/0091_disable_gemini_stt_engine.sql` ·
`db/migrations/0092_bench_window_auto_drain_refusal.sql` · any new test file you need.
**Untouched:** `lib/stt/room-drain.ts` · `lib/bench-window.ts` · `lib/stt/fanout.ts` ·
`lib/emotion/enqueue.ts` · `lib/emotion/client.ts` · `lib/mcp/**` · `lib/stt/adapters/**` ·
`lib/jobs/runner.ts` · `lib/jobs/store.ts` · `lib/jobs/submit.ts` · `vercel.json` · `apps/**` ·
`package.json`.

## 5. Gate and report

`npx tsc --noEmit` and the full suite, both green, quoted. Swift out of scope.
Report to `docs/handoff/ETA-S1-FIX2-REPORT-14-SEP-2026.md`: new sha · gate output · `git diff --stat`
against `d852127` · **every inferred SQL string verbatim, both migrations included** · the mutation-check
count including the env mutations · flags. Env var NAMES only.
