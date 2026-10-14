# Architecture

NewCat phase 0 is the OPD slice of the 12 Oct 2026 greenfield redesign: an event spine, typed facts, versioned rules, closed-question decisions, and audience-typed output. It is a library plus an HTTP API. Pulse and the Governance portal are the callers.

## Module map

| Module | Proposal | What phase 0 does |
|---|---|---|
| `src/api` | §4 function map, called by Pulse and Governance | Capability registry, `/v1` envelopes, API keys, idempotency, async jobs, signed webhooks, OpenAPI generated from zod |
| `src/ingest` | §3.2 event spine, P1 | Note versions keyed by `(source, uid, content_hash)`. Re-date is a no-op. A changed body is a new version and enqueues work. Leases, attempt cap 2 |
| `src/identity` | §3.2 identity, P5 | Caller-asserted `patient_ref` + `encounter_ref`, or `unmapped`. No name or department match |
| `src/clock` | P5 | UTC storage. `clinical_date` is UTC+05:30 with UTC getters. `visible_at` is stored |
| `src/facts` | §3.2 ClinicalState O | Zod facts. Every fact has a source span and an extractor version stamped by code |
| `src/llm` | §3.2 Bedrock language layer, P10, P11 | Bedrock Converse via `@aws-sdk/client-bedrock-runtime`. Tiers haiku, sonnet, opus. Intended and served model ids, tokens, latency, cost estimate. Budget charged before the call. Fake client is explicit |
| `src/extract` | §3.2 extraction, P9 | Haiku prompt and parser. Validators: span, units, ranges, a small negation check. One Sonnet re-run on validation failure. Provider failure and truncation are not escalated |
| `src/rules` | §3.2 rule layer, P6 | Eight pure rules. Severity is assigned by the rule. Re-score reads stored facts and does not call a model |
| `src/decide` | §3.2 Jev, P7 | TypeSafe HTTP adapter. Both option orders, averaged. Quantile abstention. Safety findings are never auto-dropped |
| `src/audience` | P4, Governance pipe | Allowlist serializer. Doctor, operator, and internal are different zod objects. A leak throws and is not sent |
| `src/auth` | P3 | API keys with scopes and an audience ceiling. Cron bearer with a constant-time compare. Missing secret refuses |
| `src/evidence` | §4 retrieval | pgvector chunks, hybrid BM25 plus vector with reciprocal-rank fusion, audience licence filter. Similarity does not score a finding |
| `src/eval` | §3.5 | Frozen gold hash, Jaccard, safety recall and precision with bootstrap intervals, non-inferiority, abstain rate, ECE, latency, cost, PASS/FAIL gate |
| `src/db` | P13 | One migration runner and `schema_migrations`. PGlite when `DATABASE_URL` is unset. Neon serverless driver when it is set |
| `src/llm` credentials | P10 | Production Bedrock auth is GCP federation: service-account JSON, IAM Credentials ID token, STS in `ap-south-1`. `vercel-oidc` and `default-chain` are explicit. `POST /v1/internal/bedrock/check` is admin-scoped |
| `src/worker.ts` | §3.2 queue | One always-on process claims async jobs and delivers webhooks. The Vercel function only accepts them |
| `src/pipeline` | §3.3 one OPD note | Ingest → facts → findings → decisions → persisted audit |

### Principles P1–P16

| Principle | Phase 0 |
|---|---|
| P1 Event spine | Implemented for notes pushed by the caller. There is no db13 reconciler yet |
| P2 Typed outcomes | Stage outcomes and the API envelope. Empty is a status with a reason. Failures are not HTTP 200 |
| P3 Deny by default | Every route except `GET /health` requires a credential. `/health` returns `{ status: "ok", jev }` and no clinical data |
| P4 Audience typing | Serializer plus banned-key walk for the doctor audience |
| P5 Identity and clock | Asserted refs or `unmapped`. IST clinical date. `visible_at` |
| P6 Rules in code | `src/rules/pack.ts`. The decision state does not include the finding summary |
| P7 Jev | Validity for every finding. Route only for non-critical findings. A critical finding at or above the safety bar is routed by the abstention policy |
| P8 Language last | Doctor sentences in phase 0 are the rule templates, not a generative call |
| P9 Escalation by failure | One Sonnet call after validator failure only |
| P10 No silent fallback | Intended vs served model. Fake is provider `fake`. No second provider |
| P11 Budget before call | `call_budgets` update `where calls_used < max` |
| P12 Replay | Audit row stores engine, rule pack, extractor, question-set SHA, and model ids. Rules are pure |
| P13 Migrations | `migrate()` only |
| P14 Doctor belief | Not stored in phase 0. Doctor responses are a later capability, not a validity label |
| P15 Conversation ledger | Not built. `ask` is a registered stub |
| P16 One live stream | No dark flags. Shipping is the process in `DECISIONS.md` |

