# CDMSS rerank telemetry — Addendum v14

Date: 16 August 2026
Branch: `exp/rerank-telemetry`
HEAD at the time of writing: `40164b6d4ee23e88a1332ea41d18740c7d44e4d6`
Authority: **Saul review 26.**
Review 26 revised the first draft of this addendum. Review 25 remains the source
of the repair itself. Review 26 governs where the two differ.

This document replaces the first draft of v14 in full. The first draft was never
signed and never committed.

---

## 0. Signature

```text
STATUS: SIGNED by V, 16 August 2026
```

V gave this signature in the orchestration thread on 16 August 2026, in the
words "consider it all signed". The orchestrator typed the line on that
instruction. V should read this section before the builder starts. If the
wording does not match what V intended, V corrects it now.

Addendum v9 was tracked before V signed it. Saul ruled that v9 must stay unsigned
forever. This section exists to stop a second instance.

---

## 1. What this addendum does

Saul review 25 withheld formal closure of proofs 11 and 12. He accepted the
technical work in full. He withheld closure for two reasons. The gate evidence
did not run command 6 as written. Two governing documents were not in the tree.

Saul review 26 rejected the first draft of the repair and set its shape.

This addendum authorizes **two commits**. Commit G carries the governance
documents. Commit E carries the gate evidence. It ratifies three items after the
fact. It corrects the definition of gate command 6. It closes the byte-count
question. It defines the shape of pass 2.

This addendum does not close proofs 11 and 12. Saul closes them after he reads
commit E and its evidence.

---

## 2. Documents commit G tracks

Commit G adds the seven files below to git. Each file is in the worktree root.
Each digest below was computed on 16 August 2026 with `shasum -a 256`.

| File | SHA-256 | Note |
|---|---|---|
| `CDMSS-RERANK-TELEMETRY-ADDENDUM-v13-15-AUG-2026.md` | `56a1ac30484ada2239165c2632e9e188e2897143ae71ba2084b4f3930786cbcd` | Unchanged. Signed. Governed pass 1a and 1b. |
| `CDMSS-SAUL-REVIEW-24-15-AUG-2026.md` | `7208e015cceb5c4d61fd7267cc61c44c394c5854c02df1b57669338c2ec28919` | Unchanged. |
| `CDMSS-SAUL-REVIEW-25-16-AUG-2026.md` | compute at commit time | Verbatim copy of review 25. |
| `CDMSS-SAUL-REVIEW-26-16-AUG-2026.md` | compute at commit time | Verbatim copy of review 26. |
| `CDMSS-RERANK-TELEMETRY-ADDENDUM-v14-16-AUG-2026.md` | compute at commit time | This document, after V signs it. |
| `CDMSS-PROOF-PASS-1-REPORT-FINAL-FOR-SAUL-15-AUG-2026.md` | `fa1e7ec7cb9be9c4b32d33a04c27e3ec02980ef4c0da5a9103ea14d9a38589eb` | Copy from the doc folder. The bytes must not change. |
| `.gitignore` | not applicable | Gains one negation line per document above. |

The builder verifies the digest of the pass 1 report after the copy. If the
digest differs from
`fa1e7ec7cb9be9c4b32d33a04c27e3ec02980ef4c0da5a9103ea14d9a38589eb`, the builder
stops and reports.

Addendum v13, review 24, review 25, and review 26 must not be edited. Track them
as they are.

Commit E adds one file. Section 6 defines it.

---

## 3. Verified findings

The orchestrator ran these checks on 16 August 2026. Each finding rests on
command output.

### 3.1 Command 6 was not run as written. Confirmed, and wider than review 25 states

The tracked file `CDMSS-GATE-EVIDENCE-PASS-1-CORRECTED-15-AUG-2026.md` records
this command line in its section 6.

```console
$ bash -c npm run architecture:map && git diff --exit-code lib/architecture/map.generated.ts
```

Three defects follow.

1. The command omits `git add lib/architecture/map.generated.ts`.
2. The command runs `npm run architecture:map` one time. Review 25 assumed two
   runs with a stage between them. There is one run. The recorded command is
   therefore not a weakened determinism check. It is not a determinism check at
   all.
