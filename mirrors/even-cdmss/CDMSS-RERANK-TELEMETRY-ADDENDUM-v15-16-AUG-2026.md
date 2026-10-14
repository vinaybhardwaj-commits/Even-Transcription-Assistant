# CDMSS rerank telemetry — Addendum v15. Pass 2

Date: 16 August 2026
Branch: `exp/rerank-telemetry`
HEAD at the time of writing: `72960baa8ba88d618b4eee1c43dc56ecfec58113`
Authority: **Saul review 27**, which released pass 2, and **Saul review 28**,
which returned the first draft NO-GO and set its corrections.

**This document replaces both earlier drafts of v15 in full.** Neither was signed
and neither was committed. Section 12 lists what was wrong with each.

---

## 0. Signature

```text
STATUS: SIGNED by V, 16 August 2026
```

**This section contains exactly one `STATUS:` line, and it is the one above.** It
is the live state of the document, not an example. Any check on it may be made by
reading the first `STATUS:` line in this section.

An earlier revision of this section held two `STATUS:` lines, one live and one as
a template showing V what to paste. A grep for the signed string would have
matched the template and reported the document signed while it was not. The
builder caught that by reading the section instead of grepping. The template is
removed.

Only V changes this line. If it does not name V, the builder stops and reports.

Review 28 requires that V signs the **final revised bytes** of this document. A
signature given before a revision does not carry to it. V gave this signature in
the orchestration thread on 16 August 2026, over the bytes revised after the
adversarial comparison and the executability audit. The orchestrator typed the
line on that instruction and made no other change to this section.

---

## 1. State at the start of pass 2

```text
HEAD          72960baa8ba88d618b4eee1c43dc56ecfec58113
upstream      72960baa — in sync
tree          clean
proofs        11 and 12 CLOSED at 72960baa by Saul review 27
hard proofs   2 of 20 closed
judge proofs  0 of 4 closed
deployed      nothing
migrated      nothing
```

---

## 2. Scope

Proofs **2, 16, 17, 18, 70**. Judge proofs **J1, J2, J3, J4**.

J5 and J6 stay deferred to the Cohere Treatment Protocol. Proof 35 stays in
pass 3.

**Pass 2 changes no production source in the worktree.** These files must stay
byte-identical to their state at `72960baa`: `lib/rerank.ts`, `lib/retrieve.ts`,
`lib/multi-query.ts`, `lib/llm.ts`, `lib/trace.ts`,
`lib/retrieval-telemetry-core.ts`, `lib/retrieval-settlement.ts`,
`lib/retrieval-capture.ts`, and every file under `app/`, `scripts/` and `data/`.

⚠️ **The mutation sandbox in section 7.3 is exempt.** It is a copy outside the
repository with its `.git` pointer removed. Section 7.3 authorizes edits to
production files **inside that copy only**. The worktree copies are never edited.

### 2.1 Commit 1 changes exactly these four implementation paths

```text
lib/__tests__/judge-server-stub.ts                   EXISTS, 272 lines. Extended.
lib/__tests__/explicit-judge-equivalence.test.ts     new
lib/__tests__/rerank-pass-2.test.ts                  new
lib/__tests__/explicit-judge-retrieve.test.ts        new
```

`judge-server-stub.ts` is already tracked. Keep its name. It is deliberately not
`.test.ts`, because the suite glob is `lib/**/__tests__/*.test.ts`. That glob was
verified: it picks up the three new files and skips the stub.

No other implementation path may appear in commit 1.

### 2.2 Commit 2 changes exactly these six governance and evidence paths

```text
.gitignore
CDMSS-SAUL-REVIEW-27-16-AUG-2026.md
CDMSS-SAUL-REVIEW-28-16-AUG-2026.md
CDMSS-RERANK-TELEMETRY-ADDENDUM-v15-16-AUG-2026.md
CDMSS-GATE-EVIDENCE-PASS-2-16-AUG-2026.md
CDMSS-PROOF-PASS-2-REPORT-FOR-SAUL-16-AUG-2026.md
```

