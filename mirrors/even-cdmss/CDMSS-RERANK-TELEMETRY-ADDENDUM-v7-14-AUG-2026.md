# CDMSS rerank telemetry: addendum v7, the prospective guardrail and scope addendum

**14 August 2026.** Prospective. Signed before the work it governs, not after.

**SIGNED by V on 14 August 2026, sections 1 to 15 in full, without amendment. See section 15.**

Nothing in this document authorizes a deploy, a migration, a canary, or a change to
`RERANK_BACKEND`.

SHA-256 of this file at signature: recorded by the operator when the file is force-added to the
branch. This file sits at the worktree root, which `.gitignore:73` excludes with the rule `/*.md`.
Addenda v1 to v6 are tracked because they were force-added. v7 must be force-added the same way, or
it is not part of the record it claims to govern.

## 0. Authority and preflight

Governs all work after `c4920ed61828bbf3d356cdd1f3fd30a9e576a5a8` on `exp/rerank-telemetry`.
Continues addendum v6. Every settled decision stands unless a section below names it.

```text
branch:      exp/rerank-telemetry
HEAD:        c4920ed61828bbf3d356cdd1f3fd30a9e576a5a8
origin:      c4920ed, in sync
origin/main: 81b7c93, untouched
tree:        clean
suite:       3084 of 3084
```

This addendum implements the ruling in
`CDMSS-SAUL-RULING-GUARDRAILS-CRITICAL-PATH-14-AUG-2026.md` and the review of 14 August. It does not
amend the ruling.

**It does not amend, rebase or rewrite any accepted commit.** The seven commits of this workstream
are `32f0f79`, `10f4a65`, `31424cb`, `d452fec`, `cdc9c34`, `123041b`, `c4920ed`.

A correction to the record. The ruling refers to "six accepted commits". The carryover says seven.
Seven is right for this workstream. Six is the count of build passes. Separately,
`git log --oneline origin/main..c4920ed` returns fifteen commits, because eight earlier commits
predate this workstream. Any future non-amendment clause must name the seven, not the fifteen.

## 1. The five guardrails

Two instruments. They must not be collapsed. Regression detectors protect the instrumentation
topology from accidental round trips and payload growth. Absolute admission limits protect runtime
behavior, and are pass or fail rather than a band around a noisy baseline.

| # | Name | Guardrail | Kind |
|---|---|---|---|
| 1 | Start-write latency | p99 ratio at most 2.00 against the corrected baseline | regression detector |
| 2 | Terminal-write latency | per-role p99 ratio at most 2.00 against a production-shaped baseline | regression detector |
| 3 | Manifest size | per-role serialized-byte ratio at most 2.00 against the approved fixture | regression detector |
| 4 | Retrieval wall-time impact | one-sided 95% upper bound on paired median ON minus OFF at most 1.00 ms | absolute admission limit |
| 5 | Audit completion preservation | 100.00% of paired OFF-completing audits also complete with instrumentation ON | absolute admission limit |

No guardrail has a qualifying baseline today.

**Guardrail 1.** The measured object is the combined concurrent pre-provider gate at production
default `max=8, conc=8`.

```text
G = duration(route-level startInvocation)
  + duration(batch declareNoteRuns)
  + max(duration(per-note startInvocation) over the first admitted wave)
```

Timers surround those calls only. Record minimum and maximum per-note completion offsets and their
skew. The existing serial cells do not measure `G`, so no absolute millisecond ceiling can be
computed from them. The component sum 430.83 ms is context and is not a denominator.

**Guardrail 2.** Rerun per role with deterministic, text-free captures matching the real role shape.
Primary uses `opdRetrieveOpts(false, env)` and a production-default 24-candidate, five-batch result.
Normative uses `normativeChannelOpts(env)`. Primary carries the scorer-context HMAC. Normative
carries the role-correct null. The empty-capture values 116.22 ms and 83.10 ms must not be
denominators.

**Guardrail 3.** Same approved role fixtures. The Step 21 byte counts 5,518 and 5,463 are context
and must not be doubled into production limits.

