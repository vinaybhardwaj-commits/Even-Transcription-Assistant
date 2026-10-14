# CDMSS rerank telemetry: addendum v9, the pre-proof corrective pass

**15 August 2026.** Prospective scope for one corrective pass. Four commits. No proofs.

**UNSIGNED. Awaiting V's signature. Section 3 awaits Saul's ruling before signature. See section 10.**

## 0. Authority and scope

Continues addendum v8. Governs all work after `9185cb98d39e467f2463b06a3a889ae35303fef4` on
`exp/rerank-telemetry`.

This addendum records, before the work happens, the scope of the corrective pass that Saul's review
20 requires. Ruling 6.2 of that review: use a standalone corrective pass before the twenty proofs,
and do not fold it into proof pass 1.

**This addendum is deliberately narrow.** It covers four commits. It reopens no settled decision. It
adds no telemetry, changes no ranking behaviour, and touches no scoring path. Every settled decision
in v1 through v8 stands.

**v8 is not edited.** Its SHA-256 is
`ac48e66562ba0859669c18b589fa613000f09ac33f6f611482c7a2ab13e13e56`. v7's is
`0e05f4b006fb90e9d9c31cd476577f8df06eb333265db60e1e70a760bdbf8682`. Any correction to either lives
here or in a later addendum.

The preflight, verified against the branch on 15 August:

```text
worktree     /Users/vinaybhardwaj/dev/Even-CDMSS-rerank-telemetry
branch       exp/rerank-telemetry
HEAD         9185cb98d39e467f2463b06a3a889ae35303fef4
origin       9185cb9, in sync at the last fetch, 14 August 16:04
origin/main  81b7c93a8e5e0323a47a3f893fd4b0e96aaa421a, untouched
tree         clean
suite        3137 at 9185cb9, recorded not re-run
```

## 1. Why this pass is separate

Review 20 finds two High defects. Both are in code that passes 0a and 0b already touched. Both would
corrupt the twenty hard proofs if the proofs were written on top of them.

The migration defect leaves a table with no constraint if a statement fails part way. The settlement
defect lets a run settle clean when nobody checked whether it was clean. A proof written against
either would prove the wrong thing and would look green while doing it.

So this pass runs first, alone, with the full gate after each commit that changes code.

## 2. How the four commits divide, and why

| Commit | Contents | Runs |
|---|---|---|
| A | Track this addendum | now |
| B | Exclude `persisted_dirty`. One run per role. | now |
| C | Migration atomicity, both tables | now |
| D | Deliver the defect map. A missing own-role key settles partial. | **held for Saul** |

**D is one commit because its two halves cannot be separated.** Section 5 gives the reason: shipping
the missing-key rule without the map delivery changes production settlement for every failed audit,
immediately. B and C touch nothing D touches, so holding them buys nothing.

## 3. Correction. Review 20 finding 2 names the wrong cause.

**The finding is right about the harm and wrong about the mechanism.** This section records the
correction and asks Saul to rule on it. Commit D is not built until he does.

Finding 2 says the deterministic fallback at `lib/opd-note-audit.ts:1723` "returns without
`withHandle`, so persistence owners receive `{}`". The stated remedy is to route that return through
`withHandle`.

**The handle already reaches the owner on that path.** It travels through the
`onLifecycleHandleUpdated` callback, declared at `lib/opd-note-audit.ts:1309` and published by
`publishHandle` at `:1525`. The code states this at `:1716-1722` and calls it a rule, not an
omission:

```text
⚠️ NO HANDLE IS ATTACHED HERE, AND THAT IS D11's RULE, NOT AN OMISSION. The non-enumerable
property is "for the SUCCESS path"; every throwing path is covered by
`onLifecycleHandleUpdated`, which has already given the owner the latest handle — including
on this one, where the throw happened after declaration.
```

**What does not reach the owner is the defect map.** `attachRetrievalTelemetry` carries two fields,
`handle` and `manifestDefectsByRole` (`lib/retrieval-telemetry-store.ts:95-98`). The callback carries
one, the handle.

The owner's read is the same at all six sites:

```text
const defectsByRole = readRetrievalTelemetry(audit)?.manifestDefectsByRole ?? {};
```

