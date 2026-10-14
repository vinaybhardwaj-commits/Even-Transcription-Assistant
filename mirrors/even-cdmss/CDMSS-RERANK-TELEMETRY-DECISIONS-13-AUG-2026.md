# CDMSS rerank telemetry: eight decisions

**13 August 2026.** V ruled on eight open items. This document records each ruling, the
evidence under it, and what has to change.

**No code changed today. Nothing was pushed.** The branch is at `32f0f79` on
`exp/rerank-telemetry`, working tree clean, one commit held locally.
`origin/exp/rerank-telemetry` is at `ee92c26`. `origin/main` is at `81b7c93`.

**This document amends** `CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md`
at D9 and D12, and `CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md` at line 223.
It supersedes section 3 of `CDMSS-CARRYOVER-13-AUG-2026-RERANK-TELEMETRY.md` where they
conflict. It does not change the PRD, which never carried these decisions.

---

## 0. Two corrections to the record, before the rulings

### 0.1 D9, D12 and D17 are in the kickoff, not the PRD

```
$ grep -n "^### D9\.\|^### D12\.\|^### D17\." CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md
537:### D9. Fourteen states, the outcome-to-state table, every owner.
684:### D12. Revisions, transitions, canonicalization.
914:### D17. Validation, edge cases, and the scorer-context HMAC.
```

The kickoff holds eighteen such sections, D1 to D18. The PRD v2.1 decisions log is
lettered A1 to A12 and has no D numbers. Every earlier document that cites "PRD D9" cites
the wrong file.

### 0.2 The ordering of the four items V holds is a chain, not a set

```
$ git ls-tree -r --name-only origin/main | grep migrate-retrieval-telemetry
NOT on origin/main
$ git ls-tree -r --name-only HEAD | grep migrate-retrieval-telemetry
app/api/admin/migrate-retrieval-telemetry/route.ts
lib/__tests__/migrate-retrieval-telemetry-parity.test.ts
$ git ls-tree -r --name-only origin/main | grep telemetry-key-guard
NOT on origin/main
```

The migration route ships with this branch. So does the key guard. The order is fixed:

1. Put `CDMSS_TELEMETRY_HMAC_KEY` in Vercel Production. The key guard throws at config
   import in production without it, so no production deploy of this branch can start.
2. Deploy.
3. Run `POST /api/admin/migrate-retrieval-telemetry` once.
4. Read the response. Only then does the legacy-data question arise. See section 9.

The carryover listed these as four independent items. They are not.

---

## 1. The file-mode assertion. Delete both lines.

### The question

Two tests assert a file mode. They fail in any checkout whose umask or mount differs from
V's Mac.

### The evidence

There are exactly two mode assertions in the repository.

```
$ grep -rn "0o7777" --include=*.ts lib app scripts
lib/__tests__/reconciler-races.test.ts:718:    assert.equal(st.mode & 0o7777, 0o644, `${b.file} is mode ${(st.mode & 0o7777).toString(8)}, not 644`);
lib/__tests__/reconciler-route-artifact.test.ts:81:  assert.equal(st.mode & 0o7777, 0o644, `${ROUTE_FILE} is mode ${(st.mode & 0o7777).toString(8)}, not 644`);
```

Each comment gives the same reason in slightly different words.

```
reconciler-races.test.ts:712     "a mode change gives the same hash and is not the same committed object"
reconciler-route-artifact.test.ts:75  "a mode change hashes the same and is not the same committed object"
```

**That reason is false.** Git records the executable bit and nothing else.

```
$ git ls-files -s app/api/admin/retrieval-telemetry-reconcile/route.ts
100644 ffd77c61ef5489bfa622db07911890de55d304c4 0	app/api/admin/retrieval-telemetry-reconcile/route.ts
$ git ls-files -s | awk '{print $1}' | sort | uniq -c
   1086 100644
```

A tree entry for a regular file holds `100644` or `100755`. Group and other bits are never
stored. So `chmod 640` and `chmod 664` leave both the blob and the tree entry unchanged.
The assertion does not protect the artifact against them, because there is nothing to
protect. `chmod 777` leaves the blob unchanged too. It flips the tree entry to `100755`,
which git reports on its own.

Delete the two lines and this still runs.

