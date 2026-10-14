# CDMSS rerank telemetry: addendum v11, the prospective proof-pass addendum

**15 August 2026.** Signed, prospective. It authorises the proof programme and nothing else.

**SIGNED by V on 15 August 2026 at 20:11 IST, all sections in full, without amendment. See section 12.**

## 0. Authority and scope

Continues addendum v10. Governs all work after `15d5e8f` on `exp/rerank-telemetry`.

Saul's review 22 declined the first proof pass 1 kickoff and required a signed prospective addendum
before any further production-code change. This is that document. **No proof pass may be issued
until this addendum is committed.**

Preserved and unedited. **v9 alone is unsigned, and stays unsigned.** v10, v8 and v7 are signed and
are equally never edited.

```text
v9   unsigned  9e04cf1052a8373102374068f691826eb204e09e   08ab334d434084cfa3259f38babe2a8d5bc0b3b6cbf94b3790ad58d5a989efbb
v10  signed    5279cfa                                    c052c710a4a95c1cc4c819281c6f097e7f61eee7c638a5f000a79766f24cb185
v8   signed                                               ac48e66562ba0859669c18b589fa613000f09ac33f6f611482c7a2ab13e13e56
v7   signed                                               0e05f4b006fb90e9d9c31cd476577f8df06eb333265db60e1e70a760bdbf8682
```

## 1. The gate. It is nine commands, and it was not run.

**Finding, recorded because it was ours.** Commits B `f21dd7e`, C `f8b7c13` and D `15d5e8f` each ran
three gate commands. The governing gate is nine, defined at
`CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md:1191-1212` and repeated with the
keyed-build clause at `CDMSS-RERANK-TELEMETRY-ADDENDUM-v1-13-AUG-2026.md:496-512`.

Addendum v10 section 6 step 5 says only `run the complete gate`. **It names no gate and defines
none** — the word "gate" appears once in the whole of v10, on that line. The kickoffs that drove
those three commits then defined it as three commands. **Both faults are the orchestration thread's:
a governing document that pointed nowhere, and a kickoff that filled the gap wrongly. Neither is a
builder error.**

**Remedy, executed 15 August, verified not inferred.** All nine were run at HEAD, and the six that
had been skipped were also run at `f21dd7e` and at `f8b7c13` by detached checkout.

```text
4  architecture:check      PASS   8 rules and coverage green, 39 subsystems
5  architecture:map        PASS   regenerated lib/architecture/map.generated.ts
6  map determinism diff    PASS   exit 0, byte-identical after regeneration
7  reasoning:registry+diff PASS   30 prompts, 7 rubrics, 36 builders, 19 features, diff exit 0
8  reasoning:governance    PASS   0 ungoverned model calls
9  changelog:coverage      PASS   19 shipped engine versions documented
1  npm test                PASS   3159 pass, 0 fail
2  npm run typecheck       PASS   clean
3  npm run build           PASS   127 static pages
   unkeyed production build FAILS and names CDMSS_TELEMETRY_HMAC_KEY, as required
   keyed production build   succeeds

B  f21dd7e   all six skipped commands PASS
C  f8b7c13   all six skipped commands PASS
D  15d5e8f   all six PASS, plus the three already run
```

Neither generator modified its file, so nothing was regenerated into the tree and no restore was
needed. **No commit is retroactively invalidated. Nothing is re-run and nothing is amended.**

**Owed, and owed because of this workstream's own rule.** The results above are the builder's report.
Nothing on disk attests them, and a measurement is not taken until its raw output is saved. **The
governance commit that tracks this addendum also carries the raw gate output as an evidence file, and
that file's SHA-256 goes in the commit message.** Until then, section 1 is a claim and not a record.

**The complete gate is nine commands plus the keyed and unkeyed build split. Every proof pass runs
all of it. No kickoff may redefine it.**

## 2. Erratum. Proof 14 lands completely.

The Stage 0a completion plan of 15 August recorded that `labRetrieve` in `lib/mcp-tools.ts` is not
instrumented, and proposed that proof 14 land partial. **That was wrong.**

`labRetrieve` is fully instrumented at HEAD: capture and declaration at `lib/mcp-tools.ts:1140-1156`,
terminal write at `:1172` and settlement at `:1173` inside `finish()`, which runs `:1161-1174`, and
both catch arms recording `retrieval_failure` before the fork at `:1224-1238`. `defaultRecall`'s
reads are instrumented at `lib/lvc.ts:264-276`, and the semantic leg at `:287-295`.