On the fallback path that read returns null, so the owner passes an **empty map**, not no map, and
every declared role settles on the base outcome alone with nothing having checked it. That is the
harm finding 2 describes, reached by a different route.

**The stated remedy would break three committed tests.** That return is pinned as source text, not as
behaviour:

```text
lib/__tests__/vertex-primary-ladder.test.ts:304   pins the whole return statement, verbatim
lib/__tests__/opd-invalid-marking.test.ts:81      pins its tail, 'quietingGen: quietCfg.gen, llmLegFailed: true };'
lib/__tests__/pdqi9-fail-loud.test.ts:285         pins the return
```

Wrapping the return in `attachRetrievalTelemetry` rewrites the text and fails all three.

**Proposed ruling, for Saul.** `onLifecycleHandleUpdated` gains a trailing optional second parameter
carrying the defect map known at the moment of publication. Line 1723 is not touched. D11 holds,
because no handle is attached at the fallback return.

This is the same minimal-plumbing shape review 20 ratified for `settleOwned` in ruling 6.1: a
trailing optional parameter, no positional argument moved, omission compatible. Ten call sites supply
this callback across seven files, and none of them break, because a JavaScript caller ignores an
argument it does not name.

## 4. Commit B. Settlement corrections that stand alone.

**4.1 Exclude `persisted_dirty` from the base settlement input.** `SettlementInput.outcome` at
`lib/retrieval-settlement.ts:23-24` is typed `SettlementOutcome`, which includes `persisted_dirty`
(`lib/retrieval-telemetry-core.ts:949-954`). Addendum v1 line 523 requires
`Exclude<SettlementOutcome, 'persisted_dirty'>`. Apply it. `persisted_dirty` is derived inside
settlement by `upgradeForDefects` at `:187-192` and must never arrive pre-derived.

One test stops compiling. `lib/__tests__/retrieval-settlement.test.ts:193` passes
`outcome: 'persisted_dirty'` at line 200. It is a revision-0 test and its subject is unrelated to the
outcome value it happens to use.

**4.2 One run per role, on any handle that settles or writes.** `LifecycleHandle.runs` is a plain
array with no uniqueness rule (`lib/retrieval-telemetry-store.ts:40-46`). Two functions assume
uniqueness and disagree with each other:

```text
lib/retrieval-telemetry-store.ts:274   writeRetrievalTerminal takes the FIRST match, by find
lib/retrieval-telemetry-store.ts:371   advance updates EVERY match, by map
```

With two `primary` runs on one handle, one row is written and both revisions advance. Nothing reports
it.

**The guard does not go at declaration.** `declareNoteRuns` at `lib/retrieval-telemetry-store.ts:230`
maps every note in a batch to a run with role `primary` and declares them in one call, so a 30-note
batch produces one handle carrying 30 `primary` runs. That handle is discarded and only the run ids
are used, which is why nothing has broken yet. A declare-time guard would stop the worker. This is
what review 20 means by "without rejecting legitimate multi-row batch declarations".

The guard goes at the two functions that assume uniqueness.

In `settleRetrievalTelemetry`, a duplicate role is refused and reported, using the existing rejection
vocabulary at `lib/retrieval-telemetry-store.ts:53-56`. A sixth class is added. **It needs no
migration.** Rejection classes are a return value plus a free-text `error_class`, and `error_class`
carries no CHECK constraint in the generated DDL or in migration 0035. Verified in both artefacts. The
failure phase stays `persistence_link`, already in `TELEMETRY_FAILURE_PHASES` at
`lib/retrieval-telemetry-core.ts:307-310`.

In `writeRetrievalTerminal`, a duplicate role throws, matching the throw already at
`lib/retrieval-telemetry-store.ts:275` for a role with no declared run.

**What protects the throwing path is the revision, not the defect map.** An earlier draft of this
addendum claimed the missing-key rule in section 5 catches a role whose terminal write throws. **That
claim was wrong and is withdrawn.** The verdict keys are assigned before the writes that can throw,
at `:786` before `:787` and at `:802` before `:803`, so a role whose write throws still carries its
key. What keeps it from being linked is `expectedRevision` staying at zero, which sends it through
`stateForUnwrittenRun` at `lib/retrieval-settlement.ts:69`. That path is unchanged by this pass.

