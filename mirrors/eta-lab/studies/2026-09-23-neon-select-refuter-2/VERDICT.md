# kit/neon-select.mjs — Refuter verdict (eta-refuter-2, 23 Sep 2026)

Under review: eta-lab `kit/neon-select.mjs` @ 4f0d281 ("read-only production query helper for panes"). Not
built by this session. **Production was never queried.** I checked the guard offline and checked the SQL
behaviour on a throwaway local `postgres:16` container, which has since been removed.

**VERDICT: FAIL as a read-only tool.** A regex is the only thing keeping it read-only, and it connects to
production as `neondb_owner`, the owner role. Normal SELECTs work. But the tool promises "read-only", so
panes will trust it with any statement that starts with SELECT.

## N1 (HIGH, reproduced): writes pass the guard
I ran these through the helper's own guard (:9–12, copied verbatim):
- ALLOWED `SELECT * INTO probe_t FROM …`: this **creates a table**. Confirmed on pg16: the table exists afterwards.
- ALLOWED `SELECT setval('seq', 42)` / `SELECT nextval('seq')`: these **move a sequence**. Confirmed on pg16:
  last_value becomes 42. On production that shifts future ids.
- ALLOWED `SELECT pg_terminate_backend(pid) FROM pg_stat_activity …`: as the owner role, this can kill the
  app's own connections.
- ALLOWED `SELECT set_config(…)`, and any SELECT of a function that writes.
- Refused, correctly: data-modifying CTEs (`WITH x AS (DELETE …)`), multiple statements, and non-SELECT prefixes.

## Fix (both parts; either alone is not enough)
1. **Run every query in a READ ONLY transaction.** The installed driver (@neondatabase/serverless 0.10.4)
   supports `readOnly`, e.g. `sql.transaction([sql.query(q)], { readOnly: true })`. On pg16 this refuses
   SELECT INTO, setval and nextval ("cannot execute … in a read-only transaction"). **It does NOT refuse
   `pg_terminate_backend`**: I checked, and it's allowed inside `BEGIN READ ONLY`.
2. **Connect as a real read-only role**, not `neondb_owner`: a Neon role with only `SELECT` grants on
   `public` and no `pg_signal_backend` membership. Store that role's URI for panes. Then the database
   enforces read-only, not the regex.

## N2 (MEDIUM): the helper holds a project-admin credential
Each call reads `~/.claude/secrets/neon_api_key`, a Neon **console API key**. It can manage the whole project
(branches, roles, resets). The helper uses it to fetch the owner's connection string. A "read-only" helper
shouldn't need a key that can delete the database. Fix: ship the read-only role's URI (fix part 2) and drop
the API-key fetch.

## Lower
- `r.ok` is never checked (:14–15). A failed or rate-limited API call gives `uri = undefined` and an
  unhandled rejection. Check r.ok, and print a fixed message that never echoes the response.
- The output is every column as JSON. Nothing stops a pane from selecting transcript or note text into its
  own transcript. The header comment says counts and ids only; enforcing that is out of scope, but worth a
  column denylist for `transcript%`/`note%`/`text` if it's cheap.

## Verified good
- The connection string is never printed on the success path.
- Multiple statements are refused (`;` check), and data-modifying CTEs are refused by the keyword list.
