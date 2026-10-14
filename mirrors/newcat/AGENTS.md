# AGENTS.md: building an audit agent on newcat

newcat is Even's audit-and-decision platform. An **agent** is one definition file that the platform turns into a capability with a fixed run order, quote gate, judge stack, budget, audit trail and eval gate. You write the domain parts (sources, extraction prompt, fact schema, rules, question set). The platform owns everything that makes a verdict safe. Contract: `PLATFORM-SPEC.md` section 2 (signed by fable).

## Shape

An agent is an `AgentDefinition<I, F>` (`src/platform/agent/types.ts`):

| Field | Meaning |
|---|---|
| `id`, `version`, `summary`, `modes` | Capability identity. The id is also the API scope (`requiredScopes: [id]`). |
| `audiences` | Ceiling. `defineAgent` rejects `doctor` here when `doctorVisible` is `'never'`. |
| `doctorVisible` | `'never'` forces `doctor_visible: false` on every finding and makes the run throw `EmitRefusal` for audience `doctor`. `'policy'` shows a finding to doctors only if its rule has a `doctorSentence` (template text, ADR 7). |
| `input` | Strict zod object (`defineAgent` rejects a non-strict object). |
| `output` | Envelope passthrough schema. |
| `sources(input)` | `Source[]`: the text the quote gate checks against (below). |
| `completeness?(input)` | Runs before any model call. `{ ok: false, reason }` becomes `abstained` with that reason. |
| `extract` | Tier, optional escalation tier, forced tool (name, description, JSON schema), prompt builder, `factSchema`, `roleTable`, optional `maxDropRate` (default 0.30). |
| `rules` | Pure functions `facts -> candidates`, each with id, version, severity, `safety_class?`, `citation?`, `enabled`. Disabled rules are counted, never run. |
| `judge` | Question set `{ id, sha, question }`, `second: 'gemini' \| null`, `thresholds { safety, nonSafety }` (start 0.9 / 0.75; change only by PR with an eval report). |
| `abstention` | Closed lists of reasons and empty reasons. Snake_case identifiers, no PHI. The platform adds `extraction_unverified`, `judge_disagree`, `no_candidate_findings`, `judge_dropped_all`. |
| `evalGate` | Fixture paths and case names for the eval gate. |
| `budget` | Per-run caps: `llmCalls`, `jevCalls`, `clefCalls?`. |
| `versions` | Extra stamps (`extractor`, `rules`, ...) added to the run record. |

## Run order (`src/platform/agent/run.ts`)

1. Parse input (strict). 2. `completeness` (abstain, no model call). 3. Budget check: global `call_budgets` rows must have headroom. 4. Extract with a forced tool (tier, then one escalation re-run). 5. Quote gate. 6. Rules. 7. Judge. 8. Abstention policy. 9. Persist `agent_runs` (metadata only). 10. The HTTP layer serializes for the caller's audience.

## Sources and the quote gate (`quote-gate.ts`)

`Source = { id, segments: Segment[] }`, `Segment = { id, role, t0?, t1?, text }`. A note is one source with one segment of role `note`. Source and segment ids must be opaque (`s1`, `seg-0007`), never patient identifiers, names, UHIDs, phone numbers or any text derived from the record: ids appear in run rows, governance bodies and logs. The model returns facts as `{ group, quote, segment_id, ...your fields }` and nothing else. The gate:

- strips zero-width characters (U+200B, U+200C, U+200D, U+2060, U+FEFF) from quote and segment, keeps an origin map so offsets point into the original text;
- calls `findQuote` (`src/facts/quote.ts`, shared with `audit.note`): exact first, then case- and whitespace-folded;
- rejects a quote found only in another segment, a quote found nowhere, an unknown group or segment id, a segment id used twice, a fact that fails `factSchema`, and a role not in `roleTable[group]`;
- computes offsets and stamps role, t0, t1 itself. The model never supplies them;
- counts drops by reason. Quotes and segment text are never logged.

A drop rate above `maxDropRate` is a validation failure: one escalation re-run, and a second failure is `abstained` with `extraction_unverified`.

## Judges

Rules decide what is a candidate. Models never score. Each candidate goes to the judge port (`judge-port.ts`: `askValidity(state, question, set) -> { p_yes, servedModelIds }`; the F1 adapter over Jev is the default wiring, and an unready Jev holds findings). With `second: 'gemini'` a `SecondJudge` (`src/platform/judge/second.ts`) must also answer: both at or above the threshold keeps the finding, both below drops it, one yes and one no abstains with `judge_disagree`, and an unavailable judge holds the finding (`hold`, queued as `judge_unavailable`). There is never a one-judge verdict for a two-judge agent. A registered agent with no wired judge holds every finding.

## Governance lane