`PerRunSettlementResult.status` stays at three values. D12 fixes that union at
`lib/retrieval-telemetry-store.ts:58-72` and this pass does not extend it. The new class goes in
`rejection`.

## 5. Commit D. The map and the missing key. Held.

**5.1 Deliver the defect map on the failure path.**

`onLifecycleHandleUpdated` gains a trailing optional second parameter of type
`ManifestDefectsByRole`. `publishHandle` at `lib/opd-note-audit.ts:1525` gains the same and passes
the map built so far. The parameter type inside `writeRetrievalTerminals` at `:752` gains it too, or
the call sites will not typecheck. Those two call sites, at `:792` and `:808`, run after the primary
and normative verdicts are assigned at `:786` and `:802`, so each publication carries what is known
at that point. The two sites at `:1548` and `:1551` pass nothing; no map exists at declaration.

Every owner that both supplies the callback and settles must keep the last map the callback gave it,
and must prefer the map attached to the audit when one is attached. The attached map remains the
authority on the success path. The captured map is used only when nothing is attached.

The six read sites that must capture it:

```text
app/api/opd-audit/run/route.ts:89
app/api/opd-audit/worker/route.ts:187
app/api/opd-audit/worker/route.ts:326
app/api/admin/opd-audit-mini-backfill/route.ts:185
lib/mcp-tools.ts:895
scripts/bedrock-opd-note-probe.mjs:124
```

`lib/lab-batch.ts` and `scripts/metamorphic-llm-report.mjs` supply the callback and never read the
map. They settle without one. They are unchanged.

**5.2 A missing own-role key in a provided map settles partial.** At
`lib/retrieval-settlement.ts:61` the current line is:

```text
const roleDefects = input.manifestDefectsByRole?.[run.role] ?? [];
```

The `?? []` makes an absent key indistinguishable from a clean verdict.

The rule, stated exactly:

1. **No map provided at all** — behaviour unchanged. Review 20 says "a missing own-role key in a
   **provided** map". This preserves `lib/lab-batch.ts` and `scripts/metamorphic-llm-report.mjs`,
   which pass none.
2. **A map was provided and holds an entry for the run's role** — that entry decides, including an
   empty array, which means clean.
3. **A map was provided and holds no entry for the run's role** — the run does not settle clean.

Rule 3 reaches only roles on `handle.runs`, because settlement walks that array and nothing else can
settle.

**Apply the rule at lines 61 and 62 and leave the `linkable` branch at lines 68 and 69 alone.** A
role still at revision 0 keeps deciding its state through `stateForUnwrittenRun`, unchanged.

**5.3 Why 5.1 and 5.2 are one commit.** Rule 1 protects far less than it appears to. The six owners
in section 5.1 always pass a map, because their read ends in `?? {}`. On the failure path they pass
an empty map, which rule 3 treats as a missing key for every declared role.

So **if 5.2 ships without 5.1, every deterministic-fallback audit settles `persisted_partial` for
every declared role, on all six owners, from the moment it lands.** Saul's stated harm would be gone
and a new artefact would take its place, invisible afterwards because nothing records which partials
were artefacts. Shipped together, the owner has the real verdict and settles on evidence.

**5.4 A recorded limitation.** Where a verdict genuinely is missing, it is treated exactly as a
defective verdict, so both produce `persisted_dirty` and then `persisted_partial` through
`SETTLEMENT_STATE` at `lib/retrieval-telemetry-core.ts:969`. The stored state cannot afterwards tell
"no verdict" from "bad verdict". A distinct outcome value was considered and not proposed, because
adding one touches the settlement outcome vocabulary and this pass authorises no migration. If the C0
baseline needs the two separated, that is a later change with its own authorisation.

**5.5 Why this reverses a pass 0b acceptance property, and why it should.** Tests 1 and 2 in
`lib/__tests__/role-keyed-defects.test.ts:54` and `:65` assert that a defect in one role leaves the
other role clean. Both use a two-role handle and provide a map holding one key. Under rule 3 those
runs now settle partial. The isolation property itself is not weakened: a defect in one role still
never contaminates the other. What changes is that a declared role with no verdict stops counting as
evidence of cleanliness. The fixtures must be rewritten to write an explicit entry for every declared
role, which is what production code does at `:786` and `:802`. A fixture that does not look like
production hides real behaviour.