Six paths. Review 28 said five. The sixth is review 28 itself, which did not
exist when review 28 was written. It is tracked for the same reason review 27 is:
HEAD must contain the authority the pass ran under.

The `.gitignore` change is five negation lines, one per new root document.

### 2.3 `attempt-taxonomy.test.ts` is not touched

Addendum v14 section 11 item 2 asked for a comment fix in
`lib/__tests__/attempt-taxonomy.test.ts` under the pass 2 authorization. That
conflicted with the four-file contract in the same document. **Saul review 27
resolved it: the four-file contract takes precedence.** The comment fix moves to
a separately authorized comment-only cleanup after the five proof passes.

That conflict was a defect the orchestrator introduced in v14. It is recorded
rather than dropped.

---

## 3. The canonical J1 to J4 contract

Quoted from addendum v11 section 9, adopted prospectively on Saul review 22.

> **J1.** Explicit judge and environment-default judge must produce byte-identical
> serialized results, canonical telemetry payloads, and outbound judge requests under
> deterministic collaborators. Cover success, real batch parse failure, and generic
> outer judge failure. **No field differences are permitted.**
>
> **J2.** Explicit judge invokes neither `checkHealthy` nor `cohereFn`, under judge or
> hostile Cohere defaults, on success or failure. **This is call-local; an earlier
> memoized probe is irrelevant.**
>
> **J3.** Execute `retrieve` under a hostile Cohere default. The omitted-backend
> control must demonstrate Cohere intent and downgrade; the explicit-judge arm must
> show zero Cohere consultation, judge intent, judge service, no downgrade, nonzero
> batches, and actual reordering.
>
> **J4.** `retrieveMultiQuery` keeps reranking off on every retrieval arm and performs
> exactly one fusion-level rerank with third argument `'judge'`. **Expansion is
> independent and must not be claimed to "agree" on a rerank backend.**
>
> Use the real local judge server for J1, J3 and J4, and injected call counters for J2.

### 3.1 The J1 claim ceiling

J1 claims exactly this and no more:

> Byte-identical HTTP method, path, and entity-body bytes received by the loopback
> server.

It claims nothing about TCP framing, TLS, or secret-bearing headers. No test, no
comment and no report may describe J1 as proving more than that sentence.

---

## 4. Pinned rulings, from Saul review 28 section 3

### 4.1 J3. Wire-level, plus J2's counters for the call-level fact

J3 proves **zero Cohere outbound requests through `retrieve`**. That is a wire
observation: no request leaves for any Cohere endpoint during the explicit-judge
arm.

The separate call-level fact, that `checkHealthy` and `cohereFn` are never
invoked, is J2's, and J2 proves it with injected counters. Do not merge the two.

### 4.2 J1 generic outer failure. Call, then throw

A generic outer judge failure must be produced by a fixture that **calls the real
loopback judge and only then throws**.

If an arm throws before any request leaves, both arms record zero wire
observations and "byte-identical" compares two empty sets. That is a vacuous
pass. Both arms must produce **nonempty** wire observations, byte-identical,
before either enters the outer failure path.

### 4.3 Proof 70. What it says, and one instruction with no definition

Proof 70, verbatim from kickoff v11:

> 70. **The Cohere-to-judge downgrade.** Backend Cohere by environment default,
> `checkHealthy` throws `RerankBackendError`, the judge serves. `intended_backend` is
> Cohere, `served_backend` is the judge, `rerank_backend_downgraded` is true,
> `expected_batch_count` matches the judge's batches, and the row is
> `persisted_complete`. **Also assert that provider selection and fallback order are
> byte-identical to today**, since PRD section 4.4 forbids changing them.

