# ETA — voice_centroid (migration 0113). REFUTER VERDICT. 22 Sep 2026

`vinay/voice-centroid` **@ `4cf422d`** (builder lx), one commit on `248c2ae`: `db/migrations/0113_voice_centroid.sql`, `lib/voice-centroid.ts`, `tests/unit/voice-centroid.test.ts`. Contract: PLAN-v2.1 §D and line 6. Own detached worktrees `/tmp/refute-vc` and `/tmp/refute-vc-mut`; builder's worktree never written to, nothing pushed, **no migration applied**, no Neon branch created (the unit tests mock the database). lx's build report is not on the bus yet; the migration header refers to a flag in it, so I refuted against the plan and the code.

## PASS — two findings, neither blocks the merge

**Gate, under the heavy-run lock:** `typecheck` 0; **`Test Files 163 passed (163)`, `Tests 3660 passed | 1 skipped (3661)`**, 187 s; `build ✓ 20.2s`. My run left no containers; the seven up afterwards belonged to the next lock-holder's live suite and were left alone.

**Mutations: 14 of 16 killed**, targeted file only.

### The contract holds

- **Schema = plan §D**: `clinician_id`, `domain` with CHECK exactly `('room_primary','phone','meet')`, `generation`, plus embedding, model, dim, n_samples and provenance. V15 (widen the CHECK) dies.
- **Migration number is clean — checked the way the plan asks.** Across every remote branch head, only `origin/vinay/voice-centroid` carries a `0113_*` file (0112 is the shared predecessor everywhere). Production, read-only: `max(version) = 112`, 106 applied, 0111 and 0112 present — matching "prod at 112". `voice_centroid` does not exist live, so nothing was applied out of band. The test's own clash guard (`voice-centroid.test.ts:71`) sees the local tree only; the cross-branch check is manual, and I did it.
- **Additive and idempotent**: one table, one unique constraint, one partial index, all `IF NOT EXISTS`; no existing table touched; app-owned, no GRANTs; `schema_migrations` insert is `ON CONFLICT DO NOTHING`.
- **The race is safe.** Two writers on one key, default READ COMMITTED: the second's `UPDATE` blocks on the row lock, re-checks `retired_at IS NULL` after the first commits and retires nothing; its `next_gen`, from the statement-start snapshot, computes the same generation, the INSERT hits `voice_centroid_generation_uq`, and the whole statement — retire included — rolls back. Nothing forks. V7 (retire nothing) and V8 (reuse the generation) both die.
- **Input validation**: empty, non-finite and zero-direction embeddings, bad ids, bad model, `n_samples < 1` and a non-object `source` are all refused (V1–V4 die); a stored embedding whose length disagrees with its `embedding_dim` reads as `null`, not as a short vector (V5, V6 die).

### FINDING 1 — the one guard against loading a revoked centroid is untested

**V11 survives:** deleting `AND retired_at IS NULL` from `listActiveCentroids` — "what a matcher loads" — leaves the suite green. I checked whether the JS layer would catch a retired row on its own: fed the reader exactly what the database would return without the clause, and

```
V11_PROBE returned=1 ids=["vc_revoked"] retired_at=["2026-09-22T16:00:00.000Z"]
```

a retired centroid comes back as if active. `rowToCentroid` copies `retired_at` but nothing filters on it, so that one SQL clause is the **only** guard.

**Failure scenario:** a bad or compromised voiceprint is revoked with `retireCentroid(id)` and not replaced — the case that function exists for. If the clause ever regresses, the matcher keeps matching against the revoked print, and no test goes red. `readActiveCentroid`'s equivalent clause *is* pinned (V10 and V12 die on its statement text); `listActiveCentroids`'s is not. **Fix:** the same statement-text assertion for `listActiveCentroids`; optionally a JS `retired_at === null` filter as defence in depth. Low today — **no route calls this yet** — but it is exactly the guard that matters once a matcher does.

### FINDING 2 — revoking biometric data leaves no record of who or why

`retireCentroid` sets `retired_at` and nothing else: the table has no `retired_by` or reason column, and the helper logs nothing. A write records provenance in `source` ("who built it"); a revocation of the same biometric template records only a timestamp. For voice biometric data at rest this is the part of the design an auditor would ask about first. Not a code defect; a schema decision worth making before the first revocation, while 0113 is still unapplied and a column is free to add.

### Noted, not findings

- **One-active is not enforced by the schema.** At most one active row per `(clinician, domain, model)` is the writer's rule, defended by the reader's newest-generation dedupe (V9 dies) — the builder flags this in the migration header. A partial `UNIQUE … WHERE retired_at IS NULL` would enforce it. Note that the existing `voice_centroid_active_idx` is keyed `(clinician_id, domain)` **without `embedding_model`**, so it could not simply be made unique to do this: that would allow one active row per clinician-and-domain across all models, contradicting the writer's per-model rule.
- **Readers validate less than the writer.** `readActiveCentroid` and `listActiveCentroids` do not check `embeddingModel` against `MODEL_RE`. Bound parameters, so no injection; an inconsistency only.
- **V14 (drop `Math.fround`) survives** and is equivalent at unit level: under a mocked database nothing observes float32 vs float64, and Postgres `real[]` rounds on storage anyway.
- **`iso()` cannot throw on real data.** I suspected `new Date(s).toISOString()` might throw on a Postgres timestamp string; tested — every format Postgres returns parses, and only a string a `timestamptz` column never produces throws. Rejected.

## Jev (V's standing rule) — after my read, rerun and mutations; neutral context this time

I sent the task, the source diff and neutral context (conventions, driver, isolation level, gate result) and **none of my findings**, per the rule learned today, so its leads are independent. Scores **5.2–6.7**, every issue `low`, confidence **0.08–0.62**.

- **observability 5.6** ("a relevant service boundary lacks a useful outcome signal") → **CONFIRMED**, and it is FINDING 2. Independent: I gave it nothing about auditing.
- **correctness 5.2** ("requested behaviour appears missing or incomplete"; confidence 0.08) → **CONFIRMED in substance**: the task says "at most one active", and the schema does not enforce it (noted above; the builder's own flag).
- **consistency 5.8** ("related parts follow inconsistent conventions") → **CONFIRMED**: the readers' missing `MODEL_RE` check.
- **changeability 6.2 / duplication 6.1** ("a domain rule scattered across locations") → **CONFIRMED but mitigated**: the domain set lives in the SQL CHECK and in `VOICE_DOMAINS`, and the test pins both to the same literal list (`voice-centroid.test.ts:59`, `:93`) — V15 dies, so the copies cannot drift silently.
- **reliability 5.4** ("a race or concurrency assumption threatens reliable behaviour") → **REJECTED for data integrity**: I traced the concurrent-writer path above and it cannot fork. What survives of it is a contract note — the losing writer gets an unhandled unique-violation exception with no retry, which the header documents; the future route that calls this must handle it.

**Verdict: PASS.** The table matches the plan, the number is clean against every branch and production, and the one-active rule survives a concurrent writer. Finding 1 is one missing assertion on the matcher's load path; Finding 2 is a schema question best settled before 0113 is applied.

**Manual step for V (not run by me):** migration **0113** is unapplied on production; the number is verified free.