3. The section heading in that file states the `git add` form. The heading and
   the command below it disagree. The summary table in the same file also drops
   the `git add`.

Existing evidence files must never be edited. Section 6 defines a new file.

### 3.2 The root markdown ignore rule hides governance documents

```console
$ git check-ignore -v CDMSS-RERANK-TELEMETRY-ADDENDUM-v13-15-AUG-2026.md
.gitignore:73:/*.md	CDMSS-RERANK-TELEMETRY-ADDENDUM-v13-15-AUG-2026.md

$ git status --porcelain --ignored | grep '^!! CDMSS-'
!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v13-15-AUG-2026.md
!! CDMSS-RERANK-TELEMETRY-ADDENDUM-v14-16-AUG-2026.md
!! CDMSS-SAUL-REVIEW-24-15-AUG-2026.md
!! CDMSS-SAUL-REVIEW-25-16-AUG-2026.md

$ git status --porcelain
                       (no output)
```

Rule `/*.md` ignores every markdown file in the worktree root. The negation
block covers review 23, addendum v12, and the two gate evidence files. It has no
negation for v13, v14, review 24, or review 25.

The consequence is a trap. `git status --porcelain` returns no output. The tree
reads as clean while four governing documents sit in it unrecorded. Section 9
turns this into a standing rule.

### 3.3 The byte-count question is closed. It is a unit label, not nondeterminism

Review 26 gave the explanation. The check confirms it exactly.

The generator prints a JavaScript string length, and labels it "bytes".

```console
$ grep -an "source.length" scripts/architecture-map-gen.mjs
161:  console.log(`architecture:map — wrote ${OUT_PATH} (${source.length} bytes).`);
```

`source` is a JavaScript string. `source.length` counts UTF-16 code units. It
does not count bytes. The label in the log line is wrong.

```console
$ wc -c lib/architecture/map.generated.ts
90494

$ LC_ALL=C.UTF-8 wc -m lib/architecture/map.generated.ts
90492

$ python3 -c "..."
bytes            : 90494
codepoints       : 90492
utf16 code units : 90492

$ python3 -c "collections.Counter(ch for ch in t if ord(ch)>127)"
[('0x2014', "'—'", 1)]
```

The file holds exactly one non-ASCII character. It is U+2014 EM DASH. That
character is one UTF-16 code unit and three UTF-8 bytes. The difference is two
bytes. 90492 plus 2 is 90494.

The two numbers must differ, every time, for this file. A run that reports
90492 and measures 90494 bytes is correct behavior.

**Stop rule.** Do not stop on the difference between 90492 and 90494. Stop only
if the two generator runs report different numbers from each other, or if a git
diff in command 6 exits non-zero.

The mislabeled log line is a defect in `scripts/architecture-map-gen.mjs`. This
addendum does not authorize a fix. Section 11 records it as owed work.

### 3.4 The 11.5b AST check. Review 25 understated it. Review 26 is correct

Review 25 stated that the check proves the absence of neither a dynamic import
nor a CommonJS `require`. Review 26 stated that it does catch a dynamic import
and misses only `require`. The code decides it.

The check is in `lib/__tests__/attempt-taxonomy.test.ts`, in the test titled
`11.5b — REQUIREMENT 3: neither read may throw, on any hostile input`. The file
uses flat top-level `test(...)` calls from `node:test` and has no `describe`
blocks. Cite the file name and the title. Do not cite a line number.

The walk is:

```ts
if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n)) imports += 1;
if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) imports += 1;
if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) instanceofs += 1;
if (ts.isFunctionDeclaration(n) && n.name?.text === 'declaresConnectionTimeout') hasGuardFn = true;
```

It asserts `instanceofs === 0`, `imports === 0`, and `hasGuardFn`.

A dynamic `import(...)` parses as a call expression whose expression is the
`ImportKeyword` token. The second line matches it. **Review 26 is correct.**