Assert four things. The runtime order, `checkHealthy` throwing before the judge
serves. The manifest facts. The `persisted_complete` state through section 4.4's
composition. Source parity of provider selection and fallback order against
`72960baa`.

⚠️ **Review 28 item 3 also required "the base-to-commit production byte
comparison". That phrase occurs exactly once in the corpus: in review 28 itself.
It is defined nowhere.** It does not occur in kickoff v11, in the PRD, in any
addendum v1 to v15, or in any earlier Saul review. Proof 70 states one byte
requirement and it is the sentence quoted above, which is a source-parity
assertion over `lib/rerank.ts`, not a wire comparison.

**The orchestrator declines review 28 item 3.3's second clause pending
clarification.** Pass 2 implements the four assertions above. If Saul intended a
different comparison he names it, and it goes into pass 3. This deviation is
disclosed rather than silently resolved.

Two further facts the builder needs.

- **Proof 70 was never implemented.** The 11 August build report section 12 lists
  it among the omissions. There is no prior test to extend.
- **The health probe is memoized** per backend and model for ten minutes. A
  passing probe from an earlier test in the same process prevents the downgrade.
  Call `_resetRerankHealth()` before exercising proof 70 and restore health state
  afterwards. A thrown probe is not cached.

### 4.4 `persisted_complete` is validation plus real state mapping, not a database write

Do not write to a database. Do not read one back. Compose the real production
functions and assert the result.

```text
outcomeForSaveResult(result)         lib/retrieval-settlement.ts
verdictForRun(map, role, linkable)   lib/retrieval-settlement.ts
upgradeForDefects(base, defects)     lib/retrieval-settlement.ts
stateForSettlement(outcome)          lib/retrieval-telemetry-core.ts
```

`stateForSettlement` is the mapper. `persisted_complete` is produced by exactly
one outcome, `persisted_clean`. Assert the composed result equals
`'persisted_complete'`.

All four are synchronous and pure. `stateForUnwrittenRun` is module private and
is reached only when `expectedRevision === 0`, which this assertion never is.

### 4.5 Two vocabularies, both real

The manifest uses snake_case. The in-memory capture uses camelCase. Both exist
and neither is a typo.

```text
manifest                      capture
intended_backend              intendedBackend
served_backend                servedBackend
rerank_backend_downgraded     rerankBackendDowngraded
expected_batch_count          expectedBatchCount
rerank_soft_failed            rerankSoftFailed
```

`lib/retrieval-capture.ts` bridges them. Use snake_case for manifest assertions
and camelCase at the capture seam.

---

## 5. The request recorder. Full behavioral definition

Authorized in `lib/__tests__/judge-server-stub.ts`, opt-in.

### 5.1 The recorder is a separate store

The recorder keeps its **own** observation list. It does not add fields to
`JudgeRequest` and it does not change how `requests` is populated.

Reason: `requests` is the parsed API and section 5.11 requires it unchanged. The
parsed path discards the raw body immediately after `JSON.parse`, so a wire-level
recorder cannot be built from `JudgeRequest` at all. A separate store satisfies
5.11 by construction.

Two hook points are needed, not one.

- **Byte accounting in the `data` handler.** The running total must be known
  before the body completes, because the limit in 5.5 is enforced there.
- **Observation capture in the `end` handler**, at the expression that
  concatenates the received chunks. `req.method` and `req.url` are both in scope
  at that point, so method, path and body come from one place.

### 5.2 Enablement

Recording is **off** by default. A test turns it on through a new setter on the
`JudgeServer` handle, in the style of the six existing `set*` mutators. While
recording is off, no observation is stored and no counter advances.

### 5.3 What one observation holds

```text
seq        integer, assigned at acceptance
method     the HTTP method as received
path       req.url as received, unmodified
body       the exact entity-body bytes received, as a Buffer
overflowed boolean
```

No headers. No authorization values. No timestamps. Nothing derived.

### 5.4 Sequencing. Acceptance time, not completion time

