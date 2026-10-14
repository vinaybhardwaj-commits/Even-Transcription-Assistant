# Ruling: rerank telemetry guardrails and the critical path

**14 August 2026.** In response to
`CDMSS-SAUL-REQUEST-GUARDRAILS-AND-CRITICAL-PATH-13-AUG-2026.md` and the accompanying
measurement report.

The ten-cell run is useful evidence. It establishes a warm, serial, Vercel-Preview-to-Neon-branch
latency of about 66 ms per simple telemetry statement for the measured Mumbai-to-Singapore
deployment pair. It does not establish the production critical-path totals claimed in the request.

**Decision:** the Stage 0b canary does not open yet. The five guardrails can be defined numerically,
but none has a complete qualifying result. A written reduction of
the 73 tests is legitimate, but the reduced hard set is not yet complete. The region gap should be
costed before Stage 1a, in parallel with this work, and does not block the telemetry canary.

This ruling does not reopen or rewrite any of the six commits through `c4920ed`. The measurement
route did what its committed implementation does. The corrections below govern how its output may
be interpreted and what evidence is still required.

---

## 1. Corrections that precede the guardrail decision

### 1.1 The worker topology is `3 + 5N`, not `3 + 4N`

The omitted statement is a second `startInvocation()` for every note.

```text
batch level
  1  route-level startInvocation INSERT
  2  multi-row declaration INSERT
  3  invocation declared-count UPDATE

per note
  1  startInvocation INSERT ... ON CONFLICT DO NOTHING
  2  activeRun SELECT
  3  terminal UPDATE
  4  settlement SELECT
  5  settlement UPDATE
```

Source:

- route-level invocation: `app/api/opd-audit/worker/route.ts:345-347`
- batch declaration: `app/api/opd-audit/worker/route.ts:157-160`
- per-note invocation, including the predeclared path: `lib/opd-note-audit.ts:1525-1545`
- actual invocation insert: `lib/retrieval-invocation-store.ts:32-49`
- `activeRun`: `lib/opd-note-audit.ts:762-765`
- terminal write: `lib/opd-note-audit.ts:778-786`
- settlement read and update: `lib/retrieval-telemetry-store.ts:414-478`

Warm default `N=8` is therefore **43 statements**, not 35 or 36. A nominal cold process adds the
three `ensureRunsTable()` DDL statements. Concurrent first use can issue more than one DDL set
because the module stores a Boolean rather than an in-flight promise; do not price cold as exactly
three added statements without measuring it.

### 1.2 The critical path has two provider gates, not one uniform 199 ms shift

The actual order is:

```text
route-level startInvocation
note selection
batch declaration INSERT + counter UPDATE
mapLimit admits up to eight notes

for each admitted note
  duplicate startInvocation
  expansion / embedding / retrieval / rerank provider work
  activeRun
  terminal telemetry update
  main audit-scorer provider work
  audit persistence
  settlement
```

The duplicate invocation precedes the first retrieval-provider opportunity. `activeRun` and the
terminal write occur after retrieval and before the main audit scorer. Settlement occurs after all
provider work and persistence.

Using the measured new-row invocation insert as an unverified proxy for the production conflict/no-op
insert, the median component sums are:

```text
before first retrieval-provider opportunity
  66.29 + 132.66 + 66.29 = 265.24 ms

before main audit-scorer opportunity
  265.24 + 65.17 + 65.99 = 396.40 ms

through settlement
  396.40 + 131.31 = 527.71 ms
```

Those are **component sums**, not measured path distributions. The per-note no-op invocation was
not measured, and eight-way concurrency was not exercised. Medians and p99s are not additive, and
the wall time of eight concurrent chains is controlled by their maximum, not by a serial sum.

The corrected serial component model at `N=8` is:

```text
198.95 + 8 * 328.76 = 2,829.03 ms
```