A bare `require('x')` parses as a call expression whose expression is an
identifier. No line tests for an identifier named `require`. That form is not
detected.

Section 7.1 records the accurate claim.

### 3.5 The production build guard, and why a passing build proves less than it looks

The guard is in `next.config.mjs`. A typed twin is in `lib/telemetry-key-guard.ts`.

```js
if (process.env.VERCEL === '1' && process.env.VERCEL_ENV === 'production'
  && !String(process.env.CDMSS_TELEMETRY_HMAC_KEY ?? '').trim()) {
  throw new Error(
    'CDMSS_TELEMETRY_HMAC_KEY is required for a production build. ...',
  );
}
```

Three facts follow, and the third one matters.

1. The key clause is `!String(x ?? '').trim()`. An empty string triggers the
   refusal. A whitespace-only string triggers it. Review 26's
   `CDMSS_TELEMETRY_HMAC_KEY=` form exercises the clause correctly.
2. The guard reads `VERCEL` and `VERCEL_ENV`. It does not read `NODE_ENV`. All
   three clauses join with `&&`.
3. `.env.local` in this worktree sets `VERCEL=1` and `VERCEL_ENV=production`,
   and does not name `CDMSS_TELEMETRY_HMAC_KEY` at all.

Fact 3 means a plain `npm run build` in this worktree should already refuse
today. It also means that if any run leaves `VERCEL` or `VERCEL_ENV` unset, the
guard is disarmed and the build succeeds for a reason that has nothing to do
with the key.

**A successful build is not by itself evidence that the guard works.** Only the
pair proves it. Two runs, same explicit environment, one difference between
them. One must fail and one must succeed. Section 5 states the pair.

`@next/env` does not overwrite a name that is already in `process.env`. An
explicit `env` prefix therefore wins over `.env.local`. The evidence file records
the guard-relevant state of `.env.local` so a later reader can see the comparison
was controlled.

---

## 4. Gate command 6. The conflict between review 7 and review 25

Review 25 required a command block that stages the first generation. An earlier
Saul ruling retired that step.

The errata register records the earlier ruling.

```text
CDMSS-RERANK-TELEMETRY-ERRATA-REGISTER-12-AUG-2026.md, entry 9, citing Saul review 7:
Kickoff v11 gate 6 begins `git add lib/architecture/map.generated.ts`, which stages
any change to the generated map and then proves only that a second generation
matches the staged copy. It does not prove equality with `e5dc756`. Version 2
replaces it with a non-staging comparison against `HEAD`.
```

Review 7 objected that the staged form proves determinism but does not prove
that the committed map is current. Review 25's block adds
`git diff --cached --exit-code`, which compares the staged first generation
against HEAD. The two checks together prove both properties.

**Saul review 26 accepted this reading.** Review 25 supersedes review 7 on
command 6. Section 5 states the resulting block.

---

## 5. The gate

The gate runs once, at clean commit G, before commit E exists. Nine commands,
then both build modes. No numbered command may be dropped. No numbered command
may be added.

```bash
npm test                       # 1. all green, state the count
npm run typecheck              # 2. clean
npm run build                  # 3. green, run in the explicit keyed form below
npm run architecture:check     # 4.
npm run architecture:map       # 5.
                               # 6. determinism and currency, five lines, see below
npm run reasoning:registry \
  && git diff --exit-code data/reasoning-registry/prompts.generated.json  # 7.
npm run reasoning:governance   # 8.
npm run changelog:coverage     # 9. read-only regression gate
```

### Command 6

Preconditions. Run these first and record them. Both must exit zero.

```bash
git diff --exit-code -- lib/architecture/map.generated.ts
git diff --cached --exit-code -- lib/architecture/map.generated.ts
```

Then the block. Five lines, in this order, each a separate command with its own
recorded exit status.

```bash
npm run architecture:map
git add lib/architecture/map.generated.ts
npm run architecture:map
git diff --exit-code lib/architecture/map.generated.ts
git diff --cached --exit-code lib/architecture/map.generated.ts
```

Interpretation.

- Line 4 compares generation two with the staged generation one. That proves the
  generator is deterministic.