The counter starts at 0. A number is assigned when the server **accepts** the
request, before the body has finished arriving. It is not assigned at completion.

Numbers are monotonic and never reused. Two requests that arrive in order A then
B receive numbers in that order even if B finishes first.

`resetObservations` returns the counter to 0.

### 5.5 The 1 MiB boundary and overflow

The limit is **1048576 bytes**, exactly.

- A body of 1048576 bytes is **accepted** and recorded in full.
- A body of 1048577 bytes is **rejected**.

On rejection the server stops accumulating, responds **HTTP 413** with an empty
JSON object as the body, and ends the response normally. It does not destroy the
socket.

An overflowing request still produces an observation, carrying its `seq`,
`method`, `path`, `overflowed: true`, and a zero-length `body`. The raw bytes are
discarded, never buffered beyond the limit, and never logged.

**Both boundary values must be tested.** A test that exercises only a small body
and a very large body does not prove the boundary.

### 5.6 In-flight refusal

An in-flight counter increments at acceptance and decrements when the response
ends, for 200 and for 413.

While it is above zero, **both** `snapshot` and `resetObservations` **throw**.
They do not return partial data. They do not wait. The thrown error names the
counter value.

### 5.7 Defensive snapshots

`snapshot` returns a new array of new objects, each with a copied Buffer.

Mutating the returned array, mutating any returned object, or writing into any
returned Buffer must leave recorder state unchanged. A second `snapshot` after
such mutation returns the original values.

### 5.8 Multiplicity

Two identical requests produce two observations. The recorder never
deduplicates, collapses, or merges.

### 5.9 Comparison by stable marker identity

Concurrent batches are compared by the marker tokens found in the body, not by
arrival order.

Batches are otherwise indistinguishable. Model, system prompt, temperature,
`max_tokens`, options, `keep_alive` and the `QUESTION:` prefix are byte-identical
across batches, and the local slice index restarts at `[0]` in every batch.

A comparison helper groups observations by marker set. Two runs match when the
multiset of marker-keyed bodies matches, whatever order the sockets completed in.

### 5.10 Reset independence

`resetObservations` clears the observation list and the sequence counter.

It does **not** clear responder configuration. Scores, raw content, usage
inclusion, expansion text, embedding override and chat discrimination all survive
a reset unchanged.

### 5.11 The parsed API is unchanged

`readonly requests: JudgeRequest[]` keeps its current fields, its current
population at the two existing push sites, and its arrival ordering across all
three request kinds. `JudgeRequest` gains no field.

### 5.12 Ten guarded terms

**Each of sections 5.2 through 5.11 must have at least one test that fails when
the behavior is broken.** That is ten guarded terms. A contract term with no test
is a claim, not a guard.

Section 5.1 is architecture, not behavior. Its guard is section 5.11's test,
because a recorder that wrote into `JudgeRequest` would break that test.

### 5.13 The thirteen labels, mapped

Addendum v12 section 6 and Saul review 23 state the contract as thirteen labels.
Addendum v13 section 7 restated it and dropped four. This addendum restates all
thirteen as ten guarded behaviors. The map exists so that no future document has
to guess which numbering is meant.

| v12 / review 23 label | This addendum |
|---|---|
| opt-in | 5.2 |
| captures method, path, exact body bytes | 5.3 |
| acceptance sequence for concurrent requests | 5.4 |
| bounds body size, 1 MiB | 5.5 |
| HTTP 413 on overflow | 5.5 |
| never records headers or authorization values | 5.3 |
| never writes or logs raw bodies | 5.3, 5.5 |
| returns defensive snapshots | 5.7 |
| refuses reset or snapshot while in flight | 5.6 |
| compares by stable marker identity | 5.9 |
| preserves multiplicity | 5.8 |
| resets observations without resetting responder config | 5.10 |
| preserves the existing parsed `requests` API | 5.11 |