**Guardrail 4.** 200 independent pairs. Each arm is a timed block of 20 retrievals, divided by 20
before differencing. Balanced AB and BA order, 100 pairs each, from a committed fixed seed. A fresh
capture is created for every ON retrieval inside the timed block. The OFF arm performs no
corresponding allocation. The estimand is the median of the differences. The one-sided 95% upper
bound is the 95th percentile of 100,000 pair-level bootstrap resamples with replacement, from a
committed bootstrap seed. Retain the 200 differences and both seeds.

**Guardrail 5.** At least 200 paired accepted jobs from a preregistered matrix of at least 20
distinct synthetic note fixtures, with no fixture contributing more than ten pairs. The matrix
covers successful retrieval, zero hits, swallowed retrieval failure, rerank soft failure, and the
production-default successful provider path. Arm-isolated database state, fresh deterministic
identifiers. A retrieval hit list is not an audit.

Baselines are approved by V when the fixtures are approved. The concrete ceilings are recorded then.

## 2. The test reduction

A written reduction is legitimate because it is signed before the canary and because it names what
is deferred.

**Retained as hard pre-canary. Fifty-seven tests.**

```text
1-25, 28-35, 37, 42, 44-47, 49, 51-60, 64-66, 68-71
```

These protect migration semantics, privacy, noninterference, batch and attempt attribution, durable
starts, lifecycle ownership, valid manifests, HMACs, reconciliation, ranking invariance, and
provider selection and fallback order.

**Currently missing or materially incomplete. Twenty tests. These are the blockers.**

```text
2, 10-12, 14, 16-18, 21-24, 35, 44-47, 49, 56, 70
```

All twenty must pass before the final measurements.

**Deferred until before C0. Seven tests.**

```text
38, 43, 50, 61-62, 67, 73
```

These complete attempt detail, passage-HMAC cardinality, index provenance, class counters, source
slicing, and failure-class distinctions. They are not needed to decide whether a Stage 0b row is
admissible. They are needed before that evidence supports a C0 conclusion.

**Completeness only, not a Stage 0b prerequisite. Nine tests.**

```text
26-27, 36, 39-41, 48, 63, 72
```

Operator response shape, non-worker and lab seams, a nonproduction missing-key path, and defensive
source pins. Owed where the governing build requires them. They do not gate the canary.

Fifty-seven plus seven plus nine is seventy-three. The three groups partition the set with no
overlap. The reduction takes thirty-eight unwritten requirements down to twenty named blockers.

## 3. Window closure

PRD section 7 says a window closes only after every invocation reaches a terminal or explicitly
reconciled state. Addendum v1 deliberately leaves retrieval invocations `closure_unknown`, and no
production route calls `closeInvocation`. Both cannot govern literally.

This addendum preserves the settled no-close design and amends the Stage 0b window rule.

> A Stage 0b window closes after every retrieval run declared by an invocation started in the window
> reaches a terminal or explicitly reconciled state, and after selected audits reconcile. The
> invocation row itself may remain `closure_unknown` under addendum v1's settled design. This is a
> Stage 0b window-accounting rule and does not describe `closure_unknown` as a closed invocation.

The alternative is to reopen invocation ownership and wire outer boundary closers. That alternative
is not selected here. If V prefers it, this section does not apply and the canary waits on that
build.

## 4. The `auditOpdNote` test seam

Guardrail 5 requires the real `auditOpdNote` lifecycle with deterministic provider emulation and a
nonproduction database. The current seam is partial. `AuditOpdOpts` at `lib/opd-note-audit.ts:1276`
injects telemetry, a lifecycle callback, rerank backend and model routing. It does not inject the
generator or the database. `defaultGenerate` is module-private and called directly at
`lib/opd-note-audit.ts:1597`. `sql` is a module import.

**Authorized: one default-preserving test dependency seam.** It must satisfy all of the following.

1. Default behavior is unchanged when the seam is not supplied. The production call path must be
   byte-identical to today.
