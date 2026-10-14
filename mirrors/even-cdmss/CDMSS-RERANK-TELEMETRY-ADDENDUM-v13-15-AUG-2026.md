# CDMSS rerank telemetry: addendum v13, the pass 1a ratification and the final cleanup

**15 August 2026.** Signed, narrow. It ratifies a deviation retrospectively and authorises two
commits.

**SIGNED by V on 15 August 2026 at 21:54 IST, all sections in full, without amendment. See section 8.**

## 0. Authority and scope

Continues addendum v12. Governs all work after `75b3367` on `exp/rerank-telemetry`.

Saul's review 24 finds proofs 11 and 12 still open, on four blockers and one governance deviation.
This addendum ratifies the deviation, records it as a deviation, and authorises the final correction.

Preserved and unedited. v9 alone is unsigned.

```text
v9   unsigned  08ab334d434084cfa3259f38babe2a8d5bc0b3b6cbf94b3790ad58d5a989efbb
v10  signed    c052c710a4a95c1cc4c819281c6f097e7f61eee7c638a5f000a79766f24cb185
v11  signed    cf387871a80a019318cdf8cbff620790052cc372d6a89f5fd7b0e954a3ccaf98
v12  signed    7edf6dfed79a9897ee4675dc00e5189c7580c3a6954aba3f606b1a89df3e52c9
```

## 1. The deviation, stated plainly

**Addendum v12 authorised one corrective commit.** Its opening line: "It authorises one corrective
commit and nothing else." The work landed as two, `0c9ad85` and `75b3367`.

**The cause was a contradiction between two documents written by the same hand on the same day.** v12
said one commit. The pass 1a kickoff, `CDMSS-PROOF-PASS-1A-CC-KICKOFF-15-AUG-2026.md`, opened with
"Two commits" and specified a gate after each. The builder followed the kickoff, which is the document
it was given, and had no way to see the conflict.

**This is an orchestration failure, not a builder failure, and it is the second of its kind.** The
first was addendum v10 pointing at a "complete gate" it never defined while the kickoff redefined it
as three commands. Both have the same shape: a governing document and its kickoff disagreeing, with
the kickoff winning by default because it is what reaches the builder.

**Standing rule, added here.** Every kickoff must restate its governing addendum's commit count and
gate definition verbatim, and any difference is a defect in the kickoff to be fixed before issue.

## 2. Retrospective ratification

**`0c9ad85` and `75b3367` are ratified jointly, as one logical pass 1a, on 15 August 2026, and are
not backdated.** Neither is amended, reverted or squashed.

The split is acceptable retrospectively because **no intervening code, deploy, migration or canary
occurred between them**, and both passed the complete gate. It is recorded as a deviation and is not
treated as compliant.

**The production correction itself is accepted.** Saul's review 24: the real OpenAI SDK timeout now
classifies as `timeout`, hostile values fail safely, the 429 rule is unchanged, and the rewritten
test 12.7 genuinely executes all six arrangements. Verified independently against the installed
package.

## 3. What is still open

Proofs 11 and 12 do not close. Four blockers, all confirmed against the tree.

**3.1 The comment stripper is line-based and defeatable.** The `code()` helper filters lines that
*begin* with `//`, `*` or `/*`. A cloud success push wrapped in `/* … */` survives the filter and is
counted as executable. Test 11.3 is therefore still satisfiable by commented-out code.

**3.2 The gate evidence names the wrong commit.** `CDMSS-GATE-EVIDENCE-15-AUG-2026.md` records
`HEAD 15d5e8f12c5b450f2fdaf6d69d4aab7490ce211c`. Addendum v11 section 1 requires raw gate output to be
saved as evidence; the gate claims for `0c9ad85` and `75b3367` are not recorded under that rule.

**3.3 A listener can leak.** `boot()` starts the judge server, then performs three dynamic imports,
then assigns `booted`. An import failure in that gap leaves the server running and unregistered with
the `after()` hook. Separately, tests 12.3 to 12.5 reset `setRawContent` on the following line rather
than in a `finally`, so a failing assertion leaves the responder configured for the next test.