`governance` is a fourth audience: a separate lane for audit/QA reviewers, not a rung on the internal > operator > doctor ladder. Rules:

- **Who may ask.** Allow matrix (`src/auth/consumers.ts`): an `internal` key may request any audience; `governance` -> governance only; `operator` -> operator, doctor; `doctor` -> doctor.
- **Opt in.** An agent lists `governance` in `audiences` only with `serializers.governance`, a function `(audit) => body`. `validateDefinition` rejects the pair otherwise. `audit.note` never lists it.
- **No generic body.** `serialize` has no default governance projection: no hook means `EmitRefusal`. After the hook runs the platform checks the body and refuses (never repairs) unless: every finding has non-empty `evidence` (each item with non-empty `segment_id` and `quote`) and `judge.primary_p` (and `judge.second_p`, when not null, in 0..1), and `judge` carries no other key than `agree` (boolean) and `served_model_ids` (string[]); `versions` is a record of strings; `trace_id`, `capability`, `capability_version` and a finding's `id`, `finding_type`, `rule_id`, `rule_version`, `severity`, `procedure_group` are strings; `abstentions` keys match `^[a-z][a-z0-9_]{0,63}$`; the platform checks the `JSON.stringify` snapshot of the hook output, not the live object; `summary` and `reason` are strings; `status` is one of the five envelope statuses; evidence `t0`/`t1` are numbers >= 0; no finding has `action: 'abstain'` (abstentions appear only as `abstentions: { reason: count }`); `doctor_visible` is false or absent; no `prompt`, `system_prompt`, `user_prompt`, `rationale`, `raw_text`, `raw_model_text`, `model_text`, `completion` or `tool_input` key at any depth.
- **Segment ids.** `audit.note` evidence carries quotes and offsets only. Agent evidence (F7.3) also carries `segment_id`, `role` and, when the segment has them, `t0`/`t1`, so a governance serializer can read the segment id straight from the finding.

## F7.3 additions (agent needs)