## 6. Commit C. Migration atomicity.

**6.1 One statement per table.** `retrievalTelemetryDdl()` at `lib/retrieval-telemetry-core.ts:1135`
returns 31 statements. Ten are constraint work, in five separate drop and add pairs:

```text
opd_audit_retrieval_telemetry      state_check_drop 1198     state_check 1202
                                   role_check_drop 1206      role_check 1212
                                   outcome_check_drop 1216   outcome_check 1222
opd_retrieval_telemetry_failures   rtf_phase_check_drop 1296 rtf_phase_check 1300
                                   rtf_run_check_drop 1304   rtf_run_check 1308
```

Both executors run these in a plain loop with no transaction:

```text
app/api/admin/migrate-retrieval-telemetry/route.ts:72-75
app/api/admin/telemetry-overhead/route.ts:298
```

Ten statements become two, one per table, each a single `ALTER TABLE` with a comma-separated action
list, in the form review 20 gives. Every standalone constraint DROP is removed. Both executors read
the same generator, so one change covers both. The statement count falls from 31 to 23 and the
migrate route's `steps` object shrinks by eight entries.

**The primary table is the more dangerous of the two.** Its `CREATE TABLE` at `:1140-1171` carries no
inline CHECK at all, deliberately, and says so at `:1128-1134`. The drop and add pair is the only
source of all three of its constraints. A failure between them leaves the table unconstrained, and
nothing later puts the constraint back. The failure table does carry its two inline.

**6.2 A property of the collapsed form the builder must know before running it.** PostgreSQL sorts
the subcommands of one `ALTER TABLE` into ordered passes. Drops run before adds. So dropping and
adding the same constraint name in one statement works, but it works because of pass ordering and
not because the actions run left to right. The whole statement takes one lock and validates the new
CHECK against existing rows inside it. That is the atomicity this commit is for, and it also means
one bad row now fails the entire replacement instead of leaving the table half constrained. This is
asserted from general knowledge and must be proven on the disposable database, not assumed.

**6.3 Keys.** The two new statement keys are `retrieval_checks` and `failure_checks`, matching the
existing `retrieval_table` and `failure_table`. Nothing outside the generator names any of the six
primary keys. Only `lib/__tests__/pass-0a-corrections.test.ts` names any of the four failure keys,
and it names all four. No other code and no document names any of the ten.

**6.4 Migration 0035.** `migrations/0035_opd_audit_retrieval_telemetry.sql` mirrors the generated DDL
and is held in parity by test. It carries the same split shape at lines 142 to 164 and 261 to 267,
and no `BEGIN;` or `COMMIT;`. It collapses identically, or parity fails.

**6.5 Parity is upgraded to ordered.** The parity test compares normalised statement strings as sets
in both directions plus an equal count. It does not compare order. Review 20 requires exact ordered
parity. The comparison becomes element by element, in order.

**If the two sides are not already in the same order, the builder stops and reports it. It does not
reorder the mirror to make the test pass.**

**6.6 The report must not overclaim.** Each table's constraint replacement becomes atomic. The
migration route does not become transactional. The build report says exactly that and no more.

**6.7 Proofs on a disposable database.** Old-schema upgrade, rerun, rollback on invalid data, and the
final constraint definitions. Not on production. Not on any branch of production.

## 7. What this pass does not do

It deploys nothing and migrates nothing. It runs no canary. It changes no ranking behaviour, no
scoring path, no engine version and no `RERANK_BACKEND`. It does not collapse the duplicated
`RERANK_SEED_STATUSES`, which review 20 places in the first hard-proof pass that covers both core and
capture. It does not begin the twenty hard proofs. It does not close pass 0b, which review 20 keeps
open until these corrections land.

It does not prove `neondb_owner`. That check is owed before any production migration and belongs to
the operator, not to this pass.

## 8. Consequences to record, not discover