- Line 5 compares the staged generation one with HEAD. That proves the committed
  map was already current.
- On success the map has no staged delta. It is therefore not part of commit G
  and not part of commit E. An unchanged file cannot appear in a changed-file
  list.
- Expect both generator runs to report `90492`. Expect `wc -c` to report `90494`.
  Section 3.3 explains why.
- Stop only if the two generator reports differ from each other, or if line 4 or
  line 5 exits non-zero. If either happens, stop and report. Do not unstage the
  map. Do not regenerate it. Do not commit.

### Both build modes

Run every build with an explicit environment. Do not rely on `.env.local`.

Numbered command 3 is this command. It must exit zero.

```bash
env VERCEL=1 VERCEL_ENV=production \
  CDMSS_TELEMETRY_HMAC_KEY=local-gate-key-not-a-secret \
  npm run build
```

After the nine numbered commands, run the pair. Refusal first.

```bash
env VERCEL=1 VERCEL_ENV=production \
  CDMSS_TELEMETRY_HMAC_KEY= \
  npm run build
```

It must exit non-zero and name `CDMSS_TELEMETRY_HMAC_KEY`.

Then the keyed mode, which repeats the command 3 form exactly.

```bash
env VERCEL=1 VERCEL_ENV=production \
  CDMSS_TELEMETRY_HMAC_KEY=local-gate-key-not-a-secret \
  npm run build
```

It must exit zero.

The build runs three times in total. Command 3 runs once. The pair runs twice.
The pair runs last so the tree ends after a successful build.

The two commands in the pair differ in one name only. A pass on both proves the
key clause carries the refusal. A pass on a green build alone proves nothing.
Section 3.5 explains why.

The guard throws while `next.config.mjs` loads, which happens before the build
writes anything. A refusal therefore leaves no partial output behind.

### Auxiliary commands

`git status`, `git rev-parse`, `git diff`, `shasum -a 256`, `wc -c`, `ls`, and
`grep` are allowed at any point. They read state. They are not numbered gate
entries. Running them does not change the count of nine. Record their output in
the evidence file.

### One note on ordering

`npm test` includes `architecture-map-gen.test.ts`, which compares the committed
map against a fresh build. Commit G adds markdown files and edits `.gitignore`.
Neither changes the import graph. If `npm test` fails on map staleness, stop and
report. Something else is wrong.

State the test count from `npm test`. Expect 3178.

---

## 6. The two commits

### Commit G, governance

Commit G runs first, before any gate command. The gate then runs from a clean
committed authority.

Commit G contains exactly these paths and no others.

```text
.gitignore
CDMSS-RERANK-TELEMETRY-ADDENDUM-v13-15-AUG-2026.md
CDMSS-SAUL-REVIEW-24-15-AUG-2026.md
CDMSS-SAUL-REVIEW-25-16-AUG-2026.md
CDMSS-SAUL-REVIEW-26-16-AUG-2026.md
CDMSS-RERANK-TELEMETRY-ADDENDUM-v14-16-AUG-2026.md
CDMSS-PROOF-PASS-1-REPORT-FINAL-FOR-SAUL-15-AUG-2026.md
```

No test file belongs in G. No production file belongs in G.
`lib/architecture/map.generated.ts` does not belong in G.

The commit message records the `shasum -a 256` digest of each document.

Before commit G, run one auxiliary check. Regenerate the architecture map and
confirm it does not change.

```bash
npm run architecture:map
git diff --exit-code -- lib/architecture/map.generated.ts
```

Commit G edits `.gitignore`. If the map generator reads ignore rules, that edit
could change the map, and `npm test` would then fail on map staleness after the
commit. This check finds that before the commit rather than after. It is an
auxiliary command. It is not numbered command 5.

If the diff exits non-zero, stop and report. Do not commit G.

### The gate run

Run the gate from clean commit G. Capture the raw output to a file outside the
repository while the gate runs. The evidence file must not make the gate tree
dirty while the gate is measuring that tree.

Commit G exists before the gate runs. That is deliberate. Saul review 26
requires the gate to start from a clean committed authority.