The perfect-overlap one-wave component model is `527.71 ms`. The sum of the relevant component p99s
is `786.39 ms`. Neither is an observed concurrent wall-time percentile.

### 1.3 The terminal cell did not carry the stated 5.5 KB production manifest

At `c4920ed`, `payloadFor()` calls `createTelemetryCapture(role)` and immediately builds the payload.
A fresh capture is the deliberate zero-candidate shape: no hydrated candidates, no passage HMACs,
and no rerank batches.

Source:

- measurement payload: `app/api/admin/telemetry-overhead/route.ts:179-183`
- fresh zero-candidate capture: `lib/retrieval-capture.ts:176-201`

Therefore the statement that the measured terminal update carried a 5.5 KB canonical manifest is
false. The measured terminal latency remains useful as an empty-manifest branch baseline. It is not
the required production-shaped terminal baseline.

The Step 21 byte counts are not production-role baselines either. Its `normative_channel` capture
ran with the primary retrieval options, while the real channel uses `normativeChannelOpts()`:
`topK=4`, restricted sources, no reranker, no source weighting, no hybrid leg, and skipped expansion
at `lib/opd-note-audit.ts:676-692`. Both Step 21 roles also used shortened synthetic operational
values. The reported 5,518 and 5,463 bytes remain reproducible fixture sizes, not approved production
size denominators.

### 1.4 The run does not isolate transport or bound contention

The narrow result that stands is:

> Across these warm serial branch cells, medians were approximately 65 to 67 ms per simple statement
> or approximately 131 to 134 ms per two-statement boundary.

The following stronger statements do not stand:

- `median(A + B) / 2` is not either statement's median.
- Similar medians across statement classes do not prove that server work is under 1.71 ms.
- Production contention can add connection, proxy, compute-queue, lock, index, and pool waits. It is
  not confined to a residual inferred by subtracting cross-cell medians.
- The statements do not consume provider quota directly, but pre-dispatch delay and skew can change
  provider interarrival and burst shape.

The real/null settlement result is properly stated as a **0.012 ms difference between two
independently measured two-statement boundary medians**. It does not causally measure a 12 microsecond
foreign-key probe. The p99s differed by 26.95 ms, which is also not causal without pairing.

Likewise, batching is strongly favorable at the median, but not free: `declare max=30` had p99
225.28 ms versus 147.72 ms at `max=1`.

### 1.5 The first timed sample is not the first statement in the process

Every request performs `to_regclass` and an audit-id query before the timed loop at
`app/api/admin/telemetry-overhead/route.ts:296-313`. Terminal and settlement cells perform further
setup writes before timing. `first_statement_in_process` must be renamed
`first_timed_sample_after_preflight` in any report that retains it. It is excluded from the reported
distributions, so this labeling defect does not invalidate their warm samples.

---

## 2. What the five guardrails are for

There are two different instruments. They must not be collapsed.

1. **Regression detectors** protect the known instrumentation topology from accidental extra round
   trips, duplicated payloads, or role-specific growth. Baseline-relative limits are appropriate.
2. **Absolute admission criteria** protect runtime behavior. Retrieval noninterference and audit
   completion are pass/fail properties, not bands around a noisy database baseline.

PRD line 268 remains a separate acceptance judgment: a regression detector does not, by itself,
prove that throttling behavior is unperturbed. Canary rollback triggers are a third instrument and
do not replace missing pre-canary evidence.

### The five numeric guardrails

| # | PRD name | Numeric guardrail | Kind | Current status |
|---|---|---|---|---|
| 1 | Start-write latency | production-default pre-retrieval-provider telemetry-gate p99 ratio **<= 2.00** versus the corrected baseline | regression detector | **not established** |
| 2 | Terminal-write latency | per-role p99 ratio **<= 2.00** versus a production-shaped terminal baseline | regression detector | **not established** |
| 3 | Manifest size | per-role serialized-byte ratio **<= 2.00** versus the approved production-role fixture | regression detector | **not established** |
| 4 | Retrieval wall-time impact | one-sided 95% upper confidence bound on paired median `ON - OFF` **<= 1.00 ms** | absolute admission limit | **not established** |
| 5 | Audit completion preservation | **100.00%** of paired OFF-completing audits also complete with instrumentation ON | absolute admission limit | **not measured** |

