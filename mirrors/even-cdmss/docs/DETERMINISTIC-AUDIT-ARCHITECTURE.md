## 3. Binding architecture (commit-ready)

After GO, commit this section verbatim as `docs/DETERMINISTIC-AUDIT-ARCHITECTURE.md`. Cite that commit SHA in the PR 1 kickoff. Until it is in git, **this section is the architecture.** Do not cite v2 §3. Do not cite a 10 August path that was never a git object.

### 3.1 Pipeline

```
Source Record
  → Canonical Snapshot
  → Clinical Fact Extraction          // facts are inputs; they do not score
  → Optional Model Evidence Proposal  // additive after PR 2; not a finding
  → Deterministic Rule Evaluation     // versioned evaluator; see §3.6
  → Finding Decision                  // origin + disposition + severity
  → Score and Report                  // score-core consumes findings per disposition
```

Principle:

> LLMs propose structured candidate evidence. Deterministic engines decide whether anything becomes a finding, how severe it is, and how it affects the score.

The engine stops asking “what problems do you see?” It asks “what structured facts can you extract?” Code then decides which versioned rules those facts trigger, and with what disposition.

**Facts do not score.** A fact has provenance and verification state. A rule reads facts and returns `fired` | `not_fired` | `not_auditable`. Only a *fired* rule with `rule_disposition = scoring`, inside its activation window on the policy clock, may move the score. Informational fired rules are visible and do not score. Advisory fired rules are visible as advisory.

A model-derived fact never scores by provenance alone. It may feed a versioned rule only after deterministic checks for: span, subject, negation, temporality, units, contradiction, and encounter applicability.

Absence does not accuse. If a required fact is missing or stale, the evaluator returns `not_auditable`, not a miss on the doctor.

PDQI remains explicitly model-derived and approximately 25% of the score. This programme makes *findings* more deterministic. It does not make the whole index deterministic.

### 3.2 Identities (do not collapse)

| Identity | Job | Lives on |
|---|---|---|
| Audit-row identity (`uid` and THE RULE in `lib/audit-canonical.ts`) | One doctor-facing *audit row* per note identity | `opd_note_audits` |
| `computeStableRef` = `sha1(signal_type ␁ norm(subject))` | Note-scoped **finding-kind token** (labels, grouping). **Not** THE RULE. **Do not change in this programme.** | Finding blob |
| `rule_ref` | Governance identity of an executable rule | Registry + (after evaluator) rule-origin findings |
| `(rule_ref, version)` | Immutable snapshot of that rule’s executable definition | Version ledger (non-executable) |
| `lvp_pattern_id` (`pattern:{direction}:{action}:{target}`) | Evidence identity on the LVP shelf | `lvp_*` / mapping table |
| `concept_id` | Stamp / dictionary evidence identity | Coder tables; not a rule id |
| `signal_type` | Triage cluster key | Triage |
| `individual_uid` | Opaque, write-once **cached link key** to the person on db13 | Audit row only. **Never** in prompts, fact snapshots, findings, traces, or exports |

THE RULE is unchanged: one active doctor-facing audit *row* per identity. Quote `lib/audit-canonical.ts`. Nothing is deleted. Older rows remain history. Finding-version snapshots (PR 4, after an inventory of every update/delete path) record a *reading* without creating a second active row. Snapshot-before-overwrite is mandatory; a failed snapshot blocks the overwrite.

`rule_ref` present on a legacy model-authored finding means the matcher stamped metadata onto prose. It does **not** mean the typed evaluator fired.

Mapping at promotion (L3, not this kickoff) uses `lvp_pattern_id` ↔ `rule_ref`. Hide writes `lvp_hidden` only.

### 3.3 Orthogonal fields (this is D2 — not T1–T5)

Do not introduce another overloaded tier vocabulary. Existing severity and provenance vocabularies stay. New structured fields:

```
fact_provenance            // how the fact was obtained (structured extract, model, join, …)
fact_verification_state    // unverified | span_verified | checks_passed | failed | not_applicable
rule_disposition           // advisory | informational | scoring
severity_tier              // existing governed severity vocabulary; lives on the finding
human_decision_type        // label | contest | ratification | hide | …
  + actor + scope + authority
finding_origin             // deterministic | model | unknown   // legacy-honest on historical rows
```

Scoring permission is a *function* of these fields, not a fifth mixed tier:

- Score **only if** a rule fired, `rule_disposition = scoring`, window contains the policy clock, and (if any input fact is model-derived) `fact_verification_state` has passed the checks in §3.1.
- Informational: finding visible, score unchanged.
- Advisory: finding or proposal visible, score unchanged.
- Human decisions override within their `scope` and `authority`.
- LVP Hide is `human_decision_type = hide`, scope = shelf, authority = cosmetic. It does not change `rule_disposition` and does not suppress scoring.

### 3.4 Fact schema (audit-time)

The admin page today reconstructs **current** db13 data at render. That is allowed as a *current-source* pane, labelled current, not audit-time.

Any fact a rule may read must be persisted at audit time:

- De-identified.
- Versioned with the audit / engine version.
- Provenance + verification state + measurement timestamp where the source has one.
- **Age:** encounter-time (from the note / visit, not “today”).
- **Weight:** timestamp, units, validity range, staleness policy. Stale or unit-unknown → `not_auditable` for dependent rules, never an accusation.
- **Not on the fact snapshot:** `individual_uid`, Even account numbers, mobiles, doctor names, member names.

