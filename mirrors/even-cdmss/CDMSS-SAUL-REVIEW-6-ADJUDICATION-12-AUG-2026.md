# Adjudication: Saul review 6a and 6b

**12 August 2026.** Against `177adc9`. Every ruling below was checked against the tree by two adversarial subagents on Opus, with the disprove rule. The ruling is mine.

Outcome: kickoff version 1 is superseded. Version 2 is `CDMSS-RERANK-TELEMETRY-STEPS-14-17-CC-KICKOFF-v2-12-AUG-2026.md`.

---

## 1. Reply 6b, the eight blocking findings

| # | Finding | Code claim | Defect against the documents | Where it lands |
|---|---|---|---|---|
| 1 | Settlement reports rejected writes as settled | CONFIRMED | **YES** for revision-0, against D9 line 574. Documents silent on the general `rejected` mapping | v2 section 2.1 |
| 2 | Clean versus partial "not implementable" | CONFIRMED as code | **NO.** Unimplemented, not unimplementable. D17 gives three criteria and D12 places the caller at `onPersisted`, which does not exist. The per-role half is real and unspecified | v2 sections 2.1 and 7.2 |
| 3 | `closeInvocation` has no production owner | CONFIRMED, zero callers | **DOCUMENTS SILENT.** Every kickoff mention is DDL. D9's matrix assigns settlement outcomes, not closure. No step assigns it | v2 section 7.1, for V |
| 4a | Duplicate roles on one handle, first-role selection | CONFIRMED | **NO.** D10 threads predeclared ids per note; `opd-note-audit.ts:1519` builds a fresh single-role handle. A latent trap, not a specified defect | noted, not scoped |
| 4b | `pairId` and `replicate` dropped | CONFIRMED | Narrower than stated. `COLUMN_CLASSIFICATION` puts both in `mutable_terminal`, so absence from the declaration insert is consistent. The real defect is that `DeclareInput` advertises two inputs no writer consumes | v2 section 2.5 |
| 4c | Counts requested rows, not inserts | CONFIRMED | **YES**, against D11 line 681 and the callee's own contract | v2 section 2.2 |
| 4d | No `work_declaration` failure evidence | CONFIRMED | **YES**, against test 29 and D13 line 742 | v2 section 2.3 |
| 5 | Terminal writes lack lost-acknowledgement recovery | CONFIRMED as code | **NO, and the fix is forbidden at that site.** D12: "rejected and logged on mismatch, never retried blindly." Reread-and-compare appears once, at kickoff line 748, inside D13, governing the reconciler | v2 section 3, rejected |
| 6 | Reconciler contract incomplete | Correct | It is step 17, unbuilt. Naming the D13 elements is a fair ask | v2 section 6 |
| 7 | MCP multi-query exposes invalid manifests | CONFIRMED on five links, **one link wrong** | **YES**, and worse than stated. Nothing rejects the null at runtime: `validateManifest` returns a `string[]`, no production code calls it, the column is nullable with no CHECK. A null `index_version` row would be written and stored silently. D17 forbids null. This build makes it reachable by wiring `lib/mcp-tools.ts` | v2 section 2.4 |
| 8 | Test 57 structurally unsound, use an AST oracle | CONFIRMED | **YES.** And the approach needs no dependency: `typescript` 5.9.3 is a devDependency, resolves from `lib/__tests__/`, and type-checks under this repository's own flags. Verified with a probe in scratch, not assumed | v2 section 0 |

**Six of eight adopted. One rejected outright, finding 5. One accepted with its framing corrected, finding 2.**

Finding 5 matters. It asks the build to add behavior that D12 explicitly forbids at that call site. Building it would have been a silent amendment to a governing document. The harm the finding describes is real and it is closed by fixing settlement instead.

---

## 2. Reply 6b, the brief amendments

**File authorization list. Adopted, and it was my error.** Version 1's edit list named only the untouched section 4 files. The build has to edit the stores it wrote. Version 2 section 4 carries the full list.

**Missing test files. Adopted.** Version 2 section 4 names eight to create.

**"Steps 19 to 22 are out of scope." Withdrawn, and it was my error.** Step 20 is tests and step 22 is the report, and version 1 demanded both in its own sections 4 and 6. Corrected scope: 19 deferred, 20 in scope for the named subset, 21 deferred, 22 in scope. The partial-continuation language is adopted.

**Two stop conditions for V. Adopted, both.** Version 2 section 7. The A/A one is narrowed: bind the fields where the classification puts them, add a bound-parameter test, and do not invent values. What goes in `pair_id` and `replicate` is an A/A question and V has not opened A/A.

---

## 3. Reply 6a, two corrections to my verdict. Both land.

**3.1 "`terminalOutcomeFor` is the only reader of the new evidence on the retrieval path." Wrong as written.**

Seven consumers read the transport attribution or failure attribution. Three are on the retrieval path: `evidenceFromCompletion` at `lib/retrieval-capture.ts:67`, `evidenceFromError` at `:80`, and `terminalOutcomeFor` at `lib/rerank.ts:392`. Four more read the evidence afterwards during manifest build.

The clause that survives: none of them influences an order, a threshold, a slice or a score. In `rerank.ts` the evidence is a batch-local assigned at `:460` and `:501` and consumed at `:503`; `scores[]` is filled at `:483` from the parsed judge JSON, and the sort reads `scores`, never the evidence. Saul concedes this half.

The defensible version of my sentence: `terminalOutcomeFor` is the only function that reads a `TransportEvidence` value while the retrieval is still running and turns it into a recorded fact.

**3.2 "Two false sentences compiled into running code." Wrong, and my correction to the report was itself the error.**

`lib/telemetry-key-guard.ts` had no importer at `90d8db1`. It is in the `tsc --noEmit` include set, so it is type-checked, but Next bundles by module graph and a module no entry point imports is never emitted or evaluated. Type-checked is not running.

And on a literal reading, neither `next.config.mjs:8` nor `telemetry-key-guard.ts:10` is compiled into anything. Both are comment lines. The defensible framing is Saul's: one of the two files is evaluated build configuration and the other was not evaluated at all. One, not two.

**3.3 Numbers.** Saul's 14 call sites, 89,301 registry bytes, 908,045 ms, and the CHECK slice stopping one character short all match what I already recorded. His 23 removed and 76 added is confirmed, and section 15.1 of the report is internally inconsistent by exactly one line: the block lists 76, the header sums to 77. The extra line is a comment at `retrieval-telemetry-core.test.ts:108` containing the substring `assert.deepEqual`.

---

## 4. Where this leaves the branch

Unchanged by this review. `177adc9`, partial. Steps 14 and 15 partial, 16 and 17 unbuilt, 50 named tests absent, overhead unmeasured, test 57 holed.

Saul's decision to keep the branch classified as partial and not use it for a canary matches the standing position. No canary date is proposed. The A/A pilot is not started. Nothing beyond steps 14 to 17 is prepared.

Saul's suggestion of an errata addendum rather than another rewrite of the thousand-line report matches my own ruling from the correction verdict. That decision is still V's and is not taken here.