**From here forward the count is ten guarded terms, sections 5.2 to 5.11.** Do
not write "thirteen terms" in any test, comment, commit message or report.

---

## 6. The gate

Nine numbered commands, then the build pair.

```bash
npm test                       # 1. all green, state the OBSERVED count
npm run typecheck              # 2. clean
                               # 3. green production build, explicit env, see below
npm run architecture:check     # 4.
npm run architecture:map       # 5.
                               # 6. determinism and currency, five lines, see below
                               # 7. registry, quoted form, see below
npm run reasoning:governance   # 8.
npm run changelog:coverage     # 9. read-only regression gate
```

### 6.1 Command 3, and the build pair

Numbered command 3:

```bash
env VERCEL=1 VERCEL_ENV=production \
  CDMSS_TELEMETRY_HMAC_KEY=local-gate-key-not-a-secret \
  npm run build
```

After the nine numbered commands, run the pair. Refusal first, then keyed. The
keyed run repeats the command 3 form exactly.

```bash
env VERCEL=1 VERCEL_ENV=production \
  CDMSS_TELEMETRY_HMAC_KEY= \
  npm run build

env VERCEL=1 VERCEL_ENV=production \
  CDMSS_TELEMETRY_HMAC_KEY=local-gate-key-not-a-secret \
  npm run build
```

The refusal must exit non-zero and name `CDMSS_TELEMETRY_HMAC_KEY`. The keyed run
must exit zero.

**The build runs three times: command 3, then the pair.** Saul review 27 ruled
the armed refusal and keyed-success pair sufficient. **Do not add a third build
mode. Do not add a disarmed control.** The count of build invocations is three.
The count of build modes is two.

### 6.2 Command 6. Every command must exit zero

Preconditions.

```bash
git diff --exit-code -- lib/architecture/map.generated.ts
git diff --cached --exit-code -- lib/architecture/map.generated.ts
```

The block. Five lines, each a separate command with its own recorded exit status.

```bash
npm run architecture:map
git add lib/architecture/map.generated.ts
npm run architecture:map
git diff --exit-code lib/architecture/map.generated.ts
git diff --cached --exit-code lib/architecture/map.generated.ts
```

**Every one of those seven commands must exit zero.**

`git add` of an unchanged file stages no delta. The index entry is rewritten to
the value it already held, so `git status --porcelain` stays empty and the map
enters no commit. **No unstage step is needed.** The pass 1 evidence recorded an
empty status immediately after command 6, at commit G and at the end of the gate.

**The architecture map does not read the test tree.** This was verified in the
generator: the edge scan, the version registry and the subsystem list all filter
`__tests__/` out. Adding three files under `lib/__tests__/` cannot change
`lib/architecture/map.generated.ts`. If a command 6 line nevertheless exits
non-zero, something else is wrong. Stop and report.

The generator prints `source.length`, a count of UTF-16 code units, and labels it
"bytes". `wc -c` reports a larger number. That difference is expected. Stop if
the two generator runs disagree with each other.

### 6.3 Command 7. The quoted form, plus one auxiliary capture

```bash
bash -c 'npm run reasoning:registry && git diff --exit-code data/reasoning-registry/prompts.generated.json'
```

Then, separately:

```bash
git diff --exit-code data/reasoning-registry/prompts.generated.json
```

The second is an allowed auxiliary check. **It does not add a numbered gate
entry.** The gate is nine.

### 6.4 The test count

`npm test` was 3178 at `72960baa`. **Pass 2 adds tests. Report the observed
count. Do not require 3178.** Record a baseline before implementation and a
second count before commit 1, and state the difference.

### 6.5 Command authorization

**Read-only, allowed at any point, not numbered gate entries:**

```text
git status      git rev-parse      git diff      git log      git show
git ls-files    git cat-file       git check-ignore
shasum -a 256   wc                 ls            grep         sed (read-only)
cmp             date               echo
```