The factor `2.00` is a deliberately broad topology-regression threshold, not a claim that twice the
latency is clinically or operationally safe. The one real-branch run does not support a tighter
universal band. Future comparisons must use the same deployment-region pair, statement boundary,
batch shape, role, payload shape, and percentile method, or establish a new approved baseline.

### Guardrail 1: start-write latency

`start-write` is prospectively clarified as the sum of the telemetry-only awaited intervals before
the first retrieval-provider opportunity at production default `max=8, conc=8`:

```text
route invocation insert
+ declaration insert
+ declaration counter update
+ eight concurrent per-note invocation conflict/no-op inserts
```

For each invocation define:

```text
G = duration(route-level startInvocation)
  + duration(batch declareNoteRuns)
  + max(duration(per-note startInvocation) over the first admitted wave)
```

The timers surround those calls only. They exclude authentication, settings reads, note selection,
trace setup, deterministic audit preparation, and every other non-telemetry interval. Also record
the minimum and maximum per-note completion offsets and their skew. The p99 guardrail applies to
`G`. The existing serial cells do not measure that object, so no honest absolute millisecond ceiling
can be computed from them.

The existing component sum `132.46 + 165.91 + 132.46 = 430.83 ms` is context only. It is not the p99
of the combined concurrent gate and is not the baseline denominator.

### Guardrail 2: terminal-write latency

Rerun per role with deterministic, text-free captures matching the actual role shape:

- primary uses `opdRetrieveOpts(false, env)` and a production-default 24-candidate/five-batch result;
- normative uses `normativeChannelOpts(env)`, not the primary options;
- both use representative production-length invocation, deployment, trace, route, backfill and
  timestamp values, fixed in the approved fixture;
- primary carries the scorer-context HMAC and normative carries the role-correct null.

The guardrail is `future p99 / approved baseline p99 <= 2.00` per role. The empty-capture p99 values
116.22 ms and 83.10 ms must not be used as the denominators.

### Guardrail 3: manifest size

Use the same approved role fixtures as Guardrail 2. The limit is
`future serialized bytes / approved fixture bytes <= 2.00` per role. Record the resulting concrete
byte ceilings when the fixtures are approved. The 5,518/5,463 Step 21 values are context only and
must not be doubled into production limits. This detects duplicated sections and comparable schema
growth; it is not a Postgres capacity limit.

### Guardrail 4: retrieval wall-time impact

No **telemetry-write** database call lies inside `retrieve(..., capture?)`. Retrieval's vector, BM25,
hydration and optional normative SQL run in both arms. A real database therefore adds common-path
variance; it does not supply a missing telemetry-write term. The Step 21 result correctly says the
effect was below its resolution; it does not say zero.

Rerun with deterministic collaborators using **200 independent pairs**. Each arm in a pair is a
timed block of **20 retrievals**; divide block duration by 20 before differencing. Use balanced AB/BA
order, 100 pairs in each order, assigned from a committed fixed seed. For pair `i`, define
`d_i = on_ms_per_retrieval - off_ms_per_retrieval`.

Create a fresh capture for every ON retrieval, inside the timed block immediately before calling
`retrieve`; never reuse a mutable capture across calls. The OFF arm performs no corresponding
allocation. This includes both allocation and population, matching the production caller's added
work.

The estimand is `median(d_i)`. Compute its one-sided 95% upper confidence bound as the 95th percentile
of **100,000 pair-level bootstrap resamples**, with replacement, using a committed fixed bootstrap
seed. Retain the 200 differences and the seeds. Pass only when that upper bound is at most 1.00 ms.

### Guardrail 5: audit completion preservation

