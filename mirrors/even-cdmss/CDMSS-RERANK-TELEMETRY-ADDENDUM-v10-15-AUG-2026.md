# CDMSS rerank telemetry: addendum v10, the governance addendum for the pre-proof pass

**15 August 2026.** Signed. It ratifies two commits that have run, authorises one that has not, and
records four rulings.

**SIGNED by V on 15 August 2026 at 16:41 IST, all sections in full, without amendment. See section 8.**

## 0. Authority and scope

Continues addendum v9. Governs all work after `f8b7c13` on `exp/rerank-telemetry`.

This addendum exists because addendum v9 was tracked before it was signed. Saul's review 21, ruling
4, forbids editing or signing v9 after the fact and requires a signed v10 instead. This is that
document.

**v9 is preserved, unsigned, exactly as it stands:**

```text
commit   9e04cf1052a8373102374068f691826eb204e09e
SHA-256  08ab334d434084cfa3259f38babe2a8d5bc0b3b6cbf94b3790ad58d5a989efbb
```

v9 is never edited and never signed. Its acceptance block stays empty. Where v9 and this addendum
conflict, this addendum governs.

v8's SHA-256 is `ac48e66562ba0859669c18b589fa613000f09ac33f6f611482c7a2ab13e13e56`. v7's is
`0e05f4b006fb90e9d9c31cd476577f8df06eb333265db60e1e70a760bdbf8682`. Neither is edited.

## 1. The chronology, stated plainly and not backdated

v9's text was written on 15 August, before commits B and C ran. It was tracked as commit A and was
never prospectively signed, because the kickoff that drove the work sequenced tracking before
signature. That was an ordering error by the orchestration thread and it is recorded here rather
than repaired in place.

So the true order of events was:

```text
1  v9 written, unsigned
2  A  9e04cf1  v9 tracked, unsigned, and its commit message says so
3  B  f21dd7e  ran under v9's text and V's kickoff instruction, unratified
4  C  f8b7c13  ran under v9's text and V's kickoff instruction, unratified
5  Saul's review 21
6  this addendum, signed
7  D            authorised prospectively by this addendum, not yet run
```

Commits B and C are **ratified retrospectively by this addendum, on 15 August 2026, and are not
backdated.** They were correct work performed without a signature in hand. They stay unchanged.

## 2. Ratification of commit B, `f21dd7e`

"One run per role, and a base outcome that cannot arrive pre-derived."

`SettlementInput.outcome` is now `Exclude<SettlementOutcome, 'persisted_dirty'>`, per addendum v1
line 523. `settleOwned`, `outcomeForOwnedSave` and the derivation helpers narrow with it.

A sixth settlement rejection class, `duplicate_role_on_handle`, guards the two functions that assume
role uniqueness and disagreed about it: `writeRetrievalTerminal` took the first match by `find`,
`advance` updated every match by `map`. Settlement refuses and reports the duplicate. The terminal
write throws, as it already did for an undeclared role. The guard is not at declaration, because a
batch legitimately declares one `primary` run per note.

No migration. `error_class` carries no CHECK constraint in the generated DDL or in migration 0035.
`PerRunSettlementResult.status` keeps its present three values and gains none. The code records at
`lib/retrieval-telemetry-store.ts:75` that D12 fixed that union at two and that `rejected` was added
as a third deliberately, against it. The new class goes in `rejection`, and the union is not extended
again.

**Ratified.**

## 3. Ratification of commit C, `f8b7c13`

"One constraint statement per table, so a half-applied replacement cannot exist."

Ten constraint statements became two. The DDL fell from 31 statements to 23. Every standalone
constraint DROP is gone. Migration 0035 mirrors both statements exactly and the parity test now
compares element by element, in order.

**Ruling 2 of review 21 is recorded here. The grouped form stands.** All DROPs are followed by all
ADDs inside one `ALTER TABLE` per table. PostgreSQL executes ALTER subcommands in internal passes
with constraint drops before additions, whatever the textual interleaving, so the grouped form
describes the real behaviour more honestly than the interleaved example in review 20 ruling 6.2.

**The claim this pass may make, and the only one:**

> Each table's constraint replacement is atomic.

**The claim it may not make:** that the 23-statement migration route is transactional. It is not. The
route applies statements in a plain loop with no transaction.

Independent verification against the git objects, not against the builder's report: the commit chain,
`lib/opd-note-audit.ts` untouched across all three commits, 23 statements counted from the generator,
no standalone DROP in the generator or in 0035, no `BEGIN` or `COMMIT` in 0035, and every CHECK body
character-identical before and after. `OUTCOME_REQUIRED_STATES`, `OUTCOME_EITHER_STATES` and
`RUN_SCOPED_FAILURE_PHASES` all pre-existed at `9185cb9`, so no value list was rewritten in passing.

**Ratified.**

## 4. Erratum. v9 section 8 omitted an induced test adaptation.