| check | races, test 64 | route artifact |
|---|---|---|
| symlink | 715 | 78 |
| regular file | 716 | 79 |
| `nlink === 1` | 717 | 80 |
| SHA-256 | 733, over the file with the authorised line reverted in memory | 86, over the raw bytes |
| git blob id | **not present** | 94 |

The git blob id runs in the artifact block only. `reconciler-races.test.ts` has never held
one. Every content baseline verifies today. The mode line is the only red assertion.

### The ruling

**Delete `reconciler-races.test.ts:718` and `reconciler-route-artifact.test.ts:81`.**
Replace each with one comment that names what is no longer covered: a permission change
that does not touch the executable bit. State that git does not carry those bits, so such
a change is not a change to the committed artifact.

### Blast radius

Two lines removed. Two comments edited. No production file. The suite then runs on any
machine.

### What this is expected to fix

The suite goes from 3028 of 3030 to 3030 of 3030 in a Linux checkout. Confirm that on
the Mac as well, because the mode line passing there was never the thing under test.

---

## 2. D9's contradiction. Amend the wording. The code stands.

### The question

D9 line 559 says `aborted`, `persistence_unknown` and `telemetry_persistence_failed` are
reachable only by the reconciler. D9 line 563 says a role still at revision 0 is settled
from the failure evidence. The only mapping from that evidence produces two of those
three states.

### The evidence

The code follows the second half.

`lib/retrieval-settlement.ts:99-105`

```ts
async function stateForUnwrittenRun(
  run: LifecycleRun,
  outcomeState: RetrievalPersistenceState,
): Promise<RetrievalPersistenceState> {
  if (isAllowedTransition('started', outcomeState)) return outcomeState;
  return reconcilerStateFor('started', await failurePhasesForRun(run.runId));
}
```

`lib/retrieval-telemetry-core.ts:925-933`

```ts
export function reconcilerStateFor(
  rowState: 'started' | 'retrieval_complete',
  failurePhases: readonly string[],
): RetrievalPersistenceState {
  if (rowState === 'started') {
    return failurePhases.includes('retrieval_terminal') ? 'telemetry_persistence_failed' : 'aborted';
  }
  return failurePhases.includes('persistence_link') ? 'telemetry_persistence_failed' : 'persistence_unknown';
}
```

Line 104 passes `'started'`, so settlement can write `telemetry_persistence_failed` and
`aborted`. It cannot write `persistence_unknown`, because that branch needs
`'retrieval_complete'`.

Two committed tests pin both readings and both pass. The mapping table `SETTLEMENT_STATE`
genuinely does not name the three states. The reachability runs around the table, through
`reconcilerStateFor`.

The cost of making the code obey the literal first half:
`RECONCILER_STALE_AFTER_SECONDS` is `WORKER_MAX_DURATION_SECONDS + 1800`, about 2,600
seconds. A row whose fate is already known would sit non-terminal for about 43 minutes
and then receive the identical value from the identical mapping. The kickoff forbids
tuning that constant.

### The ruling

**Amend D9 line 559.** The three states come only from `reconcilerStateFor`, wherever it
is called. No settlement mapping table produces them. Settlement may reach them only by
calling that function for a revision-0 run, which is the same rule and not a new one.

The code does not change.

### Blast radius, documents only

| File | What changes |
|---|---|
| `CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md` | D9, line 559 |
| `lib/retrieval-settlement.ts:92-97` | the FLAGGED docstring becomes a decided one, citing this document |
| `lib/retrieval-telemetry-core.ts:869-875` | the docstring above `SETTLEMENT_STATE` says reconciler-only. Correct it to say the table does not name them |
| `lib/__tests__/retrieval-telemetry-transitions.test.ts:96-99` | assertion message reads "reachable only by the reconciler (D9)". Correct the message, not the assertion |
| `lib/__tests__/retrieval-settlement.test.ts:69` | the comment |

### The consequence V accepted

C0 query 1 counts `aborted` runs. After this ruling, `aborted` no longer means the
reconciler found the row. It means nobody ever wrote a terminal manifest, whoever noticed.
Any C0 text that reads `aborted` as a reconciler count must say so.

If that distinction is wanted later, the cheap route is one additive column recording the
writer, not a new state. That is not decided and is not in scope.

---

## 3. Per-role settlement. Defects keyed by role. One outcome per handle.

### The question

D17 gives per-row criteria for clean against partial. D12 fixes the API at one outcome
per handle. Which wins.

### The evidence

Only one handle in the tree carries two roles.