The prior non-empty-retrieval count is withdrawn. Run at least **200 paired accepted jobs** from a
preregistered matrix of at least **20 distinct synthetic note fixtures**, with no fixture contributing
more than ten pairs. The matrix must cover successful retrieval, zero hits, swallowed retrieval
failure, rerank soft failure, and the production-default successful provider path. Use arm-isolated
database state and fresh deterministic identifiers.

The denominator is pairs whose OFF arm returns an audit and whose save result is the preregistered
successful result (`inserted` for fresh identifiers). The numerator is those same pairs whose ON arm
also returns an audit, produces the same save result, and reaches the role-correct
persisted-and-settled telemetry terminal condition.

Use the real `auditOpdNote` lifecycle with deterministic provider emulation and a nonproduction
database. Require observed preservation of **100.00%**. Report numerator, denominator, failure phase,
and paired fixture identity. A retrieval hit list is not an audit.

### Canary decision

**Closed.** Guardrails 1 through 3 need corrected role- and topology-specific baselines. Guardrail 4
is unresolved. Guardrail 5 is unmeasured. Amendment 1 expressly says canary rollback triggers do not
substitute for pre-canary evidence.

The statement that PRD line 268 is already satisfied is withdrawn. It may be satisfied after the
concurrent pre-provider gate shows bounded delay and skew and guardrails 4 and 5 pass. Cross-cron and
backfill alignment remains part of the canary overlap analysis; it does not excuse missing direct
pre-provider skew evidence.

---

## 3. The narrow evidence pass still required

Use a prospective signed addendum. Do not amend, rebase, or rewrite the six accepted commits.

1. Complete the reduced hard pre-canary proof set in section 4. If a resulting production-code change
   affects a measured path or artifact, it necessarily precedes the final baseline.
2. Add a combined `pre_provider_gate` measurement at `max=8, conc=8` that times only the exact batch
   invocation/declaration calls and the eight per-note conflict/no-op invocation inserts. Compute
   `G`, first readiness, last readiness, and skew as specified above.
3. Rerun both terminal cells with deterministic production-shaped, text-free manifests and assert
   their serialized sizes before timing.
4. Rerun retrieval ON/OFF with the fixed paired method and calculate the one-sided 95%
   bound specified above.
5. Run paired actual-audit completion with deterministic provider emulation and real branch
   persistence/settlement.
6. Correct the topology and first-sample labels in the report. Preserve the original raw evidence;
   do not rewrite it.
7. Record deployment SHA, Vercel region, Neon region, endpoint identity, raw archive path, byte count,
   and SHA-256 for every new cell.

The current temporary route still expires at the start of 20 August UTC and remains owed deletion.
Do not silently extend it. If the new pass cannot finish before expiry, delete and disarm it as
promised, then authorize a new temporary instrument with a new explicit expiry.

---

## 4. Ruling on the 73 tests

**A written reduction is legitimate** if signed before the canary and if it names the requirements
being deferred. `3084/3084` says every written test passes; it does not satisfy an unwritten hard
requirement.

### Hard pre-canary set

```text
1-25
28-35
37
42
44-47
49
51-60
64-66
68-71
```

These protect migration semantics, privacy, noninterference, batch/attempt attribution, durable
starts, lifecycle ownership, valid manifests, HMACs, reconciliation, ranking invariance, and provider
selection/fallback order. They bear directly on PRD section 7 or on whether opening the canary can
change production behavior.

The currently missing or materially incomplete hard proofs are:

```text
2
10-12
14
16-18
21-24
35
44-47
49
56
70
```

Those remain blockers. This is the legitimate reduction of the outstanding work, not a waiver of all
38 unwritten requirements.

### May defer until before C0

```text
38
43
50
61-62
67
73
```

These complete attempt detail, passage-HMAC cardinality, index provenance, class counters, source
slicing, and failure-class distinctions needed for C0 interpretation. They are not required to
decide whether a Stage 0b row is admissible, but they are required before that evidence is used for
C0 conclusions.

