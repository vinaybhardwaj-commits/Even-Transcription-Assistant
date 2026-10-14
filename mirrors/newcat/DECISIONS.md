# Decisions

## ADR 1 — Headless engine, one open route

NewCat has no user interface. Callers are other systems, mainly Pulse and the Governance portal. `GET /health` is the only unauthenticated route. It returns `{ "status": "ok", "jev": "ok" | "fake" | "unavailable" }` and no clinical data. Every other route denies by default.

## ADR 2 — `/v1` deprecation

`/v1` is the stable major version. A breaking change to an envelope, a capability input, or a capability output ships as `/v2`. After `/v2` is available, `/v1` stays up for 90 days. Responses in that window include `Deprecation` and `Sunset` headers. Adding an optional field is not a breaking change. Removing a field, changing a type, or changing a status code is. Phase 0 does not send those headers because no successor version exists.

## ADR 3 — One envelope

Every capability uses the same request and response envelopes. The capability registry declares the input schema, the output schema, required scopes, allowed audiences, sync and async modes, and the version. Per-consumer API keys carry scopes and a maximum audience. The serializer applies the audience. The idempotency key is enforced on `(principal, capability, key)`. The same key and the same body replay the stored response, including a stored `202`. The same key and a different body return `409`.

Async jobs are accepted with `202` and a body that has `pending: true` and no findings. Completion is readable at `GET /v1/jobs/:id` and `GET /v1/events`. A webhook is HMAC-SHA256 over `timestamp.body`, header `x-newcat-signature`, five-minute tolerance. One delivery attempt. If `WEBHOOK_SIGNING_SECRET` is unset, the process records `webhook.refused` and does not call the URL.

## ADR 4 — Postgres, with an in-memory default

`DATABASE_URL` selects `pg` so the same SQL runs on Neon. When it is unset, the process uses PGlite. Tests and the example script use PGlite. Schema changes go through `migrations/*.sql` and `schema_migrations`. There is no runtime `ALTER`.

## ADR 5 — Jev HTTP shape

`NEWCAT_JEV=live` selects the HTTP adapter. `http` is a deprecated alias. `JEV_BASE_URL`, `JEV_API_KEY`, and `JEV_MODEL` are the configuration names. `TYPESAFE_*` is still read if the `JEV_*` value is unset.

The public TypeSafe contract is System One. `JEV_BASE_URL` is the origin with no path, `https://api.typesafe.ai`.

`POST {JEV_BASE_URL}/v1/systemone`

`Authorization: Bearer ${JEV_API_KEY}`

Body: `{ model, state, questions }`. `model` is `JEV_MODEL`, or `jev-latest` when that variable is unset. Live responses name the served model; `jev-latest` currently resolves to `jev-1.13.0`. `questions` is a map keyed by the caller-chosen question id. That key is not sent to the model. A `noul` answer is one binary scalar: 0 means no, 1 means yes, and 0.5 means uncertain. It is not a three-way distribution, carries no `confidence`, and has no option order. The adapter therefore reads it directly as P(yes) and never inverts it.

Finding validity uses a two-option `choice` (`yes`, `no`) so option-order testing is real. Instructions contain a concrete, rule-specific factual question plus `rule_id`, `claim`, and `quotes`; absence rules explicitly point to the relevant typed facts in `state`. The response's `probabilities.yes` is normalized only by the sum of the two returned option probabilities. The second call reverses the criteria key order without changing either option's meaning, and the two P(yes) values are averaged. Route remains a three-option `choice`; Score criteria remain an ordered array.

`200`: `{ model, answers, usage }`. `answers` is a map of `noul` (`noul` in 0..1), `choice` (`choice`, `probabilities`, `confidence`), or `score` (`score`, `legend`, index-keyed `probabilities`, `confidence`). The served model id is `model`. Probabilities are checked against the closed option set, then divided by their sum. A free-text field, an extra or missing label, a non-finite or negative weight, a non-positive sum, or any other shape throws `JevSchemaError` and the call is `failed` / `invalid_provider_payload`. The error message does not include the body. A non-200 or a transport error is `unavailable`. The audit then stays `unavailable`. It is not rewritten into a route, a drop, or an empty finding list. There is no fallback model.