If any gate command fails after commit G, commit G stays. Do not amend it. Do
not revert it. Do not rewrite it. Stop and report. A failed gate is repaired by
a later forward commit, under a new authorization.

### Commit E, evidence

Commit E runs after the gate finishes. It contains exactly these paths and no
others.

```text
.gitignore
CDMSS-GATE-EVIDENCE-V14-DETERMINISM-16-AUG-2026.md
```

The `.gitignore` change in E is one negation line for the evidence file.

The commit message records the `shasum -a 256` digest of the evidence file.

### The evidence file

`CDMSS-GATE-EVIDENCE-V14-DETERMINISM-16-AUG-2026.md` records:

- the commit G SHA
- the date and time of the run
- every command line, exactly as run
- stdout and stderr, either separated or explicitly marked as merged
- the exit status of every command
- `git status --porcelain` and `git status --porcelain --ignored` before the
  whole gate and after the whole gate
- `git status --porcelain` immediately before command 6 and immediately after
  command 6
- the generator's reported number and `wc -c`, for both generations
- the worktree diff and the cached diff of the map, before and after command 6
- the guard-relevant state of `.env.local`: whether `VERCEL` equals `1`, whether
  `VERCEL_ENV` equals `production`, and whether the name
  `CDMSS_TELEMETRY_HMAC_KEY` is present. Record these three facts only. Record
  no value from that file.

Raw output only. Do not summarize a command instead of pasting its output.

The existing evidence files must not change.

```text
f8dc6861ad8a23bd66c66eacbb18b532e744ac6096b05d23f14bf96f00de4ed5  CDMSS-GATE-EVIDENCE-15-AUG-2026.md
a90446922c1631e966771dfe2ccdd327efda4d4775390a14d494e262db94a409  CDMSS-GATE-EVIDENCE-PASS-1-CORRECTED-15-AUG-2026.md
```

### Constraints on both commits

- Do not amend, squash, rebase, or rewrite any existing commit.
- Do not force push. Do not push. V pushes.
- Do not make a third commit.
- Do not use `git add -f`. Add a negation line to `.gitignore` instead.
- Do not run `git checkout --` over uncommitted work. Use a scratchpad copy for
  any mutation test.

---

## 7. Ratifications

### 7.1 The 11.5b AST extension. Governance record only

Addendum v13 enumerated seven changes for pass 1b. The builder converted the two
structural checks in test 11.5b to an AST query. That exceeded the seven. The
builder disclosed it. Review 25 accepted it after the fact. Review 26 confirmed
the acceptance and rejected any edit to the test.

**No file changes under this item.** This is a governance record.

The accurate statement of what the check proves, read from the code in section
3.4:

The check reads the AST of `lib/transport-attribution-core.ts` and asserts three
things.

1. The file holds no static ESM import declaration, and no
   `import x = require(...)` declaration.
2. The file holds no dynamic `import(...)` call.
3. The file holds no `instanceof` operator.

It also asserts one positive property. The function `declaresConnectionTimeout`
exists as a function declaration.

The check does **not** detect a bare CommonJS `require(...)` call. That form
parses as a call expression on an identifier, and no branch of the walk tests
for it.

`lib/transport-attribution-core.ts` currently holds no import of any kind. The
`require` gap is latent. It is not exploited.

Review 25 stated that the check proves the absence of neither a dynamic import
nor a `require`. That statement is wrong on the dynamic import. Review 26
corrects it. This addendum records review 26's version.

The comment inside test 11.5b still calls these "the two structural properties".
The walk asserts three. That wording is inaccurate and is not corrected here.
Section 11 records it as owed work for pass 2, under its own authorization.

Commit `7bb52b5` is not rewritten.

### 7.2 The `.gitignore` negation in commit 40164b6

Commit `40164b6` added a negation line for
`CDMSS-GATE-EVIDENCE-PASS-1-CORRECTED-15-AUG-2026.md`. Addendum v13 authorized
that commit as evidence only. The line was necessary to track the evidence. This
addendum ratifies it after the fact.