The error was citing `CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md:3751` and `:3768`, which
describe the commit range `fc28e0f..90d8db1`. Those two lines were written on 12 August.
`lib/mcp-tools.ts` was instrumented later the same day, by `e5dc756` at 14:17 IST. **The report was
three days out of date when it was cited, and the decision taken on it is void.**

**Proof 14 lands completely, as review 22 requires. A partial proof cannot close Stage 0a.**

## 3. Correction to Saul's review 22, item 2

Review 22 requires attempt outcomes to be validated in three manifest locations. **None of the three
is validated today. All three are new work.**

```text
expansion attempts       core:707   PRESENCE only — `expansion_attempts_field_absent`
rerank batch attempts    core:765   PRESENCE only — `batch_attempts_field_absent`
variant-generation       core:487   typed, populated at lib/retrieval-capture.ts:366,
attempts                            not reached by validateManifest at all
```

The first two check that the field exists. **Neither reads an attempt's `outcome`.** The only place
in the file that touches `a.outcome` is the counter at `:877`, which is not validation.
`validateManifest`'s multi-query block at `:813-834` checks `status`, `served_route_class`,
`generated_variant_count` and variant arity, and never touches `vg.attempts`.

So the count of attempt-outcome validation today is zero of three, which is what section 4 item 3
assumes when it says the validator gains one branch per location, all three.

## 4. Prospectively authorised. The attempt-outcome validator.

1. `TRANSPORT_ATTEMPT_OUTCOMES` becomes the runtime authority, declared in
   `lib/transport-attribution-core.ts`, with `TransportAttemptOutcome` derived from it. Values
   unchanged.
2. `ManifestAttempt.outcome` **stays `string`**. Review 22 item 3. The runtime branch is the
   contract; a compile-time narrowing does not stop a value arriving from JSONB.
3. `validateManifest` gains one branch per location, all three, with the stable defect name
   `attempt_outcome_absent_or_invalid`.
4. `lib/retrieval-telemetry-core.ts` may import from `lib/transport-attribution-core.ts`. **No cycle
   is possible**: the core imports only `node:crypto`, and transport-attribution-core imports
   nothing at all.

**Fixtures made dirty by this branch are found and corrected in the same pass, and every one is named
in the report.** The branch is not weakened to accommodate a fixture.

## 5. Prospectively authorised. The architecture map.

`lib/architecture/map.generated.ts` is regenerated and committed in pass 1. The new core-to-transport
import adds the first outbound edge `retrieval-telemetry-core` has ever had, so the edge list changes.
Both modules are already nodes; the module list does not change.

Gate commands 5 and 6 prove the regeneration is deterministic.

## 6. Prospectively authorised. The two D16 payload corrections.

Both are durable telemetry changes. Neither affects ranking or provider behaviour. **Both land in
pass 3, before proof 35, not before.**

**6.1 A skipped stage records `attempts: []`, not `null`.** Today `lib/retrieval-capture.ts:309`
emits `null` when `expansionSkipped`, and `manifestAttempts` itself returns `null` for absent
evidence at `:122-123`.

**6.2 A variant-generation stage that ran and failed without transport proof records
`unattributed`.** Today `lib/retrieval-capture.ts:364` reads `vg && ev ? servedClassOf(ev) : null`,
and `ev` is null on that path because `evidenceFromError` returns null without attribution. So a
stage that genuinely ran is recorded identically to a stage that never ran. **Only a stage that did
not run records stage-level `null`.**

The parse path already behaves correctly and is not changed: `lib/multi-query.ts:99-112` preserves
provider, model, attempts and both token counts.

## 7. Prospectively authorised. The seed-status collapse.

Core becomes authoritative for `RERANK_SEED_STATUSES`. Capture re-exports **the same object**.
Identity is tested with `strictEqual`, not deep equality alone, so a future re-declaration fails.
`RerankSeedStatus` moves with the const, so `lib/rerank.ts:21` needs no change.

The detached JSDoc at `lib/retrieval-capture.ts:86-93` is reattached to `servedClassOf`, and its
false promise of a `null` return is corrected: the null is produced by the callers at
`lib/retrieval-capture.ts:307` and `:364`, not by the function.

## 8. Prospectively authorised in principle. The lifecycle test seam.

