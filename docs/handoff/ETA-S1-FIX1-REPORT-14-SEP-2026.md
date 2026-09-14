# ETA — S1 FIX1 — REPORT (STOPPED: PREMISE MISMATCH IN C2)
**14 September 2026 · Builder · branch `vinay/s1-auto-drain` · HEAD still `d852127` · not pushed**

## 1. Commit

**No commit.** The tree contradicts a premise of change C2, and the standing rule is to stop and report rather than improvise. None of C1–C4 is built. No file in the working tree was edited. The only new file is this report, untracked. I committed none of the bus documents from §3, because that commit belongs to the halted round.

Pre-flight passed:
- `pwd` was the repo.
- `git rev-parse --abbrev-ref HEAD` returned `vinay/s1-auto-drain`.
- `git rev-parse HEAD` returned `d852127f8727b8c4d6392e6ae404cfd84ef0ed39`.
- `git status --porcelain | grep -v '^??'` was empty.
- All six bus files named in §3 are present and untracked.

## 2. The mismatch

The kickoff §2 C2 says: *"`app/api/admin/diarize-windows/route.ts` already resolves an actor for POST — copy that shape. When POST is authorised by `MIGRATION_SECRET` rather than an admin cookie, use whatever actor string that route uses for the same case; do not invent a new one."* The verdict F3 says: *"The POST handler must pass the resolved admin id with `via: "admin_route"`."*

What the tree has:

**`diarize-windows` does not resolve an admin id.** `adminOrSecret` returns a boolean only. It verifies the cookie and discards the claims (`try { await verifyAdminJwt(cookie); return true; }`). POST then passes a fixed string for every authorised caller, cookie and `MIGRATION_SECRET` alike:
```ts
export async function POST(req: NextRequest) {
  if (!(await adminOrSecret(req))) return respondError("AUTH_REQUIRED", "admin or migration secret required");
  return run(req, "admin_route:diarize_windows");
}
```
There is no separate `MIGRATION_SECRET` case in that route to copy. Its actor also never reaches `actorProblem`: it goes to `submitJob`, not to `drainRoomWindow`.

**The route that does resolve an admin id is `app/api/admin/bench/drain/route.ts`:**
```ts
async function guard(): Promise<string | null> {
  const cookie = await readAdminCookie();
  if (!cookie) return null;
  try { const c = await verifyAdminJwt(cookie); return String(c.admin_id ?? ""); } catch { return null; }
}
...
  const adminId = await guard();
  if (adminId === null) return respondError("AUTH_REQUIRED", "Sign in required");
  if (!isUsableActor(adminId)) return respondError("AUTH_REQUIRED", "admin_id_missing_from_token");
  const actor = { actor: adminId, via: "admin_route" as const };
```
It has **no `MIGRATION_SECRET` door**, so it has no actor string for that case either.

So the three instructions cannot all be met:
1. "Resolved admin id" plus "copy `diarize-windows`": that route has no resolved id to copy.
2. "For `MIGRATION_SECRET`, use that route's string; do not invent one": the only candidate is `"admin_route:diarize_windows"`. Using it would file drain-windows spend under the diarize route's name. Any `drain_windows` variant is a new string, which the kickoff forbids.

## 3. The fork, for a ruling. Options only; I have not chosen one.

- **(a)** POST resolves the admin id the way `bench/drain` does, including its `admin_id_missing_from_token` refusal. Keep the `MIGRATION_SECRET` door and name its actor explicitly in the ruling (for example `"admin_route:drain_windows"`, or some other string), with `via: "admin_route"`. `actorProblem` accepts any non-empty non-`SYSTEM_ACTOR` string with `admin_route`.
- **(b)** As (a), but POST drops the `MIGRATION_SECRET` door and becomes cookie-only, like `bench/drain`. There is then no string to name. The cost: the Orchestrator and the Refuter lose the scripted manual door, while GET still accepts `MIGRATION_SECRET` as the cron.
- **(c)** POST resolves the admin id when a cookie is present, and refuses a `MIGRATION_SECRET`-only POST with `AUTH_REQUIRED`. This is (b) with an error that says why.

Whichever is chosen, the ruling needs to state the exact actor string, if any, for the secret-authorised POST.

## 4. The rest of FIX1: premises checked, no other mismatch

These were verified so the next round can proceed without a second stop:
- **C1**: `enqueueSubject(subjectType, subjectId, tier = "asr")` is at `lib/stt/fanout.ts:55`. Its SQL is `INSERT INTO stt_subject_job (subject_type, subject_id, tier, state) VALUES (…, 'queued') ON CONFLICT (subject_type, subject_id, tier) DO NOTHING`, and the table is from `0061_stt_subject_job.sql`. This matches the kickoff.
  - Test note, not a fork: "its failure is recorded with a non-zero attempt count" needs the real `recordFailure` in `room-drain.ts` to run against the real-Postgres container, together with `stt_subject_job` DDL from 0061. The current S1 test mocks `drainRoomWindow`, so this test will run the real drain with its outside world faked. It is buildable inside the file contract.
- **C3**: `join_failed` with detail `join_service_not_configured` is returned at `room-drain.ts:481`. This matches the kickoff.
- **C4**:
  - `lib/mcp/tools/health.ts:116` is the `ok` line that requires every `enabled && !virtual` engine to be healthy.
  - `lib/stt/adapters/gemini.ts:345` is `if (!cfg.gateOn) return { ok: false, …, error: "gemini_stt_disabled" }`.
  - The row `('gemini', …, enabled = true, fanout_enabled = false, …)` is seeded by `0073_gemini_stt_engine.sql`.
  - `0090` is the latest migration, so `0091` is free.
  - `tests/unit/migrations-self-record.test.ts` requires 0091 to carry `INSERT INTO schema_migrations (version, name) VALUES (91, '0091_disable_gemini_stt_engine')`.
  - All of this matches the kickoff.

## 5. Gate

Not run. No code changed since `d852127`, whose gate is recorded in the S1 report.

## 6. SQL

None written this round.

## 7. Manual steps for V

None. Re-issue the order once C2's actor is ruled.

## 8. Subagents

None used.