**State-changing, authorized only for the named purposes:**

```text
cp, mkdir, ln -s   building the section 7.3 sandbox, and nothing else
rm                 deleting inside the section 7.3 sandbox, and nothing else
in-place file edit writing the four paths in section 2.1;
                   and editing files inside the section 7.3 sandbox
git add            staging the paths named in sections 7.1 and 7.4
git commit         the two commits in section 7
```

**Not authorized at all:**

```text
git restore   git checkout   git reset   git stash   git rebase   git push
node -e with arbitrary code
any git command executed inside the section 7.3 sandbox
```

Where a check needs more than the read-only list, the kickoff states the exact
command.

---

## 7. The two commits

### 7.1 Commit 1. Implementation

Contains exactly the four paths in section 2.1.

After staging and before committing, run and record:

```bash
git status --porcelain --untracked-files=all
git diff --cached --stat 72960baa
git diff --cached --name-only 72960baa
git diff --exit-code
```

`git diff --cached <commit>` compares the index against that commit. It is valid
git and it means what this sentence says. `git diff --exit-code` compares the
worktree against the index and must exit zero, proving nothing is left unstaged.
`git diff --cached --name-only 72960baa` must list exactly the four paths.

After committing:

```bash
git diff --name-only 72960baa..HEAD
```

It must list exactly the four paths.

### 7.2 The gate run

Run the gate from commit 1. Capture raw output to a directory outside the
repository while the gate runs, so the evidence file does not make the gate tree
dirty.

If a gate command fails after commit 1, commit 1 stays. Do not amend it. Do not
revert it. Stop and report.

### 7.3 Mutation testing. Finite table, full sandbox

Mutation testing runs in a **full temporary copy of the repository**, outside the
worktree. Not a single-file scratchpad.

Build the sandbox by copying the worktree and then removing three things:
`.next`, `node_modules`, and `.git`. Link `node_modules` from the original.

**Removing `.git` is load-bearing.** The worktree's `.git` is a file, not a
directory. It is a pointer to the real gitdir. If it survived into the copy, a
git command run in the sandbox would resolve to the real repository. `rm -rf`
removes a regular file, so the removal works.

Verify the copy before trusting it. `cp -a src/. dst` is a GNU idiom and BSD `cp`
on macOS may handle the trailing `/.` differently. List the sandbox root
including dotfiles and confirm the shape before running any mutation.

**Run no git command inside the sandbox.** ⚠️ **Never run `git checkout --` over
uncommitted work.** A builder destroyed its own uncommitted work that way during
pass 1.

In-place edits to production files are authorized **inside this sandbox only**.
Section 2's prohibition covers the worktree.

Delete the sandbox when the table is complete.

The kickoff carries the finite mutation table. Each row names the file, the exact
change, and the test that must fail. A mutation that does not fail its named test
is a defect in the test, not in the table.

### 7.4 Commit 2. Evidence, report and governance

Contains exactly the six paths in section 2.2.

Before committing, confirm the three earlier evidence files are untouched. If any
digest differs, stop and report.

```text
f8dc6861ad8a23bd66c66eacbb18b532e744ac6096b05d23f14bf96f00de4ed5  CDMSS-GATE-EVIDENCE-15-AUG-2026.md
a90446922c1631e966771dfe2ccdd327efda4d4775390a14d494e262db94a409  CDMSS-GATE-EVIDENCE-PASS-1-CORRECTED-15-AUG-2026.md
065be6a1af1232a34de56f2b26da3aaec8a3e6e1bded0db84fb267624a0e63a3  CDMSS-GATE-EVIDENCE-V14-DETERMINISM-16-AUG-2026.md
```

Each commit message records the `shasum -a 256` digest of each document it adds.

### 7.5 Constraints on both commits

- Do not amend, squash, rebase, or rewrite any existing commit.
- Do not force push. Do not push. V pushes.
- Do not make a third commit.
- Do not use `git add -f`.
- Do not change any production source file **in the worktree**. The section 7.3
  sandbox is exempt.
