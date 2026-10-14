# CDMSS rerank telemetry: addendum v12, the real-SDK timeout correction

**15 August 2026.** Signed, prospective, narrow. It authorises one corrective commit and nothing else.

**SIGNED by V on 15 August 2026 at 21:26 IST, all sections in full, without amendment. See section 8.**

## 0. Authority and scope

Continues addendum v11. Governs all work after `bbff250` on `exp/rerank-telemetry`.

Saul's review 23 declined `bbff250` as completing proofs 11 and 12, and requires a narrow prospective
signed addendum before the correction. This is that document.

**`bbff250` is not reverted and not amended.** The correction lands forward, as pass 1a. Everything
else in `bbff250` stands: the seed collapse, the three validator locations, the architecture edge, and
proof 12's rows 3 to 6.

Preserved and unedited. v9 alone is unsigned.

```text
v9   unsigned  08ab334d434084cfa3259f38babe2a8d5bc0b3b6cbf94b3790ad58d5a989efbb
v10  signed    c052c710a4a95c1cc4c819281c6f097e7f61eee7c638a5f000a79766f24cb185
v11  signed    cf387871a80a019318cdf8cbff620790052cc372d6a89f5fd7b0e954a3ccaf98
```

## 1. The defect. It is in production code, not only in tests.

`lib/transport-attribution-core.ts:141`:

```ts
const kind = e.name === 'APIConnectionTimeoutError' ? 'timeout' : status === null ? 'transport' : 'http';
```

The installed `openai` package's error does not carry that name. Verified by executing against the
package in the worktree, not by reading:

```text
new APIConnectionTimeoutError({ message: 'timed out' })
  e.name             "Error"
  e.constructor.name "APIConnectionTimeoutError"
  e.status           undefined
```

**So the check is never true for a real SDK timeout.** Every local timeout classifies `transport`,
then `transport_error`.

**And the consequence reaches the batch outcome.** `terminalOutcomeFor` at `lib/rerank.ts:523` lifts a
batch to `timeout` only when the last attempt's outcome is `timeout`. Since that never happens on the
local arm, **the batch outcome `timeout` is unreachable in production on that arm**, and D15's highest
precedence rank never fires there.

**Why this is the worst place for it to be.** The local arm is the `llama3.1:8b` substitution path
under throttling. Observing that path is the reason this programme exists. The instrument was blind
where it was built to look.

**The cloud arm is not affected.** `lib/openrouter-retry.ts:251` decides from `ctrl.signal.aborted`,
a different mechanism, and is correct.

**Nothing is deployed and nothing is migrated, so no recorded data is wrong.** No row exists yet.

**Why the tests did not catch it.** Both `attempt-taxonomy.test.ts:163` and the proof 12 mock construct
a local class that sets `this.name = 'APIConnectionTimeoutError'` by hand. The fixture did not look
like production, and it hid the behaviour. This is the rule this workstream already holds: in a
measurement pass the fixture is the experiment.

**Engine freeze.** This is a data-integrity defect in telemetry. It changes no ranking, no provider
selection and no scoring. The freeze exception it requires is V's written signature, which section 8
supplies.

## 2. Prospectively authorised. The production correction.

`classifyLocalAttempt` recognises **both** the declared `name` and `constructor.name`, fail-safely.

Requirements:

1. A real SDK `APIConnectionTimeoutError` classifies `timeout`.
2. An error declaring `name === 'APIConnectionTimeoutError'` still classifies `timeout`. The existing
   behaviour is preserved, not replaced.
3. Neither read may throw. A null prototype, an absent constructor, a getter that throws, and a
   non-object input all resolve without error.
4. **No `instanceof`, and no import of the SDK.** `lib/transport-attribution-core.ts` has zero
   outbound imports, and that property is what made pass 1's new architecture edge safe. It stays
   zero.
5. The 429 rule and the status handling are untouched.

## 3. Prospectively authorised. The test corrections.