Every one of these is a known break. The builder that finds them has found nothing new, and a report
that presents them as discoveries has misread this section.

**Commit B:**

```text
lib/__tests__/retrieval-settlement.test.ts:193   passes 'persisted_dirty' at line 200, stops compiling
lib/__tests__/retrieval-settlement.test.ts:227   enumerates exactly five rejection classes, gains a sixth
```

Watch `retrieval-settlement.test.ts:51`, which hand-types the `persisted_dirty` state mapping at line
56. It iterates the outcome list and should still compile. If it does not, report it rather than
widening the type.

**Commit C:**

```text
lib/__tests__/pass-0a-corrections.test.ts:35, :51, :61, :69, :82, :103
lib/__tests__/migrate-retrieval-telemetry-parity.test.ts:68, :119, :148
```

`pass-0a-corrections.test.ts` reads the four failure keys directly at `:40-43`, `:52-54` and `:62-66`,
and asserts four ALTER statements at `:95`. `migrate-retrieval-telemetry-parity.test.ts:80` asserts a
floor of 25 statements and the count falls to 23. `:157-163` requires a DROP before each ADD, which
one statement cannot satisfy. `:126` counts quotation marks in the isolated role-check statement to
prove it names exactly five roles, and a combined statement carries three constraints' values, so
that assertion needs a different anchor and must keep proving what it proved.

**Commit D:**

```text
lib/__tests__/role-keyed-defects.test.ts:54, :65, :100, :212, :230
```

`:216` pins the exact source text of line 61 and must pin the new text. `:151`, test 5c, survives if
the rule is applied at lines 61 and 62 and fails if it is applied after the linkable branch. `:117`,
test 5, passes no map at all and must keep passing unchanged; it is the direct test of rule 1.

**Tests that must not change.** `lib/__tests__/vertex-primary-ladder.test.ts:304`,
`lib/__tests__/opd-invalid-marking.test.ts:81` and `lib/__tests__/pdqi9-fail-loud.test.ts:285` pin
the fallback return. If any fails, the pass has touched line 1723 and has left its scope.

**The suite total changes.** It stood at 3137 at `9185cb9`. Tests are added and rewritten, so the
number moves. Report the count. Do not preregister one; addendum v1 line 325 forbids it.

**One open question, flagged not decided.** The owner list at
`lib/__tests__/role-keyed-defects.test.ts:189-195` names five files while its comment says "ALL SIX
OWNERS". There are six read sites across five files, because `worker/route.ts` appears twice. The
comment may be counting sites. This addendum does not rule on it and does not commission a change.

## 9. Carried forward from review 20, without change

Ruling 6.1 is ratified and closes an open decision. The trailing optional fourth parameter to
`settleOwned` stands. `outcomeForOwnedSave` stays a pure save-result mapper. `upgradeForDefects`
stays separate. The defects map does not move into `LifecycleHandle`. `settleOwned` is not rewritten
into an object-form API.

The early deletion of the `telemetry-measure` Neon branch is accepted. The temporary measurement
route and its guard may be deleted before 20 August; that date is a deadline, not a waiting period.
Measurement revision 3, the `sin1` costing and fixed-pool archiver preparation may proceed in
parallel with this pass.

## 10. What this addendum does not do

It does not reopen decision D4, the guardrails, the test reduction, the window-closure wording, the
ladder, or any section of v1 through v8. It authorises no deploy, no migration, no canary, and no
change to `RERANK_BACKEND` or `JUDGE_BATCH`. It does not admit telemetry to production.

## 11. Acceptance

```text
Accepted by:
Date:
Sections accepted:
Sections amended, with the amendment:
Saul's ruling on section 3:
```

Section 3 records a correction to review 20's own finding. It is written as a proposal and not as a
settled decision. Commit D, section 5 in full, is held until Saul rules on it. Commits A, B and C
stand on review 20 as written and need only V's signature.

Two claims in an earlier draft of this addendum were wrong and are corrected here rather than
quietly removed. The first said the six owners call `settleOwned` without a map on the failure path;
they pass an empty map, and section 5.3 records what follows from that. The second said the
missing-key rule catches a role whose terminal write throws; section 4.2 records the withdrawal and
names what actually protects that path.
