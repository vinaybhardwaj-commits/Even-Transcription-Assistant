# Saul review 24

**Recorded 15 August 2026, verbatim, from V's transcript. Not edited.**

Governs: pass 1a. It accepts the production timeout correction, holds proofs 11 and 12 open on four
blockers, and requires a signed narrow v13 before the final cleanup.

---

**Findings**
1. **Governance blocker:** v12 authorized one corrective commit, but implementation was split into `0c9ad85` and `75b3367`. Do not rewrite or squash them, but the deviation needs explicit ratification.
2. **Proof 11 blocker:** Test 11.3 still does not remove multiline block-comment bodies. Wrapping a cloud success push in `/* ... */` leaves it counted as executable.
3. **Evidence blocker:** The committed raw gate evidence still identifies `15d5e8f`, not the corrected pass-1 SHA. The complete gate claims for `0c9ad85` and `75b3367` are not yet recorded under addendum v11's evidence rule.
4. **Isolation gap:** A dynamic-import failure after the judge server starts can leak the listener, and tests 12.3–12.5 do not reset responder state in `finally`.
5. **Scope debt:** The four stale references required by v12 remain in capture and core.

The production timeout correction itself is correct. The real OpenAI SDK timeout now classifies as `timeout`, hostile values fail safely, the 429 rule is unchanged, and rewritten 12.7 genuinely executes all six arrangements.

**Ruling 1**
Proofs 11 and 12 do not close yet.

Do not amend or revert the existing commits. Use a signed narrow v13 to:

- Retrospectively ratify `0c9ad85` and `75b3367` jointly as logical pass 1a.
- Record that splitting the signed one-commit scope was a deviation.
- Authorize one final test/comment cleanup commit.
- Authorize a subsequent evidence-only commit.

The split is acceptable retrospectively because there was no intervening code, deploy, migration, or canary. It must not be silently treated as compliant.

**Final Pass 1b**
Use this exact correction scope:

- `lib/__tests__/attempt-taxonomy.test.ts`
- `lib/__tests__/batch-outcome-precedence.test.ts`
- `lib/retrieval-capture.ts`, comments only
- `lib/retrieval-telemetry-core.ts`, comments only

Required changes:

1. Replace the line-based comment stripper with TypeScript AST traversal that counts executable call expressions. This avoids line comments, block comments, strings, and prose entirely.
2. Count exactly two live cloud `attempts.push(...)` success calls and two live `localAttemptSuccess()` calls.
3. Mutation-test both `//` and `/* ... */` removal using scratchpad copies.
4. Make `boot()` close the server if any dynamic import fails.
5. Reset `setRawContent` in `finally` in every test that changes it.
6. Keep unconditional mock and listener cleanup.
7. Replace stale line citations with symbol references such as `buildRetrievalPayload`, `buildMultiQuerySection`, and `manifestAttempts`, not new line numbers.

After pass 1b:

- Run all nine gate commands and both build modes.
- Save raw stdout, stderr, command lines, exit statuses, HEAD, and tree state.
- Commit a new pass-1 gate evidence file rather than modifying the evidence for `15d5e8f`.
- Record its SHA-256 in the evidence commit message.
- Issue one final corrected pass-1 report referencing the evidence artifact.

**Ruling 2**
The stale references move into pass 1b, not pass 3.

V12 explicitly required their correction. Replace them with symbol references now so pass 3 does not repeat the same line-number failure.

**Ruling 3**
Pass 2's technical scope remains approved, but it cannot begin until pass 1b is reviewed and proofs 11 and 12 close.

Pass 2 remains:

```text
Proofs 2, 16, 17, 18, 70
J1, J2, J3, J4
```

It is test-only with four files:

- `lib/__tests__/judge-server-stub.ts`
- New `lib/__tests__/explicit-judge-equivalence.test.ts`
- New `lib/__tests__/rerank-pass-2.test.ts`
- New `lib/__tests__/explicit-judge-retrieve.test.ts`

No production source may change.

The request recorder remains authorized with a fixed 1 MiB body limit, HTTP 413 on overflow, acceptance-time sequence numbers, exact method/path/body capture, defensive snapshots, no headers, no logging, and snapshot/reset refusal while any request remains in flight.

Current branch state is accurately reported: clean at `75b3367`, three commits ahead of origin and held for V.