1. **Test against the actual exported `APIConnectionTimeoutError`** from the installed `openai`
   package. The look-alike class is removed as the primary evidence, and kept only as the explicit
   contrast for requirement 2.2.
2. **Proof 12 row 1's method mock throws that actual SDK error.**
3. **Proof 12 row 2 replaces the closed-server case with a deterministic generic-error method mock.**
   Closing the server made the case order-dependent and left a server lifecycle in the file.
4. **Unconditional cleanup** for the loopback server and every mock, so a failing case cannot leak a
   listener or a patched method into another.
5. **Test 11.3 strips comments before counting** the two cloud success pushes and the two local helper
   sites. `lib/__tests__/defect-map-delivery.test.ts:27` already carries the helper for this.
6. **Test 12.7 is renamed or rewritten** so it does not claim to aggregate executions it never reads.
   It hard-codes six strings today, and the pass 1 report overstated it.
7. **Stale source references corrected.**

## 4. Standing instruction, added because it was missing

**Mutation testing uses scratchpad copies. `git checkout --` is never run over uncommitted work.**
This applies to every remaining pass. Its absence from the pass 1 kickoff was an orchestration
omission, and the builder disclosed the near-miss rather than concealing it.

## 5. Finding 7.1, ruled

The precedence-resolver extraction is **deferred**, per review 23. `BATCH_OUTCOME_PRECEDENCE` is
documentary vocabulary and the six behaviours are directly executable, so extraction is not required
by pass 2 or pass 3 and would edit ranking-adjacent code before the byte-equivalence proofs.

It gets its own prospectively authorised refactor **after the five proof passes**.

## 6. Pass 2, confirmed and constrained

Scope after pass 1a: proofs 2, 16, 17, 18 and 70, plus J1 to J4. Proof 35 stays in pass 3.

**Pass 2 is test-only. No production source change is presently required.** It must leave
`rerank.ts`, `retrieve.ts`, `multi-query.ts`, `llm.ts`, `trace.ts`, capture, telemetry core and store,
and settlement byte-identical to the corrected pass 1 base.

**The request recorder is authorised** in `lib/__tests__/judge-server-stub.ts`, opt-in, capturing HTTP
method, request path, exact entity-body bytes, and the acceptance sequence for concurrent requests.
It preserves the existing parsed `requests` API, never records headers or authorization values, never
writes or logs raw bodies, bounds body size, returns defensive snapshots, refuses reset or snapshot
while requests are in flight, compares concurrent batches by stable marker identity rather than
arrival order, preserves multiplicity, and resets observations without resetting responder
configuration.

**J1's claim is exactly this and no more:**

> Byte-identical HTTP method, path, and entity-body bytes received by the loopback server.

It does not claim equality of TCP framing, TLS, or secret-bearing headers.

## 7. The sequence

```text
1  sign and track this addendum
2  land pass 1a as a forward commit
3  run the complete gate, nine commands plus both builds
4  issue a corrected pass 1 report
5  Saul reviews and closes proofs 11 and 12
6  issue the pass 2 kickoff with the recorder and the test-only contract
7  begin pass 2 only after that review
```

## 8. Acceptance

```text
Accepted by:                          V
Date and time:                        15 August 2026, 21:26 IST
Sections accepted:                    all, in full
Sections amended, with the amendment: none
Saul's review 23:                     accepted in full, without amendment
Engine-freeze exception:              signed, for the section 2 correction only, on the ground of a
                                      data-integrity defect in telemetry
```

## 9. What this addendum does not do

It authorises no deploy, no migration, no canary, no ranking change and no Cohere change. It does not
touch `RERANK_BACKEND` or `JUDGE_BATCH`. It does not revert or amend `bbff250`. It does not extract a
precedence resolver. It does not begin pass 2. It does not close Stage 0a: two of twenty proofs are
pending acceptance, and none of the four executable judge proofs exists.