- **Judge in the envelope.** `InternalFinding.judge` is `{ primary_p, second_p, agree, served_model_ids }` (numbers 0..1 or null), identical to `agent_findings.judge`. Absent on `audit.note` findings. doctor, operator and internal bodies never carry it; an agent's governance serializer reads it.
- **Evidence segments and meta.** Agent finding evidence items carry `segment_id`, `role` and, when the segment has them, `t0`/`t1`, stamped from the gated fact. A `Candidate` may set a flat `meta` (snake_case keys, string/number/boolean values); it is copied to `InternalFinding.meta` and never reaches the judge state or the claim. Meta keys are a closed set: the agent declares `metaKeys` (slug-shaped, not identifier-like; validateDefinition refuses others) and a candidate using any other key fails the run with `invalid_meta_key`; no declaration means no meta. Governance bodies may carry `meta` per finding with the same shape; doctor, operator and internal bodies never do.
- **Absence findings.** `judge.questionSets` maps a rule id to its own `QuestionSetRef`; a rule without an entry uses `judge.questionSet`. The decision's `question_id` is the set used, and `agent_runs.versions.question_sets` records `id@sha` per rule. `audit.versions.question_sets` carries the same record (key absent for a default-set-only agent). A `Candidate` may carry `contextRanges: [{ source_id, segment_from, segment_to }]` (segment ids, inclusive, in source order): the judge state then has `context_segments` (source, segment id, role, whole text), separate from the evidence quotes. A range outside the sources drops the candidate and counts `context_out_of_range` in `counts.drops`. The platform ships no question wording.
- **Persist hook.** `AgentDefinition.persist(ctx: { sql, runId, traceId, input, audit })` runs after the platform's run rows are written, in the same job, only for status ok, empty or abstained. It gets the parsed input. A throw is caught, counted (`counts.persist_failed`, present only on failure), logged as a code only, and never changes the returned audit. It can run again for a retry under the same idempotency key, so keep it idempotent. The hook gets deep copies of the audit and input (mutating them changes nothing that is returned or stored in `agent_findings`). It also gets `facts` (the gated facts that survived the quote gate: `group`, `fields` (the agent's own validated fields), `segment_id`, `role`, `t0`, `t1`, `quote`; empty when the run ended before the gate or on `extraction_unverified`) and `drops` (the gate's counts by reason, as in `counts.drops`), both deep copies. Facts carry quotes: they may go only to the agent's own tables. A hook never logs facts or quotes. It has a deadline: `persistTimeoutMs` (default 10 s, capped at 60 s); on timeout the run counts `persist_failed` and carries on. The hook still holds the unscoped `sql` handle: write only to the agent's own tables (a scoped role is a later slice). The hook runs before serialize, so a governance `EmitRefusal` can leave agent rows for a refused run: key on `runId` and expect refused runs (R7). `countReasons` may not use `Object.prototype` names (`constructor`, `__proto__`, `toString`, ...). Context ranges (`context_segments`) are agent-chosen whole segments for absence claims and bypass the extract `roleTable`; the consult-window rule still bounds them (R4).
- **Duplicate spans.** Two facts of one group on the same span: identical fields are deduped silently; different fields count `duplicate_span_different_fields` in the gate's drops (it counts toward the drop rate) and the first fact stands.
- **Counts without candidates, agent empty reason.** A rule's `evaluate` may return `{ candidates, counts?, empty_reason? }` instead of a bare list (`candidatesOf` normalises). `counts` keys must be in the agent's `countReasons` (snake_case, closed set) and values non-negative integers; a violation fails the run with `invalid_agent_count`. Sums go to `InternalAudit.agent_counts` (omitted when empty) and `agent_runs.counts.agent_counts`; an agent's governance serializer may emit `agent_counts` (record of non-negative integers, abstention-style keys). doctor, operator and internal bodies never carry it. `empty_reason` must be one of the agent's own `abstention.emptyReasons` (else `invalid_abstention_reason`); when the run ends empty with no candidates, the first rule's (in rule order) replaces `no_candidate_findings`. It does not apply when candidates existed and the judge dropped them (`judge_dropped_all` stands).

## F7.4 additions

- **Rule context.** `AgentDefinition.context(input)` (optional) returns plain JSON derived from the parsed input; every enabled rule's `evaluate(facts, ctx)` gets its own deep copy as the second argument. It is for rule logic only: it never reaches a judge state, the claim text, logs, `agent_runs`, `agent_findings` or any audience body. A throw or a non-JSON value fails the run with `invalid_rule_context`. A rule declared with one argument keeps working. Put nothing in the context you would not put in the input.
- **Opaque governance ids.** `AgentDefinition.identity(input)` (optional) may return `{ doctor_uid?, encounter_id? }`, each matching `^[A-Za-z0-9._:-]{1,128}$` with no run of 8 or more digits (a bad value or a throwing `identity` is left off, not an error, and counted in `agent_runs.counts.identity_invalid` by field: `doctor_uid`, `encounter_id`, `threw`). The platform stamps them on `InternalAudit`; only governance bodies may carry them, at top level (strings, same pattern). Doctor, operator and internal bodies never emit them. Identifier-like keys (`patient_name`, `uhid`, `individual_uid`, `phone`, `email`, `name`, ...) are refused at governance top level (except the two ids), in findings, as finding `meta` keys and as `versions` keys. The test is by token: keys split on `_`, `-`, `.` and camelCase, and refused when any token is name, uid, uhid, mrn, phone, mobile, email, aadhaar, aadhar, dob, address, patient, individual, ip, ipno, pan, passport or contact (so `phone_number`, `patientName`, `mrn` all fail). F7.5 widens this to every key at every depth of a governance body (findings, evidence, judge, meta, versions incl. `versions.question_sets` inner keys, abstentions, `agent_counts`); only top-level `doctor_uid` and `encounter_id` are exempt. A key is also refused when its lowercased form contains a concatenated spelling (phoneno, mobileno, patientname, fullname, uhidno, emailid, abha, ssn, aadhaarno) or holds 8 or more digits after stripping `- _ . space /`; opaque ids count digits the same way (`9876-543210` fails). `versions.question_sets` inner keys match `^[a-z][a-z0-9_.]{0,63}$`. A finding `meta` string value is at most 128 characters and may not equal any evidence quote in the same body. `validateDefinition` applies the identifier test and the 8-digit rule to abstention `reasons`, `emptyReasons`, `countReasons` and `metaKeys`. Governance `versions` keys are `engine|rules|extractor|models|question_set_sha|question_sets` plus slug-shaped non-identifier agent keys; values are strings (`question_sets`: record of strings).
- **Persist timeout is abandonment, not cancellation.** When `persist` outlives `persistTimeoutMs` the run counts `persist_failed` and carries on, but the hook keeps running: nothing cancels it. Do not hold locks, open transactions or pooled connections across an `await` in a hook, and write idempotently, because a late hook can still finish after the response. A non-number, `NaN` or infinite `persistTimeoutMs` falls back to the 10 s default. A hook that returns a plain value instead of a promise is awaited normally and is not counted as failed.

Counts: `counts.served_unverified_second` (present only when above 0) counts answers of a declared second judge that came back with an empty `servedModelIds`.

## Budgets

`budget.jevCalls` counts asks: `run.ts` takes one per ask (two per candidate when a second judge is declared; the second judge's ask is not a Jev wire call). Each ask is two wire calls, each charged on the global jev ledger before the request (`transport.ts`). A per-run cap of N therefore allows up to 2N ledger calls.

## Eval gate (`src/platform/eval/`)

Each agent ships synthetic `fixtures/<dir>/` and `test/agents/<dir>/eval.test.ts` built from `metamorphic` (delete / paraphrase / role-swap / insert transforms with expected finding-type deltas), `plantedClaim` (altered evidence, every judge must say no) and `regression` (frozen fixture hash plus expected output). CI runs the fake-judge variants. Live runs go to the box, never the repo. See `src/agents/example-echo/` and `test/agents/example-echo/`.

## Registering an agent

1. Put the definition under `src/agents/<dir>/` (the directory name is free; the id lives in the definition).
2. In `src/agents/index.ts` add **one import and one array entry** to `AGENTS`.
3. Nothing else in `src/api/registry.ts` changes: `CAPABILITIES = [...CORE_CAPABILITIES, ...AGENTS.map(toCapability)]`.

`example.echo` is the template's test agent and is deliberately not in `AGENTS`.

## Retention and stored input

- `AgentDefinition.retention?({ sql, now }) => { swept }`: the worker (`src/jobs/retention.ts`, called from `src/worker.ts`) runs it at most once per UTC day per process (the first tick after a start always runs; the last-run day is in memory, there is no state table). Each hook runs under a deadline (default 30 s, `Promise.race`); a timeout logs `error_type:'timeout'` and the pass moves on, so a hanging hook cannot block job claiming longer than that. A throw is caught and logged as `{event:'agent.retention', agent_id, error_type:'retention_failed'}`. `swept` is coerced to a non-negative integer (a non-number logs `error_type:'bad_count'`); success logs `{event:'agent.retention', agent_id, swept}`. Counts and codes only. Keep the hook idempotent.
- `AgentDefinition.storedInput?(input) => unknown`: for an async job, `jobs.request` is replaced by this projection at completion, in the same UPDATE that writes the result (`runQueuedJob`). Until then `jobs.request` holds the full input, so a lease-expired (crashed) retry runs on the full input. The run uses the full in-memory input. Note `jobs.request` IS the parsed capability input (not an envelope with an `input` key). Agents without it keep the full input until the 90-day sweep. A ubus `rerun` of a job whose request was trimmed (projection) or swept (90 days) fails closed with `invalid_input`-style `failed`, not a refusal.
- Same daily pass: `jobs.request` of finished jobs (status not queued/running) older than 90 days is set to `'{}'`. Rows are never deleted.

## Audit trail

Migration `0006_agent_runs.sql`: one row per run in `agent_runs` (agent id and version, trace id, idempotency key (default: the request envelope's `idempotency_key`; the trace id only when the caller has none, e.g. async jobs), input sha, status, reason, version stamps including served model ids, counts). **No input text.** Agents that need their inputs keep them in their own tables.

## Ownership

| Area | Owner |
|---|---|
| `src/platform/**`, `src/decide/**`, `src/llm/**`, `src/facts/**`, `src/api/**`, `src/audience/**`, `src/jobs/**`, `src/worker.ts`, `src/config.ts`, `src/runtime.ts`, `AGENTS.md`, `CLAUDE.md`, `.github/**`, the migration sequence | newcat-lead |
| `src/agents/<agent-id>/**`, `test/agents/<agent-id>/**`, `fixtures/<agent-id>/**`, one line in `src/agents/index.ts`, the migration number newcat-lead gives you | the agent's lead |

Migration numbers: 0005 consult-audit, 0006 agent runs, 0007 platform outbox, next free 0008. Every migration is additive.

## Gate

`npm ci && npm run typecheck && npm run lint && npm test`. One slice = one branch `platform/<slice>` = one PR. Nobody pushes `main`.

## Rules

- **Vendors.** Only Bedrock, Jev, Gemini (via Vertex or an OpenRouter ZDR route) and Cloudflare Workers AI (Clef) may receive patient text.
- **Rules in code, models never score.** Models extract quoted facts and answer closed questions. Severity, thresholds and actions come from code.
- **Absence is not evidence** unless the agent's `completeness` passed.
- **Synthetic fixtures only** in the repo.
- **No identifiers** in specs, fixtures, logs, `agent_runs` or bus posts.
- **`audit.note` stays byte-identical.** Every existing test stays green and unedited.

## Artefacts

`src/platform/artefact/` holds `ArtefactRef` (`store`, `path`, `layer`, `engine`, `version`, `cfg8`, `sha256`, `schema`; a new cfg8 is a new artefact), `readConsultBundle` (wraps `kit.reb.consult_bundle`, returns refs only) and `resolveTrack` (reads the track at read time and checks its sha256). Persist refs only, never artefact bodies or quote text (D1); bodies are resolved when a body is needed. Reads happen only in the worker on eta-lab-t4: both functions throw when `VERCEL=1`. Env: `NEWCAT_ETA_LAB_DIR`, `NEWCAT_REB_ROOT`.