### Completeness, not a Stage 0b prerequisite

```text
26-27
36
39-41
48
63
72
```

These cover operator response shape, non-worker/lab seams, a nonproduction missing-key path, and
defensive source pins. They remain owed where the governing build requires them, but do not gate the
telemetry canary.

### Primary-rejected, normative-landed hazard

Retain it as a **hard canary failure**, not a pre-canary behavior correction. The characterization
test stands. If the path occurs, the Stage 0b link gate fails and the window does not pass. Do not
change production behavior inside the frozen telemetry workstream merely to make the gate greener.
A later correction requires its own authorization.

### Invocation closure conflict

PRD section 7 says a canary window closes only after every invocation reaches a terminal or explicitly
reconciled state. Addendum v1 prospectively and deliberately leaves retrieval invocations
`closure_unknown`, and the production routes have no `closeInvocation` owner. Those statements cannot
both govern the window literally.

The prospective addendum must choose one before canary authorization. This ruling preserves the
settled no-close design and amends the Stage 0b window rule narrowly:

> A Stage 0b window closes after every retrieval run declared by an invocation started in the window
> reaches a terminal or explicitly reconciled state, and after selected audits reconcile. The
> invocation row itself may remain `closure_unknown` under addendum v1's settled design. This is a
> Stage 0b window-accounting rule and does not describe `closure_unknown` as a closed invocation.

If V does not sign that wording, the alternative is to reopen invocation ownership and wire outer
boundary closers. Until one alternative is signed and proved, the canary cannot close.

---

## 5. Ruling on the region gap

**Cost a Vercel `sin1` Preview before Stage 1a. Do not cost a Neon migration first.** A Vercel Preview
is reversible; moving the shared Neon project is a data migration affecting other consumers.

This experiment does not block the telemetry canary and must not change the production region during
that canary. Run it in parallel or immediately afterward, but decide it before the stable baseline
used to compare Stage 1a. A region change after baseline would confound the worker-overlap result.

The experiment compares identical isolated Preview deployments in `bom1` and `sin1`, pointed at the
same nonproduction Neon branch, with crons disabled and synthetic fixtures only. Measure:

- serial and eight-way concurrent SQL p50, p95, p99, maximum, and error rate;
- route entry to first and last provider readiness and their skew;
- full `max=8, conc=8` synthetic worker duration and completion;
- Metabase/db13, Vertex, OpenRouter, and other active dependency latency/error distributions;
- India-origin dynamic-route latency;
- Vercel duration, Neon compute, and transfer cost.

Do not describe `sin1` as single-digit until it is measured. The present result includes geography,
the Neon HTTP proxy/pooler, fetch/TLS behavior, and scheduling. It is not a pure RTT measurement.

Even a one-second saving does not remove the structural four-minute-cron-versus-800-second-worker
overlap. Region colocation may improve every database path, but it does not replace Stage 1a unless a
full-worker comparison proves that the overlap risk itself has disappeared.

---

## 6. Ordered critical path

```text
1  sign the prospective guardrail, test-reduction and window-closure addendum
2  implement and pass the reduced hard pre-canary proof set
3  run the narrow four-part evidence pass against the resulting code
4  record concrete guardrail 1-3 denominators and ceilings; confirm all five pass
5  verify the production HMAC key independently
6  V authorizes production deployment
7  deploy, then POST the production migration route once and inspect `steps`; continue only on `ok: true`
8  on 409/table-not-empty, stop for a written legacy-data decision; otherwise run one Stage 0b canary
9  delete and disarm the temporary measurement route and branch before merge
10 complete the deferred C0 tests and Step 19 query texts before C0 interpretation
```

The `sin1` costing runs outside this sequence and completes before Stage 1a baseline selection.

No canary date is proposed. No production deploy, migration, region move, or load control is
authorized by this ruling.