`lib/opd-note-audit.ts:1528-1533` builds `primary` plus `normative_channel`. Every other
declare site passes one run.

The defects from both roles are merged into one flat array.

`lib/opd-note-audit.ts:761, 780, 796`

```ts
  const defects: string[] = [];
  ...
    defects.push(...validateManifest({ ...primaryPayload, operational: primaryOperational }));
  ...
      defects.push(...validateManifest({ ...normPayload, operational: normOperational }));
```

`lib/retrieval-settlement.ts:141-147`

```ts
export function outcomeForOwnedSave(
  result: 'inserted' | 'updated' | 'exists' | 'skipped',
  manifestDefects: readonly string[] = [],
): SettlementOutcome {
  const base = outcomeForSaveResult(result);
  return base === 'persisted_clean' && manifestDefects.length > 0 ? 'persisted_dirty' : base;
}
```

So one defect on the normative manifest marks the **primary** row `persisted_partial`.
The store's own docstring at `lib/retrieval-telemetry-store.ts:77` concedes it:
*"`manifestDefects` is `validateManifest`'s output for whichever role was dirtiest."*

The save result is genuinely one per handle. `saveOpdAudit` runs once per audit and
returns one value. Both roles belong to one audit. So the outcome does not need to be
per role. Only the defects do.

### The ruling

**Keep D12's one outcome per handle. Pass the manifest defects keyed by role. Compute the
clean-or-partial upgrade inside the settlement loop, per run.**

Each row then states the truth about its own manifest. Neither the false partial on the
primary row nor its mirror survives.

### Blast radius

| File | Function |
|---|---|
| `lib/retrieval-settlement.ts` | `SettlementInput` gains an optional per-role defects field. The loop in `settleRetrievalTelemetry` applies the upgrade per run. `outcomeForOwnedSave` takes the base outcome only |
| `lib/opd-note-audit.ts` | `writeRetrievalTerminals` returns defects keyed by role, not one flat array. Lines 761, 780, 796, 807, 1518, 1523, 1581 |
| `lib/retrieval-telemetry-store.ts` | the `manifestDefects` docstring at line 77 |
| owners | `app/api/opd-audit/worker/route.ts:185` and `:322`, `app/api/opd-audit/run/route.ts:87`, `app/api/admin/opd-audit-mini-backfill/route.ts:183` |

Single-role callers stay byte-identical if the field is optional:
`lib/lvc.ts:250`, `lib/lab-batch.ts:301` and `:311`, `lib/mcp-tools.ts:495` and `:1159`.

### Two hazards found alongside it, not fixed by this ruling

Both come from the revision-0 rule and belong to section 2's territory. Neither is decided.

1. **The audit id can attach to `normative_channel` and not to `primary`.** If primary's
   terminal write is rejected and normative's lands, primary stays at revision 0 and is
   not linkable, and normative is. The canary gate reads "exactly one linked terminal
   retrieval run with role `primary`". That gate would then fail on a run that persisted
   correctly. **A test must cover this before the canary.**
2. Case 1's mirror, primary lands and normative does not, produces different states per
   role today and is correct under section 2's ruling.

---

## 4. The reconciler route change-detector. Keep it. Write the procedure.

### The question

Any legitimate route change fails the suite until someone updates the baseline. No
procedure for that is written down.

### The evidence

Baselines live inline in the file that hashes, at
`lib/__tests__/reconciler-route-artifact.test.ts:35-36`.

```ts
const ROUTE_SHA256 = '6ecd5b38d276802632294a192b0acb618ee1b05d815fe747890a37a900d4fd56';
const ROUTE_GIT_BLOB = 'ffd77c61ef5489bfa622db07911890de55d304c4';
```

Both match the file on disk today. The only re-baseline instruction anywhere is the
failure message at lines 87 and 88. The build report's pointer to the procedure is stale:

```
BUILD-11-AUG-2026.md:223
"The baseline is a two-line edit in reconciler-races.test.ts and the failure message says so"
```

Part VII moved the baseline. It is now in `reconciler-route-artifact.test.ts`.

Test 64's cron baselines at `lib/__tests__/reconciler-races.test.ts:692-707` have no
procedure at all, and the failure message names no fix. It reads
`something OTHER than the cron count changed`.

### The ruling

**Keep the change-detector. Write the procedure down in both pin files.**

The procedure for the route pin:

1. Confirm the route change is intended and reviewed.
2. Compute `sha256sum app/api/admin/retrieval-telemetry-reconcile/route.ts`.
3. Compute `git hash-object app/api/admin/retrieval-telemetry-reconcile/route.ts`.
4. Replace `ROUTE_SHA256` and `ROUTE_GIT_BLOB` in
   `lib/__tests__/reconciler-route-artifact.test.ts`.
5. State in the build report what changed in the route and why.

The procedure for test 64:

1. Confirm the cron-count edit is the only intended change.
2. Take the file, replace the authorised line with its historical form, and hash the
   result with SHA-256.
3. Replace `sha256At177adc9` and `line` in `CRON_BASELINE`.
4. State the change and the reason in the build report.

Also fix `BUILD-11-AUG-2026.md:223`, which names the wrong file.

### Blast radius

Comments in two test files. One line in the build report. No production file.

---

## 5. The sql-guard-core blocklist. Do not add the telemetry tables.

### The question

Should `opd_audit_retrieval_telemetry`, `opd_retrieval_invocations` and
`opd_retrieval_telemetry_failures` join `BLOCKED_RELATIONS`.

### The evidence

`lib/sql-guard-core.ts:25`

```ts
const BLOCKED_RELATIONS = /\b(traces|trace_events|appropriateness_runs|ccb_briefs|care_track_assignments|opd_audit_feedback)\b/i;
```

The list's stated criterion is raw clinical text. The telemetry manifests carry candidate
ids, counts and HMACs. `pre_rerank_passage_hmacs` holds HMACs, not passages. No manifest
field carries a note or a passage.

`opd_note_audits` is not on the list either. The requirement in the kickoff is controls no
weaker than `opd_note_audits`. So adding the telemetry tables would be stronger than the
requirement.

Two committed tests assert the literal is unchanged:
`lib/__tests__/provider-switch-unit-d.test.ts:257`, in a test titled
*"lib/sql-guard-core.ts was NOT edited by this build"*, and
`lib/__tests__/prognosis-outcomes-core.test.ts:341`.

The guard has three production call sites:
`lib/mcp-tools.ts:1254` (`audit_query`, cap from the caller),
`lib/mcp-tools.ts:912` (`labBatchStart`, cap 2000),
`app/api/admin/lab-batch/route.ts:88` (cap 2000).
All three are admin-gated.

### The ruling

**Do not add them.** The controls that apply are the ones `opd_note_audits` already has:
admin gating on every route that reads them. Close the flag at build report section 13,
item 1. `lib/sql-guard-core.ts` stays byte-identical.

---

## 6. Two gaps in the same guard. Logged. Privilege checked.

### The finding

Both are separate from the blocklist question and neither is a telemetry defect.

**Gap 1. `pg_read_binary_file` passes.** `FORBIDDEN` at `lib/sql-guard-core.ts:12` matches
the substring `pg_read_file`. The string `pg_read_binary_file` does not contain
`pg_read_file`, so the match never fires.

**Gap 2. `pg_catalog` and `information_schema` pass.** Neither regex names them.

### The privilege check, run today against the live database

```sql
SELECT current_user AS db_role,
       has_function_privilege('pg_read_binary_file(text)', 'execute') AS can_exec_read_binary_file,
       (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser
```

```json
{ "db_role": "neondb_owner", "can_exec_read_binary_file": false, "is_superuser": false }
```

**Gap 1 is not reachable.** The database role cannot execute the function and is not a
superuser. The regex hole is real and its consequence is not.

**Gap 2 is reachable.** That query read `pg_roles` through the guard, which is the proof.
Its reach is bounded by the role's own privileges, and the role is not a superuser.

### The ruling

**Log both. Do not act now.** Fixing them edits a file the kickoff forbids editing and
would break two committed tests. If either becomes a priority, it needs its own brief,
outside the telemetry build and outside the engine freeze.

Two false-positive behaviours are worth recording at the same time. The regexes run over
the raw string and do not strip literals or comments. `WHERE note = 'insert'` is rejected
as a write. A comment containing the word `traces` is rejected as a PHI relation.

---

## 7. The status union. Ratify three members.

### The question

`PerRunSettlementResult.status` ships three members. D12 declares two.

### The evidence

`lib/retrieval-telemetry-store.ts:68` ships `status: 'settled' | 'failed' | 'rejected'`.
The kickoff at line 699 declares `status: 'settled' | 'failed'`.