**3.4 The four stale references remain**, in `lib/retrieval-capture.ts` and
`lib/retrieval-telemetry-core.ts`. v12 section 3 item 7 required their correction and v12 section 5
forbade touching those files. That conflict was ours.

## 4. Prospectively authorised. Pass 1b, one commit.

Exactly four files:

```text
lib/__tests__/attempt-taxonomy.test.ts
lib/__tests__/batch-outcome-precedence.test.ts
lib/retrieval-capture.ts             COMMENTS ONLY
lib/retrieval-telemetry-core.ts      COMMENTS ONLY
```

Seven changes:

1. **Replace the line-based stripper with TypeScript AST traversal that counts executable call
   expressions.** This sidesteps line comments, block comments, strings and prose entirely.
   `typescript` 5.9.3 is a devDependency and `lib/__tests__/telemetry-key-guard.test.ts` already uses
   the compiler API, so there is house precedent.
2. **Count exactly two live cloud `attempts.push(...)` success calls and two live
   `localAttemptSuccess()` calls.**
3. **Mutation-test both `//` and `/* … */` removal, using scratchpad copies.**
4. **`boot()` closes the server if any dynamic import fails.**
5. **Reset `setRawContent` in a `finally`** in every test that changes it.
6. **Keep unconditional mock and listener cleanup.**
7. **Replace stale line citations with symbol references** — `buildRetrievalPayload`,
   `buildMultiQuerySection`, `manifestAttempts` — **and not with new line numbers.**

**One commit. Not two.** Section 1 exists because of the last split.

## 5. Prospectively authorised. The evidence commit.

After pass 1b passes the complete gate, a **separate evidence-only commit** carries a **new** gate
evidence file for the corrected pass 1. It records raw stdout, stderr, command lines, exit statuses,
HEAD and tree state.

**It does not modify the evidence file for `15d5e8f`.** That artefact stands as the record of what it
recorded. Its SHA-256 goes in the evidence commit's message.

## 6. Ruling. The stale references move to pass 1b, not pass 3.

v12 explicitly required their correction, so deferring them again would let the same failure repeat.
They are replaced with symbol references in pass 1b.

**And the wider point is accepted.** Line-number citations are a recurring failure mode in this
workstream, not a series of incidents. Symbol references replace them wherever a pin is needed, so an
assertion shrinks rather than an instance breaking.

## 7. Pass 2, approved in scope, blocked in sequence

Pass 2 may not begin until pass 1b is reviewed and proofs 11 and 12 close.

Scope unchanged: proofs 2, 16, 17, 18 and 70, plus J1 to J4. Proof 35 stays in pass 3.

**Test-only. No production source may change.** Four files:

```text
lib/__tests__/judge-server-stub.ts
lib/__tests__/explicit-judge-equivalence.test.ts     new
lib/__tests__/rerank-pass-2.test.ts                  new
lib/__tests__/explicit-judge-retrieve.test.ts        new
```

**The request recorder**, authorised, with these fixed properties: a 1 MiB body limit, HTTP 413 on
overflow, acceptance-time sequence numbers, exact method, path and body capture, defensive snapshots,
no headers, no logging, and refusal to snapshot or reset while any request remains in flight.

J1's claim stays exactly: byte-identical HTTP method, path, and entity-body bytes received by the
loopback server. It claims nothing about TCP framing, TLS, or secret-bearing headers.

## 8. Acceptance

```text
Accepted by:                          V
Date and time:                        15 August 2026, 21:54 IST
Sections accepted:                    all, in full
Sections amended, with the amendment: none
Saul's review 24:                     accepted in full, without amendment
Ratified retrospectively:             0c9ad85 and 75b3367, jointly, as one logical pass 1a,
                                      recorded as a deviation from v12's one-commit scope
```

## 9. What this addendum does not do

It authorises no deploy, no migration, no canary, no ranking change and no Cohere change. It does not
touch `RERANK_BACKEND` or `JUDGE_BATCH`. It does not revert, amend or squash any commit. It does not
extract a precedence resolver. It does not begin pass 2. It does not close Stage 0a: two of twenty
proofs remain pending acceptance, and none of the four executable judge proofs exists.
