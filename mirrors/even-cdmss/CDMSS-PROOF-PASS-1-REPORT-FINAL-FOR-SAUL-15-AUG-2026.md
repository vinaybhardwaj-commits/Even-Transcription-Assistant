# For Saul: proof pass 1, final report

**15 August 2026.** Supersedes both earlier pass 1 reports. Covers pass 1, pass 1a and pass 1b, and
references the evidence artefact your review 24 required.

## 0. State

```text
branch    exp/rerank-telemetry
HEAD      40164b6
origin    40164b6, in sync
suite     3178 pass, 0 fail
gate      all nine plus both build modes, after the correction commit
deployed  nothing
migrated  nothing
```

```text
bbff250   pass 1
75eed4e   governance — v12 and review 23
0c9ad85   pass 1a, the production correction        ratified jointly by v13 §2
75b3367   pass 1a, the test corrections             ratified jointly by v13 §2
7bb52b5   pass 1b, the correction, ONE commit, four files
40164b6   pass 1b, the evidence, no code
```

**Evidence artefact**, per your review 24 and v13 section 5:

```text
CDMSS-GATE-EVIDENCE-PASS-1-CORRECTED-15-AUG-2026.md
SHA-256  a90446922c1631e966771dfe2ccdd327efda4d4775390a14d494e262db94a409
HEAD     7bb52b52f96c9dbe69757c3054f0af5b1d8047ec
13 exit statuses captured, exactly one non-zero — the unkeyed build, which must fail
```

**The `15d5e8f` evidence file is untouched**, hash still `f8dc6861…`, as v13 section 5 requires.

One thing to read correctly rather than as a flag: that file records `Tree at start DIRTY`. The gate
was re-run in full at `7bb52b5` **while the evidence file was itself accumulating**, so the tree
carried one untracked file. It is recorded honestly rather than tidied.

## 1. Your four blockers, closed

**Blocker 2, the stripper.** Gone, not patched. Test 11.3 now parses `lib/llm.ts` with
`ts.createSourceFile` and walks it with `ts.forEachChild`, collecting `CallExpression` nodes.

```text
2 cloud pushes   isCallExpression whose callee is a PropertyAccessExpression `attempts.push`,
                 whose first argument is an ObjectLiteralExpression carrying
                 PropertyAssignment outcome: 'success', tier asserted to be exactly
                 ['openrouter', 'vertex']
2 helper calls   isCallExpression whose callee is the Identifier localAttemptSuccess
```

Vacuity guards: parse diagnostics must be zero, and total call count must exceed 50.

**Both mutations run from scratchpad copies.** Commenting one cloud push with `//` fails 11.3.
Wrapping one in `/* … */` fails 11.3 — **and the same run shows the old line stripper still counted it
as live.** That is the class fixed rather than the instance, and the proof is in the run.

**Blocker 3, the evidence.** A new file at the corrected SHA, listed above. The old one is untouched.

**Blocker 4, the two leaks.** `boot()` wraps the three dynamic imports in `try`/`catch`; on failure it
awaits `judge.close()` and rethrows the original error unchanged. Previously a throw in that window
left a listener the `after()` hook could not see, because it closes `booted.judge` and `booted` was
still null. `withRawContent` restores the responder in a `finally` and is now the only site touching
`setRawContent`; 12.3, 12.4, 12.5 and 12.7's helper all route through it.

**Blocker 5, the four stale references.** Replaced with symbol references, not new line numbers.

```text
lib/retrieval-capture.ts:307                  → buildRetrievalPayload
lib/retrieval-capture.ts:364                  → buildMultiQuerySection
retrieval-capture.ts:309, cited in core       → buildRetrievalPayload in that file
:122-123, cited in core                       → manifestAttempts in that file
```

Both production files verified **comments only** — zero non-comment changed lines in either, checked
against the diff rather than asserted.

**Blocker 1, the governance deviation.** Addendum v13 section 2 ratifies `0c9ad85` and `75b3367`
jointly as one logical pass 1a, on 15 August, not backdated, and records the split as a deviation
rather than treating it as compliant. Section 1 records the cause: v12 said one commit, the pass 1a
kickoff said two, and the builder followed the document it was given. **That was an orchestration
failure and the second of its kind.** v13 section 1 adds the rule that prevents the third — every
kickoff must restate its governing addendum's commit count and gate definition verbatim.

## 2. The gate

All nine plus both build modes after commit `7bb52b5`. Exit 0 everywhere except the unkeyed build,
which must fail and does, naming `CDMSS_TELEMETRY_HMAC_KEY`. Suite 3178 pass, 0 fail. The full raw
capture is the evidence artefact in section 0.

## 3. Independent verification

Checked against the git objects by the orchestration thread: the two commits and their parents; commit
1 confined to exactly the four authorised files; both production files carrying zero non-comment
changed lines; `map.generated.ts` unchanged; the `15d5e8f` evidence file unchanged and its hash
re-computed; the line stripper absent from the tree; `boot()`'s `try`/`catch` and rethrow;
`withRawContent`'s `finally`; and `ts.createSourceFile`, `ts.forEachChild` and `ts.isCallExpression`
present where the report says they are.

## 4. Two disclosures from the builder, both worth your attention

**4.1 It named the defect as its own, twice over.** It wrote the line stripper in pass 1a *as the fix
for your finding 2*, and reported it as closing that finding. It closed one spelling of the attack.
You found the second in one move. The builder said so plainly rather than presenting 1b as fresh work.

**4.2 It took scope it was not given, and flagged it.** v13 section 4 authorised seven items. The
builder extended the AST conversion to test 11.5b as well, because that test's `instanceof` and import
checks were regexes over stripped source — **and the word `instanceof` appears in that file's own
comment**, which is precisely why stripping was needed there. Leaving them as regexes would have left
the defeatable technique alive in the same file that removes it.

**This is inside the file contract**, since `attempt-taxonomy.test.ts` is one of the four authorised
files, but it is beyond v13 section 4's seven items. **It is flagged for your ruling rather than
presented as authorised.**

**4.3 And one thing that did not happen this time.** The builder reports no gap in the governing
documents for this pass: v13 section 4's seven items were complete and each was directly executable.
Every prior pass in this programme has had at least one instruction that could not be carried out as
written.

## 5. What is asked of you

1. **Close proofs 11 and 12**, or say what remains.
2. **Rule on 4.2** — accept the 11.5b extension retrospectively, or require it be recorded some other
   way.
3. **Release pass 2**: proofs 2, 16, 17, 18 and 70 plus J1 to J4, test-only, four files, with the
   request recorder at a 1 MiB body limit and HTTP 413 on overflow, as v13 section 7 records.

## 6. What these passes did not do

No deploy, no migration, no canary, no ranking change. Nothing was reverted, amended or squashed. The
accepted production timeout correction was not touched in 1b. No precedence resolver was extracted —
deferred by your ruling to after the five passes. Stage 0a stays open: on your acceptance this is two
of twenty proofs, and none of the four executable judge proofs exists.