A missing URL or key returns `unavailable` / `jev_not_configured` before a budget charge and before `fetch`. In production that absence does not block boot: the process logs a warning and `GET /health` reports `jev: "unavailable"`. `NEWCAT_JEV=fake` in production still refuses to boot. Both option orders are required. If either call fails, the result is not a one-sided average.

## ADR 6 — Abstention

Policy `abstention-policy/0.2.0` (Vinay, 12 Oct 2026). Thresholds are quantiles of a synthetic score list, not a clinical calibration. The daily budget starts at 25. Safety receives at least 60% of the slots. At backlog 0 the safety bar is 0.97 and the non-safety bar is 0.88.

A critical finding whose validity is at or above the safety bar is routed to the doctor. The route, hold, and drop question is not asked for that finding. The route question is asked only for non-critical findings. A safety-class finding below the safety bar abstains and is queued for a human. It is never dropped. A non-critical safety-class finding that the route question labels `drop_informational` also abstains rather than dropping. A confident `no` on validity is `suppressed_invalid`: recorded, not queued, not shown to a doctor. Stored decisions are reused only when both the question-set SHA and this policy id match.

"Raise the threshold on non-safety" when the backlog exceeds two days is implemented as shrinking non-safety slots first (to a quarter). Safety slots stay. That lowers the non-safety bar, so fewer non-safety items consume the remaining human slots. The doctor audience does not receive abstained findings, the queue, or probabilities. An audit whose only findings are abstentions or holds is `empty` with reason `nothing_routed` for a doctor. An operator receives the queue. `failed` and `unavailable` stay failed for every audience.

## ADR 7 — Audiences

Ranks are doctor 0, operator 1, internal 2. A key may request its rank or a lower one. The body principal must equal the key's consumer name.

Doctor fields: id, summary, severity, evidence quotes, recommendation (the summary). Operator adds rule id, rule version, action, evidence offsets, queue, and engine and rule versions. Internal adds probabilities, policy id `abstention-policy/0.2.0`, rationale, model ids, extractor version, and the question-set SHA.

## ADR 8 — No silent model fallback

`NEWCAT_LLM` defaults to `bedrock`, not `fake`. Production must set `NEWCAT_LLM=bedrock` and `NEWCAT_JEV=http`. A fake run is an explicit environment choice. Haiku `unavailable` or `truncated` is returned as that status. Sonnet runs only after the code validators reject a completed extraction, and only once. If Sonnet also fails validation, the stage is `extraction_failed` and the stored facts are null.

The budget row is incremented before the provider call and is not refunded when the call throws. Prices used for the estimate are Haiku 1/5, Sonnet 3/15, Opus 5/25, and Jev 0.042 per million input tokens with output free. Those are estimates, not invoices.

## ADR 9 — Finding identity

A finding id is the hash of rule id, rule version, and the sorted clinical slots. Span offsets are on the evidence, not in the id, so two drug orders produce one finding. The table primary key also includes the note version and the rule-pack version, so two notes do not collide.

## ADR 10 — Doctor copy is a template

Phase 0 does not call Sonnet to explain a finding. The doctor recommendation is the sentence the rule already produced. A later version can add a citation-checked Sonnet explanation without changing the score. Severity stays the rule's severity. Jev does not assign it.

## ADR 11 — Work and webhooks do not retry forever

Attempt cap is 2. A third failure is terminal `failed`. Extraction failure and a refused budget are terminal immediately. `unavailable` and `truncated` requeue until the cap. The webhook is a single POST. A failed POST is an event, not a loop.

## ADR 12 — Section isolation is later

The proposal's validators include section membership. Phase 0 checks that the span is inside the note and matches the quote, that units and frequencies are in the allowlist, that ages and vitals are in a plausible range, and that a fact labelled as a negation is rejected. It does not isolate history from plan. Do not treat a phase-0 extraction as section-aware.

