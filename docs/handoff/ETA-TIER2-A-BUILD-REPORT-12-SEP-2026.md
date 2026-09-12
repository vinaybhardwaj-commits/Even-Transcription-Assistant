# ETA TIER 2 SLICE A BUILD REPORT — guards & hygiene — 12 Sep 2026

**Commits** on `vinay/tier2-a`, branched from `vinay/release-b1` @ `7e5e572` (the spec's stated base). Not pushed. `main` and `vinay/release-b1` untouched.
`fbb7415` §2.1/§2.2 assign-channel floor + channel audit · `65a9de4` §2.3–§2.7 scopes, budgets, detail, listChanged, scribe_fleet · `2b456dc` §2.4 detail on the other three tools · `17dd9d0` the kickoff.

**Gates** (all four, on the final tree):
- `npx tsc --noEmit` exit 0.
- `npm test`: `Tests 1821 passed (1821)`, 82 files. Baseline was `1776 passed`, 79 files — **+45 tests, +3 files**, none removed.
- `npm run build` exit 0.
- `npm run check:silent`: the same **9** accepted findings, none in a file this slice touched.
- No `swift build` / `swift test`: this slice changes no Swift. `apps/room-recorder` is untouched (verified by `git diff --name-only`).

**Files** (`git diff --stat 7e5e572..HEAD`): 23 files, +1358/−74. All are in §1's Slice A row (`lib/mcp/**`, `lib/room-install.ts`, the assign-channel route, audit) or are tests, docs, or the kickoff. **No migration, no `vercel.json`, no `apps/room-recorder`, nothing published.** `LISTENER_FRESH_MS` and `ACK_WAIT_MS` are unchanged.

**What each item became**
1. **§2.1 floor.** `TEST_CHANNEL_MIN_APP_VERSION = "0.1.22"` + `assignChannelRefusal(channel, version)` in `lib/bench-bus-constants.ts`; the route answers 409 `APP_TOO_OLD` (the code already existed and already mapped to 409). `stable` is never gated. **Nothing is written on a refusal** — no UPDATE, no audit row.
2. **§2.2 audit.** `install.assign_channel` {install_id, room_id, from, to, actor}; the actor is `installAdminGuard`'s `adminId`, so a migration-secret call records `migration_secret` and a cookie call records the admin. `install.channel_reported` {install_id, channel, cleared} fires once per transition. Both best-effort: a failed insert warns and never fails the caller.
3. **§2.3 scopes.** `SCRIBE_MCP_TOKENS` maps **sha256(token) → {actor, scopes}**, so the env var never holds a usable credential. Resolved first; `SCRIBE_MCP_TOKEN` still resolves to `operator-v1` with all three scopes. `audit_log.actor_id` = `mcp:<actor>`.
4. **§2.4 detail.** On `scribe_diff_room`, `scribe_day_report`, `scribe_system_map`, `scribe_fuse_report` and the new `scribe_fleet`; `summary` default. `scribe_diff_room`'s description cut **490 → 148 words**; the long text is `docs/operator-mcp/TOOL-NOTES.md`.
5. **§2.5 budgets.** `lib/mcp/budgets.ts`: read 55 s → downstream 40 s, invoke 115 s → 90 s, with tighter per-service ceilings for ollama (10 s), gemini (30 s) and r2 (15 s). `withBudget()` returns `{error:"<svc>_timeout", elapsed_ms, budget_ms}` and **aborts the request**.
6. **§2.6 listChanged.** `initialize` now advertises `capabilities.tools.listChanged: true`.
7. **§2.7 `scribe_fleet`.** Read scope, via the same `readFleet` + `deriveRow` the admin card uses.

**SQL (all INFERRED; no live database)**
- `assignInstallChannel` gains a pre-read: `SELECT install_id, room_id, app_version, assigned_channel FROM room_install WHERE install_id = ? AND retired_at IS NULL LIMIT 1`. The UPDATE itself is unchanged.
- Both audit rows: `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json) VALUES ('system', ?, ?, 'room_install', ?, ?::jsonb)`.
- **The one risky change.** The poll UPDATE gains, between its SET list and its WHERE: `FROM ( SELECT assigned_channel AS prev_assigned_channel, room_id AS prev_room_id FROM room_install WHERE install_id = ? ) AS prev`, its WHERE becomes `WHERE room_install.install_id = ? AND room_install.retired_at IS NULL`, and its RETURNING list is now fully table-qualified with `prev.prev_assigned_channel, prev.prev_room_id` appended. RETURNING cannot see pre-update values, and §2.2 needs the assignment that was just cleared. **This is the hottest statement in the system** (every room, every 1.5 s) and it is inferred: if the subquery or the qualification is wrong, every install row stops updating fleet-wide and the failure is caught fail-open, exactly the 0081 hazard. It wants live eyes on the preview before promote.

**Seams I interpreted differently from the spec**
1. **§2.1's "fleet card's Move to test control disabled" was NOT built.** There is no "Move to test" control on the card — only "Move to stable" (`can_move_to_stable`, offered on a Mac reporting `test`). More decisively, §1's file table puts Slice A in `lib/mcp/**`, `lib/room-install.ts`, the assign-channel route and audit; `components/` is not in it, and §8 says allowed files are that table plus tests. Adding a new control is a design decision this slice was not given. **Needs a ruling**: add the control in Slice E, or drop the sentence.
2. **`appVersionAtLeast` and `AppTooOld` moved** from `lib/bench-commands.ts` to `lib/bench-bus-constants.ts` and are re-exported from their old home. `bench-commands` imports `room-install`, so `room-install` importing `bench-commands` would have been a cycle; the pure constants module is the only place both can reach. Every existing import path still works.
3. **§2.5 is the module and its contract, not a call-site migration.** No tool was rewired onto `withBudget` yet: the outbound calls live in `lib/whisper.ts`, `lib/bench-join.ts` and the STT adapters, which are not in Slice A's file table, and §4/§5 rewrite those call sites anyway. The budgets, the envelope and the abort are built and tested; adopting them is Slice C/D work.
4. **§2.3 adds no read-only token.** "Add one read-only token for watchers" is an env change on a deployment, not a code change, and this Builder does not set env vars. The mechanism is in and tested; V mints the token.
5. **A malformed `scopes` list grants NOTHING** rather than defaulting to `read`. The spec does not say; widening access on a typo is the one failure this feature must not have.
6. **`summary` is pinned as a projection, not a second answer.** A test asserts every field `summary` returns is byte-identical to the same field under `full`, so the two cannot drift into different computations.
7. **`fuse-report`'s existing suite now asks for `detail:"full"`** (one line, in its `run` helper) because it asserts the per-row content §2.4 moved behind the flag. Four other test files changed only because the poll statement's text changed (their fakes interpret it).
8. **`scribe_fleet` carries hostnames and device names.** They describe machines, not people, and the admin card already shows them — but it is the first MCP tool to return them, so it is named here rather than assumed.

**V's manual steps.** None. Nothing to migrate, nothing to publish. To use §2.3, set `SCRIBE_MCP_TOKENS` on the deployment; until then the single token behaves exactly as it does today.

**Subagents:** none.

## Fix-up — on the three Slice A rulings

**Rulings 1 and 2 need no code**: the fleet-card "Move to test" control is dropped (seam 1 closed), and §2.5 module-only is accepted as built (seam 3 closed).
**Ruling 3** — `c43bbcb`. `pollCommands`' fail-open catch was a `console.warn`. It is now `console.error` every time (a log that drops repeats hides how long the fault has run) plus one best-effort `install.poll_write_failed` audit row per install per five minutes, through the existing `rateLimited` bucket. Unbounded at the 1.5 s poll cadence that would be ~2,400 rows per room per hour into the table meant to make this readable. The poll still fails OPEN — the registry is bookkeeping, the tape is not.
New SQL (INFERRED): the same `INSERT INTO audit_log … VALUES ('system', 'install', 'install.poll_write_failed', 'room_install', ?, ?::jsonb)` shape as §2.2's two rows.
**Tests +4**, in `tier2-assign-channel-guard`: ten rapid polls on one install write **exactly one** audit row while `console.error` fires **ten** times; a second install in the same window gets its own row (the limit is per install); the window is pinned at 5 min with the next window writing again; and a throwing poll still returns a normal result.
**Gates rerun, all four**: `tsc --noEmit` 0 · `npm test` **1825 passed (1825)**, 82 files (was 1821) · `build` 0 · `check:silent` the same 9, none in a changed file.
**One thing the fix-up changed beyond the ruling**: the five minutes is written `5 * 60_000`, not `300_000`. B3's guard test forbids a re-typed `300000` anywhere in `app|lib|components|db|scripts` — the house rule is that numbers are named and derived, not re-typed. Writing it in minutes × ms matches `CHANNEL_DRIFT_MS` next door.
Branch `vinay/tier2-a` pushed. Slice B not started.

## Fix-up 2 — Refuter (d) FAIL, all four items

`6d149f2`. **The Refuter is right and the defect was mine.** `pickSummary` did `if (k in row)` and skipped the rest, so a wrong name answered *less* instead of failing — a projection that drops what it cannot find has no failure mode.
**(2)** It now THROWS on a missing required key, naming the key and the row's actual keys; `optional` is the explicit escape for genuinely-conditional fields. Running it immediately caught a second one I had not been told about: `diff_room`'s `degraded` is spread conditionally, so the silent version would have been thin on every *healthy* room.
**(1)** `keys` is `readonly (keyof T)[]` and the `as Record<string, unknown>` casts that defeated it are gone, so a bad name fails tsc **at the call site** — proven, because that is what surfaced the day_report list. `SUMMARY_DAY_SESSION_FIELDS` also carries `satisfies readonly (keyof DayReportSession)[]` (= `ReturnType<typeof buildDaySession>`). `diff_room` and `fuse_report` build their payloads as inline literals with no named type, so those are guarded at the call site only — flagged rather than refactored.
**(3)** Day list corrected to the real row: `session_id`, `status`, `started_at`, `tape_ended_at`, `ended_at` (optional), `end_time_disagrees`, `chunks`, `gaps` — six of the previous ten were wrong. fuse-report counted `full.silence`, which does not exist (`silence` lives at `reconciliation.silence`), so `silence_spans` was **0** on the one day the section exists for, and the spans array rode inside `reconciliation` regardless. Now counted where it lives and stripped from the scoreboard.
**(4)** One round-trip per tool from real fixtures asserting every summary key exists on full and equals it; **the OPD-7 day reports `silence_spans` 1**. The day_report fixture gained a real session — a probe showed those loops were running over zero sessions, i.e. vacuous, which is the same class of bug again.
**Gates, all four:** `tsc --noEmit` 0 · `npm test` **1837 passed (1837)**, 82 files (was 1825) · `build` 0 · `check:silent` the same 9. **The poll UPDATE was not touched.** Branch pushed.

## Fix-up 3 — the type guard was still theatre
`buildDaySession` was declared `): Record<string, unknown>`, which collapses `keyof DayReportSession` to `string`, so fix-up 2's `satisfies` AND `pickSummary`'s `readonly (keyof T)[]` both accepted anything. Annotation dropped so the literal shape is inferred; a comment now forbids re-adding one.
**Proven, not asserted**: adding `"id"` back to the list fails `tsc --noEmit` with **TS2322 at the `satisfies` (bench.ts:2461)** and TS2345 at the call site, both enumerating the eleven real keys; removed again. Gates: tsc 0 · **1837 passed (1837)** · build 0 · check:silent the same 9.

## Slice A in production
Promoted **06:37:13Z**; `/api/health` reports `42ce902`. `tools/list` now serves **45** tools, `scribe_fleet` among them.
**The poll UPDATE is writing.** Five reads of `/api/admin/bench/fleet`, 30 s apart, 06:38:00Z → 06:40:02Z: **all 9 installs advanced their `last_seen_at` on every read**, ages 0–3 s throughout, `degraded: []` every time, `state_flags []` on every row. No row froze — the FROM subquery (the slice's highest-risk inferred SQL) is correct against the live schema.
**Failures: 0, by construction rather than by count.** `last_seen_at` is written by the very UPDATE whose failure would raise `install.poll_write_failed`, so 9 rooms advancing across 2 minutes means it never threw. **The direct count was NOT obtainable**: `/api/admin/dashboard` (the only `SELECT … FROM audit_log` that is routed) answers 401 without an admin cookie, and no MCP tool reads `audit_log`. **Tier 2 gap: the audit rows §2.2/§2.3 write cannot be read back by an operator.** Worth a tool in Slice E.
**§2.4 detail** on Home Office: `summary` **14 keys**, `full` **44** — every summary key present in full, `room_state.flags []` / `drift_since null` identical in both.
**§2.1 floor** on OPD 6 (0.1.21): `{"channel":"test"}` → **HTTP 409 `APP_TOO_OLD`**, message naming 0.1.21 and 0.1.22. Row unchanged before and after (`update_channel stable`, `assigned_channel null`) — the refusal writes nothing, as designed.