**Ruling 3 of review 21.** `lib/__tests__/retrieval-telemetry-core.test.ts` was outside v9's file
contract and outside its list of known breaks. It had to change: `constraintBody` bounded its slice at
the next semicolon, which was correct only while each ADD was its own statement. Collapsed, the state
CHECK's slice swallowed the role and outcome CHECKs. The semicolon bound sat at line 97 before commit
C; the replacement function begins at line 107 after it.

The replacement bounds the slice on the CHECK's own matching parenthesis and adds a guard that a
sibling constraint's name never appears inside a slice. It preserves the original assertion and
strengthens it.

**The omission was the orchestration thread's, not the builder's, and the builder flagged the file
rather than editing it quietly.** The file stands in commit C. It is not removed, not split out, and
commit C is not rewritten.

## 5. Commit D, authorised prospectively

**Ruling 1 of review 21 accepts the correction in v9 section 3.** The deterministic fallback already
delivers the latest handle through `onLifecycleHandleUpdated`; only the role-keyed defect map is
lost. **Line 1723 is not wrapped with `withHandle`.**

Commit D is authorised, and only commit D, under these requirements. They govern where v9 section 5
is thinner.

1. `onLifecycleHandleUpdated` gains a trailing optional `manifestDefectsByRole` argument.
2. Declaration publications pass no map.
3. Terminal publications pass **shallow snapshots** of the map known at that moment, not the live
   object.
4. Owners prefer the final attached map, then the callback-captured map.
5. **If neither exists, `undefined` is preserved. Every owner-side `?? {}` is removed.**
6. A provided map missing the run's own key settles a **linkable** clean run as partial.
7. No map at all remains backward compatible and clean.
8. An explicit own-role `[]` remains clean.
9. Revision-zero roles continue through `stateForUnwrittenRun` and are never linked by this rule.
10. Own-property checks, so an inherited key does not count as a verdict.
11. The deterministic fallback return and its three source pins stay unchanged.

**Sections 5.1 and 5.2 of v9 land in one commit.** The plumbing could technically land first. The
missing-key rule must never be deployable or cherry-pickable without it.

**The file contract gains one comment-only correction, expressly permitted by ruling 1.**
`lib/retrieval-telemetry-store.ts:97` currently states that a missing key and an empty array both
settle clean. That becomes false under requirement 6. The same false claim sits at
`lib/retrieval-settlement.ts:84`, in a file commit D edits anyway.

**The type at `lib/retrieval-telemetry-store.ts:110` stays required.** `RetrievalTelemetryOutcome`
declares `manifestDefectsByRole` as a required field, so an attached outcome always carries a map,
`{}` when no terminal write ran. Requirement 5 is still met, because an owner's
`readRetrievalTelemetry(...)?.manifestDefectsByRole` already yields `undefined` when nothing is
attached. What requirement 5 cannot express through the attached channel is "instrumented, and no
verdict". Requirement 9 covers that case: a run that never had a terminal write stays at revision
zero and is never linked. The trace is in the commit D kickoff and must be confirmed in the build
report. Making the field optional was considered and is not authorised here; it would take the store
file beyond a comment-only change.

**Why requirement 5 matters more than it looks.** All six owner sites read
`readRetrievalTelemetry(...)?.manifestDefectsByRole ?? {}`. While that `?? {}` stands, an owner never
passes "no map"; it passes an empty map, which requirement 6 reads as a missing key for every
declared role. Removing it is what makes requirement 7 reachable rather than decorative.

## 6. The sequence, as ruled

```text
1  write v10 and have V sign it                          this document
2  commit v10 and its .gitignore exception, and nothing else
3  begin commit D only after that governance commit
4  land callback delivery, owner selection, missing-key semantics, comments and tests together
5  run the complete gate
6  continue to the twenty hard proofs and the four executable explicit-judge proofs
```

The governance commit carries v9's unchanged hash and blob, and this document's final SHA-256, in its
message.

## 7. What this addendum does not do

It authorises no deploy, no migration, no canary, no ranking change and no Cohere change. It does not
touch `RERANK_BACKEND` or `JUDGE_BATCH`. It does not reopen decision D4, the guardrails, the test
reduction, the window-closure wording, or the ladder.

It does not close Stage 0a. Stage 0a stays open until commit D, the twenty hard proofs and the four
executable explicit-judge proofs are complete.

It does not collapse the duplicated `RERANK_SEED_STATUSES`, which belongs to the first hard-proof pass
that covers both core and capture.

It does not prove `neondb_owner`. That is owed before any production migration and belongs to the
operator.

## 8. Acceptance

```text
Accepted by:                          V
Date and time:                        15 August 2026, 16:41 IST
Sections accepted:                    all, in full
Sections amended, with the amendment: none
Saul's review 21:                     rulings 1, 2, 3 and 4 accepted in full, without amendment
```

Accepted in full and without amendment. This addendum is in force and governs all work after
`f8b7c13`. Commits B and C are ratified as they stand. Commit D is authorised and nothing else is.
