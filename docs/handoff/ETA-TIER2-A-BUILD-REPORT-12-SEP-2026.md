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