The build's reason, from the docstring at lines 61 to 67: a rejected write means the row
is not in the state the caller asked for. Reporting that as `settled` told every owner in
the D9 matrix that a link it never got had been made.

### The ruling

**Ratify three members.** Amend the D12 signature block at kickoff lines 686 to 701.
`noop` stays `settled`, because identical content already landed. The build's reason is
sound, and forcing the union back to two would restore a false report to every owner.

### Blast radius

The kickoff, D12. The build report Flag 1 closes. No code changes.

---

## 8. The rejected terminal write. Record the rejection. Decide the mapping later.

### The question

A rejected terminal write and a thrown one settle to different states for the same event.

### The evidence

`lib/retrieval-telemetry-store.ts:328-338`

```ts
    if (updated.length === 0) {
      // Revision mismatch, or the row is no longer `started`. NEVER RETRIED BLINDLY (D12): a blind
      // retry is how an old invocation overwrites a newer terminal result.
      console.warn('[retrieval-telemetry] terminal write rejected (revision or state moved)', role);
      return handle;
    }
    return advance(handle, role, updated[0].row_revision);
  } catch (e) {
    await failEvidence(handle.invocationId, run, 'retrieval_terminal', 'retrieval_complete', e, input.completedAt);
    return handle;
  }
```

The rejected branch writes no failure evidence. The catch branch writes
`retrieval_terminal` evidence. Both return the handle unchanged, so the role stays at
revision 0. At settlement, `reconcilerStateFor('started', phases)` then returns `aborted`
for the first and `telemetry_persistence_failed` for the second. Both mean this
invocation's manifest never landed. The state is decided by whether the failure path
happened to record anything.

### The ruling

**Replace the `console.warn` with a failure row that names its own phase.** Do not change
the state mapping yet.

The reason: a rejection can mean this invocation's write failed, or that another
invocation legitimately settled the row first. Today nothing can tell those apart, so any
mapping would be a guess. Recording the event makes it countable. Decide the mapping when
C0 shows how often each case occurs.

### Blast radius

`lib/retrieval-telemetry-store.ts`, the rejected branch inside `writeRetrievalTerminal`.
A new phase name must be added wherever phases are enumerated. **Check whether D13's
mapping table treats an unknown phase safely before adding one.** That check is owed and
has not been run.

---

## 9. Test 63 is already satisfied. No work owed.

Kickoff item 63, line 1177, asks that `lib/multi-query.ts` still contains the literal
`return [];`, asserted in this build's own tests as well as the determinism file.

`lib/__tests__/multi-query-telemetry.test.ts:110-118` asserts a superset of it.

```ts
test('the fail-open early exit still has its literal form, and this file does not quote it in a comment', () => {
  // Kickoff test 63's subject, asserted in this build's own tests as well so a later refactor sees
  // two failures rather than one puzzling pin in a determinism file.
  assert.ok(MULTI_QUERY.includes('if (result.status !== \'generated\') return [];'));
  // ⚠️ AND THE PIN MUST NOT BE SATISFIABLE BY PROSE. The comment above that statement was rewritten
  // (177adc9) precisely so it no longer contains the literal; if it did, the grep would pass over a
  // file that no longer had the statement. Counted here: the characters appear ONCE in the file.
  assert.equal((MULTI_QUERY.match(/return \[\];/g) || []).length, 1, 'the literal appears once, in the code');
});
```

Line 113 requires the whole statement, which contains the literal. Line 117 adds a
once-only count that test 63 does not ask for, and that closes the hole in the older pin
at `lib/__tests__/retrieval-llm-determinism.test.ts:34`, where a comment quoting the
characters would have satisfied the check.

**Consequence for the counts.** The where-we-are document says 23 tests written and 50
absent. It is 24 and 49.

---

## 10. The legacy-data question does not need a decision yet

The migration route halts safely by itself.

`app/api/admin/migrate-retrieval-telemetry/route.ts:40-62` runs three read-only queries,
and if the table exists with rows it returns HTTP 409 with `ok: false`,
`halted: 'table_not_empty'`, the row count and a state histogram. The `return` sits above
the DDL loop at line 72, so **no DDL statement executes on that path**.

So the stop rule turns a decision into a cheap fact. Run the migration after the deploy
and read the response. Decide the legacy-data policy only if it returns 409.