Pass 4 may add a narrow default-preserving fault-injection seam if proofs 21 to 24 cannot be executed
without one. **It has no production caller and is never consulted on the default path.** If pass 4
needs it, its exact shape is specified in that pass's kickoff and reported.

## 9. The canonical J1 to J6 contract

**Adopted prospectively on Saul's review 22. This is not recovered text and is not described as
such.** It supersedes an earlier reconstruction, `CDMSS-EXPLICIT-JUDGE-PROOFS-DRAFT-FOR-SAUL-15-AUG-2026.md`,
which lives in the handoff folder, is not in this repository, and is now background only. **Where
that draft and this section differ, this section governs.**

**J1.** Explicit judge and environment-default judge must produce byte-identical serialized results,
canonical telemetry payloads, and outbound judge requests under deterministic collaborators. Cover
success, real batch parse failure, and generic outer judge failure. **No field differences are
permitted.**

**J2.** Explicit judge invokes neither `checkHealthy` nor `cohereFn`, under judge or hostile Cohere
defaults, on success or failure. **This is call-local; an earlier memoized probe is irrelevant.**

**J3.** Execute `retrieve` under a hostile Cohere default. The omitted-backend control must
demonstrate Cohere intent and downgrade; the explicit-judge arm must show zero Cohere consultation,
judge intent, judge service, no downgrade, nonzero batches, and actual reordering.

**J4.** `retrieveMultiQuery` keeps reranking off on every retrieval arm and performs exactly one
fusion-level rerank with third argument `'judge'`. **Expansion is independent and must not be claimed
to "agree" on a rerank backend.**

**J5.** Assignment persists across retries. Deferred to the Treatment Protocol.

**J6.** Assignment persists across redeployments. Deferred to the Treatment Protocol.

Use the real local judge server for J1, J3 and J4, and injected call counters for J2.

## 10. The revised five passes

| Pass | Contents |
|---|---|
| 1 | proofs 11 and 12, the seed collapse, attempt validation in all three locations |
| 2 | proofs 2, 16, 17, 18, 70, plus J1 to J4 |
| 3 | proofs 35, 45, 46, 47, 49, 56, plus the two D16 payload corrections |
| 4 | proofs 21 to 24, with the section 8 seam if execution requires it |
| 5 | proofs 10, 14 and 44 |

Twenty proofs, all landing complete. Four executable judge proofs. The complete gate after every
pass, and a review before the next begins.

**Pass 1 constraints, from review 22.** Prove timeout with a test-local method mock, never an
external host or a wall-clock timeout. Start the judge server before dynamically importing `rerank`,
`multi-query`, `llm` or any transitive consumer. Replace the adjacent-pair formulation with this
executable matrix:

```text
timeout error                    → timeout
generic exhausted transport      → terminal_failure
malformed completion             → parse_failure
missing + nonnumeric keys        → missing_score_key, both counts preserved
finite + nonnumeric keys         → nonnumeric_score
all finite keys                  → success
```

## 11. Correction. Deploy precedes migrate.

The Stage 0a completion plan put the migration before deployment authorisation. **That order is
invalid.** The migration route is a deployed application handler at
`app/api/admin/migrate-retrieval-telemetry/route.ts`, and its own header at `:14-17` records that no
migration runner exists in this repository. The route does not exist in production until the
deployment exists.

The corrected order, from review 22:

```text
1  20 of 20 hard proofs, 4 of 4 executable judge proofs
2  a signed closing evidence ledger: test names, SHAs, gate results
3  the replacement qualifying measurements and all five guardrails
4  verify the production HMAC key and the database role
5  V authorises deployment
6  deploy
7  run the migration route ONCE, inspect `steps`, stop on any 409 or non-`ok:true`
8  Stage 0b begins only after successful migration verification
```

## 12. Acceptance

```text
Accepted by:                          V
Date and time:                        15 August 2026, 19:54 IST
Sections accepted:                    all, in full
Sections amended, with the amendment: none
Saul's review 22:                     accepted in full, without amendment
```

## 13. What this addendum does not do

It authorises no deploy, no migration, no canary, no ranking change and no Cohere change. It does not
touch `RERANK_BACKEND` or `JUDGE_BATCH`. It does not reopen decision D4, the guardrails, the ladder,
or any section of v1 through v10. It does not close Stage 0a. It does not export `JUDGE_BATCH`,
`judgeBatchBoundaries`, `terminalOutcomeFor` or `manifestAttempts`. It does not extract a batch-outcome
precedence resolver, which remains later work with its own specification.