2. The seam is trailing and optional in the options type, so no positional argument moves.
3. It injects the generator and an arm-isolated database handle. It injects nothing else.
4. A test asserts the default path does not construct or consult the seam.
5. No production caller supplies it.

Precedent. `rerankJudge` was exported on this branch for the same reason, recorded on the branch as
adding no caller and changing no behavior. This authorization follows that pattern and no further.

## 5. Intended attribution

There are four sites that write an intended provider or model, all in `lib/rerank.ts`. Three are
wrong.

| Site | Current value | Status |
|---|---|---|
| `:170` | `openrouter` with `RERANK_API_MODEL` | correct |
| `:268-269` | `JUDGE_MODEL` on the judge arm | wrong model |
| `:304-305` | `vertex` with `JUDGE_MODEL` | impossible pair |
| `:511` | `vertex` with `JUDGE_MODEL` | impossible pair, per-batch hot path |

**Decision. Intended provider and model mean the resolved first dispatch target.**

The sanctioned pairings are Vertex with the effective Gemini model, OpenRouter with the Gemini slug,
Ollama with `JUDGE_MODEL`, and OpenRouter with the effective Cohere model.

Resolution is dynamic. Do not replace `JUDGE_MODEL` with a hardcoded Gemini model. The judge's first
target depends on `GEMINI_ALL`, `GEMINI_UTILITY`, `GEMINI_VIA_OPENROUTER` and provider
configuration, all read at dispatch time. A hardcoded correction trades one wrong constant for
another.

All four sites are corrected before the hard proofs and before the new measurements, because the
correction changes a measured artifact.

## 6. Cohere soft-failure attribution

D16 in kickoff v11 contains a contradiction that the build flagged and did not resolve. Its mapping
table assigns `not_served` to a Cohere soft failure. Its proof rule says `not_served` requires
failure attribution as proof, and that without proof the answer is `unattributed`. Cohere is a raw
fetch and never reaches `chatWithFallback`, so it can never carry that attribution. Every declared
Cohere failure throws a typed error that propagates or downgrades. Only a generic throw reaches the
branch in question, and there non-delivery is not proven.

**Decision. The proof rule governs. A generic Cohere failure without transport proof records
`unattributed`, never an inferred `not_served`.**

D16's mapping table is amended to that extent and only that extent. Where transport proof exists,
`not_served` stands.

## 7. `active_backfill_target`

The column is declared `string | null` at `lib/retrieval-telemetry-core.ts:539` and written at
`lib/opd-note-audit.ts:770` from `readBackfillActivity()`, which returns `run.model ?? null`. No code
reads the value back. `BackfillRun` has no `target` field at all. So the name promises a backfill
target while the data holds a grader model identifier.

**Decision. `active_backfill_target` is the active backfill run's `model`. It is null when there is
no active run.**

The name is not changed in this addendum, because renaming a persisted column is a migration and
this addendum authorizes none. The definition is recorded so that no reader infers a target from it.
PRD section 7 requires active provider-backfill intervals for overlap analysis and states that an
idle cron tick is not an interval. A null here means no active run, which is exactly that
distinction.

## 8. Rejected terminal writes

`writeRetrievalTerminal` at `lib/retrieval-telemetry-store.ts:255` updates conditionally on
`row_revision` and `persistence_state = 'started'`. Zero rows updated is not an exception, so the
failure-evidence path never fires. The only trace is a `console.warn`. The manifest, counters and
defect list computed for that write are discarded.

**Decision. Add durable `retrieval_terminal_rejected` evidence before the initial production
migration.**

**Decision. On terminal compare-and-set rejection, reread the row. If it is already terminal,
preserve it. Never downgrade an existing terminal row.**

The prohibition on blind retry stands. A blind retry is how an old invocation overwrites a newer
terminal result.

## 9. Role-keyed manifest defects

**Decision. Implement role-keyed manifest defects now, rather than carrying the known cross-role
contamination into the canary.**