Every DDL statement is idempotent. One caveat: the three
`DROP CONSTRAINT IF EXISTS` and `ADD CONSTRAINT` pairs replace a constraint rather than
add one, so the route is idempotent but not purely additive.

---

## 11. What the next build does

In this order.

1. **Delete the two mode lines** and add the two re-baseline procedures. Smallest change,
   and it makes every later suite claim checkable outside V's Mac.
2. **Test 60 and test 1.** Ranking invariance with identical injected dependencies on both
   sides. Instrumentation off executes nothing, for all six functions. These prove the
   safety claim. Test 60 earns an independent adversarial pass. Most of the other tests do
   not.
3. **The defect-keying change** from section 3, with the canary-gate test from section
   3's hazard 1.
4. **Step 13.** One `telemetry` argument at `app/api/admin/lvc-judge-aa/route.ts:191`.
5. **The rejection failure row** from section 8, after the D13 unknown-phase check.
6. **Step 21.** The five overhead measurements.
7. **The remaining 47 tests.** Eight files. That figure follows section 9: 49 absent, less
   test 60 and test 1, which step 2 writes.
8. **Step 19.** The cost query text and the ten C0 query texts.

Carry the attack requirement into every brief from the start. Tell the build to attack its
own tests before claiming they hold, and to report the attacks that failed as well as
those that worked.

---

## 12. Still open. Not decided today.

1. The five numeric overhead guardrails. Blocked on step 21.
2. The canary date and the deploy authorisation.
3. `CDMSS_TELEMETRY_HMAC_KEY` in Vercel Production. Not checked. It gates everything
   after it.
4. Whether `RERANK_BACKEND` is set for Preview. Not checked.
5. The legacy-data policy, if and only if the migration returns 409.
6. The D13 unknown-phase check owed by section 8.
7. Whether the `aborted` distinction is worth an additive writer column. Section 2.
8. Both sql-guard gaps, logged in section 6 and deliberately not acted on.

---

## 13. What was checked today, and what was not

**Checked.** The branch state, by `git rev-parse` and `git status`. The absence of the
migration route and the key guard from `origin/main`, by `git ls-tree`. Every file path,
line number and quoted string in sections 1 to 10, by direct read of the files on the
branch. The database role's privilege on `pg_read_binary_file`, by one read-only query
against the live database.

**Not checked.** The suite. No test in this repository can run from the Cowork Linux
workspace, because `node_modules` holds the macOS esbuild binary and tsx cannot transform
any TypeScript there.

```
$ node --test --import tsx lib/__tests__/reconciler-route-artifact.test.ts
# You installed esbuild for another platform than the one you're currently using.
# Specifically the "@esbuild/darwin-arm64" package is present but this platform
# needs the "@esbuild/linux-arm64" package instead.
```

Every suite result in this document comes from an earlier run on V's Mac, or from
replicating a single assertion in plain node without the loader. Neither is a suite run.

---

## 14. What the attack on this document found

A subagent was told to break this document, not to review it. It found seven defects in
the first draft. All seven are corrected above. They belong in the errata register.

| # | Defect | Where | Fixed by |
|---|---|---|---|
| 1 | Section 1 claimed the git blob id runs in both pin blocks. `reconciler-races.test.ts` has never held one | section 1 | the per-block table |
| 2 | The section 0.1 grep as printed returns eighteen lines, not three | section 0.1 | a narrower command, plus the count |
| 3 | The supersession named `CDMSS-RERANK-TELEMETRY-CARRYOVER-13-AUG-2026.md`, which does not exist | header | the real name |
| 4 | Section 11 step 7 said 48 tests, contradicting section 9's own 49 | section 11 | 47, with the arithmetic shown |
| 5 | Three line references were off. The status union is at 68 not 66, its docstring at 61 to 67 not 59 to 65, the migration reads start at 40 not 42 | sections 7, 10 | corrected |
| 6 | Two labelled code ranges were abridged with no ellipsis | sections 8, 9 | full ranges restored |
| 7 | "Both comments give the same reason" quoted one wording as if both files held it | section 1 | both quoted |

Six claims survived the attack: the git mode reasoning, one outcome per handle, hazard 1
and its gate quote, the manifest carries no clinical text, the test 63 superset, and no
DDL on the 409 path.

The lesson from 12 August held again. **Every defect here was found by an agent told to
attack. None came from reading the draft.**