- Do not change any test file outside the four paths in section 2.1.

---

## 8. The ignored-document check is phase-specific

`.gitignore` holds the rule `/*.md`, on the line so numbered today. It ignores
every markdown file in the worktree root, so a governance document is invisible
to `git status` until its negation line lands. A negation block of `!/CDMSS-`
lines sits at the end of the file and runs to the last line, so appending works.

The negation lines for this pass land in **commit 2**. This addendum, review 27
and review 28 are therefore legitimately ignored during commit 1 and during the
gate. A check that forbids that stops the builder before it starts. **The first
v15 draft carried exactly that check. It produced the NO-GO.**

### 8.1 At commit 1, and throughout the gate

```bash
git status --porcelain --ignored | grep '^!! CDMSS-' | sort
```

Exactly these three lines, and no others:

```text
!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v15-16-AUG-2026.md
!! CDMSS-SAUL-REVIEW-27-16-AUG-2026.md
!! CDMSS-SAUL-REVIEW-28-16-AUG-2026.md
```

This is expected. Do not stop on it. Any other line: stop and report.

### 8.2 After commit 2

```bash
! git status --porcelain --ignored | grep -q '^!! CDMSS-'
```

The `!` negates the whole pipeline. It exits zero when no CDMSS root document
remains ignored, which is the passing condition.

### 8.3 The standing rule

Every commit that adds a governance document adds that document's `.gitignore`
negation line in the same commit. A clean `git status` does not prove that a
governance document is tracked.

---

## 9. Debt. Recorded, not authorized

1. `scripts/architecture-map-gen.mjs` prints `source.length` and labels it
   "bytes".
2. `scripts/reasoning-registry-gen.mjs` has the same label defect.
3. The comment in test 11.5b in `lib/__tests__/attempt-taxonomy.test.ts` calls
   the AST checks "the two structural properties". The walk asserts three.
4. `startJudgeServer` mutates **ten** environment variables and restores none of
   them. No existing test restores them either. Pass 2 adds its own teardown. A
   permanent fix inside the stub is not authorized here.

None of these may be fixed in pass 2. Item 3 moves to a separately authorized
comment-only cleanup after the five proof passes. Items 1, 2 and 4 need a pass
that may change those files.

Standing from earlier addenda, unchanged:

- The precedence resolver extraction stays deferred by review 23 until after the
  five proof passes.
- `lib/__tests__/retrieval-telemetry-core.test.ts` names two test files in its
  header that have never existed. Pass 3 creates them and corrects the header.

---

## 10. The connection guard

Review 28 requires a guard permitting only `127.0.0.1` and rejecting all TLS and
external connections. No such guard exists anywhere in the suite. It is built
here, in the four authorized paths. It changes no production code.

### 10.1 The seam

Patch `net.Socket.prototype.connect`. That is the only seam that covers
everything the pass touches. It was tested: loopback `http`, remote `http`, and
`tls.connect` all pass through it, and so does Node's native `fetch`.

Do **not** patch `http.Agent.prototype.createConnection`. The OpenAI SDK's node
shim installs `agentkeepalive`, which supplies its own `createConnection`, so an
`http.Agent` patch misses the SDK's traffic.

### 10.2 Three facts the implementation must handle

1. **The argument shape is not uniform.** Through `http` and `https`, which is
   the OpenAI path, the first argument is an **array** of `[options, callback]`,
   because `net.createConnection` normalizes its arguments. Through
   `tls.connect`, it is a plain object. Read `host ?? hostname` after
   normalizing both shapes. A guard that reads only `args[0].host` refuses
   loopback.
2. **A throw inside the guard is synchronous.** It escapes the caller rather than
   arriving as an `error` event. Through `http.get` it propagates out of
   `new ClientRequest`. Through `fetch` it surfaces as a wrapped cause. The guard
   test must use `try`/`catch`, not an event listener.