### 7.3 The dirty-start evidence posture of pass 1b

The pass 1b evidence run started from a tree that was not clean. The builder
disclosed it. This addendum ratifies that disclosure for the pass 1b evidence
only.

The two-commit shape in section 6 removes the cause. The gate now runs from
clean commit G, and the evidence is written outside the repository while it runs.
This posture must not recur.

---

## 8. Deviations

None.

The first draft of this addendum carried four disclosed deviations. Saul review
26 ruled on all four.

| First-draft item | Review 26 ruling | State now |
|---|---|---|
| One commit instead of two | Rejected | Removed. Section 6 defines G and E. |
| The review 7 conflict on command 6 | Accepted | Recorded in section 4. |
| A comment edit inside a governance commit | Rejected | Removed. Section 7.1 is a record only. |
| The byte-count difference | Resolved | Explained and closed in section 3.3. |

Section 3.5 reports one finding that review 26 did not hold. It strengthens
review 26's build commands rather than changing them.

---

## 9. Standing rule. The root markdown trap

`.gitignore` holds the rule `/*.md`. It ignores every markdown file in the
worktree root. A new governance document is therefore invisible to
`git status`.

From this addendum forward, one rule applies.

Every commit that adds a governance document must add that document's
`.gitignore` negation line in the same commit.

Before any commit is called complete, run this check and read the output.

```bash
git status --porcelain --ignored | grep '^!! CDMSS-'
```

If the output names a governance document, that document is not tracked. A clean
`git status` does not prove that a governance document is tracked.

---

## 10. Pass 2

Review 25 approved the pass 2 scope. Review 26 confirmed it. This addendum
restates it so that the pass 2 kickoff can quote it.

Proofs 2, 16, 17, 18, 70, and judge proofs J1, J2, J3, J4.

Exactly four test side files.

```text
lib/__tests__/judge-server-stub.ts
lib/__tests__/explicit-judge-equivalence.test.ts
lib/__tests__/rerank-pass-2.test.ts
lib/__tests__/explicit-judge-retrieve.test.ts
```

No production source may change in pass 2.

Pass 2 is exactly two commits.

1. One test implementation commit.
2. One evidence and report commit.

The pass 2 gate is the gate in section 5 of this addendum, with the same command
6, the same two build modes, and the same rule on auxiliary commands.

The pass 2 kickoff must restate this commit count and this gate word for word.
Any difference is a defect in the kickoff. Fix the kickoff before you issue it.

Do not issue the pass 2 kickoff until all of the following hold.

1. Commit G exists.
2. Commit E exists.
3. Saul has read commit E and its evidence.
4. Saul has formally closed proofs 11 and 12.

---

## 11. Owed work. Not authorized here

Two defects were found while writing this addendum. Neither is fixed here. Each
needs its own prospective authorization.

1. `scripts/architecture-map-gen.mjs` prints `source.length` and labels it
   "bytes". It is a count of UTF-16 code units. The label is wrong. It caused one
   false alarm already. Fix it in a pass that is allowed to change that script.
2. The comment in test 11.5b calls the AST checks "the two structural
   properties". The walk asserts three. Correct the wording in pass 2, under the
   pass 2 authorization.

---

## 12. What this addendum does not do

- It does not close proofs 11 and 12.
- It does not authorize any production source change.
- It does not authorize any test file change.
- It does not authorize a deployment or a migration.
- It does not change the engine version or the engine freeze.
- It does not reopen decision D4.
- It does not extract the precedence resolver. Review 23 deferred that.
- It does not touch the branch `park/lvc-arm-c-unshipped-11-aug-2026`.

---

## 13. Order of work

1. V signs section 0.
2. The builder makes commit G.
3. The builder runs the gate from clean commit G.
4. The builder makes commit E.
5. The builder reports.
6. The orchestrator verifies the report against the tree.
7. The orchestrator sends commit E and the evidence file to Saul.
8. Saul closes proofs 11 and 12, or he does not.
9. The pass 2 kickoff follows his closure.

V pushes. The builder does not push.
