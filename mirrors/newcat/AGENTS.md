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
- **No generic body.** `serialize` has no default governance projection: no hook means `EmitRefusal`. After the hook runs the platform checks the body and refuses (never repairs) unless: every finding has non-empty `evidence` (each item with non-empty `segment_id` and `quote`) and `judge.primary_p` (and `judge.second_p`, when not null, in 0..1); no finding has `action: 'abstain'` (abstentions appear only as `abstentions: { reason: count }`); `doctor_visible` is false or absent; no `prompt`, `system_prompt`, `user_prompt`, `rationale`, `raw_text`, `raw_model_text`, `model_text`, `completion` or `tool_input` key at any depth.
- **Segment ids.** `InternalAudit` evidence carries quotes and offsets only, so the agent's serializer maps each quote to its segment id from its own sources.

## Eval gate (`src/platform/eval/`)

Each agent ships synthetic `fixtures/<dir>/` and `test/agents/<dir>/eval.test.ts` built from `metamorphic` (delete / paraphrase / role-swap / insert transforms with expected finding-type deltas), `plantedClaim` (altered evidence, every judge must say no) and `regression` (frozen fixture hash plus expected output). CI runs the fake-judge variants. Live runs go to the box, never the repo. See `src/agents/example-echo/` and `test/agents/example-echo/`.

## Registering an agent

1. Put the definition under `src/agents/<dir>/` (the directory name is free; the id lives in the definition).
2. In `src/agents/index.ts` add **one import and one array entry** to `AGENTS`.
3. Nothing else in `src/api/registry.ts` changes: `CAPABILITIES = [...CORE_CAPABILITIES, ...AGENTS.map(toCapability)]`.

`example.echo` is the template's test agent and is deliberately not in `AGENTS`.

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