Implementation detail is owed and is not settled by this addendum. The build must report the exact
keying scheme it adopts and the defect codes it moves, and must not change any defect's meaning
while rekeying it.

## 10. Reranker temperature and seed in the manifest

Neither seed nor temperature is captured anywhere today. The finding that started this workstream
names an unseeded judge, and no persisted row would show a seeding change.

**Decision. Record reranker temperature and seed status in the manifest configuration before the
size baselines are established.**

Before, because the fields change the serialized byte count, and guardrail 3 measures serialized
bytes. Adding them after the baseline would breach the guardrail it is meant to protect.

Record seed status, not an assumed seed. The Ollama options bag that would carry a seed is stripped
before every cloud call, so a seed set in code does not reach a cloud provider. The manifest must
record what actually applied.

## 11. Raw measurement output

The ten raw response bodies from the 13 August measurement do not exist in either repository, in
Downloads, on the Desktop, or anywhere in git history. The route writes nothing to disk by design
and said so in its own response. The instruction to hash and record was written into build report
part XI and never executed. About 2,500 samples are gone.

**Decision. Save, hash and verify raw measurement output in the same operator session that takes
it.**

A measurement is not taken until its raw output is saved and hashed. An instrument that writes
nothing to disk hands that duty to the operator, and the operator discharges it before the session
ends. Record deployment SHA, Vercel region, Neon region, endpoint identity, raw archive path, byte
count, and SHA-256 for every cell.

**Decision. Measurement revision 3 is a withdrawal, not a correction.** Statistics whose inputs no
longer exist cannot be corrected. No summary from the old report may become a guardrail denominator.

## 12. Temporary instruments

**Decision. Every temporary instrument carries a new explicit expiry and a deletion contract at the
time it is authorized.**

The current route returns 410 from the start of 20 August UTC. It is not extended. It is deleted and
disarmed, with its Preview variables and its Neon branch removed. A new instrument against the
corrected code is authorized separately, with its own expiry.

## 13. PRD line 268 acceptance

PRD line 268 is a human acceptance judgment and sits outside the five numeric guardrails. It is not
satisfied today. The claim that it was satisfied is withdrawn.

**Decision. It passes only when the new evidence shows all of the following.**

1. Pre-provider telemetry gate p99 at most 1,000 ms.
2. First-wave readiness-skew p99 at most 250 ms.
3. Retrieval ON minus OFF one-sided 95% upper bound at most 1 ms.
4. Audit completion preservation exactly 100% in the approved paired harness.
5. No provider-order, fallback-order, score, prompt, candidate or ranking change with telemetry ON.
6. No unexplained incomplete or unattributed telemetry path.

These are admission criteria. They are separate from the 2.00 regression guardrails, and passing the
guardrails does not satisfy them.

## 14. What this addendum does not decide

1. The rollout mechanism for Cohere. Not in scope here. Decision D4 stands until V reopens it.
2. The primary-rejected and normative-landed hazard. It remains a hard canary failure and not a
   pre-canary behavior correction. A behavioral correction needs its own authorization.
3. The `sin1` region. A Preview-only comparison may run in parallel. No production region changes
   during any canary.
4. The DDx 0.2 threshold, the learning-miner 0.5 floor, and the `even-lvc` source weight. Each needs
   its own study and its own authorization.
5. Legacy data policy, unless the production migration returns 409.

## 15. Acceptance

The addenda carry no signature convention. This one needs an explicit acceptance, because sections
1 to 13 authorize work that has not started and because a prospective addendum signed after the fact
is not prospective.

V accepts by recording, in writing, the date and the sections accepted. If any section is rejected
or amended, the amendment is written here before any work under it starts.

```text
Accepted by:                          V
Date:                                 14 August 2026
Sections accepted:                    1 to 15, in full
Sections amended, with the amendment:  none
```

Accepted in full and without amendment. Sections 1 to 13 are now in force and govern all work after
`c4920ed`. Section 14 stands: this addendum decides nothing about the Cohere rollout, and decision
D4 remains in force until V reopens it in a separate written record.