## Request path

1. The caller sends one envelope: principal, purpose, optional patient and encounter refs, audience, idempotency key, `sync` or `async`, optional webhook, and the capability input.
2. The API checks the key, that the principal matches the key, the scopes, and that the requested audience is at or below the key's ceiling.
3. `audit.note` ingests the note. The content hash is the normalized body plus structured fields. The source timestamp is not in the hash.
4. Extraction runs if this note version has no successful facts. A previous `extraction_failed` stays failed.
5. Rules score the facts. Decisions run if this question-set SHA does not already cover every finding.
6. The serializer projects the internal audit. Async work returns `202` with a job id and no findings, then posts one signed webhook or records a refusal.

## Bug classes

| Class | How phase 0 avoids repeating it |
|---|---|
| 1 Silent empty | Status is `ok`, `empty`, `abstained`, `unavailable`, or `failed`. `empty` carries a reason. Extraction failure is HTTP 422, not `[]`. Retrieval failure stays `unavailable` |
| 2 Auth fail-open | No route trusts `x-vercel-cron` or the host. A missing `CRON_SECRET` is `missing_secret`. Production boot checks required secrets |
| 3 Doctor leakage | Doctor output is an allowlist. `assertDoctorSafe` throws `EmitRefusal` if a banned key is present. The HTTP layer turns that into `refuse_emit` |
| 4 Identity hops | Both refs or `unmapped`. Finding ids hash the rule id, rule version, and sorted clinical slots. Drug order does not change the id. The storage key also includes the note version and rule-pack version |
| 5 Clock | `clinicalDateIst` uses a fixed +05:30 offset and UTC calendar fields. Re-dating an unchanged note does not update the stored row |
| 6 Mislabelled fallback | The ledger stores intended and served ids separately. A throw records served as null. The fake provider is `fake`. Haiku being down does not call Sonnet |
| 7 Retry storms | Lease plus attempt cap 2. A refused budget finishes the work item as terminal `failed`. The webhook is one attempt |
| 8 Truncation | `stopReason === max_tokens` is status `truncated` (HTTP 502) and is not parsed as facts |
| 9 Nondeterminism | Rules are pure. Jev averages both option orders. Doctor text is a template |
| 10 Prompt-only rules | The eight rules are functions. Jev is not shown the conclusion sentence |
| 11 Reviewer rule errors | Drug aliases live in code (`coumadin` → warfarin, `glucophage` → metformin, `crocin` and `acetaminophen` → paracetamol, `brufen` → ibuprofen). Pregnancy, renal, and hepatic are `yes`, `no`, or `unknown`. Unknown is not treated as no. Section isolation is not implemented; validators cover span, units, ranges, and a small negation check |
| 12 Migrations | One runner, one ledger, no runtime `ALTER` in `src` or `scripts` |
| 13 Vacuous instruments | ECE is null when there are no samples. A gold hash mismatch refuses to score. An empty safety-positive set fails as `VACUOUS` |
| 14 Unverified shipping | Phase 0 has no feature flags. The gate and the example script are the checks that run in CI and locally |

## What is stubbed

`ask`, `med_reconcile`, `ddx`, `appropriateness`, and `triage.decide` have input and output schemas, scopes, and audiences. Their handler returns `unavailable` / `not_implemented`. Retrieval is the same kind of stub. There is no RAG index and no real patient data.