3. **The guard sees hostnames, not resolved addresses.** DNS has not run at this
   point. `localhost` arrives literally and a strict `!== '127.0.0.1'` test
   refuses it. **Decide `localhost` explicitly and state the decision in a
   comment.**

### 10.3 Requirements

1. Permit `127.0.0.1`. State the `localhost` decision.
2. Reject every TLS connection.
3. Reject every other host, with an error naming the refused host.
4. Uninstall in teardown, so it does not leak into later files.
5. One test proves the guard refuses a non-loopback host.

### 10.4 On import order

A prototype patch is global and order-independent, so the guard itself does not
need to precede the dynamic imports. **The real order constraint is different and
still binding:** `lib/llm.ts` reads `OLLAMA_BASE_URL` and constructs its OpenAI
client at module evaluation, and `startJudgeServer` is what sets that variable.
**Start the judge server before the dynamic import of any module that reads the
client.** Installing the guard early as well does no harm.

---

## 11. Order of work

1. The orchestrator compares the kickoff against this document, line by line, and
   records the result.
2. The builder confirms HEAD is `72960baa8ba88d618b4eee1c43dc56ecfec58113`, clean
   and synchronized.
3. The orchestrator records the `shasum -a 256` digest of this document and of
   the kickoff.
4. **V signs the final revised bytes of section 0.**
5. Only then may pass 2 implementation begin.
6. The builder writes the four files and makes commit 1.
7. The builder runs the gate from commit 1.
8. The builder runs the mutation table in the sandbox.
9. The builder writes the evidence file and the report, and makes commit 2.
10. The orchestrator verifies the report against the tree.
11. The orchestrator sends commit 2 and the evidence to Saul.
12. Saul reviews. Pass 3 follows his review.

V pushes. The builder does not push.

---

## 12. What was wrong with the two earlier drafts

Recorded so the same defects are not reintroduced.

### 12.1 First draft, returned NO-GO by review 28

1. It said "exactly four files" and "No fifth file may change", then listed five
   paths for commit 2.
2. Its ignored-document check was not phase-specific. It would have fired at
   commit 1 on documents whose negation lines were not due until commit 2. **This
   produced the NO-GO.**
3. It labelled the recorder terms instead of defining them.
4. It required only command 6 lines 4 and 5 to exit zero.
5. It authorized `git restore` and arbitrary `node -e` as blanket auxiliaries.
6. It required tests for eight terms, not all.
7. It left the mutation instruction open-ended.

### 12.2 Second draft, returned by the orchestrator's own review

8. Section 2.2's heading said "five" over a list of six.
9. Section 4.3 claimed the phrase "base-to-commit production byte comparison"
   occurs "in no Saul review". It occurs in review 28. The claim was false and
   the refusal rested on it.
10. It said "thirteen recorder terms" in three places while requiring guards for
    sections 5.2 to 5.11, which is ten.
11. Its production-source prohibition was unscoped and contradicted its own
    sandbox.
12. It authorized no command that can perform an edit, while requiring twenty.
13. "Do not add a third build" contradicted three build invocations.
14. It omitted `ln -s` and `echo` from the command lists while instructing both.

Items 1, 8, 9, 10, 11 and 13 are all one failure: a document contradicting
itself. That is now six instances across v14 and v15. **Section 11 step 1 exists
because an author cannot find these in their own text.**

---

## 13. What this addendum does not do

- It does not authorize any production source change in the worktree.
- It does not authorize any implementation path outside section 2.1.
- It does not authorize a third build mode.
- It does not close any proof. Saul closes proofs.
- It does not authorize a deployment or a migration.
- It does not change the engine version or the engine freeze.
- It does not reopen decision D4.
- It does not touch the branch `park/lvc-arm-c-unshipped-11-aug-2026`.
- It does not begin pass 3.