## ADR 13 — Synthetic gold is a wiring fixture

`fixtures/gold/safety-v1.json` is marked `synthetic: true`. The gate can PASS on it because the fake model and the fake decision client are deterministic. That is a check that the pipe and the gate are wired. It is not a clinical validation. A hash mismatch refuses to score. An empty positive set fails as `VACUOUS`. ECE with no rows is null, not zero.

## ADR 15 — Vercel API, Neon, and one worker

The `/v1` API is a Vercel function (`api/index.ts`). Async work is not finished inside that function, because the invocation can freeze after the response. A single Docker worker claims `jobs` rows and delivers one signed webhook. Postgres in production is the Neon serverless driver. Tests leave `DATABASE_URL` unset and use PGlite. `npm run migrate` is the only DDL path. The API checks that the ledger is current and does not apply migrations itself.

Production Bedrock credentials are GCP federation. `GCP_SA_KEY_JSON` loads a Google service account. An impersonated IAM Credentials client mints an ID token whose audience is `GCP_AUDIENCE` (or the service-account email when that is unset). STS `AssumeRoleWithWebIdentity` in `AWS_STS_REGION` (`ap-south-1` by default) returns 1-hour credentials for `AWS_ROLE_ARN`, session name `newcat-<NEWCAT_ENV>`. The Bedrock client refreshes them about 5 minutes before expiry. `BEDROCK_AUTH=vercel-oidc` remains available and still does not pass a custom audience, so that trust policy's `aud` stays `https://vercel.com/<team_slug>`. `default-chain` is only used when selected, or when no key is set outside production. `BEDROCK_REGION` is explicit because Vercel may set `AWS_REGION` to the function region.

`POST /v1/internal/bedrock/check` requires the `admin` scope. It reports the auth mode, whether the ID token mint and AssumeRole succeeded, the GetCallerIdentity role-session ARN, and a one-token Converse call. The probe prompt is not a note. The response does not include the key, the token, or the session credentials.

API keys are SHA-256 hashes in `api_consumers`. `npm run keys` mints and revokes them. The token is printed once and is not logged.

## ADR 17 — CAT corpus import is already approved

CAT's existing corpus is a database that has been in production use. Rows imported from it are pre-approved and live as soon as they land. The import sets `signed_by` to `cat-corpus-import` and `signed_at` to the import time. There is no human gate on that import. `signed_by` / `signed_at` stays a gate only for rows added later from new sources: those rows are not used until someone signs them. Licensed sources stay internal-only and are not cited or quoted to a doctor.

## ADR 16 — Logs

Structured logs are a whitelist. Note ids are stored as a short hash. Bodies, quotes, patient refs, encounter refs, authorization headers, and webhook URLs are not log fields. A failure log records an error name, not the provider message, so a credential or a note cannot ride along in the text.

## ADR 14 — Evidence

Retrieval is a separate layer from the rules. Similarity search attaches citations after a finding is scored. It does not change the finding id, the decision, or the score.

`migrations/0003_evidence.sql` enables pgvector and adds sources, documents, chunks, and the empty structured tables `drug_interactions`, `dose_limits`, `banned_fdc`, and `nlem_items`. `signedStructuredRows` returns a row only when `signed_by` and `signed_at` are both set. The phase-0 rules do not read those tables. CAT JSONL import signs its documents as `cat-corpus-import` (ADR 17). Europe PMC open-access fetches stay unsigned, licence `open`, and doctor-visible.

Hybrid retrieval ORs significant terms on a tsvector, with British and Indian spelling expansions, and ranks a 1024-d vector. Reciprocal rank fusion joins the two lists. A doctor request only reads `doctor_visible` sources. Licensed classes stay internal: the doctor response has no licensed quote and no licensed source id. An empty corpus is `empty`. An embed or database failure is `unavailable`. `evidence.retrieve` is internal-only, scope `evidence.retrieve`. `audit.note` attaches the refs it found. Optional Haiku rerank (`BEDROCK_RERANK=haiku`) reorders hits and, if it fails, leaves the fused order in place.