Until PR 3 ships, PR 1’s fact sheet is current-source and says so. Facts remain shadow / non-scoring through PR 3. The evaluator in PR 4 reads the snapshot, not live db13.

### 3.5 Registry, versions, clock, authority

- **Sole executable registry:** `lvc_recommendations` (current row = current executable definition). Do not fork a second executable table.
- **Immutable version ledger:** non-executable snapshots keyed `(rule_ref, version)`. Never mutate a snapshot. Adding a mutable `version` column on the PK row is forbidden.
- **Windows:** half-open `[valid_from, valid_to)` on the ledger row.
- **Policy clock:** named, single, in the evaluator contract. Default: encounter date in `Asia/Kolkata`. Kickoff restates it. Do not silently mix `audited_at` and encounter date.
- **Bootstrap (PR 4):** every existing executable rule is loaded into the evaluator as `rule_disposition = informational` and run in shadow. Scoring is off until the activation record.
- **Ratification / versioning:** one atomic service. A new executable version and its ledger snapshot commit together, or not at all. Close seed, learning, and MCP bypasses that write registry rows outside that service. Kill hardcoded `approved_by='admin'`. Named human, rationale, sample size. This is rare promote, not a daily CM queue.
- **Lineage / rollback:** rollback = activate a prior `(rule_ref, version)` via the same atomic service (new window), not DELETE. Inventory all update/delete paths before PR 4’s finding-version snapshots (F12).

### 3.6 Evaluator contract (PR 4)

The current matcher keyword-matches already-created finding prose. That is not this evaluator.

```
inputs:  audit-time fact snapshot + (rule_ref, version) definition + policy clock
output:  { rule_ref, version, result: fired | not_fired | not_auditable, reasons[] }
```

- `not_auditable` when a required fact is missing, stale, unit-unknown, or failed verification.
- Shadow mode (PR 4 default): persist evaluator output; **do not** replace model-authored scoring findings; **do not** change the index.
- Activation (later record): per rule family, flip `rule_disposition` to `scoring` only after preregistered human-adjudicated gates: precision, safety-recall, coverage, `not_auditable` rate, score-migration. Retire the corresponding *model-finding scoring path* only after that family is accepted.

Dead code: `applyGate` and `suppressedRuleRefs` are not a rule-level suppression system. Do not claim one exists. PR 4 deletes those dead names. Safety remains the nine-type `audit_suppression` floor. A `rule_ref` is not a side door around it. Building real rule-level suppression is a later paper.

### 3.7 Legacy behavior

| Era | What the UI says | What scores |
|---|---|---|
| Historical row, mixed blob | Finding, origin `model` / `deterministic` / `unknown` | Whatever scored then; do not recompute silently |
| Post-PR 2 dual-write | Findings as today, plus proposals in the model layer | Legacy model findings still score |
| Post-PR 4 shadow | Same, plus informational evaluator output (visible as informational, not score) | Unchanged |
| Post-activation family F | Rule-origin scoring findings for F; model-origin scoring for F retired | Score-core per disposition |

Historical scores are never rewritten silently. An engine-version bump is required when write shape changes (PR 2, PR 4).

### 3.8 Invariants (a PR that breaks one is a fail)

1. Two query planes. Neon = corpus / audits / traces. db13 = clinical source via Metabase REST database 13 only. No pg driver to db13.
2. Identifiers out of the LLM. Display names join-at-read. `individual_uid` is an opaque cached link key on the audit row only — never in prompts, facts, findings, traces, exports.
3. Hybrid ingest stays. `dpipe_prescription_pipeline` primary; `individuals-prescriptions` the escape hatch. New fields go to dpipe first. Do not union `test_values_view` with `dpipe_all_digital_values`.
4. Inference ladder: Vertex Tokyo → OpenRouter backup → Ollama-on-mini for embed + fallback. `embedQuery` is nomic-only. `USE_EMBEDDING_V2` **exists** (`lib/llm.ts`, `lib/retrieve.ts`) and is hardcoded `false`. This programme does not flip it. Moving Gemini does not move retrieval.
5. labq stays quarantined from production retrieve. **R-11:** production OPD audit does not set `useNormativeLeg`. PR 2 deletes the OPD production env path. Retain an explicit, call-graph-isolated eval path. Ask / DDx / Coach keep `NORMATIVE_LEG_K`. Rules may read a corpus **in code**.
6. Advisory, never directive. Episode-level, not a clinician scorecard (NABH B3).
7. `CCB_ENABLED` and `APP_SOURCE` keep their names.
8. Audit paths: `noLocalFallback: true`. If both clouds fail, the audit does not happen locally.
9. Contest is adjudicated, never re-sampled. Study labels never enter production figures.
10. Design and QA against `cat.evenos.app`. Preview is not CAT. Kickoffs re-pin SHA. Clean worktree (F14).
11. **Hide is cosmetic.** `lvp_hidden` touches nothing but the shelf.
12. **No rule-level suppression to claim.** Delete dead `applyGate` / `suppressedRuleRefs`. Do not invent a floor on a path that does not exist. `audit_suppression` nine-type floor stays.
13. Admin gates fail closed. Fix `requireAdmin()` fail-open when an OPD PR first needs that gate; do not expand host trust.
14. Dual-write preserves the current LVP feed until a separate proposal-to-pattern contract exists (D6).
15. `exp/rerank-telemetry` is not a shortcut. PR 2+ wait on an explicit integration order (not in this paper).
