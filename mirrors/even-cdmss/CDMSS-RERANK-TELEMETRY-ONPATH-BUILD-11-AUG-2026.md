# CDMSS Rerank Telemetry — on-path build report

**Thirteen issues, in reverse order.** Part XIII is the addendum v6 pass, 13 August 2026, on top of
`123041b`: four corrections, of which the first two are the reason the measurement could not have
run and the production denylist could not have fired. **Pass 5 was correct on all eight fixes it was
given.** Part XII is the addendum v5 pass, 13 August 2026, on top of
`cdc9c34`: eight corrections to the measurement route before it runs against anything, the highest
being a **password disclosure in the 500 body**. No new capability. It corrects two sentences in
Part XI in place. Part XI is the addendum v4 pass, 13 August 2026, on top of
`d452fec`: it builds the temporary real-database measurement route and its five-guard test, and
records V's signed Amendment 1. **It takes no measurement** — that needs a Preview deployment and a
Neon branch endpoint, which are V's steps, and this pass deploys nothing. The route is owed a
deletion and guard 5 enforces it. Part X is the addendum v3 pass, 13 August 2026, on top of
`31424cb`: it closes the safety claim on the **production** retrieval shape — `topK: 8`,
`useSourceWeights: true`, expansion and embedding live — adds the canary-gate characterization test
the decisions document requires, and reports step 21's eight overhead numbers. It **rejects nothing**
from Part IX; it adds an erratum (§12a) recording that Part IX's claim was single-configuration.
**No production file changed at all.** Part IX is the addendum v2 pass, 13 August 2026, on top of
`10f4a65`: test 60 and test 1 — the two tests that prove the safety claim — plus a shared judge
server and three corrections owed from pass 1. It **rejects nothing** from Part VIII; it corrects one
false statement Part VIII repeated and two line citations Part VIII got wrong. **No production file
changed except one comment.** Part VIII is the addendum v1 pass, 13 August 2026, on top of
`32f0f79`: four mechanical items — the two file-mode assertions deleted with both re-baseline
procedures written down, D9's wording finished at five sites, the test 63 case renumbered, and step
13 built as the five edits it actually is, with test 42 in two parts. It **rejects nothing** from
Part VII; it corrects one stale pointer in this report's §6 and amends report item 23. Part VII moves
the route pin out of the process it measures, 12
August 2026, on top of `ee92c26`: it **rejects Part VI's route artifact pin**, which five attacks
survived, and accepts everything else from that pass. Part VI is the reconciler pin, on top of
`2eeeaac`: it **rejects Part V's reconciler pin**, which seven attacks survived, and accepts Part V's
guard and cron-hash pins unchanged. Part V is the second pin repair, on top of `180e88f`. Part IV is
the first, on top of `e5dc756`. Part III is the steps 14 to 17 build, on top of `177adc9`. Part II is
the correction issue committed in `177adc9`, which withdrew twelve claims from the first issue. Part
I is in git history at `90d8db1` and is not rewritten there.

Every edit any part makes to an earlier one, in full. Part XIII edits nothing in any earlier part; it corrects a comment inside the route it shares with Part XI and XII. Part XII edits three sentences in Part XI: the 500-body claim, the response-shape count, and the expiry claim — all three struck through in place with the correction beside them. It changes nothing in Parts I to X. Part XI edits nothing in any earlier part.
Part X edits one thing in Part IX: it adds
§12a, an erratum stating that Part IX's invariance claim covers one `opts` shape and not
production's. It changes nothing in Parts I to VIII. Part IX edits two things in Part VIII: its §4
claim that `lib/retrieval-telemetry-failure-store.ts:66` was true, which it was not, and its §6 line
citation for the pinned arms. It changes nothing in Parts I to VII. Part VIII edits two things in this report: the
§6 pointer at line 223, which named the wrong file for the route baseline, and report item 23, whose
`lib/sql-guard-core.ts` question is now closed. It changes nothing in Parts I to VII beyond that.
Part VII edits one claim in Part VI: its
attack table, which reported no survivors for a pin five attacks then defeated. Part VI edits two
claims in Part V: its
reconciler attack row, which reported ten of ten caught, and its `package.json` flag, which
overstated the reach. Part V edited four sentences in Part IV: the flag count in its §1, the
oracle's reach in its §2, and the two script citations in its §2 and §4. Part IV edited one sentence
in Part III — the §3.2 citation of D11, from line 681 to 674. Part III edited one sentence in Part
II's preamble. Nothing else in any earlier part is touched.

---

# PART XIII — THE POOLER SUFFIX (on top of `123041b`)

**13 August 2026.** Governed by `CDMSS-RERANK-TELEMETRY-ADDENDUM-v6-13-AUG-2026.md`, added to the
commit unedited. Four corrections, no new capability.

**Pass 5 was correct on all eight fixes it was given.** These are defects found afterwards, and the
first is the orchestrator's own — the bare endpoint id was handed over with `-pooler` already
stripped by hand, and the build was never told to normalise the same way.

**No measurement was taken, nothing was deployed, no production database was touched, no migration
was aimed by hand, and no threshold is proposed.** Zero sockets were opened, to any host.

| | |
|---|---|
| Parent | `123041b47afb96ebc140c0fcda43d48dde4f9e49` |
| SHA-256, `CDMSS-RERANK-TELEMETRY-ADDENDUM-v6-13-AUG-2026.md` | `bc2eb98b1f3233680f42c961835badd34f93ff19a469a1b2667c32c3da17320a` |

## 1. Fix 1 — `neonEndpointId` did not strip a trailing `-pooler`

**Confirmed by measurement before anything was changed.** `grep -n "pooler"` over the route returned
nothing, and the parse against real-form hosts gave:

```text
branch POOLED  url → ep-young-moon-aofuyr1u-pooler   vs expected ep-young-moon-aofuyr1u   → endpoint_mismatch
branch direct  url → ep-young-moon-aofuyr1u          vs expected ep-young-moon-aofuyr1u   → PASSES
prod   POOLED  url → ep-super-union-aoys3lle-pooler  vs denylist ep-super-union-aoys3lle  → endpoint_mismatch
prod   direct  url → ep-super-union-aoys3lle         vs denylist ep-super-union-aoys3lle  → forbidden_endpoint
```

A real connection string uses the pooled host, so **every request would have returned
`endpoint_mismatch` and the measurement could not have run at all.**

**The fix.** One trailing `-pooler`, stripped case-insensitively after the label matches, and the two
environment values normalised the same way. Normalised **in the code, not in the variables**: telling
the operator to set the `-pooler` form instead would leave the denylist blind to the direct host,
which is the worse of the two failures.

Four stated behaviours, each with a test:

| input | result | why |
|---|---|---|
| `ep-x-pooler` | `ep-x` | the real case — Neon exposes both for one compute |
| `ep-pooler-test-000001` | unchanged | `pooler` in the middle is part of the id |
| `ep-x-pooler-pooler` | `ep-x-pooler` | one occurrence only; Neon never emits this and stripping repeatedly would invent a rule |
| `ep-pooler` | unchanged | the remainder is not a valid id, so it is not collapsed to a bare `ep` |

## 2. Fix 2 — the denylist did not fire on production's pooled host

Same root cause, higher severity. Production's pooled host parsed to `…-pooler`, the denylist held
the bare id, so `forbidden_endpoint` **did not fire**; the request fell through to
`endpoint_mismatch`. Nothing was exposed, because it still refused — but the guard that exists
specifically to catch production did not catch it, and had both variables been set to production
values the route would have run.

**Proven by execution with a pooled host, not by inspection**, as the addendum required:

- `v6 FIX 2 — production on its POOLED host refuses forbidden_endpoint, NOT endpoint_mismatch`
- `v6 FIX 2 — production on its DIRECT host also refuses forbidden_endpoint`

And the failure the addendum named directly — **both variables set to production, pooled host** —
now refuses `forbidden_endpoint` in either form:

```text
both vars = production, POOLED host   → 403 forbidden_endpoint
both vars = production-pooler form    → 403 forbidden_endpoint
```

## 3. Fix 3 — the fixtures were not shaped like real Neon hosts

`ep-measure-branch-000001` and `ep-production-primary-999999` carry no `-pooler`, so no test ever saw
a realistic pooled host and the whole class above was invisible.

**This is the same shape of error as the `u` username in pass 5, two passes running: an unrealistic
fixture hid a real behaviour.** The fixtures are now the real endpoints in the real host form,
`ep-<label>[-pooler].c-2.ap-southeast-1.aws.neon.tech`, the username is `neondb_owner`, and **the
pooled host is the default** — the direct form is the variant, because pooled is what an operator
actually pastes.

That change alone is load-bearing: reverting fix 1 now fails **12 of 31** cases rather than the two
that name it, because most of the suite runs through the pooled default.

All six mandated cases are covered, each as its own test: branch pooled vs bare expected; branch
direct vs bare expected; branch pooled vs pooled expected; production pooled; production direct; and
`ep-pooler-test-000001` unchanged.

## 4. Fix 4 — a comment recorded a conclusion the build had retracted

The route's 500-path comment said two of the three paste shapes leak and the dropped scheme does not.
Re-measured against the real driver with three usernames, reproducing the addendum's table exactly:

```text
user=u             dropped scheme     PW=no    HOST=no
user=u             wrapped in quotes  PW=LEAK  HOST=LEAK
user=u             leading psql       PW=LEAK  HOST=LEAK
user=neondb_owner  all three          PW=LEAK  HOST=LEAK
user=cdmss_user    all three          PW=LEAK  HOST=LEAK
```

**Why `u` differs, which is the useful part** and is now in the comment: `u:` is a valid URL scheme,
so `new URL('u:…')` **parses successfully** with `protocol === 'u:'` and the driver never reaches its
"not a valid URL" branch — it emits a generic format template instead. `new URL('neondb_owner:…')`
throws, because an underscore cannot appear in a scheme, and that is the path that echoes the raw
string. The real user is `neondb_owner`, so **all three shapes leak**.

The code was safe either way — nothing error-derived reaches the body — but the comment was wrong on
the highest-severity item in the place the next reader looks first.

## 5. The gate

| # | Command | Result |
|---|---|---|
| — | **map pre-gate** | **clean**; regenerated map byte-identical to `123041b` |
| 1 | `npm test` | **GREEN — 3084 of 3084** (3076 at the parent, +8 cases) |
| 2 | `npm run typecheck` | clean |
| 3 | unkeyed production build / keyed build | fails naming the key / succeeds |
| 4 | `npm run architecture:check` | all 8 rules + coverage green |
| 5–6 | map + determinism | unchanged, exit 0, nothing staged |
| 7 | reasoning registry | unchanged |
| 8–9 | governance / changelog | GREEN |

Guard test wall clock **8.35 s** for 31 cases, up from 5.77 s for 23. `PEERS (none)`, `DNS (none)`
in parent and all children.

## 6. Every attack, including the ones that broke nothing

| # | Attack | Expected | Observed |
|---|---|---|---|
| 1 | revert fix 1 — pooled branch case | must fail | **fails**, `403 !== 200`: the measurement is blocked, exactly as measured before the fix |
| 2 | revert fix 1 — production pooled case | must fail on `forbidden_endpoint` | **fails**, `'endpoint_mismatch' !== 'forbidden_endpoint'` — the denylist is blind, confirming fix 2's root cause |
| 3 | feed `ep-pooler-test-000001` | must not truncate to `ep` | **not truncated**; it matches itself, and expecting `ep` refuses |
| 4 | feed `-pooler-pooler` | decide, state, test | **one strip on each side**: doubled host matches a doubled expectation; a single-`pooler` or bare expectation refuses |
| 5 | pooled host with pooled id, and with bare id | both must pass | **both pass** |
| 6 | did any refusal body gain a field? | none may | **none did** — every 403 is exactly `{ok, refused}`; the 410 keeps its four, unchanged from v5 |
| 7 | can stripping make two DIFFERENT endpoints equal? | must not | **cannot** — all four pooled/direct combinations of two different endpoints still refuse `endpoint_mismatch` |

**Nothing broke nothing**: every attack landed on at least one assertion, and attacks 1 and 2
reproduced the two headline defects precisely.

**One failure was mine, not the code's.** My first `-pooler-pooler` case asserted that a doubled host
would match a *single* `-pooler` expectation — forgetting that the expectation is normalised too. The
route was right; the test was wrong. That symmetry is the whole point of normalising in the code
rather than in the variables, and the corrected case now states it.

## 7. Owed, unchanged

1. **DELETE THIS ROUTE** and its test before `exp/rerank-telemetry` merges anywhere; guard 2's
   expiry of **2026-08-20** enforces the date. Remove `CDMSS_OVERHEAD_MEASURE`,
   `CDMSS_OVERHEAD_DB_ENDPOINT`, `CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT` and the branch-scoped
   `DATABASE_URL` from Vercel at the same time, and delete the Neon branch.
2. **The measurement has still not been taken.** Part XI §4's cells are still empty. V's variables
   stay exactly as they are — **bare ids, no `-pooler`** — because the route now normalises both
   forms.
3. §5's row-count verification, the 35-vs-36 topology figure, and the region finding (Part XI §9.4)
   are all unchanged and still owed.

---

# PART XII — EIGHT CORRECTIONS BEFORE THE MEASUREMENT RUNS (on top of `cdc9c34`)

**13 August 2026.** Governed by `CDMSS-RERANK-TELEMETRY-ADDENDUM-v5-13-AUG-2026.md`, added to the
commit unedited. **No new capability.** Eight defects an adversarial pass found in `cdc9c34`, the
highest of which is a password disclosure. The route ran against nothing before these landed and
still has not: **no measurement was taken, nothing was deployed, no production database was touched,
no migration was aimed by hand, and no threshold is proposed.** Zero sockets were opened, to any
host.

| | |
|---|---|
| Parent | `cdc9c34e04f4adceb06cdfb03d55fc896bae33d3` |
| This commit | *on top of `cdc9c34`, not an amend and not a rebase* |
| SHA-256, `CDMSS-RERANK-TELEMETRY-ADDENDUM-v5-13-AUG-2026.md` | `43842c5eeeaa3c055253d5f80900740d7c077312f167eb7a9e3bde7fdd896960` |

## 1. Fix 1 — the 500 body leaked the database password

**Confirmed against the real driver before changing anything, and the addendum's claim held.**
When `DATABASE_URL` fails `new URL` but satisfies the hand parse, `neon()` puts the entire
connection string into its throw, and the route returned that message sliced to 200 characters —
more than enough for user, password and host. `lib/admin-gate.ts` returns `null` when `ADMIN_TOKEN`
is unset, so the route may be open, which makes it a disclosure to anyone who can reach the URL.

Measured, with a realistic username:

```text
value still wrapped in quotes  →  Connection string: "postgresql://cdmss_user:PASSWORD@ep-….neon.tech/db"
a leading `psql `              →  Connection string: psql postgresql://cdmss_user:PASSWORD@ep-….neon.tech/db
a dropped `postgresql://`      →  Connection string: cdmss_user:PASSWORD@ep-….neon.tech/db
```

**⚠️ I NEARLY FILED A FALSE CORRECTION AGAINST THIS, AND IT IS WORTH RECORDING.** My first probe used
the one-character username `u`, where `u:` parses as a URL scheme and the driver emits a different,
non-leaking message. On that evidence I was about to report "two of the three shapes leak, not
three". Re-running with a realistic username showed **all three leak**. The addendum was right and my
correction was wrong; the only reason it did not reach this report is that the test fixture used a
realistic username and disagreed with me.

**The fix.** The 500 body carries a fixed sentence plus `(e as Error).name` — the constructor name,
which never carries operator input — and **nothing else derived from the caught error**. Not sliced,
not sanitised, not included. Both `steps` values are fixed strings (`schema`, `audit_id`) and were
checked for the same property.

**Test:** `FIX 2 + FIX 1 — a REAL 500 …` asserts status 500, the fixed sentence, a short
`error_class`, and that no part of the connection string appears anywhere in the child's output.

## 2. Fix 2 — the test for that path never ran

The old case was keyed on `CDMSS_OVERHEAD_FORCE_DB_ERROR`, which **nothing in the repository reads**,
so it silently duplicated the all-pass case and the 500 shape had never been exercised at all.

**The fix, taking the addendum's preferred option:** drive the real defect rather than simulate it.
A `DATABASE_URL` with the scheme dropped parses to the expected endpoint, passes every guard, and
makes `neon()` throw inside the route. The variable is gone.

## 3. Fix 3 — guard 5 parsed the wrong part of the string

The old parse took the last `@` in the **whole** string, so a query parameter could move the parsed
host while the driver connected elsewhere:

```text
postgresql://u:pw@ep-production-999999.…/db?x=@ep-measure-000001.…
parsed by the old code   ep-measure-000001      ← allowed
connected by the driver  ep-production-999999   ← exactly what the guard exists to prevent
```

**The fix.** The authority is cut off first — at the first `/`, `?` or `#` after the scheme — and the
last `@` is taken **within it**. The hand parse stands; `new URL` is still not used, because its
error object retains the input.

**Test:** `FIX 3 — a query parameter cannot move the parsed host …`. The bypass URL is now refused,
and it is refused by the **denylist**, because the authority names the forbidden endpoint.

**A second effect, found by testing.** The stricter parse also refuses the wrapped-in-quotes and
leading-`psql ` shapes outright, before the driver ever sees them — so the two worst leak paths are
now closed twice: once by never returning the error, once by never reaching it.

## 4. Fix 4 — the denylist, because an allowlist of two operator-set variables cannot tell which side is wrong

The design problem rather than the bug. Guard 5 compared two variables V sets and had no independent
knowledge of which endpoint is production. Debugging a refusal late, the natural move is to change
the variable you just added rather than the one that was already there — and that single paste would
have opened the route onto production.

**The fix.** `CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT` holds the production endpoint id and is checked
**before** the equality clause. Setting the expected value to production's id now still refuses, with
the distinct word `forbidden_endpoint` and nothing else in the body. **An absent denylist refuses
too** (`no_denylist`): a denylist that is not there is not a denylist.

**Tests:** two — the production-id-on-both-variables case, and the unset case.

## 5. Fix 5 — the p99 was the maximum

At the default `n = 50`, one sample is consumed as `first_statement_in_process`, 49 remain, and
nearest-rank p99 over 49 returns index 48: the largest sample. `p99 === max` for every n up to 99.
The route printed p95, p99 and max side by side with no floor and no warning, which addendum v4 §4
had warned about in as many words.

**The fix.** `p95` is emitted only at n ≥ 40 and `p99` only at n ≥ 200. Below the floor the value is
`null` and a sibling field names the floor that was not met.

**Tests:** two. At n = 50 (49 surviving) `p99` is null with `p99_withheld` naming the 200 floor,
while `p95` **is** reported because its floor is 40 — and at n = 11 (10 surviving) `p95` is withheld
too. The second case exists because a floor that always refuses is as useless as no floor.

**⚠️ My first version of that test asserted `p95` was also withheld at n = 49 and failed. The route
was right and the test was wrong** — the addendum sets p95's floor at 40, and 49 clears it.

## 6. Fix 6 — statement 1 had no cell

The topology is 3 + 4N. Boundary 1 timed `declareRetrievals`, which is statements 2 and 3;
`startInvocation` — the `INSERT INTO opd_retrieval_invocations` — was called untimed inside that
cell. So 34 of 35 statements had a cell and any batch-level total built from the cells was short by
exactly one statement.

**The fix, taking both halves the addendum offered.** A `start_invocation` cell now times it, **and**
the `declare` response carries `batch_total_note` saying plainly that it is a two-statement figure
and that the batch total is `start_invocation` + `declare`.

## 7. Fix 7 — the shape label was false for four cell types

`shape: { max, conc }` was echoed into every response, including the four per-note cells, which run
exactly one declared run per iteration whatever `max` says. Part XI recorded `terminal_primary` and
`settle_primary` at shape `8/8` when the batch was size 1. The latency was unaffected; the
provenance was wrong, which is worse in a report V reads to set guardrails.

**The fix.** `shape` is `{ batch_size: max }` for the batch cell and `{ batch_size: 1 }` for per-note
cells, with `shape_note` saying which it is. **`conc` is removed entirely**, not merely ignored: it
never ran anything concurrently in any cell, and implementing it would introduce contention, which is
a different experiment from the one D18 asks for. The response now says
`concurrency: NOT EXERCISED anywhere in this route` once, instead of implying otherwise in every
row. The test asserts `conc` is absent from the route's source, not just unused.

## 8. Fix 8 — the real-audit arm could silently become the null arm

If `SELECT id FROM opd_note_audits` returned nothing, `auditId` was null while `audit_mode` still
read `"real"` — so two runs differing only in that string would be read as the foreign-key comparison
when they were the same measurement twice.

**The fix.** The real arm **refuses** (409, `no_audit_id`) rather than measuring.

**One scoping decision the addendum left open, taken deliberately and flagged.** The refusal applies
only to the cells that **consume** the id — the settlement boundary is the only one that binds
`audit_id`. A `declare` or `activerun` run on a branch with no audits measures nothing false and is
not refused, and those cells now report `audit_mode: 'n/a — this cell does not bind audit_id'`. A
blanket refusal would have blocked every cell on any branch without audit rows, which is not what
fix 8 is protecting.

## 9. §9.1 — the expiry now runs second

Part XI claimed "after 2026-08-20 every request is 410 whatever else is configured". With the expiry
running **fifth** that was false: anything failing guards 2, 3 or 4 got a 403 after the expiry and
never saw a 410, so the deletion deadline did not mean what the report said. **The expiry moved to
position two, directly after admin** — the first position where the claim can be true. The guard
order is now:

```text
1  admin              requireAdmin alone
2  expiry             hard UTC 2026-08-20 → 410
3  preview            VERCEL_ENV=preview AND VERCEL_GIT_COMMIT_REF=exp/rerank-telemetry
4  armed              CDMSS_OVERHEAD_MEASURE=1
5  database identity  NOT the forbidden endpoint, AND equal to the expected one
```

All five guard-case titles and every in-file cross-reference were renumbered to match; a stale
number in a comment is how the next reader gets this wrong.

## 10. §9.2 — the response shapes, and which were unexercised

Part XI said "all eight response shapes". That was **eight test cases covering five shapes**. The
route can return **seven** statuses, and after this pass **every one is exercised** by the leak check,
which asserts the set explicitly so a new shape cannot be added without covering it:

| status | shape | covered before | covered now |
|---|---|---|---|
| 401 | admin refusal | ✗ | ✓ |
| 410 | `expired` | ✓ | ✓ |
| 403 | `not_preview` | ✓ | ✓ |
| 403 | `not_armed` | ✓ | ✓ |
| 403 | `no_denylist` | — new | ✓ |
| 403 | `forbidden_endpoint` | — new | ✓ |
| 403 | `endpoint_mismatch` | ✓ | ✓ |
| 409 | `no_audit_id` | — new | ✓ |
| 400 | unknown cell | ✗ | ✓ |
| 500 | driver throw | ✗ (the case never ran) | ✓ |
| 200 | success | ✓ | ✓ |

**Nothing remains unexercised.** The leak check also now searches the child's **stdout and stderr**,
not only the parsed `RESULT` line — the old harness would have missed a driver message printed by a
`console.error`.

## 11. The gate

| # | Command | Result |
|---|---|---|
| — | **map pre-gate, RESTORED** | **empty — the map did not move**; no new imports |
| 1 | `npm test` | **GREEN — 3076 of 3076** (3066 at the parent, +10 guard cases) |
| 2 | `npm run typecheck` | clean |
| 3 | `npm run build`, unkeyed production | fails as required, naming `CDMSS_TELEMETRY_HMAC_KEY` |
| 3 | `npm run build`, keyed | succeeds; `ƒ /api/admin/telemetry-overhead 600 B` |
| 4 | `npm run architecture:check` | all 8 rules + coverage green |
| 5 | `npm run architecture:map` | byte-identical to `cdc9c34` |
| 6 | determinism | exit 0, nothing staged |
| 7 | `npm run reasoning:registry && git diff --exit-code …` | exit 0, unchanged |
| 8 | `npm run reasoning:governance` | GREEN: 0 ungoverned model calls |
| 9 | `npm run changelog:coverage` | GREEN |

**Wall clock:** `telemetry-overhead-guard.test.ts` — **5.77 s** for 23 cases and roughly 30 child
processes, up from 3.07 s for 13.

**No socket to anything, including loopback.** Measured under a `--require` preload recording each
socket's own `remoteAddress` on `connect` plus every `dns.lookup`, propagated to children via
`NODE_OPTIONS`: `PEERS (none)`, `DNS (none)`, parent and all children.

## 12. Every attack, including the ones that broke nothing

The addendum's seven, plus six of my own deleting each fix in turn — because a fix whose test does
not depend on it is decoration.

| # | Attack | Expected | Observed |
|---|---|---|---|
| 1 | each of the three unparseable shapes from fix 1 | body carries no part of the URL | **none does**, in body, stdout or stderr. Two are refused at guard 5 before the driver; the third reaches the 500 and carries a fixed sentence |
| 2 | the `?x=@host` bypass from fix 3 | guard 5 refuses | **refuses**, as `forbidden_endpoint` |
| 3 | expected = production id, denylist = same | `forbidden_endpoint` | **refuses**, body has exactly two keys |
| 4 | unset `CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT` | must refuse | **refuses**, `no_denylist` |
| 5 | a cell at n=50 | `p99` null with a floor field | **null**, `p99_withheld` names the 200 floor. `p95` is a number, correctly — its floor is 40 |
| 6 | real-audit arm with no `opd_note_audits` rows | must refuse | **refuses**, 409 `no_audit_id` |
| 7 | delete each guard in turn | its tests fail | **all fail** — see below |
| A | delete the denylist clause | fix 4's tests fail | **2 fail** |
| B | delete the absent-denylist refusal | its test fails | **1 fails** |
| C | revert fix 3 to the whole-string `@` | the bypass test fails | **2 fail** |
| D | restore the truncated error in the 500 body | the leak tests fail | **2 fail**, naming the leaked credential: `the 500 path leaked "cdmss_user…"` |
| E | remove the p99 floor | fix 5's tests fail | **2 fail** |
| F | revert fix 8 | its test fails | **2 fail** |

**Nothing in this pass broke nothing** — every one of the thirteen attacks landed on at least one
assertion. The two failures that mattered were mine, not the code's: the false correction in §1, and
the wrong p95 expectation in §5. Both were caught by running the thing rather than reasoning about
it, which is the third and fourth time in this workstream that has been the deciding factor.

## 13. Owed, unchanged and re-stated

1. **DELETE THIS ROUTE** and its test before `exp/rerank-telemetry` merges anywhere. Guard 2's hard
   expiry of **2026-08-20** is the enforcement. Remove `CDMSS_OVERHEAD_MEASURE`,
   `CDMSS_OVERHEAD_DB_ENDPOINT`, **`CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT`** and the branch-scoped
   `DATABASE_URL` from Vercel at the same time, and delete the Neon branch.
2. **The measurement has still not been taken.** Part XI §4's cells are still empty and Part XI §8's
   six steps still stand, with one addition from addendum v5 §13: set
   `CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT` to the **production** endpoint id, Preview scope, before
   deploying — the route refuses without it.
3. §5's row-count verification is still owed, for the non-exposure collision recorded in Part XI §5.
4. The topology figure is still 35 by source and 36 by the addendum; branch verification is owed.
5. The region finding (Part XI §9.4) is unchanged and still V's call.
6. Carried forward, untouched: step 19's query texts, the remaining 38 tests, per-role manifest
   defects, the `retrieval_terminal_rejected` phase, the discriminated union, and Part X's findings
   10a and 10b.

---

# PART XI — THE MEASUREMENT ROUTE AND ITS FIVE GUARDS (on top of `d452fec`)

**13 August 2026.** Governed by `CDMSS-RERANK-TELEMETRY-ADDENDUM-v4-13-AUG-2026.md`, added to the
commit unedited.

**⚠️ THIS PASS BUILDS THE INSTRUMENT. IT DOES NOT TAKE THE MEASUREMENT.** The numbers addendum v4 §4
asks for require a Vercel Preview deployment pointed at a non-production Neon branch, with
`CDMSS_OVERHEAD_MEASURE`, `CDMSS_OVERHEAD_DB_ENDPOINT` and a branch-scoped `DATABASE_URL` set by V.
This pass deploys nothing and touches no database. **Every latency cell in §4 below is empty and is
V's to fill.** What is delivered and proven here is the route, its five guards, and the guard test.

**Nothing was deployed, no migration was aimed by hand, no production database was touched, and no
threshold is proposed.** The only files changed are the four addendum v4 §6 authorises plus the
architecture map it predicts. No socket was opened to any host at all — not even loopback.

## 1. Commit, document hash, and the signed amendment

| | |
|---|---|
| Parent | `d452fecca6851ede6bb34a524bee22f664b76407` |
| This commit | *on top of `d452fec`, not an amend and not a rebase* |
| SHA-256, `CDMSS-RERANK-TELEMETRY-ADDENDUM-v4-13-AUG-2026.md` | `989b2ea86fc3ebd75ab41f987a20b7717b12b0baff680072e4161c00e364188b` |

**Amendment 1, as V signed it, verbatim:**

> **Amendment 1 to PRD v2.1 section 6.5 and kickoff D18, made before any canary opens.**
>
> Synthetic microbenchmark evidence, as D18 specifies it, establishes the absence of an
> algorithmic blow-up. It does not set production timing guardrails and may not be used to
> approve a deployment.
>
> A second measurement is authorised and required: a production-shaped run against a
> non-production Neon branch, from a Vercel Preview deployment in the deployment's own
> region. D18's prohibition on deploying to measure is lifted for Preview only. **The
> prohibition on the production database stands without exception, and section 3's
> database-identity guard is the mechanism, not a promise.**
>
> Numeric pre-canary guardrails are set from the second measurement. Canary rollback
> triggers are a separate instrument, preregistered before exposure, and are not a
> substitute for pre-canary evidence.

PRD line 298: an amendment made before a canary opens is not a waiver. This is before.

## 2. The gate

| # | Command | Result |
|---|---|---|
| 1 | `npm test` | **GREEN — 3066 of 3066** (3053 at the parent, +13 guard cases) |
| 2 | `npm run typecheck` | clean |
| 3 | `npm run build`, unkeyed production | **fails as required**, naming `CDMSS_TELEMETRY_HMAC_KEY` |
| 3 | `npm run build`, keyed | **succeeds**; `ƒ /api/admin/telemetry-overhead 600 B` |
| 4 | `npm run architecture:check` | all 8 rules + coverage green |
| 5 | `npm run architecture:map` | **+1 edge, exactly as predicted** — see below |
| 6 | determinism | exit 0; only `map.generated.ts` staged, which this pass commits |
| 7 | `npm run reasoning:registry && git diff --exit-code …` | exit 0, unchanged |
| 8 | `npm run reasoning:governance` | GREEN: 0 ungoverned model calls |
| 9 | `npm run changelog:coverage` | GREEN: 19 engine versions documented |

**The map pre-gate is suspended for this pass only**, per addendum v4 §6, because the route imports
`createTelemetryCapture` and `buildRetrievalPayload`. The regenerated map differs from `d452fec` by
**exactly one edge and nothing else**:

```diff
+  {
+    "from": "app/api",
+    "to": "retrieval-capture",
+    "kind": "value"
+  },
```

No other edge appeared. `kind` is `value`, not `type`, which is correct: both imports are values.

**Wall clock.** `lib/__tests__/telemetry-overhead-guard.test.ts` — **3.07 s** for 13 cases, each
spawning its own child process. That is the whole cost of the child-process design and it is worth
it: three of the five guards read `process.env` at request time and one reads the clock.

**No socket to anything but `127.0.0.1` — in fact, none at all.** Measured under a `--require`
preload that records each socket's own `remoteAddress:remotePort` on `connect` plus every
`dns.lookup`, propagated to the children via `NODE_OPTIONS`:

```text
parent and all 13 children     PEERS (none)     DNS (none)
```

The child installs `telemetry-db-stub` before the route runs, so even the all-guards-pass case —
which proceeds into the DDL and a measurement cell — never leaves the process. The `DATABASE_URL`
used in the tests is a syntactically valid but entirely fictional endpoint.

**`RERANK_BACKEND` and `OPENROUTER_API_KEY` before deletion:** both **unset**, as were
`CDMSS_OVERHEAD_MEASURE`, `CDMSS_OVERHEAD_DB_ENDPOINT`, `DATABASE_URL` and `VERCEL_ENV`. This machine
has no production credentials in its environment, which is also why guard 4 could not be exercised
against a real endpoint here.

## 3. The route and its five guards

`app/api/admin/telemetry-overhead/route.ts`. **POST only**, `runtime = 'nodejs'`,
`maxDuration = 800`. Guards run in this order and all five must pass:

| # | Guard | Refusal |
|---|---|---|
| 1 | `requireAdmin(req)` **alone** — no `isAdminUnlocked()` clause | 401, from the gate itself |
| 2 | `VERCEL_ENV === 'preview'` **and** `VERCEL_GIT_COMMIT_REF === 'exp/rerank-telemetry'` | 403 `not_preview` |
| 3 | `CDMSS_OVERHEAD_MEASURE === '1'` | 403 `not_armed` |
| 4 | **Neon endpoint id === `CDMSS_OVERHEAD_DB_ENDPOINT`** | 403 `endpoint_mismatch`, and nothing else |
| 5 | Hard UTC expiry `2026-08-20T00:00:00Z` | 410 `expired` |

**Guard 4 is the one that matters, and it is a mechanism rather than a promise.** The branch is a
copy-on-write clone, so row counts and schema are identical to production — **no content check can
tell them apart** and the host is the only discriminator. The endpoint id is parsed by hand rather
than with `new URL`: the substring after the **last** `@`, stopped at the first `/`, `?`, `#` or `:`,
then the leading `ep-…` label. A password containing `@` therefore cannot shift the parsed host, and
that is a test case. **Every failure direction is "do not run"**: an absent expectation refuses, an
unparseable URL refuses, a mismatch refuses.

**Nothing anywhere logs, echoes or returns any part of `DATABASE_URL`.** Guard 4 returns one word.
~~The 500 path truncates the driver message to 200 characters.~~ <!-- CORRECTED by Part XII, addendum
v5 fix 1: truncating was not enough. `neon()` puts the WHOLE connection string, password included,
into its throw on three ordinary paste mistakes, and 200 characters is more than enough for all of
it. The 500 body now carries a fixed sentence plus the error's class name and nothing derived from
the error. --> **The 500 path returned a truncated driver message, and that was a password
disclosure — see Part XII §1.**

~~Both are checked against every connection-string substring across all eight response shapes.~~
<!-- CORRECTED by Part XII, addendum v5 §9.2: that was eight test CASES covering FIVE shapes.
401, 400 and 500 were unexercised. All are covered now; see Part XII §10. -->
**They are checked against every connection-string substring across five of the route's response
shapes; three more are covered as of Part XII.**

**Guard 5 is the only enforcement that this route is deleted**, because nothing in CI enumerates
routes and a note in a report is not a mechanism. ~~After 2026-08-20 every request is 410 whatever
else is configured.~~ <!-- CORRECTED by Part XII, addendum v5 §9.1: guard 5 ran FIFTH, so a request
failing guards 2, 3 or 4 got a 403 after the expiry and never a 410. The expiry now runs SECOND. -->
**After 2026-08-20 every AUTHENTICATED request is 410 whatever else is configured — true only
because Part XII moved the expiry to position two.**

### The five-guard test — 13 cases, all green

| Case | Result |
|---|---|
| Guard 1: `ADMIN_TOKEN` set, nothing presented | **401**, and `isAdminUnlocked` absent from the route's code |
| Guard 2: `VERCEL_ENV=production`, everything else correct | **403 `not_preview`** |
| Guard 2: preview but `VERCEL_GIT_COMMIT_REF=main` | **403 `not_preview`** |
| Guard 3: `CDMSS_OVERHEAD_MEASURE` unset | **403 `not_armed`** |
| Guard 4: endpoint set to a *different* (production-shaped) id | **403 `endpoint_mismatch`**, body has exactly two keys |
| Guard 4: expectation **unset** | **403 `endpoint_mismatch`** — refuses, does not pass |
| Guard 4: unparseable `DATABASE_URL` | **403 `endpoint_mismatch`** |
| Guard 4: password containing `@` | **200** — the last `@` wins, so the real host is read |
| Guard 5: clock one second past the expiry | **410 `expired`** |
| Guard 5: one second before | **200** — the check discriminates, it does not always refuse |
| All five pass | **200**, `route_written_as: 'script'`, first sample separated with `n=1` |
| No response carries any `DATABASE_URL` substring | green across all eight shapes |
| POST-only, expiry constant, deletion notice in source | green |

## 4. What is measured, and what is still empty

The route takes `?cell=&max=&conc=&n=&audit=` and measures **one cell per invocation**, because
`maxDuration` is 800 s and at a 68 ms floor the full matrix at p99 needs far more than that buys.

| # | Boundary | Cell name | Per |
|---|---|---|---|
| 1 | declaration insert **plus** invocation counter update | `declare` | **batch** |
| 2 | terminal update | `terminal_primary`, `terminal_normative` | note |
| 3 | settlement read **plus** update | `settle_primary`, `settle_normative` | note |
| 4 | `activeRun('opd')` | `activerun` | note, + DDL on the first call in a process |

Shapes: `max=8 conc=8` (production default), `max=1 conc=1`, `max=30 conc=8`. `max` is the batch size
the declaration insert carries; **`conc` is recorded as provenance only** — the per-note boundaries
are measured serially, so concurrency is not exercised, and the response says so rather than implying
otherwise.

**Every latency cell below is empty.** Filling them is V's step, and §9 says exactly how.

| Cell | shape | first-statement-in-process (n=1) | min | median | p95 | p99 | max | n |
|---|---|---|---|---|---|---|---|---|
| `declare` | 8/8 | — | — | — | — | — | — | — |
| `declare` | 1/1 | — | — | — | — | — | — | — |
| `declare` | 30/8 | — | — | — | — | — | — | — |
| `terminal_primary` | 8/8 | — | — | — | — | — | — | — |
| `terminal_normative` | 8/8 | — | — | — | — | — | — | — |
| `settle_primary` | 8/8 | — | — | — | — | — | — | — |
| `settle_normative` | 8/8 | — | — | — | — | — | — | — |
| `activerun` | 8/8 | — | — | — | — | — | — | — |

**The first sample of each invocation is reported on its own, labelled `first-statement-in-process`,
with `n = 1`, and never enters a percentile column.** It is not called cold: cold cannot be forced
in-process, because `ensured` in `lib/backfill-runs.ts:39` is module state with no reset and no
export. One request is one process, so that sample absorbs TLS setup and, if the branch compute has
scaled to zero, a resume of hundreds of milliseconds.

**Settlement uses a real `opd_note_audits` id.** `audit_id` is `REFERENCES opd_note_audits(id)`, so
production's `UPDATE` carries an index probe into the largest table in the schema; passing `null`
omits it and reads systematically low with nothing in the output to show it. The route selects a real
id from the branch and reports which arm it ran. `?audit=null` runs the comparison arm.

Every response carries the label `SYNTHETIC-AGAINST-A-BRANCH. Not a production measurement. No
threshold is proposed.`

## 5. The SQL topology, derived from source — and a correction to the addendum's arithmetic

Enumerated from the code, not from a document:

```text
BATCH LEVEL (once per invocation / declaration batch)
  1  INSERT INTO opd_retrieval_invocations …            lib/retrieval-invocation-store.ts:35
  2  INSERT INTO opd_audit_retrieval_telemetry …        lib/retrieval-telemetry-store.ts:177   (multi-row)
  3  UPDATE opd_retrieval_invocations SET declared_… +  lib/retrieval-invocation-store.ts:59

PER NOTE
  4  UPDATE … SET persistence_state = 'retrieval_complete'   lib/retrieval-telemetry-store.ts:269
  5  SELECT persistence_state, row_revision, audit_id        lib/retrieval-telemetry-store.ts:438
  6  UPDATE … SET persistence_state = $3, audit_id = $4      lib/retrieval-telemetry-store.ts:464
  7  SELECT … FROM backfill_runs WHERE worker = $1           lib/backfill-runs.ts:84  (activeRun, warm)
```

So the shape is **3 + 4N**, which is **35 at N = 8** — not the addendum's `4 + 4N` = 36. The
difference is one statement at batch level; the addendum's figure appears to count `activeRun`'s
first-call cost or the invocation insert differently. **Addendum v4 §5 and §13 say 36; the source says
35.** Reported rather than reconciled, because the addendum also says to verify against the branch
and that verification has not happened.

Both figures agree on the point §13 actually turns on: **the per-note serial chain is three
statements, not five** — the declaration insert and the counter update are batch-level. At a 68 ms
floor that is roughly **204 ms added per note**, plus about 17 ms of amortised batch cost at N=8,
best case, against an idle branch with no contention.

**⚠️ THE ROW-COUNT VERIFICATION HALF OF §5 IS NOT IMPLEMENTED, AND THE REASON IS A REAL COLLISION.**
`lib/__tests__/telemetry-non-exposure.test.ts` fails on any `FROM <telemetry table>` in a file outside
its `ALLOWED` set, and that test file is **not** on addendum v4 §6's contract, so it cannot be
extended. The first version of the route did `SELECT count(*) FROM opd_audit_retrieval_telemetry`
and the suite caught it. There were two ways to keep the number:

1. extend the non-exposure allow-list — forbidden by §6;
2. build the table name dynamically so the source-text scan cannot see it — which is **evading a
   privacy control by obfuscation**, and is worse than not having the number.

Neither was taken. The route now reads **nothing** from the three telemetry tables: `to_regclass`
asks the catalog whether a relation exists and reads no row of it. **§5's row-count verification is
owed** and is listed in §9.

## 6. The route creates its own tables, and two deliberate deviations

The Neon branch was cloned from `main`, and `main` has none of the three telemetry tables — so there
is nothing to write to until the route creates them. It does that **itself, after guard 4**, and
**no human is told to POST the migration route at a preview**: that endpoint is aimed by hand and the
failure mode is aiming it at production.

Two deviations from the migration route's stop rule, both flagged rather than quiet:

1. **A second invocation always finds rows** — its own, from the previous cell — and §4 requires one
   cell per invocation, so a literal 409 would make the matrix unreachable after the first call. The
   decision is taken on **existence alone**: absent ⇒ create, present ⇒ skip the DDL entirely. That
   is strictly safer than the migration route, because on the present branch no constraint is touched.
2. **The emptiness count is gone**, for the non-exposure reason in §5.

Every row this route writes carries **`route = 'script'`** (addendum v4 §7):
`/api/admin/telemetry-overhead` is not a member of the closed `InvocationRoute` union at
`lib/retrieval-telemetry-core.ts:197` and adding one is forbidden by §6. `script` is an existing
member, honest about what this is, and keeps every synthetic row separable from real traffic by one
predicate. **Those rows live only on the branch.**

## 7. Every attack, including the ones that broke nothing

| # | Attack | Expected | Observed |
|---|---|---|---|
| 1 | `CDMSS_OVERHEAD_DB_ENDPOINT` = a production endpoint id | guard 4 refuses | **refuses**, 403 `endpoint_mismatch` — permanent case |
| 2 | `CDMSS_OVERHEAD_DB_ENDPOINT` unset entirely | refuses, not passes | **refuses** — permanent case |
| 3 | `VERCEL_ENV=production`, all else correct | guard 2 refuses | **refuses** — permanent case |
| 4 | `VERCEL_ENV=preview`, ref `main` | guard 2 refuses | **refuses** — permanent case |
| 5 | clock past the expiry | 410 | **410** — permanent case |
| 6 | settlement `auditId: null` vs a real id | report both and the gap | **NOT MEASURABLE HERE.** Against the stub there is no `opd_note_audits` table and no FK, so both arms are identical and the route reports `NONE FOUND on the branch`. The parameter and the reporting are built and tested; **the gap is V's to measure** |
| 7 | run the same cell twice in one invocation | does sample 1 differ? | **yes, markedly, even with no network**: `declare` first 0.175 ms vs median-of-rest 0.045 ms (**3.9×**); `settle_primary` 0.250 vs 0.042 (**6.0×**); `activerun` 0.066 vs 0.007 (**9.9×**). Pure JIT and module warm-up against a stub — against a branch, TLS and a possible compute resume are added on top. This is the evidence for §4's rule that the first sample is `n=1` and never a percentile |
| 8 | any error path returns a `DATABASE_URL` substring | none may | **none does**, across all eight response shapes — permanent case |
| A | delete guard 4 from the route | its three cases fail | **all three fail** — the guard is real, not source decoration |
| B | guard 2 checks only `VERCEL_ENV` | the promoted-build case fails | **fails** |
| C | push the expiry out a year | the 410 case fails | **fails**, and the source-pin case with it |

Attacks A, B and C are mine, not the addendum's: §3 says a guard that exists only in source is not a
guard, so each guard was deleted in turn to confirm its test actually depends on it.

**⚠️ Attack 7 also exposed a limitation of the stub-side smoke run, recorded so nobody reads those
numbers as latencies.** The `settle_*` cells against the stub log `terminal write rejected` and
`settlement rejected: no_row`, because the stub returns `[]` for the compare-and-set. So the stub
timings measure the **rejection** path, not the success path. That does not affect the route — against
the branch the rows exist and the writes land — but it means the only trustworthy thing attack 7
shows is the *ratio* between the first sample and the rest, not any absolute figure.

## 8. What V does to take the measurement

1. Create the Neon branch from production and note its `ep-…` endpoint id.
2. In Vercel **Preview** scope only, set `CDMSS_OVERHEAD_MEASURE=1`,
   `CDMSS_OVERHEAD_DB_ENDPOINT=<the branch endpoint id>`, and `DATABASE_URL` to the branch.
3. Deploy `exp/rerank-telemetry` as a Preview. Guard 2 requires that exact ref, so a promoted build
   cannot serve this route.
4. `POST /api/admin/telemetry-overhead?cell=<cell>&max=<N>&conc=<C>&n=<n>` — **one cell per call**.
   The first call creates the three tables on the branch.
5. Save each response body; it carries `raw_samples_ms`. Nothing is written to disk from a serverless
   function, so the response **is** the archive. Hash it and record the hash.
6. Run `settle_primary` twice, once with `&audit=null`, for attack 6's comparison.

**The archive is not committed**, per addendum v4 §6 and v3's standing decision. Part XI carries the
numbers once they exist. **No archive location or hash is recorded in this issue, because no samples
were taken.**

## 9. Owed, flagged, and not acted on

1. **DELETE THIS ROUTE.** `app/api/admin/telemetry-overhead/route.ts` and
   `lib/__tests__/telemetry-overhead-guard.test.ts` are deleted before `exp/rerank-telemetry` merges
   anywhere. Guard 5's hard expiry of **2026-08-20** is the enforcement, because nothing in CI
   enumerates routes. **At the same time, remove `CDMSS_OVERHEAD_MEASURE`,
   `CDMSS_OVERHEAD_DB_ENDPOINT` and the branch-scoped `DATABASE_URL` from Vercel**, and delete the
   Neon branch.
2. **§5's row-count verification is owed**, for the non-exposure collision in §5. Taking it needs
   either the allow-list extended on a pass whose contract permits it, or the counts read from an
   already-allowed surface. It was not smuggled.
3. **The topology figure is 35 by source and 36 by the addendum.** Verification against the branch is
   owed alongside the measurement.
4. **The region finding, flagged and not acted on** (addendum v4 §13). Every statement crosses Mumbai
   (`vercel.json:4`, `regions: ["bom1"]`) to Singapore (Neon `ap-southeast-1`). If the measurement
   confirms the floor, **colocating the Vercel and Neon regions removes most of the added term** — and
   it shortens every note's wall time rather than only telemetry's share, acting directly on the
   throttling this programme exists to fix. That is outside this workstream and is V's call.
5. **`lab_sql_audit`'s p05 as a floor is an inference, and is labelled one.** Every row in that table
   is an ad-hoc analyst `SELECT`, not a single-row primary-key `UPDATE`, and the six sub-10 ms samples
   are `lab_source` filesystem reads that never touched Postgres — so the true round-trip floor is
   cleaner than 68 ms suggested, in the direction that strengthens the case.
6. **Guard 1 is open by default.** `lib/admin-gate.ts` returns `null` when `ADMIN_TOKEN` is unset. It
   is the weakest of the five, nothing is load-bearing on it, and guards 2 through 5 are what make the
   route unreachable from production.
7. Carried forward, untouched: step 19's query texts, the remaining 38 tests, per-role manifest
   defects, the `retrieval_terminal_rejected` phase, the discriminated union, and Part X's findings
   10a and 10b. **None was started.**

---

# PART X — THE PRODUCTION SHAPE, THE CANARY-GATE HAZARD, AND STEP 21 (on top of `31424cb`)

**13 August 2026.** Governed by `CDMSS-RERANK-TELEMETRY-ADDENDUM-v3-13-AUG-2026.md`, added to the
commit unedited.

**No production file changed. None at all** — not one file outside `lib/__tests__/`, `scripts/`, the
two documents and `.gitignore`. `lib/retrieve.ts`, `lib/rerank.ts`, `lib/expand.ts`,
`lib/multi-query.ts`, `lib/opd-note-audit.ts` and every store are byte-identical to `31424cb`. No
seam, export, parameter or hook was added to make a test or a measurement work. **Nothing was
deployed, no migration was run, and no production database was touched.** The only socket any of
this opened was to `127.0.0.1`.

## 1. Commit and document hash

| | |
|---|---|
| Parent | `31424cb45f0cf66606c6d1acf68c96ed121013b4` |
| This commit | *on top of `31424cb`, not an amend and not a rebase — see `git log`* |
| SHA-256, `CDMSS-RERANK-TELEMETRY-ADDENDUM-v3-13-AUG-2026.md` | `4139eef20b2f4c3fed946d19c52abd2b28cd010a4729bcb6897909d303380397` |

## 2. The gate

**Pre-gate, before anything was staged:** `git status --short lib/architecture/map.generated.ts` →
**empty**.

| # | Command | Result |
|---|---|---|
| 1 | `npm test` | **GREEN — 3053 of 3053** (3050 at the parent: +1 case C, +2 canary-gate cases) |
| 2 | `npm run typecheck` | clean |
| 3 | `npm run build`, unkeyed production | **fails as required**, naming `CDMSS_TELEMETRY_HMAC_KEY` |
| 3 | `npm run build`, keyed | **succeeds** |
| 4 | `npm run architecture:check` | all 8 rules + coverage green |
| 5 | `npm run architecture:map` | **byte-identical to the committed file** |
| 6 | determinism | exit 0, nothing left staged |
| 7 | `npm run reasoning:registry && git diff --exit-code …` | exit 0, unchanged |
| 8 | `npm run reasoning:governance` | GREEN: 0 ungoverned model calls |
| 9 | `npm run changelog:coverage` | GREEN: 19 engine versions documented |

### The four additions

**Wall clock.**

```text
lib/__tests__/retrieval-ranking-invariance.test.ts    0.58 s   (5 cases, was 0.24 s at 4)
lib/__tests__/instrumentation-off.test.ts             0.24 s   (8 cases, unchanged)
lib/__tests__/retrieval-telemetry-lifecycle.test.ts   0.17 s   (13 cases, was 11)
scripts/telemetry-overhead-measure.mjs                2.50 s   STANDALONE — not run by `npm test`
```

The measurement script is **not** in the suite: it is a `scripts/*.mjs` and the test glob is
`lib/**/__tests__/*.test.ts`. It is run by hand with `node --import tsx`. Its 2.5 s includes twelve
spawned child processes for the cold `activeRun` samples. Nothing approached the judge's 90-second
timeout, so no routing mistake is hiding as a slow green.

**No socket to anything but `127.0.0.1`.** Measured, not argued: each file and the script were re-run
under a `--require` preload that records the ACTUAL connected peer from each socket's own
`remoteAddress:remotePort` on its `connect` event, plus every `dns.lookup`.

```text
retrieval-ranking-invariance     PEERS 127.0.0.1:54259   DNS 127.0.0.1    pass 5   fail 0
instrumentation-off              PEERS 127.0.0.1:54265   DNS 127.0.0.1    pass 8   fail 0
retrieval-telemetry-lifecycle    PEERS (none)            DNS (none)       pass 13  fail 0
telemetry-overhead-measure.mjs   PEERS 127.0.0.1:54267   DNS 127.0.0.1
```

**`RERANK_BACKEND` and `OPENROUTER_API_KEY` before deletion.** Both **unset**, as were
`OLLAMA_BASE_URL`, `LLM_PIPELINE`, `GCP_PROJECT`, `GCP_SA_KEY`, `GEMINI_ALL`, `GEMINI_UTILITY`,
`GEMINI_VIA_OPENROUTER`, `EMBED_MODEL` and `TOP_K`. The helper deletes the first two regardless,
because `cohereRelevanceScores` reads the key directly at `lib/rerank.ts:118` with no
`miniPipeline()` gate and would post to `https://openrouter.ai/api/v1/rerank` for real.

## 3. Item 0 — the erratum

Added as **Part IX §12a**, quoted in full there. In summary: Part IX's invariance holds for
`topK: 4`, `skipExpand: true`, `queryEmbedding` supplied, `useReranker` false and true; it does not
cover `useSourceWeights` (which production sets and which ends in a sort), `topK: 8` (poolSize 24,
not 12), or the expansion and embedding calls that production makes and cases A and B escape.
Written as an erratum against addendum v2, which specified `topK: 4` for a clean batch count and
thereby moved the test off the production path — not as a defect of the pass-2 build.

## 4. Item 1 — the judge server serves embeddings

**`EMBED_MODEL` and the dimension, read from the code.** `EMBED_MODEL` is `'nomic-embed-text'`
(`lib/llm.ts:593`), and its column is the **768**-dimension nomic space. The 768 is stated by the
code rather than by a schema constraint: `lib/jats-chunk.ts:9` calls it "the nomic-768 embedder",
and `lib/llm.ts:604` with `lib/retrieve.ts:23` establish 1024 for the mxbai `embedding_v2` column by
contrast. The table itself declares `VECTOR` with no explicit dimension — `migrations/0019_even_ground.sql:19`
says so in as many words, calling the match to `mksap_chunks.embedding` inferred. Reported as read,
including that the DDL does not pin it.

**⚠️ A trap worth recording: the reply must be BASE64 float32, not a JSON array.** `embedQuery` calls
`llm.embeddings.create({ model, input })` with no `encoding_format`, so
`node_modules/openai/resources/embeddings.js:44-47` sends `encoding_format: 'base64'` and
unconditionally decodes the reply through `Core.toFloat32Array` (`core.js:968-973`), which does
`Buffer.from(str, 'base64')`. A plain array would have been decoded as if it were base64 and produced
garbage. The helper encodes little-endian float32 and `toFloat32Array` hands back a plain `Array`, so
`vectorLiteral`'s `.toFixed(7)` behaves exactly as it does in production.

**The vector is deterministic per input string**, because case C runs twice and both runs must be
byte-identical: an FNV-1a hash of the input seeds a plain LCG. No randomness anywhere.

**How the expansion request was distinguished from the judge request.** By the **system prompt**, not
by assuming every chat is a judge call. The expansion prompt opens `You are a medical query rewriter`
(`lib/expand.ts`) and the judge's opens `You are a clinical relevance judge` (`lib/rerank.ts:365`).
The model would also separate them — the harness sets `RERANK_JUDGE_MODEL='test-judge'` while expand
uses the hardcoded `FAST_MODEL` — but that is a property of the harness, and the prompt is a property
of the code, so the prompt is what the server keys on. Requests are recorded with a `kind` of
`'judge' | 'expansion' | 'embedding'`, which is what case C's assertions count.

## 5. Item 2 — case C, the production shape

**The `opdRetrieveOpts` output, asserted not assumed.** The case calls the real function and pins its
result:

```text
opdRetrieveOpts(false, {})  →  { topK: 8, useReranker: true, useSourceWeights: true, hybrid: true }
```

deep-equalled in the test, so a change to `lib/opd-note-audit.ts:638-642` fails this case loudly
rather than letting it drift off production silently.

**The sources and the weights the stub returned.** Three profiles cycled across the fused order,
chosen so `computeSourceQualityWeight` (`lib/source-quality.ts:109-115`) returns three clearly
different values — a fixture where every source weighs the same exercises the block and proves
nothing:

| book / source | chunk_type | token_count | bookTier × chunkTypeBonus × tokenLengthFactor | weight |
|---|---|---|---|---|
| `MKSAP 19` / `mksap-19` | explanation | 500 | 1.00 × 1.05 × 1.00 | **1.0500** |
| `StatPearls` / `statpearls` | narrative | 500 | 0.90 × 1.00 × 1.00 | **0.9000** |
| `Journal of Minor Findings` / `pubmed` | (null) | 30 | 0.80 × 0.95 × 0.70 | **0.5320** |

The third pair is chosen to match no entry in `BOOK_TIERS` and fall to the 0.80 unknown-book default;
none is a lab source, so `clampSourceWeight` leaves all three untouched.

**The unweighted and weighted orders.**

```text
fused pool (24)      301 303 305 302 304 306 307 308 309 310 311 312 313 …
unweighted top 8     301 303 305 302 304 306 307 308      ← rerank_score alone
weighted   top 8     301 302 303 307 304 310 308 313      ← rerank_score × source weight
```

**Order and membership both change.** 305 and 306 carry the 0.532 profile, sit inside the unweighted
top 8, and are demoted out of the final 8 entirely. The judge scores descend in fused order on
purpose, so the weighting is the *only* thing that can reorder. The case asserts this three ways:
against the hand-derived unweighted order; non-circularly, by re-sorting the RETURNED hits on their
own raw `rerank_score` and finding a different order than they came back in; and by checking
`rerank_score_weighted === rerank_score × source_quality_weight` on every hit.

**The numbers.** `meta.pool_size` = **24** (asserted by value), hydrated candidates = **24**, batch
count = **5** = `ceil(24 / 5)` with `JUDGE_BATCH` hardcoded as 5 and cited to `lib/rerank.ts:58`
because it is not exported. Boundaries `[{0,5},{5,10},{10,15},{15,20},{20,24}]`, compared after
sorting a copy by `index` because `capture.batches` is in completion order.

**The two escapes are gone, and that is asserted.** Per side: 1 expansion request, 1 embedding
request, 5 judge requests. The expansion request carries the rewriter system prompt; `expandedQuery`
starts with the original question and is longer than it; `embedQuery` was handed the **expanded**
text, identical on both sides; and `capture.expansion.status` is `'expanded'`.

**The call-form pin now covers `OPTS_C`.** Without that, case C — the one case that matters most —
would have been the one case free to go vacuous. Attack 1 below confirms it fires.

## 6. The routing fragments, re-verified under the new opts

The seven statements are unchanged by `useSourceWeights`, which touches no SQL. Re-run under case C's
opts, where `skipExpand` and `queryEmbedding` are both absent: **S4 (vector), S5a (BM25 default) and
S7 (hydrate) run; S1, S2, S3, S5b and S6 do not.** The pairwise non-overlap check is executed, not
asserted from the table — the last case in the file walks every statement the runs actually issued
and requires each to be matched by **exactly one** of the eight fragments, and separately that S6's
fragment does not capture the vector statement. Green across all three cases.

## 7. Item 3 — the canary-gate characterization test

Two cases at the end of `lib/__tests__/retrieval-telemetry-lifecycle.test.ts`, driving a real
two-role handle through declare → terminal write → settle against the stub.

**What it records.** When `primary`'s terminal write is rejected (zero rows back from the
compare-and-set, `lib/retrieval-telemetry-store.ts:328-334`) and `normative_channel`'s lands:

```text
primary            revision 0, audit_id NULL, state 'aborted'      ← not linked
normative_channel  revision 1, audit_id set,  state 'persisted_complete'
consequence        linked terminal runs = 1, and it is NOT primary
```

PRD line 280's Stage 0b gate asks for "exactly one linked terminal retrieval run with role
`primary`". **On this path an audit that persisted correctly produces zero.** The mirror — primary
lands, normative rejected — is also covered and is *correct* under D9 as amended; only one of the two
trips the gate, and the asymmetry is asserted rather than left implied.

**This is a characterization test. It pins current behaviour, not desired behaviour, and it fixes
nothing.** Production behaviour is unchanged by this pass. **V holds the decision** whether to accept
a hard gate failure on this path or authorise a behavioural correction. If a later pass corrects the
behaviour these two cases *should* fail — that is what a characterization test is for, and the
failure is the signal to go back and read the comment above them.

## 8. Item 4 — step 21, the five numbers and the three extras

**⚠️ EVERY NUMBER BELOW IS SYNTHETIC AND EVERY NUMBER IS A FLOOR.** The database is
`telemetry-db-stub.ts`, answering over a replaced `globalThis.fetch` with no network, no planner, no
lock and no disk; the provider is the loopback judge server. What is measured is the **cost of the
code path** — argument marshalling, canonicalisation, the SQL string build, the driver's encode and
decode — not the cost of the statement in Neon. A production figure is this plus a round trip plus
whatever the database is doing at the time. **Nothing here predicts production and no thresholds are
proposed:** D18 leaves those to V, who judges start-write latency against the throttling behaviour it
could perturb rather than against a generic budget.

**Sample sizes, and why.** `N=300` for the cheap in-process paths (1, 2, 6, 7-warm): they settle
within a few hundred iterations and their spread is dominated by GC and JIT, so 300 gives a stable
median while still showing the tail those two produce. `N=40` for the retrieval paths (4, 5): each
does one expansion, one embedding and five judge round trips over loopback at roughly 10–20 ms.
`N=12` for cold `activeRun`: cold can be observed only **once per process** — `ensured` is module
state at `lib/backfill-runs.ts:39` — so each sample is a fresh child process, which is also the
faithful model of a cold serverless invocation; 12 is where the median stopped moving. Number 3 is a
size, not a timing, so it is reported as one value rather than dressed up as three.

### The five (PRD §6.5, D18)

| # | D18's name | min | median | max | n |
|---|---|---|---|---|---|
| 1 | **Start-write latency**, batch of 50 notes | 0.1218 ms | **0.1415 ms** | 6.1732 ms | 300 |
| 1 | …per note (derived: batch ÷ 50, one statement) | 0.0024 ms | **0.0028 ms** | 0.1235 ms | 300 |
| 2 | **Terminal-write latency**, `primary` | 0.0450 ms | **0.0480 ms** | 0.9343 ms | 300 |
| 2 | **Terminal-write latency**, `normative_channel` | 0.0444 ms | **0.0450 ms** | 0.6345 ms | 300 |
| 3 | **Manifest size**, `primary` | — | **5 518 bytes** | — | 1 |
| 3 | **Manifest size**, `normative_channel` | — | **5 463 bytes** | — | 1 |
| 4 | **Retrieval wall time**, instrumentation OFF | 1.3379 ms | **1.6278 ms** | 2.2897 ms | 40 |
| 4 | **Retrieval wall time**, instrumentation ON | 1.3593 ms | **1.6423 ms** | 2.3768 ms | 40 |
| 4 | **ON − OFF, paired by iteration** | −0.5563 ms | **−0.0185 ms** | +1.0389 ms | 40 |
| 5 | **Audit completion rate**, OFF | — | **100 %** | — | 40 |
| 5 | **Audit completion rate**, ON | — | **100 %** | — | 40 |

Number 1 is reported both ways because the worker declares one `primary` run per note in a **single**
statement for the whole day's batch: the batch figure is what a request waits on, the per-note figure
is what scales. Number 3 is the bytes actually bound to the jsonb column — `canonicalJson(manifest)`
at `lib/retrieval-telemetry-store.ts:318`, not `JSON.stringify` of the payload — over a real case C
capture with 24 hydrated candidates and 5 batches.

**⚠️ Number 4's first version was wrong and is recorded as such.** Timing all the OFF samples and then
all the ON samples reported instrumentation as *faster* than no instrumentation: the OFF arm paid the
JIT warm-up for both. The arms are now warmed up, alternated within one loop, and differenced
**pairwise by iteration**. The honest reading of the corrected figure is that **the instrumentation
overhead on this path is below the measurement noise of this harness** — the median difference is
−0.019 ms against a per-iteration spread of roughly ±1 ms. It is not evidence that the overhead is
zero; it is evidence that this harness cannot resolve it.

**Number 5's limit, stated.** Against a stub that never fails, both arms complete every time. This
number can only ever falsify the claim, never confirm it: below 100 % would mean instrumentation
broke a retrieval outright, and 100 % on both arms says nothing about production failure modes the
stub cannot produce.

### The three extras (separate, not part of the five)

| # | What | min | median | max | n |
|---|---|---|---|---|---|
| 6 | Settlement write latency, `primary` | 0.0101 ms | **0.0105 ms** | 0.4013 ms | 300 |
| 6 | Settlement write latency, `normative_channel` | 0.0102 ms | **0.0109 ms** | 0.3459 ms | 300 |
| 7 | `activeRun('opd')` **COLD**, fresh process, 4 statements | 0.6663 ms | **0.7075 ms** | 1.0302 ms | 12 |
| 7 | `activeRun('opd')` **WARM**, same process, 1 statement | 0.0045 ms | **0.0053 ms** | 0.1226 ms | 300 |
| 8 | Added writes per audited note | — | **5 statements** | — | 1 |

Number 7 follows kickoff line 102's method exactly: `activeRun` is not one round trip — it awaits
`ensureRunsTable()`, which on a cold invocation issues a `CREATE TABLE` and two `CREATE INDEX` before
the `SELECT`, and one statement on every later call. Both were measured, and the child-process count
of 4 statements cold was read back from the stub rather than assumed.

Number 8, counted from the stub rather than reasoned about — one instrumented note, start to settled:

```text
INSERT INTO opd_audit_retrieval_telemetry                          (declaration)
UPDATE opd_retrieval_invocations SET declared_retrievals = …       (counter)
UPDATE opd_audit_retrieval_telemetry                               (terminal write)
SELECT persistence_state, row_revision, audit_id                   (settlement read)
UPDATE opd_audit_retrieval_telemetry                               (settlement write)
```

The three retrieval SELECTs are excluded: they are not added by telemetry. `activeRun` is not in this
count because it is per retrieval, not per note, and is reported separately as number 7.

**The output is NOT committed.** Part X carries the numbers; the script is committed and re-runnable,
and it is in the file contract as `scripts/telemetry-overhead-measure.mjs`.

**Run-to-run spread**, from the mandated second run: medians moved 0.1415→0.1369 ms (number 1),
0.0480→0.0461 ms (number 2 primary), 1.6278→1.5467 ms (number 4 OFF), 0.7075→0.6850 ms (number 7
cold). Manifest sizes and statement counts were identical. So between-run drift on the medians is a
few percent and smaller than the within-run min-to-max spread in every case — which is the point of
reporting distributions rather than means.

## 9. Every attack, including the ones that broke nothing

| # | Attack | Expected | Observed |
|---|---|---|---|
| 1 | give case C's off side a capture | the extended pin fails | **fires, and only it.** Cases A, B and C all still pass — the same result as pass 2, now confirmed for `OPTS_C` |
| 2 | flatten every source weight to one value | the reorder assertion fails | **fails** |
| 3 | embedding server returns a different vector on the second call | case C fails | **DID NOT FAIL on the first attempt** — a real gap. See below |
| 3b | …re-run against the strengthened case | case C fails | **fails**, on the `$1` vector-literal comparison |
| 4 | route the expansion to the judge responder | report what happens | **case C fails** at `expandQuery ran once per side: 0 !== 2`. What happens: the expansion is answered with the judge's scoring JSON (`{}`, since no passages are present), so `expandedQuery` becomes the question plus `"{}"` — retrieval still "succeeds" with a garbage expansion, and only the request-kind count catches it |
| 5 | set `topK` to 4 in case C | `meta.pool_size` fails at 24 | **fails** — but on the `opdRetrieveOpts` deep-equal guard, which sits earlier |
| 5b | `topK` 4 applied after that guard | as above | **fails**, on the exact-ids assertion, which sits earlier still. Measured directly instead: `pool_size` is **24** at topK 8 and **12** at topK 4, so the assertion does discriminate |
| 6 | run case C twice in one body | both runs agree | **agreed** — `301, 302, 303, 307, 304, 310, 308, 313` twice. No determinism defect |
| 7 | make the primary write succeed | the characterization test fails | **both cases fail** — they pin the hazard, not the healthy path |
| 8 | run the measurement twice | report the between-run spread | **done**, §8 above |

**⚠️ Attack 3 found a real gap and is the reason case C is stronger than it was.** Returning a
different embedding vector on the second call broke *nothing*: the database stub routes on statement
**text** and ignores bound parameters, so both runs got identical rows from different query vectors
and every other assertion still held. The embedding reaches the database only as `$1`, so that is
where it now has to be compared — case C asserts both sides bound the same vector literal. Without
it, a non-deterministic embedding was invisible to this harness.

Attacks 5 and 5b are the same pattern pass 2 hit with attack 1: an assertion earlier in the case
fires first, so the *specific* assertion named by the addendum is not the one that fails. Rather than
neutralise the earlier assertions — which produced a syntax mess in pass 2 — the discriminating power
of `meta.pool_size` was measured directly and is reported above.

Attacks 6 and 8 were run as throwaway probes, not added to the test file: extra `retrieve` calls in
the file would themselves trip the call-form pin.

## 10. The two findings, flagged and not acted on

Both come from addendum v3 §9, both concern the defect this workstream exists to make visible, and
**neither is fixed here.**

**10a. `intended_model` does not name the intended judge.**

```text
lib/rerank.ts:511   intendedProvider: 'vertex', intendedModel: JUDGE_MODEL,
lib/rerank.ts:57    const JUDGE_MODEL = process.env.RERANK_JUDGE_MODEL || 'llama3.1:8b';
lib/rerank.ts:459   { gemini: geminiUtilityModel(), promptRef: 'rerank/JUDGE_SYSTEM' }
lib/llm.ts:78       GEMINI_FLASH_MODEL default 'gemini-2.5-flash'
```

On a normal successful Vertex batch the row records `intended_model = 'llama3.1:8b'` and
`served_model = 'gemini-2.5-flash'`. Detection of the substitution is unaffected, because that runs
off `served_route_class`. But **C0 query 4 is "actual provider and model", and any query comparing
intended to served on this path reads as a permanent mismatch.** That is a defect in the telemetry
and it should be settled before C0 rather than discovered inside it.

**10b. The unseeded property is not captured anywhere.** The finding that started this workstream
names an **unseeded** `gemini-2.5-flash` judge. `capture.retrievalConfig` at `lib/retrieve.ts:426-435`
records eleven fields and neither a seed nor a temperature. The judge's `temperature: 0.0` at
`lib/rerank.ts:456` lives in the source, not in the manifest. **Nothing in a persisted row would show
a seeding or temperature change if one were ever made.**

## 11. Flagged, not decided; and defects found and left alone

1. **The canary-gate hazard (§7) is V's to rule on.** Accept a hard gate failure on that path, or
   authorise a behavioural correction. The build did neither.
2. **Findings 10a and 10b**, above, flagged and untouched.
3. **The stub cannot see bound parameters** (attack 3). Case C now compares `$1` explicitly, but the
   general limitation stands for every other statement: routing is by statement text, so any defect
   that changes only a bound value is invisible unless a test reads the parameter itself. Worth
   knowing before the remaining 38 tests are written.
4. **Number 4's overhead is below this harness's resolution** (§8). Reported as such rather than as
   "no overhead". A harness that can resolve it would need a real database and is out of scope here.
5. **The RRF tie hazard** carried from Part IX §13 still applies to case C's fixture, which is
   tie-free by construction and was verified as such.
6. Carried forward, untouched and still owed: step 19's query texts, the remaining 38 tests, per-role
   manifest defects, the `retrieval_terminal_rejected` phase, and the discriminated union. **None was
   started**, per addendum v3 §2.
7. Nothing was found unsettled between addendum v3 and the earlier documents, and **no test or
   measurement required a production change** — the one thing §15 says this pass must not do.

---

# PART IX — TEST 60 AND TEST 1: THE TWO TESTS THAT PROVE THE SAFETY CLAIM (on top of `10f4a65`)

**13 August 2026.** Governed by `CDMSS-RERANK-TELEMETRY-ADDENDUM-v2-13-AUG-2026.md`, added to the
commit unedited.

**No production file changed except one comment** — item 0a's, in
`lib/retrieval-telemetry-failure-store.ts`, proved comment-only by stripping comments and comparing
against `10f4a65`. `lib/retrieve.ts`, `lib/rerank.ts`, `lib/expand.ts` and `lib/multi-query.ts` are
byte-identical. No seam, export, parameter or hook was added to make any test run. **Nothing was
deployed, no migration was run, and no production database was touched.**

## 1. Commit and document hash

| | |
|---|---|
| Parent | `10f4a653138226a0f17f8ae60046e9fdbef02bfb` |
| This commit | *on top of `10f4a65`, not an amend and not a rebase — see `git log`* |
| SHA-256, `CDMSS-RERANK-TELEMETRY-ADDENDUM-v2-13-AUG-2026.md` | `10c94bb95679c598062e546666e85c768d430d3291a1838b3a382f0074606ab9` |

## 2. The gate

**Pre-gate, before anything was staged:** `git status --short lib/architecture/map.generated.ts` →
**empty**.

| # | Command | Result |
|---|---|---|
| 1 | `npm test` | **GREEN — 3050 of 3050**, 0 fail (3038 at the parent, +12 new cases) |
| 2 | `npm run typecheck` | clean |
| 3 | `npm run build`, unkeyed production | **fails as required**, naming `CDMSS_TELEMETRY_HMAC_KEY` |
| 3 | `npm run build`, keyed | **succeeds** |
| 4 | `npm run architecture:check` | all 8 rules + coverage green |
| 5 | `npm run architecture:map` | 90 300 bytes, **byte-identical to the committed file** |
| 6 | determinism (`git add … && map && git diff --exit-code`) | exit 0, nothing left staged |
| 7 | `npm run reasoning:registry && git diff --exit-code …` | exit 0, unchanged |
| 8 | `npm run reasoning:governance` | GREEN: 0 ungoverned model calls |
| 9 | `npm run changelog:coverage` | GREEN: 19 engine versions documented |

The map is unchanged because `lib/__tests__` is not scanned as a subsystem, so the new imports create
no edge. The total is **observed, not predeclared**.

### The three additions from addendum v2 §10

**Wall clock of the new files.** A 90-second judge timeout with no retry (`lib/llm.ts:41`) would turn
a routing mistake into a slow green, so this is measured rather than assumed:

```text
lib/__tests__/retrieval-ranking-invariance.test.ts   0.24 s   (4 cases)
lib/__tests__/instrumentation-off.test.ts            0.24 s   (8 cases)
lib/__tests__/judge-server-stub.ts                   — not a test file; no independent runtime
```

Nothing approached the timeout, so every judge request was answered by the local server.

**No socket to anything but 127.0.0.1, and how that was confirmed.** Not argued from the
configuration — measured. Each file was re-run under a `--require` preload that wraps
`net.Socket.prototype.connect` and records the ACTUAL connected peer from the socket's own
`remoteAddress:remotePort` on its `connect` event, plus every `dns.lookup`:

```text
retrieval-ranking-invariance   peers: 127.0.0.1:52377     dns: 127.0.0.1     pass 4  fail 0
instrumentation-off            peers: 127.0.0.1:52381     dns: 127.0.0.1     pass 8  fail 0
```

The peer list is the strong form: an IP-literal connection to an external host would need no DNS and
would still appear there. The only peer either file ever connected to is the loopback port the judge
server was listening on.

**`RERANK_BACKEND` and `OPENROUTER_API_KEY` in the shell that ran the tests, read BEFORE deletion.**
Both were **unset**, as were `OLLAMA_BASE_URL`, `LLM_PIPELINE`, `GCP_PROJECT`, `GCP_SA_KEY`,
`GEMINI_ALL`, `GEMINI_UTILITY` and `GEMINI_VIA_OPENROUTER`. So the outbound-HTTPS hazard addendum v2
§5 names was not armed on this machine. The helper deletes both anyway: had `RERANK_BACKEND=cohere`
been exported, `rerank()` would have taken the env-default cohere arm and
`cohereRelevanceScores` — which reads the key directly at `lib/rerank.ts:118` with **no
`miniPipeline()` gate** — would have posted to `https://openrouter.ai/api/v1/rerank` for real.

## 3. The `openai/_shims` check, which the whole pass rests on

Run in-process before anything was built on it:

```text
openai/_shims fetch === globalThis.fetch          : false
typeof shims.fetch                                : function
after a stub-style replacement of globalThis.fetch:
  shims.fetch === globalThis.fetch                : false
  shims.fetch === the ORIGINAL globalThis.fetch   : false
openai/core.js:144                                : this.fetch = overriddenFetch ?? index_1.fetch
```

The SDK binds its fetch at client CONSTRUCTION (`lib/llm.ts:41`) to the node-fetch@2 shim, which uses
the `http` module. `telemetry-db-stub.ts:103` replaces `globalThis.fetch` and never touches that. So
a judge request bypasses the database stub and reaches a real loopback socket — which is what lets one
process hold both stubs at once.

## 4. The seven routing fragments, and their pairwise non-overlap

| # | What | Ran? | Fragment |
|---|---|---|---|
| S1 | `embedding_v2` probe | no | `/information_schema\.columns/` |
| S2 | plainto lexemes | no | `/::text AS q/` |
| S3 | DF estimate | no | `/EXPLAIN \(FORMAT JSON\)/` |
| S4 | vector leg | **yes** | `/ROW_NUMBER\(\) OVER \(ORDER BY embedding <=> \$1::vector\)[\s\S]*NOT LIKE 'labq:%'/` |
| S5a | BM25 default | **yes** | `/ts_rank_cd\(text_tsv, plainto_tsquery/` |
| S5b | BM25 discriminating | no | `/WITH cand AS \(/` |
| S6 | normative leg | no | `/ROW_NUMBER\(\) OVER \(ORDER BY embedding <=> \$1::vector\)[\s\S]*source = ANY\(\$3\)/` |
| S7 | final hydrate | **yes** | `/COALESCE\(source_quality_weight/` |

**Re-verified by execution, not by reading the table.** The last case in the invariance file walks
every statement the runs actually issued and asserts each is matched by **exactly one** of the eight
fragments, and separately that S6's fragment does not capture the vector statement. S4 and S6 are
built from the same template and share their first line byte for byte; they differ only in the
rendered filter, which is why S4 is anchored on `NOT LIKE 'labq:%'` and S6 on `source = ANY($3)`. That
is also why no `restrictSources` is passed: it would add `source = ANY($3)` to the vector leg too, and
S4's fragment would then match **nothing** while S6's captured both — a failure that presents as a
missing route rather than as a regex problem.

## 5. Test 60's non-vacuity assertions, and what each catches

| # | Assertion | What it catches |
|---|---|---|
| 1 | exact hit ids in exact order, **on both sides** | a fixture or fusion change that leaves the two sides agreeing on the wrong answer |
| 2 | `meta.pool_size` **by value** — 4 in case A, 12 in case B | the empty-fusion early return at `lib/retrieve.ts:540-546`, which emits **identical meta field names** to the main return, including both conditional spreads under identical guards. Only three values differ; the shapes do not |
| 3 | `stub.matching(RE).length` delta of exactly 2 per statement | a missed route. `telemetry-db-stub.ts:115` returns `[]` for anything unmatched and all three legs at `:508`, `:509`, `:511` swallow every error, so without this a missing route is indistinguishable from an empty leg |
| 4 | `fusedCandidateIds`, `hydratedCandidateIds`, `orderedFinalCandidateIds` non-empty and correct | an on side that wrote nothing, which would make invariance trivially true |
| 5 | case B's reranked order **differs** from the input order | scores initialise to zero (`:414`) and the sort at `:523` is stable, so an all-zero judge returns input order and looks perfectly invariant |
| 6 | `expectedBatchCount === 3`, with the observed hydrated count asserted alongside | fixture drift, which then shows up as a number rather than a mystery |

Case B's observed values: **12 hydrated candidates, 3 batches**, boundaries
`[{0,5},{5,10},{10,12}]`, every outcome `success`. `JUDGE_BATCH` is 5 and is **not exported**
(`lib/rerank.ts:58`), so 5 is hardcoded in the test with that citation and the expectation derived
from it — `Math.ceil(12 / 5)`.

**Batch order.** `capture.batches` is in **completion** order: the push at `lib/rerank.ts:507` is the
last statement of an async callback inside the `Promise.all` at `:427`, and the repair sort lives only
in `buildRetrievalPayload` (`lib/retrieval-capture.ts:231-233`), which uses `.slice()` and never
repairs in place. **The test sorts a copy by `index` before comparing.** Reading `batches[0]` and
expecting `{start: 0, end: 5}` would be a race.

**Scorer context.** v11's test 60 names it alongside the ordered output, and `RetrieveResult` carries
none — so the test renders it from `hits` on both sides with the production renderer
`buildCitedContext` (`lib/citations-core.ts:111`) and compares the two strings, plus a check that the
rendering is non-empty. No HMAC is computed: these are the exact bytes an HMAC would be taken over, so
comparing them is the same claim without a key.

Not asserted, per addendum v2: `intendedProvider` is the hardcoded `'vertex'` (`lib/rerank.ts:511`)
even when served locally, and a local server yields `servedProvider: 'ollama'` and
`served_route_class: 'local'`. Both are correct behaviour.

## 6. The source pin, quoted, and the attack that proves it fires

```ts
const call = (opts: string, cap?: string) => `await retrieve(QUERY, ${opts}${cap ? `, ${cap}` : ''});`;
const CODE = SELF.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const count = (needle: string) => CODE.split(needle).length - 1;

for (const [opts, cap] of [['OPTS_A', 'captureA'], ['OPTS_B', 'captureB']] as const) {
  assert.equal(count(call(opts)), 1, `exactly one TWO-argument retrieve call for ${opts}`);
  assert.equal(count(call(opts, cap)), 1, `exactly one THREE-argument retrieve call for ${opts}`);
}
assert.equal(count(call('OPTS_A', 'captureB')), 0, 'the counter can return 0 — it is not matching everything');
```

The needles are **built, never written as literals**, so the pin cannot be satisfied by its own source
text; the trailing `;` is what stops the two-argument needle matching inside the three-argument call.

**The attack that proves it fires, and it is the most important result in this part.** Giving the off
side a capture — the vacuous test addendum v2 §15 defect 1 describes — produced:

```text
ok 1 - 60 A — useReranker false: instrumentation on and off return byte-identical results
ok 2 - 60 B — useReranker true: identical results, batch boundaries and prompts across on and off
not ok 3 - 60 — THE CALL-FORM PIN     exactly one TWO-argument retrieve call for OPTS_A: 0 !== 1
ok 4 - 60 — the seven routing fragments are pairwise non-overlapping
```

**Both behavioural cases still passed.** Every deep-equal, every count, every capture assertion was
satisfied by a test that proved only that `retrieve` is deterministic against a fixed stub. The source
pin is the single thing standing between this file and that.

## 7. Every attack, including the ones that broke nothing

| # | Attack | Expected | Observed |
|---|---|---|---|
| 1 | delete one stub route (S5a) | case A fails on non-vacuity 3 | **fails** — but on non-vacuity **1**, which is asserted first: removing the BM25 leg changes the fusion to `[101,102,103,104]` |
| 1b | route deleted with the earlier assertions neutralised | 3 fires | attempt abandoned — the neutralisation left multi-line assertions half-commented and produced a syntax mess rather than a clean result. Superseded by 1c |
| 1c | an extra uninstrumented run inside case A's body — results unchanged, only counts move | non-vacuity 3 fires alone | **fires**: `3 !== 2` on S4. This is the clean proof that assertion 3 catches a route-count change independently of the ordering assertions |
| 2 | **give the off side a capture** | the source pin fails | **fires, and ONLY it** — see §6. Cases A and B both still pass |
| 3 | judge returns all-equal scores | case B fails on non-vacuity 5 | **fails** |
| 4 | judge returns all-zero scores | case B fails | **fails** |
| 5 | malformed `content` string | report what happens | all three batches soft-fail; **outcome `parse_failure`**, provider `ollama` and model `test-judge` **preserved** (D15's inner try working), scores stay at initialiser 0, ranking collapses to input order, **nothing throws**, case B fails |
| 6 | omit `usage` from the response | report what happens | **nothing throws**; both `typeof` guards go false, `promptTokens` and `completionTokens` become `null`, and the batch still records `outcome: 'success'`. With `usage` present the same batch records 11 and 7. `usage` is omitted by default |
| 7 | swap two fixture rows so RRF ties | report whether the result changes | **the result CHANGES.** Two ids given the same rank tie exactly at `1/67`; swapping their order in the fixture swapped them in the output — ties resolve by `Map` insertion order (`lib/retrieve.ts:520-523`), and the sort at `:528-529` reads only the value. The committed fixture is deliberately tie-free, verified by computing every RRF total |
| 8 | run each case twice in one body | both runs must agree | **agreed.** Case A `101, 103, 105, 102` twice; case B `112, 108, 101, 110` twice. **No determinism defect found.** Run as a separate probe, not added to the file — extra `retrieve` calls would themselves trip the call-form pin |
| 9 | test 1: add a capture to one side only | the case still passes | **passes**, and is kept as permanent case `1a'` |

Attacks 5, 6, 7 and 8 were run as throwaway probes against the real functions and the real helper,
then deleted; 1, 1c, 2, 3 and 4 were run by patching the test file and restoring it from a byte-exact
backup, verified by hash after each.

## 8. The four dead expressions in `rerankJudge`

v11 says instrumentation off "executes nothing". For `rerankJudge` that is **false**. These four run
whether or not a capture exists, and are consumed only inside the `if (capture)` at
`lib/rerank.ts:506`:

```text
lib/rerank.ts:460   evidence = evidenceFromCompletion(r)
lib/rerank.ts:462   promptTokens
lib/rerank.ts:463   completionTokens
lib/rerank.ts:496   the outcome precedence (missing > nonnumeric > success)
```

Amended to **"executes nothing observable"**, and recorded in the test file as dead work rather than
asserted away. `expandQuery` is the contrast and is asserted as such: there `evidenceFromCompletion`
sits **inside** the guard at `lib/expand.ts:36`, so with no capture nothing runs at all.

## 9. Test 1's seven cases

| # | Function | The observable used |
|---|---|---|
| 1 | `retrieve` | two uninstrumented runs deep-equal, own keys `['hits','expandedQuery','meta']`, per-statement counts equal, and **zero** telemetry statements |
| 1' | `retrieve`, one side captured | the returned value is identical; instrumentation is observable only in the capture |
| 2 | `rerank` | `undefined` reaches `judgeFn` and `cohereFn` as the third argument; a generic throw soft-falls to input order with `recordSoftFailure` returning at `:278` |
| 3 | `rerankJudge` | identical returned array, identical request bodies at the judge server, and the four dead expressions recorded |
| 4 | `rerankCohere` | the `CapturedBatch` literal at `:162-174` exists only on the instrumented side; injected `fetchImpl`, so no socket at all |
| 5 | `expandQuery` | identical expansion text; `capture.expansion` set only on the instrumented side |
| 6 | `retrieveMultiQuery` | the house pattern — three arms, every one `hadCapture: false` |
| 7 | **the `MatchInput` seam** | `defaultRecall` provably ran (its corpus read appears in the stub) and wrote **no** telemetry statement |

Case 7 is v11 report item 11's requirement, which addendum v2 revision 1 dropped and §12 restored.
Counts are taken with `stub.matching(RE)`, never by sequence position: `stub.calls` order is not
deterministic for S4, S5 and S6, which are dispatched in one `Promise.all`.

The "no telemetry own property" assertion revision 1 asked for was **dropped**: no return type in the
six functions has ever carried such a property on any code path, so it passes unconditionally and
proves nothing. The returned object's own keys are pinned against a frozen list instead.

## 10. Item 0 — the three corrections owed from pass 1

**0a. `lib/retrieval-telemetry-failure-store.ts:66-67` was a false statement, and addendum v1 said it
was true.** It read "Used ONLY by the reconciler (D13)". There are two readers: the reconciler, and
**settlement**, through `stateForUnwrittenRun` — `lib/retrieval-settlement.ts:19` imports
`failurePhasesForRun` and `:110` calls it for a revision-0 run. Addendum v1 item 2 explicitly
preserved the line on the grounds that the claim "is about who reads them, and it is true", and Part
VIII §4 repeated that reasoning. Both were wrong. The comment now names both readers and says why the
second was easy to miss: they ask the same question of the same rows and get the same mapping.
**Comment only**, proved by comparison against `10f4a65`.

**0b. The import-scanner hazard, recorded permanently.** `scripts/lib/import-scan.mjs` matches imports
with one regex over raw file text and **does not skip comments**: `import` + `type` + any run of
characters containing no quote + `from` + a quoted specifier. In pass 1 a comment that spelled those
two keywords adjacently bound to the real statement's specifier below it and added a `type` edge to
`lib/architecture/map.generated.ts`. This is a **fourth mechanism** in the class addendum v1 §3.2
catalogues, alongside the `^(let|var) ` scan, the non-exposure walk and the import form itself.

**It recurred in this pass, in a different check, and was caught by running it.** The call-form pin in
test 60 first counted over raw source and read the file's own header illustration as a second
two-argument call (`2 !== 1`). The pin now strips comment lines before counting, and says so. The
general rule worth carrying: **any text-level check over a source file must decide explicitly whether
comments are in scope**, because the file's own explanation of the check is exactly the text most
likely to trip it.

**0c. Two line citations in Part VIII were wrong.** Its §6 said the pinned arms are "at lines 215 and
216 of the route". They are at **246 to 248** — the declaration at 246 and the two calls at 247 and
248. Lines 215 and 216 are part of the comment explaining the spread. Corrected in place.

**And one left alone, deliberately.** The pass-1 commit message says "three source cases" where test
42 has four (B5, B6, B7 and B7b). An amend is forbidden, so it stands uncorrected in git history and
is recorded here instead.

## 11. Amendments and file-contract additions

**Two v11 amendments recorded by this pass:**

1. **Test 60's wording**, "the same injected collaborators" → "an identical environment on both
   sides". This was **already settled in addendum v1 decision 9** and is restated, not made here;
   v1's wording binds. `retrieve`, `rerankJudge` and `expandQuery` have no injection parameter at all.
2. **Test 1's wording**, "executes nothing" → "executes nothing observable", because of the four
   expressions in §8.

With pass 1's finding on test 42 — that v11 asked for two things the harness cannot execute — that is
**three instances of the same pattern**: v11 asking for something the code cannot provide. Recorded
together so the pattern is visible rather than rediscovered a fourth time.

**Two additions to v11's file contract.** `lib/__tests__/instrumentation-off.test.ts` and
`lib/__tests__/judge-server-stub.ts` are not on v11's create list.
`retrieval-ranking-invariance.test.ts` is. The helper is deliberately **not** named `.test.ts`, so the
`lib/**/__tests__/*.test.ts` glob does not collect it — the same convention as `telemetry-db-stub.ts`.

**Two v11 requirements revision 1 silently narrowed, both restored:** test 60's scorer context (§5)
and report item 11's `MatchInput` seam (§9, case 7).

## 12. Determinism

Both runs agreed on both cases — see attack 8. **No determinism defect was found.**

## 12a. ERRATUM, added 13 August 2026 by the pass-3 build: this part proves a SINGLE-CONFIGURATION claim

**This is an erratum against addendum v2, not a defect of the pass-2 build**, which built exactly
what it was told to build. v2 specified `topK: 4` to get a clean three-batch count, and that
optimisation moved the test off the production path. Part IX above reads as a general safety claim.
It is not one. Stated exactly:

> The ranking invariance proved in `31424cb` holds for `topK: 4`, `skipExpand: true`,
> `queryEmbedding` supplied, and `useReranker` both false and true.
>
> **It does not cover `useSourceWeights`**, which production sets and which contains a `hits.sort(...)`
> at `lib/retrieve.ts:604-627`. Under the whole suite at `31424cb` that block was dead code, so a
> capture-conditional edit inside it would have changed production ranking under instrumentation and
> passed every assertion in Part IX.
>
> **It does not cover `topK: 8`**, which production uses and which gives `poolSize` 24, not 12 — so
> the batch arithmetic under test was not the batch arithmetic that ships.
>
> **It does not cover the expansion or embedding calls.** Production sets neither `skipExpand` nor
> `queryEmbedding`, so it runs `expandQuery` and `embedQuery` for real; cases A and B escape both.

Production's shape is `opdRetrieveOpts(false, {})` → `{ topK: 8, useReranker: true,
useSourceWeights: true, hybrid: true }` (`lib/opd-note-audit.ts:638-642`), reached through
`defaultRetrieve` at `:647`.

**Closed by pass 3**, whose case C runs at that exact shape with expansion and embedding live. See
Part X.

## 13. Flagged, not decided; and defects found and left alone

1. **The RRF tie behaviour is real and is load-bearing for this test** (attack 7). Ties resolve by
   `Map` insertion order, so a fixture with tied RRF totals would make the expected order an accident
   of row order rather than a derivation. The committed fixture is tie-free by construction and that
   was verified by computing every total. Flagged because a future edit to the fixture could
   reintroduce a tie silently — the test would still pass, but it would be pinning the wrong thing.
2. **`intendedProvider` is hardcoded `'vertex'`** at `lib/rerank.ts:511` even when the batch is served
   locally. Correct behaviour per D16 and deliberately not asserted on, but it means a manifest read
   naively would report Vertex for a call that never left the machine. Logged, not fixed.
3. **The judge timeout is 90 000 ms with no retry.** An unrouted judge server holds a test for 90
   seconds rather than failing fast. This pass measures wall clock (§2) precisely so that a routing
   mistake cannot present as a slow green; no threshold is proposed.
4. Carried forward, untouched and still owed: per-role manifest defects and the canary-gate test from
   decisions §3, the `retrieval_terminal_rejected` phase (decisions §8, blocked on the D13
   unknown-phase check), the `PerRunSettlementResult` discriminated union, and steps 19 and 21. **None
   was started**, per addendum v2 §1.
5. Nothing in this pass was found unsettled between addendum v2 and the v11 kickoff, and **no test
   required a production change** — the one thing §14 says this pass must not do.

---

# PART VIII — THE ADDENDUM v1 PASS: FOUR MECHANICAL ITEMS (on top of `32f0f79`)

**13 August 2026.** Governed by `CDMSS-RERANK-TELEMETRY-ADDENDUM-v1-13-AUG-2026.md`, with
`CDMSS-RERANK-TELEMETRY-DECISIONS-13-AUG-2026.md` as the evidence companion. Both are added to the
commit unedited.

**Nothing was deployed. No migration was run. No production database was touched.** No canary was
targeted, C0 was not started, and no engine version was bumped. This pass changes no ranking
behaviour: the only production file it edits is the A/A harness route, and the only behaviour it adds
there is a telemetry declaration on a pass that already performed the retrieval.

## 1. Commits and document hashes

| | |
|---|---|
| Parent | `32f0f79183592b804988113a36b042a8f0458f84` |
| This commit | *on top of `32f0f79`, not an amend and not a rebase — see `git log` on `exp/rerank-telemetry`* |
| SHA-256, `CDMSS-RERANK-TELEMETRY-ADDENDUM-v1-13-AUG-2026.md` | `acb13d002d0c09069fb3f2c5d21f788ff13d30b871d6b9c56027f4b835d21794` |
| SHA-256, `CDMSS-RERANK-TELEMETRY-DECISIONS-13-AUG-2026.md` | `c74b25f14d9a7178bdf2372ac764a11b1229293f82a537bf15704f0acdc34220` |

A report cannot state its own commit SHA — it is inside the object being named. This follows the
convention Part II set at its §1 rather than inventing a second one. **No served deployment SHA is
recorded here**, for the reason Part II gives: a clean local tree proves nothing about what Vercel is
serving, and this pass neither deployed nor targeted a canary.

## 2. The gate: the pre-gate map check, then all nine

**Pre-gate, run before anything was staged**, per addendum §9:

```bash
$ git status --short lib/architecture/map.generated.ts
(empty)
```

| # | Command | Result |
|---|---|---|
| — | `git status --short lib/architecture/map.generated.ts` | **empty**, before staging |
| 1 | `npm test` | **GREEN — 3038 of 3038**, 0 fail |
| 2 | `npm run typecheck` | clean, no output |
| 3 | `npm run build`, unkeyed production | **fails as required**, naming `CDMSS_TELEMETRY_HMAC_KEY` |
| 3 | `npm run build`, keyed | **succeeds** |
| 4 | `npm run architecture:check` | all 8 rules + coverage green; 39 subsystems |
| 5 | `npm run architecture:map` | wrote 90 300 bytes, **byte-identical to the committed file** |
| 6 | `git add … && npm run architecture:map && git diff --exit-code …` | exit 0, no diff; **nothing left staged** |
| 7 | `npm run reasoning:registry && git diff --exit-code …` | exit 0, registry unchanged (88 737 bytes) |
| 8 | `npm run reasoning:governance` | GREEN: 0 ungoverned model calls |
| 9 | `npm run changelog:coverage` | GREEN: all 19 shipped engine versions documented |

The test total is **observed, not predeclared**: **3038 of 3038**. The arithmetic behind it was
measured rather than reasoned about — with the new test file moved aside and every other edit in
place, the suite is **3030 of 3030**, so test 42 contributes exactly its eight cases and nothing else
in this pass adds or removes one. The two deleted mode lines were assertions *inside* existing cases,
not cases of their own, which is why deleting them moves no count. Both figures are green; 3030 is
also the parent's total, since the remaining edits are comments and one case title.

Gate 3's unkeyed message, verbatim:

```text
Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build. Rerank telemetry keys every
patient-derived value it records; an unkeyed digest of clinical text is not acceptable (§4.3). Set
it in Vercel Production before deploying.
    at <unknown> (next.config.mjs:14:9)
```

No changelog entry was added to satisfy command 9, and no engine bump was made.

## 3. Item 1 — the two file-mode assertions, deleted, with both procedures written

**The deletions.** `lib/__tests__/reconciler-races.test.ts:718` and
`lib/__tests__/reconciler-route-artifact.test.ts:81`, both
`assert.equal(st.mode & 0o7777, 0o644, …)`. Git records one permission bit, the executable bit; a
tree entry for a regular file is `100644` or `100755` and the group and other bits are never stored,
so `chmod 640` and `chmod 664` change neither the blob nor the tree entry. A change that does flip
that bit is reported by `git status` without a test.

**The two comments above them were rewritten**, each now saying those three things, at
`reconciler-races.test.ts:731-741` and `reconciler-route-artifact.test.ts:88-98`. The symlink and
hard-link sentences were left alone in both.

**Everything else in both blocks still runs**, verified by the suite:

| check | races, test 64 | route artifact |
|---|---|---|
| symlink | 740 | 97 |
| regular file | 741 | 98 |
| `nlink === 1` | 742 | 99 |
| SHA-256 | 758 | 105 |
| git blob id | not present | 113 |

**Item 1b, both re-baseline procedures**, written as comments where the constants they describe live:

- Route artifact pin, `reconciler-route-artifact.test.ts:35-43`: confirm the change is intended and
  reviewed; `sha256sum` the route; `git hash-object` the route; replace `ROUTE_SHA256` and
  `ROUTE_GIT_BLOB`; state in the build report what changed and why.
- Cron pin, `reconciler-races.test.ts:692-708`: confirm the cron-count edit is the only intended
  change; take the file **as it now stands**, replace the authorised line with its historical form in
  memory, hash with SHA-256; replace `sha256At177adc9`, and `line` if it moved; state the change and
  the reason in the build report. **Plus the sentence the addendum requires**: after any edit other
  than the cron count, the name `sha256At177adc9` stops being true, because the baseline is then the
  file at the later commit with one line reverted. Rename it when that happens.

**Item 1c, the stale pointer.** §6 of this report said the route baseline is a two-line edit in
`reconciler-races.test.ts`. Part VII moved it. It now names `reconciler-route-artifact.test.ts`, and
records that the decision of 13 August keeps the detector and writes both procedures down.

## 4. Item 2 — D9's wording, finished

### The amended rule, as now written into the code

> `aborted`, `persistence_unknown` and `telemetry_persistence_failed` are produced only through
> `reconcilerStateFor`. Settlement may call that function for a revision-0 run. The settlement
> mapping table itself never names those states.

**No code changed. No assertion changed.** Both files carrying prose changes are comment-only, proved
mechanically rather than asserted: stripping every comment from
`lib/retrieval-settlement.ts` and `lib/retrieval-telemetry-core.ts` and normalising whitespace yields
text identical to the same files at `32f0f79`.

### The four sites, opened directly by line number

**I did not rely on a grep to find them.** Each was opened at the line the addendum names, read in
its surrounding block, and edited there:

| Site | What changed |
|---|---|
| `lib/retrieval-settlement.ts:92-97` | the FLAGGED docstring became a decided one, citing the addendum and the decisions document. Now at 92-103 |
| `lib/retrieval-telemetry-core.ts:869-875` | the `SETTLEMENT_STATE` docstring now says the TABLE never names the three, and that `stateForUnwrittenRun` also calls `reconcilerStateFor`. Now at 869-879 |
| `lib/__tests__/retrieval-telemetry-transitions.test.ts:89` | the TEST TITLE, now "…the settlement table names none of the three reconciler-mapped states" |
| `lib/__tests__/retrieval-telemetry-transitions.test.ts:98` | the assertion MESSAGE, now "…is never named by the settlement mapping table (D9 as amended)". Now at 101 |
| `lib/__tests__/retrieval-settlement.test.ts:69` | the comment |

The identifier `reconcilerOnly` was left exactly as it was, at
`retrieval-telemetry-transitions.test.ts:99`, with a comment saying why it is still the right name.
`lib/retrieval-telemetry-failure-store.ts:66` was **not touched**: its claim is about who *reads*
failure phases, and it is true.

### Every search I ran, with its full output

```bash
$ grep -rn -i "only by the reconciler\|reconciler.s alone\|reconciler-only" --include='*.ts' lib app
lib/retrieval-settlement.ts:94: * only by the reconciler, while the same section required a revision-0 run to be "settled from the
lib/retrieval-telemetry-failure-store.ts:66: * Read the failure phases recorded for one run, most recent first. Used ONLY by the reconciler

$ rg -U -i --multiline "reachable only\s*\n?\s*\*?\s*by the reconciler" lib app
(no matches, exit 1)
```

Both survivors are correct. The first is the amended docstring itself, quoting the superseded wording
in order to explain what replaced it. The second is the true read-side claim the addendum says to
leave.

Two further sweeps, run because the addendum warns that its own grep missed two sites in revision 1:

```bash
$ rg -n -i "reconciler" --glob '*.ts' lib app   # filtered for reachab|alone|only|produce
lib/retrieval-telemetry-core.ts:144,906   "…would leave the only honest settlement unreachable and hand
                                           the row to the reconciler as an `aborted` guess"
lib/__tests__/retrieval-settlement.test.ts:75  "${reconcilerOnly} is not a settlement outcome"
$ rg -U -i --multiline "reachable[^.]{0,120}reconciler|reconciler[^.]{0,120}reachable" --glob '*.ts' lib app
(the two core.ts lines above, the amended settlement docstring, and unrelated
 "unreachable defensive branch" prose in the reconciler route and its test)
```

None is the stale claim. The two `core.ts` lines are about `started -> audit_generation_failed` and
are still true; `retrieval-settlement.test.ts:75` says these are not settlement *outcomes*, which is
literally true — they are states, and the case iterates the outcome table. **No site was found where
the stale claim is load-bearing inside an assertion.** Scope was `lib/` and `app/` only.

### The consequence, recorded

**C0 must not read `aborted` as "written by the reconciler".** After this amendment it means *no
terminal manifest was ever written, whoever noticed*. Any C0 text that counts `aborted` as a
reconciler count is wrong. If that distinction is later wanted, decisions §2 records the cheap route
— one additive column recording the writer, not a new state — and that is neither decided nor in
scope.

## 5. Item 3 — the test 63 case, renumbered

`lib/__tests__/multi-query-telemetry.test.ts:110`. The title now begins `63 — `. Nothing else in the
file changed: both assertions stay, including the once-only count at line 117 that closes the hole in
the older pin at `lib/__tests__/retrieval-llm-determinism.test.ts:34`.

**Nothing pins that title, confirmed for myself.** `rg` across the repository finds the file's own
name only inside itself, and finds the title text only in this file and in the decisions document's
quotation of it. No test reads the test directory to count titles: the directory walks that do exist
(`telemetry-non-exposure`, `provenance-grounding-label`, `audit-canonical-sql-twin`,
`feedback-study-filter`, `architecture-inquiry-semantics`, `admin-attribution`,
`lab-override-ask-wiring`) scan for table reads, registry ids and migration names, never for case
titles. No source-text pin covers the file — the only two content baselines in this workstream are
`CRON_BASELINE`, over `provider-switch-unit-d.test.ts` and `ipd-worker-batch-and-model.test.ts`, and
`ROUTE_SHA256`/`ROUTE_GIT_BLOB`, over the reconciler route.

### The counts, and the basis

**The basis is the mechanical one: a requirement counts as written when a case title carries its
number.** Stated so no later reader has to guess. Counted over this build's own test files, by
extracting every `test(...)` title and reading a leading requirement number:

```text
at 32f0f79, mechanical      23 written, 50 absent
after item 3                24 written, 49 absent
after test 42               25 written, 48 absent
```

Reproduced independently rather than restated; the numbers newly carried by a title in this pass are
exactly `[42, 63]`. **The substantive count at `32f0f79` was already 24 and 49**, because test 63's
subject was asserted at `multi-query-telemetry.test.ts:110-118` — a superset of it — without its
number. Item 3 is what makes the two bases agree.

**A trap worth recording for whoever counts next.** A first pass at this count returned 32 and 41,
two errors cancelling into a plausible-looking figure: it swept all of `lib/__tests__`, picking up
numbers 1 to 10 from four unrelated workstreams' own numbering, and it required a punctuation
separator after the number, which silently dropped requirement 57 — whose cases are titled
`57 case 1 — …`, `57 pin — …`. No `npm test` total is preregistered anywhere in this part: one
requirement can produce several cases.

## 6. Item 4 — step 13, which is five edits

### The three confirmations the addendum asks for, with line numbers

1. **`lib/lvc.ts:64`** declares `telemetry?: { ctx: TelemetryRequestContext; route: RetrievalRoute };`
   — the committed shape is exactly as the addendum states. No difference to report.
2. **`'lvc_judge_aa'` is a member of `RETRIEVAL_ROUTES`** at
   `lib/retrieval-telemetry-core.ts:185`.
3. **`telemetryContextFor`'s first parameter is typed `InvocationRoute`**, at
   `lib/retrieval-telemetry-core.ts:252`, not `RetrievalRoute`.
   `INVOCATION_ROUTES = [...RETRIEVAL_ROUTES, 'reconciler']` at line 196, so `'lvc_judge_aa'` is in
   both. **It compiles**: gate 2 is clean.

### The five edits, all in `app/api/admin/lvc-judge-aa/route.ts`

| # | Line | Edit |
|---|---|---|
| 1 | 57 | `import { telemetryContextFor, type TelemetryRequestContext } from '@/lib/retrieval-telemetry-core';` — one statement, inline `type` |
| 2 | 302 | `const ctx = telemetryContextFor('lvc_judge_aa', req.headers, { labExperimentId: experiment });` in `GET` |
| 3 | 194 | `runCase(uid, save, experiment, ctx: TelemetryRequestContext)` — context last, required |
| 4 | 316 | `results.push(await runCase(item.uid, save, experiment, ctx));` |
| 5 | 223 | `matchLowValueCare({ ...input, trace: false, telemetry: { ctx, route: 'lvc_judge_aa' } }, {…})` |

`lib/lvc.ts` was not edited. No `startInvocation` call was added — `defaultRecall` opens the
invocation at `lib/lvc.ts:212`, idempotently and fail-open, whenever `input.telemetry` is present, so
pass 0 opens it. No `closeInvocation` call was added. No `pairId`, `replicate` or `experimentRunId`.

**The spread, with the reason stated correctly in the code.** What keeps the pinned arms clean is the
injected `recall`: `matchLowValueCare` resolves `deps.recall ?? defaultRecall` at `lib/lvc.ts:666`,
passes A and B supply `pinned = { recall: async () => captured }` at lines 246 to 248 of the route
— the declaration at 246 and the two calls at 247 and 248 — <!-- corrected 13 Aug 2026, addendum v2
item 0c: this said "lines 215 and 216", which are part of the comment explaining the spread, not the
pinned arms -->
and `defaultRecall` — the one and only reader of `input.telemetry`, at `lib/lvc.ts:204` — never runs
on them. The spread is used anyway, as defence in depth against a later change removing that
injection, and the code comment says that and not the false reason.

### ⚠️ A finding: the architecture map moved, and the import form was not why

Gate 5 rewrote `map.generated.ts`, adding a second `app/api → retrieval-telemetry-core` edge of kind
`type` — the exact change the addendum's edit 1 exists to prevent. **The import statement was not the
cause.** `scripts/lib/import-scan.mjs` is text-level and does not skip comments: its pattern is
`import` + `type` + any run of characters containing no quote + `from` + a quoted specifier. The
explanatory comment I had written above the import spelled those two keywords adjacently; the match
ran past the prose, found no quote until the real statement below it, and bound to that statement's
specifier.

Corrected by rewording the comment so the two keywords never appear adjacently — the statement itself
is unchanged — and the comment now records why its own wording is load-bearing. After the rewording,
`npm run architecture:map` reproduces the committed file byte for byte:

```bash
$ git hash-object lib/architecture/map.generated.ts   # after regeneration
795d5982e9ae2535e613c13e746aecc9d4e902c9
$ git rev-parse 32f0f79:lib/architecture/map.generated.ts
795d5982e9ae2535e613c13e746aecc9d4e902c9
```

**`lib/architecture/map.generated.ts` is not in this commit.** This is a fourth mechanism of the class
addendum §3.2 catalogues — a check that reads files on the edit list and can be tripped by careless
wording — and it is worth adding to that list: the three named there are the `^(let|var) ` scan, the
non-exposure walk, and the import form. The import *comment* is a fourth. It was caught by
`architecture-map-gen.test.ts`, which is the guard that already covers it.

## 7. Test 42, in two parts

New file `lib/__tests__/lvc-telemetry-seam.test.ts`. Eight cases, all green.

**v11's item 42 asks for two things this harness cannot execute.** That is a finding about v11, not a
choice to skip them. `installDbStub` seams `globalThis.fetch` and fails closed on any body that is
not a Neon query — deliberately, and correctly. This file wraps that transport rather than editing the
shared helper, which is not on the file contract: a Metabase `/api/dataset` body is answered locally,
and the `lvc_recommendations` read is answered locally because the stub types every array column as
`text` (oid 25) and `rowToRec` needs a real array in `keywords`. Everything else is delegated to the
stub, so every telemetry statement is recorded with its real bound parameters, which is what the
assertions read. No live model is called: every `fetch` is intercepted.

### Part A — proved by execution

| Case | What it proves |
|---|---|
| A1 | pass 0 uses default recall: role `lvc_recall`, route `lvc_judge_aa` on the declaration, the invocation opened by `defaultRecall` itself, **and the seam's own route inside `operational.route` in the terminal manifest** |
| A2 | the pinned passes declare nothing — one declaration per case, not three |
| A3 | exactly one `lvc_recall` row per pass-0 recall, each with its own run id: not two, not zero |
| A4 | one context per request — one invocation id across every telemetry write of a request, and a different id for the next request |

A4 asserts **one id per request, not one id across the three passes**. Passes A and B never reach
`defaultRecall` and so have no id at all, which is what A2 asserts; asking for both would be asking
for a contradiction. Two uids are processed per request, because a context minted per case is
indistinguishable from a correct one on a single-case request.

### Part B — source assertions, each with its reason

| Case | Why it cannot execute |
|---|---|
| B5, the appropriateness route passes `'unknown_route'` | `POST` runs `matchLowValueCare` and `analyzeValue` in one `Promise.all`; `analyzeValue` calls a provider over `fetch`; the stub throws `UnsupportedStubTransportError` on any body that is not a Neon query. Driving it would mean modelling a provider reply well enough for `analyzeValue` to parse, which asserts the stub rather than the route |
| B6, both right-care scripts write nothing | the fixture is deliberately uncommitted, each script ends in `process.exit(0)` — which would take the runner down with it — and both make live provider calls |
| B7, the route's existing surface is unchanged | passes A and B run the real `defaultJudge` with no injection seam, and `fetchOpdNoteByUid` reaches Metabase over `fetch`, so a driven request cannot tell "unchanged" from "the harness answered". Asserted from the diff |

The reason for each is written into the test file itself, so a reader sees that the split is by
constraint and by choice. B7b is a source case added alongside A4: it pins the mint site, the widened
signature, the threading, that there is exactly **one** `telemetryContextFor(` call, and the import
form.

### The attacks, including the ones that failed to break it

| Attack | Expected | Observed |
|---|---|---|
| 1. Route string changed to `'unknown_route'` | case 1 fails | **first run: did NOT fail — a real gap in my test.** Fixed, then it fails |
| 2. Pinned arms made to produce a capture | case 3 fails | **fails** (A3, and A1, A2, B7 with it) |
| 3. Context minted inside `runCase` | case 4 fails | **fails** (A4, and B7b) |
| 4. Production edit reverted to `32f0f79` entirely | every Part A case fails | **all four fail.** B7 correctly still passes: it asserts the *unchanged* surface, which a revert preserves |
| 5. Telemetry field moved off the spread onto `input` | case 2 still passes | **did NOT fail — all 8 still green**, exactly as the addendum predicts |
| supplementary: attack 5 **and** the pinned `recall` removed | — | **A1, A2, A3 fail** |

**Attack 1 found a real defect in my own test and is the reason A1 is now stronger.** A1 originally
read the route off the declaration insert's third bound parameter — but that parameter is
`ctx.route`, which `telemetryContextFor` sets, not the `route` the seam was handed. The two are
independent: changing the literal in `telemetry: { …, route }` left every assertion true. The seam's
route reaches the database only inside `operational.route` in the terminal manifest, so A1 now parses
that manifest and asserts it there. Without that block the mandated attack was survivable.

**Attack 5 did not fail, and the addendum says so in advance.** Recording what actually protects the
pinned arms: **the injected `recall`, not the spread.** `matchLowValueCare` resolves
`deps.recall ?? defaultRecall`; passes A and B inject their own `recall`; `defaultRecall` is the only
reader of `input.telemetry` anywhere in the codebase. So a field on `input` is never read on those
arms, and moving it there instruments nothing new. The supplementary attack is the proof by
measurement: with the field on `input` **and** the pinned injection removed, passes A and B do reach
`defaultRecall`, three declarations land per case, and A1, A2 and A3 all fail. The spread is
therefore defence in depth against exactly that future edit, and is not what holds today.

## 8. The confirmations from addendum §3.2

**No hash baseline needed re-computing, confirmed for myself and not taken on the document's word.**
Every file the three pins cover is byte-identical to `32f0f79`:

| Pinned target | Covering pin | Status |
|---|---|---|
| `lib/__tests__/provider-switch-unit-d.test.ts` | `CRON_BASELINE` | unmodified |
| `lib/__tests__/ipd-worker-batch-and-model.test.ts` | `CRON_BASELINE` | unmodified |
| `app/api/admin/retrieval-telemetry-reconcile/route.ts` | `ROUTE_SHA256`, `ROUTE_GIT_BLOB` | unmodified |

The route's live digests still equal the recorded constants: `sha256`
`6ecd5b38…d4fd56` and git blob `ffd77c61…d304c4`, both computed against the file on disk.

The other two §3.2 checks were respected and verified: no line of any of the four files scanned by
`retrieval-telemetry-lifecycle.test.ts:209-218` begins with `let ` or `var ` at column 0, and no
`FROM` or `JOIN` of a telemetry table appears in `lib/retrieval-settlement.ts`,
`lib/retrieval-telemetry-core.ts` or the new test file — none of which is in the non-exposure
allow-list.

`lib/sql-guard-core.ts` is byte-identical. `data/reasoning-registry/prompts.generated.json` is
unchanged, so gate 7 required no commit of it.

## 9. Amendment to report item 23

**The `lib/sql-guard-core.ts` blocklist decision is CLOSED.** The three telemetry tables are **not**
added to `BLOCKED_RELATIONS`. The list's criterion is raw clinical text; the manifests carry
candidate ids, counts and HMACs, and `pre_rerank_passage_hmacs` holds HMACs rather than passages.
`opd_note_audits` is not on that list either, and the requirement is controls no weaker than
`opd_note_audits` — so adding them would be stronger than required. The file stays byte-identical and
both committed assertions on its literal are intact.

**The two guard gaps stay logged and out of scope**, with the privilege result from decisions §6:

- `pg_read_binary_file` passes the guard, because `FORBIDDEN` matches the substring `pg_read_file`
  and the longer name does not contain it. **Not reachable**: a live read-only query returned
  `db_role neondb_owner`, `has_function_privilege('pg_read_binary_file(text)', 'execute') false`,
  `is_superuser false`. The regex hole is real and its consequence is not.
- `pg_catalog` and `information_schema` pass. **Reachable**, and bounded by that role's own
  privileges; the query above read `pg_roles` through the guard, which is the proof.

Neither is fixed here. Fixing either edits a file the kickoff forbids editing and breaks two committed
tests.

## 10. The `.gitignore` change, and why the commit could not happen without it

`.gitignore:73` is `/*.md`, and the lines under it are explicit `!` exceptions, one per document, so
that `git add` on them keeps working. Both new documents sat in the worktree root **ignored, not
untracked** — which is why `git status --short` was empty at preflight despite their presence. Two
lines were added to the end of that exception list, in the existing form:

```text
!/CDMSS-RERANK-TELEMETRY-ADDENDUM-v1-13-AUG-2026.md
!/CDMSS-RERANK-TELEMETRY-DECISIONS-13-AUG-2026.md
```

No other line of `.gitignore` was changed, and **`git add -f` was not used**.

## 11. Flagged, not decided; and defects found and left alone

1. **A stale `index.lock` blocked every git write**, at
   `.git/worktrees/Even-CDMSS-rerank-telemetry/index.lock`: zero bytes, three hours old, and held by
   a macOS Virtualization file-share process on a **read** descriptor, not by git. No git process was
   running. I removed it, which is the standard remedy and is what git's own error text advises;
   recording it because it is a change to repository state outside the file contract. Gates 6 and 7
   and the commit could not run otherwise.
2. **The import-scanner comment hazard in §6 above.** Reported as a finding, fixed in the one file it
   affected, and proposed as a fourth entry in addendum §3.2's list.
3. **Test 42's Part B is three source assertions**, because v11 asked for two things — and, on
   inspection, a third — that the harness cannot execute. Flagged rather than quietly dropped.
4. **`RECONCILER_STALE_AFTER_SECONDS` was not tuned** and is not proposed for tuning. It is named in
   §4 only to explain why the code was not changed to obey D9's superseded literal reading.
5. Carried forward, untouched and still owed: the per-role manifest defect keying (decisions §3, with
   its hazard 1 canary-gate test), the rejected-terminal-write failure row (decisions §8, blocked on
   the D13 unknown-phase check), test 60 and test 1, steps 19 and 21. **None was started**, per
   addendum §1.
6. Nothing in this pass was flagged as unsettled between the addendum and the v11 kickoff. The one
   place they could have collided — v11 item 42's four claims against the addendum's two-part split —
   the addendum settles explicitly, and §7 above follows it.

---

# PART VII — THE ARTIFACT PIN, MOVED OUT OF THE PROCESS IT MEASURES (on top of `ee92c26`)

## 1. What this part did not do

No production code changed: the reconciler route, `next.config.mjs`, `telemetry-db-stub.ts`, `telemetry-key-guard.test.ts`, both cron test files, `package.json` and `vercel.json` are byte-identical to `ee92c26`. None of tests 21, 22, 23, 24, 47, 48 or 63 was written. Part VI's guard pin, cron-hash pin, fail-closed stub decoder, guard legibility fix and five behavioural reconciler cases are accepted and untouched; only its route artifact pin is replaced.

## 2. Why the artifact pin was rejected: one line of ordering

`reconciler-races.test.ts` imported the route at module scope — which EXECUTES it — and then read
the file from that same process. The package declares no `"type": "module"`, so tsx emits CommonJS
and `node:fs` exports are a live object. The artifact being measured ran first and owned the ruler.

Five attacks survived at 25 of 25. A shim rebuilt the reviewed bytes by truncating its own source at
a marker and replaced `readFileSync` for its own path; on top of it, the auth gate removed
(`?secret=anything` with no cron header went from 401 with zero statements to 200 with five), the
2 600-second grace turned into a query parameter while the response still echoed
`grace_seconds: 2600`, and every verdict relabelled `reconciled` with `more_may_remain` hard-coded
false. Separately, `SELECT opd_settle_stale_retrieval_row($1, $2, $3)` after a refused
compare-and-set — a body the decoder accepts, carrying neither the table name nor a write verb, so
the classifier never saw it and every refused row was settled anyway. And `node:test`'s `test`
replaced before the cases registered, so two of them ran empty and reported `ok`.

## 3. What replaces it

**A new file that never imports the route.** `lib/__tests__/reconciler-route-artifact.test.ts`
imports `node:test`, `node:assert/strict`, `node:fs` and `node:crypto`, and nothing else — nothing
from `app/`, nothing from `lib/`. `node --test` gives each file its own process, so in that one the
route is never loaded, never executed, and has nothing to patch: no `fs`, no `crypto`, no `test`, no
module cache. The whole pin moved there — the `lstat` gate, the raw SHA-256, the in-process git blob
identity — with the baselines unchanged and still hard-coded.

**A self-check, because the whole fix rests on that isolation.** Before hashing, the file READS
`require.cache` — the process's own record of every module it has evaluated — and asserts no key
lies under `app/api/admin/retrieval-telemetry-reconcile/`. It also asserts the cache is non-empty
and names this file, so the check cannot pass vacuously. An import added later that reaches the
route fails here rather than quietly restoring the old flaw. The file says in its own header why it
is separate: merging it back into `reconciler-races.test.ts` to tidy up restores all five survivors.

**`reconciler-races.test.ts` keeps its route import and every behavioural case.** A shim installed
there can still neuter cases in that file, and it cannot hide — any route change carrying one fails
the artifact file in a clean process.

**Unrecognized now means failed.** The classifier required the literal table name AND an
`update|insert|delete|merge` word, which is two ways to be invisible at once. It now decodes
Postgres Unicode identifiers, so `U&"opd_audit_retrieval_telemetr\0079"` is seen as the table it
names, and classifies any statement naming the table whatever verb it carries. Beyond that, every
statement the route sends is matched against the five shapes it is known to issue, and anything else
fails the case — which is what catches a settle function that names neither.

**The summary is asserted from the response.** `tally` was asserted nowhere and `more_may_remain` only as a substring of the route source, which a shim keeps pristine. A slice of terminal rows must now tally `{won_by_a_later_write: 2}` with no `reconciled:` key at all, and `more_may_remain` must be true when the selected count equals the limit and false when it does not.

## 4. Attacking the split pin

Every mutation ran in a copy outside the repository, the worktree never modified, each copy deleted
afterwards, no helper left in the tree. Recipe: `rsync` the tree excluding `node_modules`, `.git` and
`.next`; symlink `node_modules`; prepend the shim or apply the edit with `perl -0pi -e`; run the
targeted test files with the copy as `cwd`. Counting rule: one row per mutation, each run once;
"caught" means a non-zero `# fail` from the files it was run against.

| class | attacks | caught | survived |
|---|---:|---:|---:|
| the five that survived the in-process pin, re-run unchanged | 5 | 5 | 0 |
| the shim patching `node:crypto` instead of `node:fs`; the shim deleting its own module-cache entry; the route importing the artifact test file; the artifact file made to import the route | 4 | 4 | 0 |
| a statement naming the table with no write verb; one naming it through a Unicode identifier; one the fake table has never seen | 3 | 3 | 0 |
| a comment-only route change; a whitespace-only route change; the route deleted, emptied, and made syntactically invalid | 5 | 5 | 0 |

**One control, and it behaved as it must.** A second test file importing the route was added and the artifact file run alone: it passed, 3 of 3. That is the property, not a survivor — `node --test` isolates by file, so another file's imports cannot contaminate this one's process, and the self-check is scoped to the process it runs in rather than to the repository.

**The deleted, emptied and syntactically-invalid route each fail in a NAMED case now** — "artifact —
the reconciler route is byte-for-byte the reviewed file" — where before the split they made
`reconciler-races.test.ts` fail to load with zero of twenty-five cases registering.

**And the behavioural cases stay load-bearing.** The settle-function attack is caught twice over,
independently: the artifact file's hash, and four behavioural cases in a separate process. One
earlier route change defeated the hash outright and still failed nine of them.

## 5. The gate

| # | Command | Result |
|---|---|---|
| 1 | `npm test` | `# tests 3030 · # pass 3030 · # fail 0 · # skipped 0`, counting `node --test` cases. 3030 − 3026 = 4 added: `reconciler-route-artifact.test.ts` is new at 3, and `reconciler-races.test.ts` goes 25 → 26, having lost the artifact case to the new file and gained the two summary cases. Moving a case between files changes no total |
| 2 | `npm run typecheck` | exit 0 |
| 3a | `env -u CDMSS_TELEMETRY_HMAC_KEY VERCEL=1 VERCEL_ENV=production npm run build` | the expected production-precondition failure occurred: non-zero exit, output naming `CDMSS_TELEMETRY_HMAC_KEY`. Not a green build |
| 3b | `VERCEL=1 VERCEL_ENV=production CDMSS_TELEMETRY_HMAC_KEY=… npm run build` | exit 0 |
| 4 | `npm run architecture:check` | `all 8 rules + coverage green` |
| 5, 6 | `npm run architecture:map && git diff --exit-code HEAD -- lib/architecture/map.generated.ts` | `wrote … (90300 bytes)`, then exit 0, nothing staged |
| 7 | `npm run reasoning:registry && git diff --exit-code HEAD -- data/reasoning-registry/prompts.generated.json` | exit 0, nothing staged |
| 8 | `npm run reasoning:governance` | `GREEN: 0 ungoverned model calls` |
| 9 | `npm run changelog:coverage` | `GREEN: all 19 shipped engine versions documented (30 versioned entries)` |

Both generated artifacts are byte-identical to `ee92c26` by `git hash-object` against `git rev-parse ee92c26:<path>`, not merely unchanged against `HEAD`.

## 6. Flagged, not decided

**New.** The self-check reads `require.cache`, which exists because tsx emits CommonJS here. If the
package ever gains `"type": "module"`, that list is gone and the check silently loses its subject —
it would need `module.builtinModules`-era plumbing or an ESM loader hook instead. The assertion that
the cache is non-empty is what would turn that into a failure rather than a false pass, but the
replacement is not designed.

Unchanged, with V already: D9's contradiction about which states the reconciler alone may reach,
per-role settlement states, and whether the route stays a change-detector once the pin holds.

---

# PART VI — THE RECONCILER PIN (on top of `2eeeaac`)

## 1. What this part did not do

No production behaviour changed: the reconciler route, `next.config.mjs`, both cron test files,
`package.json` and `vercel.json` are byte-identical to `2eeeaac`. None of tests 21, 22, 23, 24, 47,
48 or 63 was written. Part V's guard and cron-hash pins are accepted and NOT redesigned; only its
reconciler pin is replaced.

## 2. Why the reconciler pin was rejected

Seven mutations to `route.ts` alone left all eighteen of Part V's cases green. An unguarded UPDATE
posted as a neon BATCH — `{queries: […]}` has no `query`, so the stub's unchecked cast produced
`undefined` and every classifier tested the string `"undefined"`. A second UPDATE to
`U&"opd_audit_retrieval_telemetr\0079"`, Postgres Unicode-identifier syntax for the same table,
invisible to a substring classifier. The revision re-read immediately before the write and bound from
there, leaving the pinned statement byte-identical and the compare-and-set vacuous. The cutoff
predicate neutralised inside `RECONCILER_SELECT_SQL`, which no case pinned as a statement. A per-row
`catch` fabricating a `reconciled` verdict, returning 200 and `ok: true` with nothing written. A
64-step blind revision walk on a branch no case reached. And `authed()` short-circuited to `true`.

Four passes tried to recognise every dangerous SQL form through an incomplete fake database, and lost four times. That approach is abandoned.

## 3. What replaces it

**The route artifact is pinned**, the way the guard pin holds: `lstat` first — regular file, not a
symlink, `nlink === 1`, mode `0644` — then the raw bytes hashed against a SHA-256 recorded at
`2eeeaac`, and hashed again under git's own blob identity, computed in the test rather than by
shelling out, so digest, blob id and file must all agree. Both baselines live in
`reconciler-races.test.ts`, outside the file hashed, neither derived from the tree at run time.

**What that costs, plainly:** any legitimate change to the route now requires updating the baseline
under explicit review. That is the point — making a reviewer look at a one-line diff to a
compare-and-set on a deploy path is the benefit, not the price. mtime, uid, gid, ACLs and xattrs stay
outside the contract, as for the cron files: git preserves none of them.

**The stub fails closed.** `lib/__tests__/telemetry-db-stub.ts` cast its decoded body instead of
validating it. It now accepts exactly one shape — a string `query`, an array `params` — and throws
`UnsupportedStubTransportError` for everything else, batches included, appending nothing to `calls`.
Batch support was NOT added: the frozen route issues one statement per call, and refusing what is not
modelled is smaller and safer than modelling a transport nothing uses.

**Five behavioural cases stay**, because a hash says the file has not changed and nothing about what
it does, and a change that updates the baseline would sail past it. The first write binds the
revision the SELECTION returned, not one re-read since; the stale SELECT sent at run time equals a
complete hard-coded statement including `started_at < $1`; a transport error on a write is a 500 with
`ok: false` and no invented verdict; a second conflict on the reread path stops after two writes and
one reread; an unauthenticated request is 401 with zero database calls. The last two had no coverage
at all before.

**Part V's guard pin gains legibility only.** Its reads and `inlinedGuard()` moved out of module
initialization into the cases, so a deleted, emptied or truncated config now fails inside named tests
rather than before `node --test` registers any. Measured with the config deleted: 14 cases register
and 9 fail, where 0 registered before. No assertion changed; all fourteen guard attacks still caught.

## 4. Attacking the new pin

Every mutation ran in a copy outside the repository, the worktree never modified, each copy deleted afterwards, no helper left in the tree. Recipe: `rsync` the tree excluding `node_modules`, `.git` and `.next`; symlink `node_modules`; apply the mutation with `perl -0pi -e`; run the targeted test file with the copy as `cwd`. Counting rule: one row per mutation, each run once; "caught" means the file reported a non-zero `# fail`.

| class | attacks | caught | survived |
|---|---:|---:|---:|
| the seven that survived Part V's pin, re-run unchanged | 7 | 7 | 0 |
| ⚠️ **withdrawn as a claim about the PIN.** Every mutation below was caught, and five forms were not tried; all five defeat this pin. Part VII §2 names them and moves the pin into its own process | — | — | — |
| new forms: a comment-only route change; a whitespace-only route change; a second db client imported under another name; a write moved into a module the route imports; the route deleted; the route emptied; a module the route imports broken | 7 | 7 | 0 |
| stub bodies, through the decoder directly: a batch, non-JSON, an array, a bare string, a number, `query` as a number, `params` as a string, `query` absent | 8 | 8 | 0 |
| guard attacks from Part V, re-run after the legibility change | 14 | 14 | 0 |

**No survivors, and two results worth stating rather than counting.** The neon-batch and
deleted-route attacks are caught because the test file fails to LOAD: the route import throws before
the artifact pin can report. A failure, and not a graceful one — the shape the guard file had before
§3's legibility fix, **not fixed here** because fixing it means importing the route lazily in every
case, a redesign of a pin that works. And five of the seven are caught independently by the
behavioural cases — the revision re-read by 10 of them, the SELECT mutation, the fabricated verdict,
the blind walk and the short-circuited `authed()` each by their own — so a change that legitimately
updates the baseline still fails with a message saying what broke.

## 5. The gate

| # | Command | Result |
|---|---|---|
| 1 | `npm test` | `# tests 3026 · # pass 3026 · # fail 0 · # skipped 0`, counting `node --test` cases. 3026 − 3019 = 7 added, all in `reconciler-races.test.ts` (25 from 18); `telemetry-key-guard.test.ts` is unchanged at 14 |
| 2 | `npm run typecheck` | exit 0 |
| 3a | `env -u CDMSS_TELEMETRY_HMAC_KEY VERCEL=1 VERCEL_ENV=production npm run build` | the expected production-precondition failure occurred: non-zero exit, output naming `CDMSS_TELEMETRY_HMAC_KEY`. Not a green build |
| 3b | `VERCEL=1 VERCEL_ENV=production CDMSS_TELEMETRY_HMAC_KEY=… npm run build` | exit 0 |
| 4 | `npm run architecture:check` | `all 8 rules + coverage green` |
| 5, 6 | `npm run architecture:map && git diff --exit-code HEAD -- lib/architecture/map.generated.ts` | `wrote … (90300 bytes)`, then exit 0, nothing staged |
| 7 | `npm run reasoning:registry && git diff --exit-code HEAD -- data/reasoning-registry/prompts.generated.json` | exit 0, nothing staged |
| 8 | `npm run reasoning:governance` | `GREEN: 0 ungoverned model calls` |
| 9 | `npm run changelog:coverage` | `GREEN: all 19 shipped engine versions documented (30 versioned entries)` |

Both generated artifacts are byte-identical to `2eeeaac` by `git hash-object` against `git rev-parse 2eeeaac:<path>`, not merely unchanged against `HEAD`.

## 6. Flagged, not decided

**New.** The route artifact pin is a change-detector, so the first legitimate reconciler change will
fail it. The baseline is a two-line edit in `reconciler-route-artifact.test.ts`, which is where Part
VII moved it, and the failure message says so — but somebody should decide that policy is right
rather than discover it mid-change. **Decided 13 August** (decisions §4, addendum item 1b): keep the
detector, and both re-baseline procedures are now written into the two pin files themselves.

Unchanged, with V already: D9's contradiction about which states the reconciler alone may reach, and
per-role settlement states when two roles on one handle disagree.

---

# PART V — PIN REPAIR, SECOND PASS (on top of `180e88f`)

## 1. What this part did not do

No production code changed. `next.config.mjs`, the reconciler route, both cron test files and
`telemetry-db-stub.ts` are byte-identical to `180e88f`. None of tests 21, 22, 23, 24, 47, 48 or 63
was written, and one survivor found in §4 is **not fixed** — §6 flags it. Six sentences false of the code beneath them are corrected in place, three per test file, each naming what it used to claim.

## 2. The guard: the file, not the statement

Part IV's harness ran the config as `process.argv[1]`; a build IMPORTS it, so anything that can tell those apart kills the guard for the test and leaves it on for nobody. Three things replace it.

**The whole file** is pinned: exactly three top-level statements in order — guard, `nextConfig`
declaration, default export — each shape-exact, no imports, no directives, no call, `new`, `await`,
function or comma expression outside the guard's condition, over a non-empty source that parses
cleanly. Every kill in that class was a prepended statement.

**The import runs in a child a build cannot be told from**: `--input-type=module --eval` with the
config URL in the environment so it never appears in `argv`, `NODE_TEST_CONTEXT` deleted, `VERCEL_URL`
set as a deployment sets it, exit `86` on a caught import, one JSON record on stdout carrying `name`
and `message` only, stdout and stderr never combined.

**The message is evaluated, not grepped**: `new Error(/* CDMSS_TELEMETRY_HMAC_KEY */ 'build misconfigured')` satisfied a source search and names nothing a reader sees, so the sole argument must be string literals joined by `+`, folded, and contain the variable name.

## 3. The reconciler, and the hashes

`AND row_revision = $2 OR TRUE` parses as `(id AND rev) OR (nonterminal)` and rewrites every
non-terminal row in one pass; a predicate parked behind `AND TRUE` in a `--` comment is text, not SQL.
Both passed a substring check. So every statement that WRITES the table — classified by table name
plus a write verb, not an anchored regex, so a CTE or a lower-case `update` is still seen — is
normalized and compared WHOLE against a value hard-coded in the test, with `--`, `/*`, `;` and NUL
refused outright.

Counts are pinned per path: 1 write / 0 rereads for an ordinary pass and the SQL-shape case, 2 / 0
for two selected rows, 2 / 1 for the race finding a fresh non-terminal row, 1 / 1 for the one finding
a terminal row, 0 / 0 for the transition refusal, 1 / 0 for the cutoff case. Those refuse a spin loop,
a forced unguarded write, and a guard weakened only on the reread path — whose write is checked by
the same helper as the first, where two kills lived.

The cutoff is bounded against the wall clock — a source pin on the constant's name is satisfied by
the import line, and `const cutoff = at` keeps `grace_seconds: 2600` in the response — so the bound
`$1` must sit inside `[before − 2 600 000, after − 2 600 000]` ms around the call. The refusal
branch is reached by fault injection — `aborted` removed from `ALLOWED_TRANSITIONS.started` for one
case, restored in `finally` — because no valid row reaches it. Nothing asserts inside the fetch
callback, since `route.ts:192` catches and returns 500, so every case asserts 200 and `ok: true`
first. For the two cron files, `lstat` must report a regular file, not a symlink, `nlink === 1`, mode
`0644` before a byte is read: `chmod 777` and a symlink to identical content both passed Part IV.
mtime, uid, gid, ACLs and xattrs stay outside the contract, stated in the file — git preserves none.

## 4. Attacking the pins before claiming they hold

Every mutation ran in a copy outside the repository, the worktree never modified, each copy deleted
afterwards, no helper left in the tree. Recipe: `rsync` the tree excluding `node_modules`, `.git` and `.next`; symlink `node_modules`; mutate; run the targeted file with the copy as `cwd`. Counting rule: one row per mutation, each run once; "caught" means a non-zero `# fail`.

| class | attacks | caught | survived |
|---|---:|---:|---:|
| guard: a prepended statement of every kind; discriminators on `argv[1]`, `NODE_TEST_CONTEXT`, `VERCEL_URL`, `.env.local`; an `uncaughtException` handler; a comma expression in the initializer; the statements reordered; the comment decoy; a guard firing unconditionally; the config emptied, corrupted, deleted | 14 | 14 | 0 |
| reconciler: `OR TRUE`; both predicates parked in `--` comments; a weakening on the reread path only; a write inside a CTE; a lower-case `update`; the grace removed; a fifty-iteration spin loop; the refusal moved after the write; a change to what is bound rather than written | 10 | 10 | 0 |
| ⚠️ **the row above is withdrawn as a claim about the PIN.** Those ten mutations were caught; nine further forms were not tried, and seven of them survive this pin. Part VI §2 lists them and replaces the pin | — | — | — |
| hashes: `chmod 777`, a symlink, a second hard link, a deleted file | 4 | 4 | 0 |
| boundary probes, chosen to find what the pins do NOT cover | 6 | 2 | 4 |

**The four survivors, none fixed.** `"build": "next build || true"` in `package.json` — the suite
proves the config throws on import, not that `npm run build` reaches it; gate 3a covers that, nothing
in the suite does, §6 flags it. A widened column list on the reread `SELECT` — only writes are pinned
whole, and a reread of the wrong ROW still fails the verdict assertions. The slice size
cut from 500 to 5 — a bound, not the property. An mtime change on a cron file — outside the contract.
Emptying, corrupting or deleting `next.config.mjs` fails the guard file at module LOAD, not in a
named case, because the guard is located at module scope: a failure, and not a graceful one.

## 5. The gate

| # | Command | Result |
|---|---|---|
| 1 | `npm test` | `# tests 3019 · # pass 3019 · # fail 0 · # skipped 0`, counting `node --test` cases. 3019 − 3014 = 5 added: 3 in `telemetry-key-guard.test.ts` (14 from 11), 2 in `reconciler-races.test.ts` (18 from 16) |
| 2 | `npm run typecheck` | exit 0 |
| 3a | `env -u CDMSS_TELEMETRY_HMAC_KEY VERCEL=1 VERCEL_ENV=production npm run build` | the expected production-precondition failure occurred: non-zero exit, output naming `CDMSS_TELEMETRY_HMAC_KEY`. Not a green build |
| 3b | `VERCEL=1 VERCEL_ENV=production CDMSS_TELEMETRY_HMAC_KEY=… npm run build` | exit 0 |
| 4 | `npm run architecture:check` | `all 8 rules + coverage green` |
| 5, 6 | `npm run architecture:map && git diff --exit-code HEAD -- lib/architecture/map.generated.ts` | `wrote … (90300 bytes)`, then exit 0, nothing staged |
| 7 | `npm run reasoning:registry && git diff --exit-code HEAD -- data/reasoning-registry/prompts.generated.json` | exit 0, nothing staged |
| 8 | `npm run reasoning:governance` | `GREEN: 0 ungoverned model calls` |
| 9 | `npm run changelog:coverage` | `GREEN: all 19 shipped engine versions documented (30 versioned entries)` |

Both generated artifacts are byte-identical to `180e88f` by `git hash-object` against `git rev-parse 180e88f:<path>`, not only unchanged against `HEAD`.

## 6. Flagged, not decided

**New.** `npm run build` can be made to swallow the guard's failure without touching `next.config.mjs`. The suite would not notice; gate 3a would. ⚠️ **Corrected in Part VI:** this defeats the local gate and CI and does NOT reach the Vercel deploy, because `vercel.json:5` sets `"buildCommand": "next build"` and Vercel runs that directly. Unchanged, with V already: D9's contradiction about which states the reconciler alone may reach, and per-role settlement states.

---

# PART IV — PIN REPAIR (on top of `e5dc756`)

## 1. What this part did not do

No production code changed, and none of tests 21, 22, 23, 24, 47, 48 or 63 was written.

```
$ git diff --name-only e5dc756
CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md
lib/__tests__/reconciler-races.test.ts
lib/__tests__/telemetry-key-guard.test.ts
```

A mode change, type change or rename is **not established** by any test (SHA-256 sees content only), and nothing new was flagged. Part III §10 holds eight flags, seven of them carrying an explicit "not decided", "not made", "not wired", "not fixed" or "V's call" — counting `**Flag` headings and those five markers.

## 2. The D8 deploy guard is now EXECUTED, not only parsed

`next.config.mjs` is spawned in a fresh child process, three times, with `VERCEL`, `VERCEL_ENV` and
the key fixed explicitly and everything else ambient. The oracle was kept: it compares one
`IfStatement`'s condition, and five of the six attacks below live outside it. The sixth, attack 4,
rewrites that condition — lines 12 and 13 of `next.config.mjs` — and the oracle passes it anyway,
because respelling `process.env.` as `env.` renders identically by design.

```
$ # in a scratch copy: prepend each attack line to next.config.mjs, then run the test file
=== baseline (unmutated scratch copy: guard ALIVE, all pass) ===
baseline                                       guard ALIVE   # pass 11  # fail 0

=== six attacks (each: guard DEAD, and the test must FAIL) ===
1. VERCEL forced to '0' above the guard        guard DEAD    # pass 10  # fail 1  not ok 6 - 57 EXECUTED
2. process shadowed, guard lines untouched     guard DEAD    # pass 10  # fail 1  not ok 6 - 57 EXECUTED
3. String redefined                            guard DEAD    # pass 10  # fail 1  not ok 6 - 57 EXECUTED
4. clauses respelled env., env shadowed        guard DEAD    # pass 10  # fail 1  not ok 6 - 57 EXECUTED
5. process.env redefined with a key            guard DEAD    # pass 10  # fail 1  not ok 6 - 57 EXECUTED
6. uncaughtException handler, no try anywhere  guard DEAD    # pass 10  # fail 1  not ok 6 - 57 EXECUTED
```

Six attacks, the list complete: the six the brief names, each run once. The `guard` column is
independent — the config is run under production inputs and its exit status read.

Attack 4 is the instructive one: the oracle passes it — respelling `process.env.` as `env.` renders
identically by design — and only the executed case fails.

## 3. The reconciler's compare-and-set is proven at run time

The exported `GET` is driven with a cron-authenticated `NextRequest` through the transport stub,
against a fake table that decides whether an update lands from the observed SQL, the bound parameters
and the row's state and revision. Five cases: the pass runs and selects; the UPDATE **as sent**
carries both predicates; each row binds its own revision; the stale decision does not land; a
terminal row wins.

The line a source pin cannot see, applied to `route.ts:124` and reverted byte-identically:

```
$ node --test --import tsx lib/__tests__/reconciler-races.test.ts   # with RECONCILER_UPDATE_SQL.replace(…)
not ok 8 - 55 runtime — the UPDATE the route ACTUALLY SENT carries both predicates
not ok 10 - 55 runtime — THE STALE DECISION DOES NOT LAND: reread, reclassify, write the FRESH state
# pass 14
# fail 2
```

The stale-decision case is the property: selected `started` at 7, moved to `retrieval_complete` at 8
immediately before the first update is evaluated; the first binds `'7'`/`aborted` and affects
nothing, exactly one reread happens, the second binds `'8'`/`persistence_unknown` and lands. Two
updates, counted with `/^\s*UPDATE opd_audit_retrieval_telemetry\b/`, because the request also
closes its invocation.

## 4. The untouched regions of the two cron test files are hashed

Neither file is edited. The one authorised line is replaced in memory with its `177adc9` line and the
whole file hashed against a baseline stored in `reconciler-races.test.ts`, not derived from the
current source and not from git.

```
$ # in a scratch copy: apply each mutation, then run lib/__tests__/reconciler-races.test.ts
=== baseline (unmutated scratch copy: must PASS) ===
baseline                                             # pass 16  # fail 0

=== three mutations (each must FAIL) ===
1. provider-switch-unit-d:273 -> assert.ok(true);    # pass 15  # fail 1  not ok 15 - 64
2. provider-switch-unit-d: one byte on line 1        # pass 15  # fail 1  not ok 15 - 64
3. ipd-worker-batch-and-model: one byte on line 1    # pass 15  # fail 1  not ok 15 - 64
```

Three mutations, and the list is complete: the one the brief names, plus one unrelated byte in each
file. The whole-file hash carries the property; the three show it holds.

## 5. Sentences corrected

| Where | What it claimed | What was done |
|---|---|---|
| header | formatting, line breaks and the `process.env.` / `env.` spelling are the only things the oracle does not count | Replaced. Parentheses, optional chaining and whether `env` is the environment at all are also not counted, and the header now says the list is not short. |
| the throw pin | "nothing here may be caught and logged" above an assertion that checks only for a `try` keyword | Narrowed to what it checks. Attack 6 swallows the throw with no `try` anywhere; the executed case is what proves the build fails. |
| header | a fourth clause joined by any operator is a difference | Made true: `.trim()`'s argument list was the one unchecked position, and `trimCall.arguments.length === 0` now closes it. |
| `reconciler-races.test.ts` header | the route is "pinned by source and by its two exported statements" | There are none — Next rejects extra route exports — and there are three constants. Rewritten to say that, and why source alone was insufficient. |
| Part III §3.2 | "D11 line 681" | The sentence is at line 674 (`grep -n "counts newly inserted run ids only" CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md` → `674:`). |

## 6. The gate

| # | Command | Result |
|---|---|---|
| 1 | `npm test` | `# tests 3014 · # pass 3014 · # fail 0 · # skipped 0` — the total the runner emits, counting `node --test` cases. 3014 − 3006 = 8 added: 3 in `telemetry-key-guard.test.ts` (11 from 8), 5 in `reconciler-races.test.ts` (16 from 11). |
| 2 | `npm run typecheck` | exit 0 |
| 3a | `env -u CDMSS_TELEMETRY_HMAC_KEY VERCEL=1 VERCEL_ENV=production npm run build` | **the expected production-precondition failure occurred**: non-zero exit, output naming `CDMSS_TELEMETRY_HMAC_KEY`. Not a green build. |
| 3b | `VERCEL=1 VERCEL_ENV=production CDMSS_TELEMETRY_HMAC_KEY=… npm run build` | exit 0 |
| 4 | `npm run architecture:check` | `all 8 rules + coverage green` |
| 5, 6 | `npm run architecture:map && git diff --exit-code HEAD -- lib/architecture/map.generated.ts` | `wrote … (90300 bytes)`, then exit 0 — compared against `HEAD`, nothing staged |
| 7 | `npm run reasoning:registry && git diff --exit-code HEAD -- data/reasoning-registry/prompts.generated.json` | exit 0, no staging |
| 8 | `npm run reasoning:governance` | `GREEN: 0 ungoverned model calls` |
| 9 | `npm run changelog:coverage` | `GREEN: all 19 shipped engine versions documented (30 versioned entries)` |

## 7. The commit shape, which this part asserted nowhere

Stated now, from `e5dc756` rather than from `HEAD`: `git diff --summary e5dc756` printed nothing, so
no mode, type or rename change; `git diff --name-status e5dc756` printed three `M` rows and no
others; `git diff --cached --name-only` equalled those three paths exactly; both generated artifacts
and both cron test files were byte-identical to `e5dc756` by `git hash-object` against
`git rev-parse e5dc756:<path>`; the parent was `e5dc756e87e4e24315038f6d27fc727d9142a09a`; and
`git status --short` was empty afterwards. All six held; none was written down.

# PART III — STEPS 14 TO 17, AND THE TEST 57 FIX

**Build report, 12 August 2026.** Branch `exp/rerank-telemetry`, on top of `177adc9`. Not pushed.

Governing documents unchanged: `CDMSS-RERANK-TELEMETRY-PRD-v2.1-11-AUG-2026.md` and
`CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md`.

No number here is restated from an earlier report: where an earlier figure would have been useful it
was re-measured or dropped. This part makes **no claim about its own method** beyond that — a
statement that every row carries its command is not checkable by reading the report, and the last
one that stood in this file was false. Check the row you care about.

---

## 1. WHAT WAS NOT BUILT

By step, then by test number, before anything else.

### 1.1 Steps not built

| Step | Status | Why |
|---|---|---|
| 18 | **NOT BUILT** | "Register every new `lib/*.ts` exporting a `*_VERSION` const." No module added by this pass exports one — `git grep -c "_VERSION =" lib/retrieval-*.ts lib/opd-audit-runtime-config.ts` returns nothing new. `architecture:check` coverage is green at 39 subsystems either way (§8 row 4). Nothing was registered because nothing qualified; if V reads step 18 as covering the constants that DO exist (`TELEMETRY_SCHEMA_VERSION`, `MANIFEST_SCHEMA_VERSION`, both already in `retrieval-telemetry-core.ts` at `177adc9`), that is a flag, not a build. |
| 19 | **DEFERRED** by §1 of the brief | The cost query text and the ten PRD §8 query texts. |
| 21 | **DEFERRED** by §1 of the brief | The five PRD §6.5 overhead numbers stay unmeasured. |

### 1.2 Tests not written, by number

The brief's §5 assigns 28 numbered tests to steps 14–17. **Six of them were not written.**

```
$ node -e 'const s14=[19,25,26,27,28,29,30,62],s15=[20,21,22,23,24,31,32,33,34,47,48],s16=[15,51,52,53,54],s17=[55,58,59,64];
const all=[...s14,...s15,...s16,...s17];
const written=[15,19,20,25,26,27,28,29,30,31,32,33,34,51,52,53,54,55,58,59,62,64];
const missing=all.filter(n=>!written.includes(n));
console.log("assigned",all.length,"written",all.filter(n=>written.includes(n)).length,"not written",missing.length,missing.join(", "))'
assigned 28 written 22 not written 6 21, 22, 23, 24, 47, 48
```

The six are:

| # | Subject | Why not |
|---|---|---|
| 21 | `onLifecycleHandleUpdated` fires after declaration and after each terminal write, and a throw at each of D11's five points leaves the caller holding the latest handle | Needs `auditOpdNote` driven end to end with five injected throw points. Its collaborators (retrieval, expansion, rerank, context assembly, generation) are not injectable at that function's boundary, so there is no seam to drive it from. **Not established.** |
| 22 | A throw after declaration and before any save settles `audit_generation_failed`, from `started` AND from `retrieval_complete` | Same seam. The *mapping* is exercised (`retrieval-settlement.test.ts`, "revision 0 KEEPS an outcome a never-retrieved run can honestly carry"); the *path through `auditOpdNote`* is not. |
| 23 | The D11 fourteen-step order: the primary terminal write happens after `assembleAuditContext` | Same seam. The order is visible in the source and is commented there; nothing asserts it. |
| 24 | `trace_id` null at declaration, written at the terminal write, null for both `trace: false` callers | Same seam. |
| 47 | The scorer-context HMAC by role | Belongs to `retrieval-capture-payload.test.ts`, which is on §4's create list and was **not created** (see 1.3). |
| 48 | An absent HMAC key outside production: four explicit nulls, `telemetry_error`, a persisting role settling `persisted_partial` | Half is D8 (covered by test 57's five cases) and half is settlement under an absent key, which needs the same `auditOpdNote` seam. |

**The common cause is one thing, said once:** `auditOpdNote` has no injection seam for its retrieval,
context-assembly or generation collaborators, so no test in this repository can drive it. Every test
that needed one is on the list above. That is a testability defect in the audit function, not in the
telemetry, and it is flag 5 in §10.

### 1.3 Files on §4's create list that were not created

```
$ ls lib/__tests__/retrieval-capture-payload.test.ts 2>&1
ls: lib/__tests__/retrieval-capture-payload.test.ts: No such file or directory
```

`retrieval-capture-payload.test.ts` is named in §4 of the brief. Its kickoff tests (49, 50) are not
in §5's step 14–17 list, so it was left; test 47 above is the one thing lost by that.

### 1.4 One file created that is on no list

`lib/__tests__/telemetry-db-stub.ts`, 132 lines. Not a test file — the `lib/**/__tests__/*.test.ts`
glob does not collect it. Four of the test files this pass owes assert what reaches the database and
there is no database in this sandbox; duplicating the stub into four files would have kept the file
list pure and made four copies drift. Flagged, not decided (§10 flag 6).

```
$ wc -l lib/__tests__/telemetry-db-stub.ts
     132 lib/__tests__/telemetry-db-stub.ts
```

---

## 2. THE TEST 57 FIX

### 2.1 The hole, reproduced

The old `normalize()` stripped all whitespace before comparing, **including whitespace inside string
literals**. One character in `next.config.mjs` defeated both the guard and its pin.

Reproduced in a scratch copy of the three files the pin reads, never in the worktree
(`/Users/vinaybhardwaj/.claude/jobs/a5ac63db/tmp/d8-mutations.sh`, which copies
`next.config.mjs`, `lib/telemetry-key-guard.ts` and the test into a scratch directory and symlinks
`node_modules`).

### 2.2 What replaces it

Both copies of the D8 predicate are now **parsed** by the TypeScript compiler API — already a
devDependency at 5.9.3 — and compared as syntax trees.

```
$ node -e "console.log(require('typescript/package.json').version)"
5.9.3
```

Exactly one thing is normalized: `process.env.X` in a build script and `env.X` in a function that
takes the environment as a parameter both render as `ENV.X`. String literals render from their
**value**, so `'1'` and `'1 '` are different literals. The oracle then validates each copy
independently: exactly three `&&` clauses at the top level, **no `||` anywhere in the condition**
(which is what catches a fourth clause the `&&` count could not see), both comparison roots as
`===`, both string literals byte-exact, the env var name taken from `TELEMETRY_HMAC_KEY_ENV`, the
`.trim()` present joint by joint, and — for the inlined copy — that it guards a direct `throw` with
no `try` anywhere in the file to swallow it. Then the two renderings are compared to each other.

### 2.3 The five mutations, each of which must FAIL

Baseline first, so a test file that failed for an unrelated reason could not be mistaken for a
mutation being caught.

```
$ zsh /Users/vinaybhardwaj/.claude/jobs/a5ac63db/tmp/d8-mutations.sh
=== baseline (unmutated scratch copy: must PASS) ===
baseline                                                   # pass 8  # fail 0

=== five mutations (each must FAIL) ===
1. inlined '1' -> '1 '                                     # pass 6  # fail 2   not ok 6 - 57 pin — each copy is exactly D8's three clauses, and there is no fourth of any kind
2. typed 'production' -> 'Production'                      # pass 4  # fail 4   not ok 1 - 57 case 1 — production Vercel build with no key at all: MISSING
3. inlined .trim() removed                                 # pass 6  # fail 2   not ok 6 - 57 pin — each copy is exactly D8's three clauses, and there is no fourth of any kind
4. '|| false' added to BOTH                                # pass 7  # fail 1   not ok 6 - 57 pin — each copy is exactly D8's three clauses, and there is no fourth of any kind
5. fourth '&&' clause added to BOTH                        # pass 7  # fail 1   not ok 6 - 57 pin — each copy is exactly D8's three clauses, and there is no fourth of any kind

=== scratch restored, worktree never touched ===
scratch == worktree
```

**One correction inside the harness itself, recorded because it nearly produced a false pass.** The
first run of mutation 1 reported `# pass 8 # fail 0`. The substitution had landed on the **comment**
at `next.config.mjs:9`, which quotes the same three clauses and is the first occurrence in the file;
the code was untouched and the pin was right to pass. The mutation is now anchored on
`process.env.VERCEL === '1'`. A mutation test that mutates nothing proves nothing, and this one
would have been read as proof.

### 2.4 The third, cosmetic hole

Case 4 was titled "NOT missing, at any key value" and tried exactly one key value. It now sweeps six
— absent, empty, three spaces, `\t\n `, `k`, `  k  ` — across all three non-production `VERCEL_ENV`
values, and case 5 sweeps the same six. The title is now true of the test.

### 2.5 The file's own comment

The old header claimed "a changed literal still fails". That is now true and is proven above; the
comment was rewritten to describe the parser rather than deleted.

```
$ node --test --import tsx lib/__tests__/telemetry-key-guard.test.ts 2>/dev/null | grep -E "^# (pass|fail)"
# pass 8
# fail 0
```

---

## 3. THE FIVE DEFECTS IN §2 OF THE BRIEF

### 3.1 A revision-0 run was settled as if it had succeeded (§2.1, step 16)

**What was wrong.** `settleRetrievalTelemetry` computed one state outside the loop and mapped
`settled`, `noop` **and** `rejected` to `{ status: 'settled' }`. `applyTerminalState` returns
`rejected` from five places — no row, stale revision, already terminal, disallowed transition, and a
zero-row update — and every one of them was reported to the caller as a success.

**What was built.**

1. A revision-0 run is now settled **from the failure evidence**, which is D9's second clause and
   was not implemented. Two cases, and they are different:
   - the outcome is one a run that never retrieved can honestly carry (`retrieval_not_run`,
     `audit_generation_failed` — both legal from `started`): it is applied unchanged, and the
     failure evidence is not read at all;
   - the outcome implies a retrieval that completed: D12's transition guard forbids it from
     `started`, so `reconcilerStateFor` decides — `retrieval_terminal` evidence gives
     `telemetry_persistence_failed`, no evidence gives `aborted`.
2. `PerRunSettlementResult.status` gains `'rejected'`, with a named `rejection` and **durable
   evidence**: a `persistence_link` failure row carrying `error_class`
   `settlement_rejected_<reason>`. `noop` remains `settled` — a retry of a write that already landed
   is not a second event.

```
$ node --test --import tsx lib/__tests__/retrieval-settlement.test.ts 2>/dev/null | grep -E "^# (pass|fail)"
# pass 11
# fail 0
```

Eleven cases, including all five rejection classes one at a time, each asserting the status, the
named reason, and that exactly one failure row was written with the right phase and error class.

**⚠️ THE SIGNATURE CHANGE IS FLAGGED, NOT TAKEN QUIETLY.** D12 fixes that union at two values. The
brief says: "take the smallest form that stops reporting a rejected write as a success", and this is
it. See flag 1.

### 3.2 `declared_retrievals` counted what was asked for (§2.2, step 14)

The insert ends `ON CONFLICT (retrieval_run_id) DO NOTHING` and carried no `RETURNING`, so the
increment bound `runs.length`. D11 line 674: "counts newly inserted run ids only." It now binds the
rows that landed.

```
$ node --test --import tsx lib/__tests__/retrieval-invocation-store.test.ts 2>/dev/null | grep -E "^# (pass|fail)"
# pass 13
# fail 0
```

The case that matters declares three runs, has the transport return two, and asserts the increment
binds `'2'` — and that a declaration landing nothing bumps nothing at all.

### 3.3 A failed declaration wrote no evidence (§2.3, step 14)

`declareRetrievals` had no `try`. `work_declaration` was in the phase union and in the migration's
CHECK, and **no code path had ever written one** — so a failed declaration, which by D13 produces no
retrieval row and whose "evidence lives only in the failure table", was invisible everywhere.

One failure row per run the batch was going to declare, then the throw still propagates (the
worker's declaration is fail-closed). Kickoff test 29, in the file above.

### 3.4 The multi-query manifest would have carried a null `index_version` (§2.4, steps 9 and 11)

`index_version` is written in exactly one place in the tree:

```
$ grep -rn "capture.indexVersion" lib | grep -v __tests__
lib/retrieve.ts:399:  if (capture) capture.indexVersion = `${embCol}|${useV2 ? EMBED_MODEL_V2 : EMBED_MODEL}`;
lib/retrieval-capture.ts:308:    index_version: capture.indexVersion,
lib/multi-query.ts:308:    capture.indexVersion = capture.indexVersion
```

Three lines, two of which write it: `retrieve.ts:399` is the original and only writer,
`multi-query.ts:308` is this pass, and `retrieval-capture.ts:308` READS it into the payload. `retrieveMultiQuery` called `retrieveFn(q, {…})` with two
arguments and `retrieve`'s capture is its third positional parameter, so no arm ever got one.

**The fix does not hand the parent capture down.** `retrieve()` also writes the candidate id lists,
the passage texts and the retrieval outcome — fusion-level facts the fusion computes for itself —
and six arms writing them in turn would have left the parent holding one arbitrary arm's view of a
pool it never had. Each arm gets its own capture, they are kept on `capture.children` (declared in
D5, written by nothing until now), and `index_version` is lifted from the first arm that has one.
Because `retrieve()` stamps before its first fallible statement, an arm that threw still has one.

```
$ node --test --import tsx lib/__tests__/multi-query-telemetry.test.ts 2>/dev/null | grep -E "^# (pass|fail)"
# pass 5
# fail 0
```

**The brief's correction to the review stands and is worse, not better.** Nothing rejects the null at
run time: `validateManifest` returns a `string[]`, the column is nullable and there is no CHECK. This
pass gives `validateManifest` its first production caller — `writeRetrievalTerminals` runs it and
hands the verdict to the owner — so a dirty manifest now makes a persisted row `persisted_partial`,
which is what D17 always said and nothing did. It still does not *reject*.

### 3.5 `DeclareInput` advertised two fields no writer consumed (§2.5, step 14)

`pairId` and `replicate` were declared and bound by nothing, which left
`opd_art_experiment_idx` — an index on `(experiment_run_id, pair_id)` — with a second column no
writer could populate. Both are now bound by the insert, alongside `experiment_run_id`, which is
their sibling and was already bound there. **No values were invented**: no caller supplies them, and
what goes in them is an A/A question V has not opened. The bound-parameter test asserts all three
positions, and asserts `[null, null, null]` when absent.

**A discrepancy this surfaced, flagged not fixed.** `COLUMN_CLASSIFICATION` calls all three
`mutable_terminal`, "written by the terminal write and by settlement". None of the three is in
`writeRetrievalTerminal`'s SET list; all three are written at insert. That was already true of
`experiment_run_id` before this pass. See flag 2.

---

## 4. WHAT §3 OF THE BRIEF FORBADE, AND WAS NOT DONE

`writeRetrievalTerminal` does **not** reread and compare after a zero-row update.

```
$ grep -c "reread" lib/retrieval-telemetry-store.ts
0
```

The zero-row branch logs and returns the unchanged handle, as D12 requires ("never retried
blindly"). Reread-and-compare appears once in either document, inside D13, and it governs the
reconciler — where it is built (§6).

---

## 5. THE D9 OWNER MATRIX AS WIRED

Thirty settlement call sites, in seven files.

```
$ grep -rn "await settleOwned(" lib app scripts | grep -v __tests__ | awk -F: '{print $1}' | sort | uniq -c | sort -rn
   7 app/api/opd-audit/worker/route.ts
   7 app/api/opd-audit/run/route.ts
   5 lib/mcp-tools.ts
   4 scripts/bedrock-opd-note-probe.mjs
   3 app/api/admin/opd-audit-mini-backfill/route.ts
   2 scripts/metamorphic-llm-report.mjs
   2 lib/lab-batch.ts
```

One line per path in D9's matrix:

| Path | Outcome settled | Where |
|---|---|---|
| worker, day and sweep — inserted/updated | `persisted_clean` / `persisted_dirty` via `onPersisted` | `worker/route.ts` `processDay` |
| worker — exists | `losing_conflict` | same, `if (!linked)` |
| worker — skipped | `persistence_skipped` | same |
| worker — DEC-2 refusal | `persistence_refused` | same, before the save |
| worker — throw after adoption | `audit_generation_failed` | same, per-note catch |
| worker — throw before adoption | `retrieval_not_run` | same, discriminated by whether the handle was ever published |
| worker, re-audit | identical, in the reshaped arm | `worker/route.ts` re-audit block |
| run route GET, force arm | `audit_persistence_failed` **settled by that arm itself** | `run/route.ts` — its `.catch(() => 'save_failed')` means the throw never reaches the outer catch |
| run route GET, normal arm | as the worker | `run/route.ts` |
| run route GET, no `?save=1` | `no_persistence_intended` | `run/route.ts` |
| run route POST | `no_persistence_intended` | `run/route.ts` POST |
| mini-backfill | as the worker; DEC-2 throw → `persistence_refused` | `opd-audit-mini-backfill/route.ts` |
| mcp-tools `mini_analyze` | `no_persistence_intended` | `mcp-tools.ts` |
| mcp-tools `backfill_control` | as the worker | `mcp-tools.ts` |
| mcp-tools `lab_retrieve`, both branches | `no_persistence_intended`, on the success AND failure paths | `mcp-tools.ts` `labRetrieve` |
| lab-batch normal completion | `no_persistence_intended` | `lab-batch.ts` `runMiniOpdToLab` |
| lab-batch refusal branch | `no_persistence_intended` | same, in its catch |
| bedrock probe script | as the worker; its own save failure → `audit_persistence_failed` | `scripts/bedrock-opd-note-probe.mjs` |
| metamorphic script | `no_persistence_intended` | `scripts/metamorphic-llm-report.mjs` |
| `defaultRecall` | `no_persistence_intended` | `lib/lvc.ts` (unchanged by this pass — it already settled) |

**The "throw before adoption" discriminator, stated because it is not obvious.** D9 distinguishes a
throw after adoption (`audit_generation_failed`) from one before it (`retrieval_not_run`). The signal
is whether `onLifecycleHandleUpdated` ever fired: it fires at D11 step 6, which is adoption.

**How the audit id reaches the settlement.** `saveOpdAudit` gains
`onPersisted?: (result: { status; auditId }) => Promise<void>` and **never receives the handle** —
the closure holds it. The store acquires no telemetry import:

```
$ grep -c "retrieval-telemetry\|retrieval-settlement\|LifecycleHandle" lib/opd-audit-store.ts
0
```

A callback exception is swallowed and the save result preserved (constraint 1); asserted in
`retrieval-telemetry-lifecycle.test.ts`, test 53.

**Instrumented call sites of `auditOpdNote`:**

```
$ grep -rn "telemetry: { ctx" lib app scripts | grep -v __tests__ | wc -l
      11
```

---

## 6. THE RECONCILER (STEP 17)

`app/api/admin/retrieval-telemetry-reconcile/route.ts`, 196 lines.

```
$ wc -l app/api/admin/retrieval-telemetry-reconcile/route.ts
     196 app/api/admin/retrieval-telemetry-reconcile/route.ts
```

### 6.1 The preregistered grace, recorded now

```
$ node --import tsx -e "import('./lib/opd-audit-runtime-config.ts').then(m=>console.log(JSON.stringify(m)))"
{"default":{"RECONCILER_GRACE_SECONDS":1800,"RECONCILER_STALE_AFTER_SECONDS":2600,"WORKER_MAX_DURATION_SECONDS":800}}
```

**`RECONCILER_STALE_AFTER_SECONDS` = 2600.** Recorded here, before any canary opens. It cannot be
tuned afterwards to make a gate pass; changing it restarts the window.

**It is conservative for most rows, deliberately, and that trade is stated rather than hidden.** 800
is the highest `maxDuration` among the instrumented routes. The worker and the appropriateness route
are 800; the run route, mini-backfill, lab-batch, the low-value-care A/A route and both MCP routes
are 300. A row from a 300-second route therefore waits 2,600 seconds before the reconciler touches
it, when its own route could not possibly have run for more than 300. **One grace for every row is
the choice**, because a per-route grace is a tuning surface and this value must not be one. The cost
is that short-route rows are reconciled later than they strictly need to be. The gain is that nobody
can shorten a grace to make a window close.

It is not read from the environment:

```
$ grep -c "process.env" lib/opd-audit-runtime-config.ts
0
```

### 6.2 The three inferred SQL statements, verbatim

```sql
-- selection: bounded, non-terminal only, oldest first
SELECT retrieval_run_id, retrieval_role, persistence_state, row_revision
  FROM opd_audit_retrieval_telemetry
 WHERE persistence_state IN ('started', 'retrieval_complete')
   AND started_at < $1
 ORDER BY started_at
 LIMIT $2

-- the compare-and-set
UPDATE opd_audit_retrieval_telemetry
   SET persistence_state = $3, persistence_settled_at = $4, row_revision = row_revision + 1
 WHERE retrieval_run_id = $1
   AND row_revision = $2
   AND persistence_state IN ('started', 'retrieval_complete')
 RETURNING row_revision

-- the reread after a revision mismatch
SELECT retrieval_run_id, retrieval_role, persistence_state, row_revision
  FROM opd_audit_retrieval_telemetry
 WHERE retrieval_run_id = $1
```

**All three are inferred and have not been executed against any database.** There is none in this
sandbox. `opd_art_nonterminal_idx` — `(persistence_state, started_at) WHERE persistence_state IN
('started','retrieval_complete')` — is the index the first statement is shaped for.

### 6.3 What the algorithm does, and what it refuses to do

- A **terminal row is skipped before anything else** — a successful terminal state always wins over
  earlier failure evidence, and failure rows are historical: never deleted, never consumed.
- The state comes from `reconcilerStateFor`, which reads only the phase relevant to the current row
  state: `retrieval_terminal` for a `started` row, `persistence_link` for a `retrieval_complete` one.
- The transition is checked against `isAllowedTransition` before the write, and a refusal is
  **recorded rather than forced** — the transition table is the only authority.
- The update carries the expected revision. A late terminal write therefore wins.
- A revision mismatch causes **one** reread and reclassification, computed from what the row became.
  Never a blind retry, and never a second reread.
- The pass **never joins `(uid, engine_version)`**, and mentions neither in any statement:
  asserted in `reconciler-races.test.ts` against the file with comments stripped.
- It opens an invocation of `kind = 'reconciler'`, `route = 'reconciler'`, and closes it on both
  exits. §2 forbids reporting a tick as a workload; a reconciler pass counted as `kind = 'retrieval'`
  would be exactly that.
- `?limit=` bounds the slice (default 500, max 2000) and the response carries
  `more_may_remain: stale.length === limit`. A bounded pass that hides its truncation reads as
  "everything was covered".
- `?dry=1` reports what it would do and writes nothing.

### 6.4 The cron

```
$ node -e "const v=require('./vercel.json');console.log(v.crons.length);console.log(JSON.stringify(v.crons.at(-1)))"
17
{"path":"/api/admin/retrieval-telemetry-reconcile","schedule":"1 10 * * *"}
```

`1 10 * * *` UTC, using the same `x-vercel-cron` guard the worker route uses. The OPD worker runs
`*/4 18-23,0-2 * * *`; the nearest worker hour to 10 is 2 or 18, **eight hours** either way — the
window wraps midnight, so the distance is circular and a naive subtraction reports −13 and reads as
an overlap that is not there. Minute 1 is odd, keeping it clear of the `*/2` backfill ticks.
`buildCommand`, `regions`, every existing schedule, every `maxDuration` and every `runtime` value
are untouched:

```
$ git diff HEAD --stat vercel.json
 vercel.json | 3 ++-
 1 file changed, 2 insertions(+), 1 deletion(-)
```

### 6.5 The two authorised test edits

```
$ git diff HEAD --unified=0 lib/__tests__/provider-switch-unit-d.test.ts lib/__tests__/ipd-worker-batch-and-model.test.ts | grep -E "^[-+][^-+]"
-  assert.equal(VERCEL.crons.length, 16, '14 + the restored IPD worker + the readmission worker');
+  assert.equal(VERCEL.crons.length, 17, '14 + the restored IPD worker + the readmission worker + the retrieval-telemetry reconciler');
-  assert.equal(cfg.crons.length, 16);
+  assert.equal(cfg.crons.length, 17);
```

One line in each file, at line 57 and line 270 respectively, and nothing else — kickoff test 64
asserts the second fact by re-reading both files line by line. `provider-switch-unit-d.test.ts`
line 255 (the test title) and line 257 (the `BLOCKED_RELATIONS` assertion) are re-read and asserted
byte-identical in the same test; **the kickoff says line 255 holds that assertion at line 112 and
line 257 at line 1073. The tree agrees with 1073.** Neither line moved.

---

## 7. TESTS

### 7.1 Written

Seven new files, 66 cases.

```
$ for f in retrieval-settlement retrieval-invocation-store retrieval-telemetry-transitions retrieval-telemetry-lifecycle worker-work-declaration reconciler-races multi-query-telemetry; do printf "%-36s %s\n" "$f" "$(node --test --import tsx lib/__tests__/$f.test.ts 2>/dev/null | grep -E '^# pass ' | tail -1)"; done
retrieval-settlement                 # pass 11
retrieval-invocation-store           # pass 13
retrieval-telemetry-transitions      # pass 7
retrieval-telemetry-lifecycle        # pass 11
worker-work-declaration              # pass 8
reconciler-races                     # pass 11
multi-query-telemetry                # pass 5
```

11+13+7+11+8+11+5 = 66. The suite total moved by exactly that:

```
$ npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)"
# tests 3006
# pass 3006
# fail 0
# skipped 0
```

3006 − 66 = 2940, which is what the suite counted at `177adc9`. That subtraction is the only claim
about the earlier count made here, and it is arithmetic on two measured numbers rather than a
recollection.

**The counting rule, because two units are in play.** 3006 counts `node --test` **cases**. 22 counts
the kickoff's **named test requirements** satisfied out of the 28 §5 assigns to steps 14–17. They
are not the same unit and neither converts to the other.

Test 30 was claimed written by an earlier report. Verified rather than accepted: it is now written
here (`retrieval-invocation-store.test.ts`, "30 — an invocation insert failure is fail-open"), and
`git grep -c "test('30" lib/__tests__` at `177adc9` returns nothing.

### 7.2 What a source pin can and cannot prove

Three of the seven files use source-text pins for route behaviour. There is no Next request harness
in this repository, so a route's HTTP behaviour is asserted by reading its source. **A source pin
proves the code says a thing; it does not prove the thing happens at run time.** That is stated in
each of those files' headers as well as here. What IS exercised behaviourally is everything the
routes delegate to — the declaration, the failure evidence, the terminal write, the revision guard
and the settlement — against a stubbed transport.

The stub intercepts `globalThis.fetch`, which is the transport the Neon driver posts `{query,
params}` to. `neonConfig.fetchFunction` is the driver's own documented seam and **does not take
under the ESM build this repository loads**: the assignment reads back and the query still resolves
DNS. Verified, not assumed. Stubbing the transport rather than the store is what makes an assertion
about a bound parameter mean something — the parameters asserted are the ones Postgres would
receive, in their wire form (a bound `1` arrives as `'1'`).

---

## 8. THE GATE

All nine, in order.

| # | Command | Result |
|---|---|---|
| 1 | `npm test` | `# tests 3006 · # pass 3006 · # fail 0 · # skipped 0` |
| 2 | `npm run typecheck` | exit 0 (`npm run typecheck >/dev/null 2>&1; echo $?` → `0`) |
| 3a | `npm run build` | **exit 1** — `Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build` at `next.config.mjs:14:9`. This is D8 firing, and it is the pass condition, not a failure. |
| 3b | `CDMSS_TELEMETRY_HMAC_KEY=local-gate-key-not-a-secret npm run build` | **exit 0** |
| 4 | `npm run architecture:check` | `all 8 rules + coverage green` · `coverage · GREEN · 39 subsystems · 16 registered, 23 explicitly unregistered` |
| 5 | `npm run architecture:map` | `wrote lib/architecture/map.generated.ts (90300 bytes)` |
| 6 | `git add … && npm run architecture:map && git diff --exit-code lib/architecture/map.generated.ts` | exit 0 — byte-identical on regeneration |
| 7 | `npm run reasoning:registry && git diff --exit-code data/reasoning-registry/prompts.generated.json` | exit 0 — `30 prompts · 7 rubrics · 36 builders · 19 features`, **file unchanged** |
| 8 | `npm run reasoning:governance` | `GREEN: 0 ungoverned model calls; parallel stores folded` |
| 9 | `npm run changelog:coverage` | `GREEN: all 19 shipped engine versions documented (30 versioned entries)` |

**Two notes on gate 3.** The plain build fails locally because `VERCEL` and `VERCEL_ENV` are set in
this environment, so D8's condition is genuinely true here; that is the same behaviour a production
Vercel build without the key would show, which is the whole point of the guard. And the build caught
a real defect on its first run: the reconciler route exported its two SQL constants for the test to
import, and a Next route module may export only its handlers and a fixed set of config fields
(`"RECONCILER_SELECT_SQL" is not a valid Route export field`). They are now module-private and the
test reads them from source — which is weaker, and is said so in the test file.

**`data/reasoning-registry/prompts.generated.json` did not change.** Nothing in this pass touched a
prompt, a rubric or a builder.

---

## 9. FILES

```
$ git status --short
 M app/api/admin/lab-batch/route.ts
 M app/api/admin/opd-audit-mini-backfill/route.ts
 M app/api/appropriateness/route.ts
 M app/api/mcp/[key]/route.ts
 M app/api/mcp/route.ts
 M app/api/opd-audit/run/route.ts
 M app/api/opd-audit/worker/route.ts
 M lib/__tests__/backfill-runs-core.test.ts
 M lib/__tests__/ipd-worker-batch-and-model.test.ts
 M lib/__tests__/provider-switch-unit-d.test.ts
 M lib/__tests__/telemetry-key-guard.test.ts
M  lib/architecture/map.generated.ts
 M lib/lab-batch.ts
 M lib/mcp-server.ts
 M lib/mcp-tools.ts
 M lib/multi-query.ts
 M lib/opd-audit-store.ts
 M lib/opd-note-audit.ts
 M lib/retrieval-settlement.ts
 M lib/retrieval-telemetry-core.ts
 M lib/retrieval-telemetry-store.ts
 M scripts/bedrock-opd-note-probe.mjs
 M scripts/metamorphic-llm-report.mjs
 M vercel.json
?? app/api/admin/retrieval-telemetry-reconcile/
?? lib/__tests__/multi-query-telemetry.test.ts
?? lib/__tests__/reconciler-races.test.ts
?? lib/__tests__/retrieval-invocation-store.test.ts
?? lib/__tests__/retrieval-settlement.test.ts
?? lib/__tests__/retrieval-telemetry-lifecycle.test.ts
?? lib/__tests__/retrieval-telemetry-transitions.test.ts
?? lib/__tests__/telemetry-db-stub.ts
?? lib/__tests__/worker-work-declaration.test.ts
```

The commit's own `git show --stat` is self-referential (this file is in it) and is left to the
reader: `git show --stat HEAD`.

### 9.1 Source pins broken by this build, and the invariant each preserves

Three pins broke. Two were preserved rather than edited; one was re-pointed.

| Pin | What broke it | What was done |
|---|---|---|
| `opd-invalid-marking.test.ts` — the det-only fallback return | wrapping the return literal to attach the handle | **Preserved.** No handle is attached on that path, which is D11's rule anyway ("the non-enumerable property … for the SUCCESS path"); every throwing path is covered by `onLifecycleHandleUpdated`. The literal is byte-identical. |
| `pdqi9-fail-loud.test.ts` and `vertex-primary-ladder.test.ts` — the same return | same | **Preserved**, same fix. |
| `eval-hardening.test.ts:297` — `runMiniOpdToLab(uid, experiment, evalCfg)` | adding a fourth parameter for the telemetry context | **Preserved.** The context is carried on `LabEvalConfig` instead, so the call text is unchanged and the pin's real subject — that the tombstone budget check happens before the attempt — is untouched. |
| `backfill-runs-core.test.ts:244` — the whole `auditOpdNote(row, provider === 'bedrock' ? … : {})` call | merging the telemetry options into that call | **Re-pointed** to `...(provider === 'bedrock' ? { bedrockModel: modelId } : {}),`. The invariant it carries — the bedrock arm threads its modelId and the vertex arm passes nothing — is preserved; the "plain prod engine" half of its claim is asserted independently on the next line and is unchanged. |

### 9.2 The seven new modules now have executing tests

The previous issue's §12.1 reported that six of the seven modules `90d8db1` created had zero test
importers. Re-measured, not restated:

```
$ for m in retrieval-telemetry-core retrieval-capture retrieval-telemetry-store retrieval-invocation-store retrieval-telemetry-failure-store retrieval-settlement opd-audit-runtime-config telemetry-key-guard; do printf "%-38s %5s %10s\n" "$m" "$(grep -rl "$m'" lib/__tests__ | wc -l | tr -d ' ')" "$(grep -rl "$m'" lib app scripts | grep -v "^lib/$m.ts$" | wc -l | tr -d ' ')"; done
retrieval-telemetry-core                  11         33
retrieval-capture                          2         11
retrieval-telemetry-store                  4         12
retrieval-invocation-store                 1          9
retrieval-telemetry-failure-store          1          5
retrieval-settlement                       1          7
opd-audit-runtime-config                   1          2
telemetry-key-guard                        1          1
```

Counting rule: column 2 is files under `lib/__tests__/` whose text contains the module name followed
by a closing quote; column 3 is the same over `lib`, `app` and `scripts` excluding the module itself.
Both over-count in principle (a mention in a comment matches) and neither is a call-graph.
`opd-audit-runtime-config` had no importer anywhere before this pass; it now has the reconciler and
its test.

---

## 10. FLAGGED, NOT DECIDED

**Flag 1 — `PerRunSettlementResult.status` now has three values, and D12 fixes it at two.** Every
alternative was worse: reporting a rejected write as `settled` is what let a permanently `started`
row and a completed audit both be true at once. No owner in D9's matrix branches on the result, so
nothing downstream changes behaviour; what changes is that the fact is now available and recorded.
**V's call: ratify the third value, or name a different smallest form.**

**Flag 2 — `COLUMN_CLASSIFICATION` says three columns are written by the terminal write, and none
is.** `experiment_run_id`, `pair_id` and `replicate` are all classified `mutable_terminal`
("written by the terminal write and by settlement") and all three are bound only at the insert. This
was already true of `experiment_run_id` before this pass. The classification is the equality
projection, so the mismatch is descriptive rather than behavioural today — but it will stop being
descriptive the moment anything writes them at the terminal. **Not decided.**

**Flag 3 — D9 says `aborted` and `telemetry_persistence_failed` are "reachable only by the
reconciler", and settlement now reaches them.** D9 also requires a revision-0 run to be "settled
from the failure evidence", and the failure evidence has exactly one mapping — D13's. The two
sentences are in tension in the documents themselves. Waiting for the reconciler instead would leave
a row whose fate is already known sitting non-terminal for 2,600 seconds. **The code takes the
second reading; V holds which one is right.**

**Flag 4 — who closes an invocation, and what makes a stale `closure_unknown` row explicitly
reconciled.** `closeInvocation` is called by exactly one caller in the tree, the reconciler, which
D13 names. Nothing else closes anything, deliberately: §7.1 of the brief says propose, do not wire.
The proposal, one outer-boundary owner per request or operation:

| Boundary | Closes at |
|---|---|
| `app/api/opd-audit/worker/route.ts` | the single `return NextResponse.json(...)` for each of its three modes, after the response body is built and before it is returned |
| `app/api/opd-audit/run/route.ts` | both handlers' final return, and their outer catch |
| `app/api/admin/opd-audit-mini-backfill/route.ts` | `autoTick`'s return, not `processRunBatch`'s — a tick is the operation, a batch is part of one |
| `app/api/admin/lab-batch/route.ts` | after `batchTick` returns, never inside it |
| `app/api/mcp/route.ts`, `app/api/mcp/[key]/route.ts` | after `dispatchMcp` returns, never inside `callLabTool` |
| `app/api/appropriateness/route.ts` | at stream close |
| `app/api/admin/lvc-judge-aa/route.ts` | its final return |
| the two scripts | at process exit, or not at all — a killed script leaving `closure_unknown` is the honest record |
| the reconciler | already wired, both exits |

**Explicitly not owners:** `auditOpdNote`, `defaultRecall`, and any per-note worker body. A shared
invocation closed by the first note to finish would report every later note's work as arriving after
closure. **Not wired.**

**Flag 5 — `auditOpdNote` has no injection seam, and six of this pass's tests could not be
written because of it.** Tests 21, 22, 23, 24, 47 and 48 all need to drive that function with
controlled collaborators and controlled throw points. This is a testability defect in the audit
function, not in the telemetry. **Not fixed** — it would mean changing the signature of the most
load-bearing function in the engine, during a freeze.

**Flag 6 — `lib/__tests__/telemetry-db-stub.ts` is on no list.** §1.4 above. Its alternative was four
drifting copies.

**Flag 7 — what D9 §7.2 asks (two roles on one handle disagreeing) remains unresolvable through
`settleRetrievalTelemetry`'s signature.** D17 gives per-row criteria for clean against partial; D12
fixes the API as one outcome for the whole handle. A clean `primary` and a dirty `normative_channel`
cannot be given different states. **The smallest change that would allow per-role states**, not
made: give `SettlementInput` an optional `perRole?: Partial<Record<RetrievalRole, SettlementOutcome>>`
consulted before `input.outcome`, leaving every existing call site byte-identical. D9 requires only
the same audit id across roles, not the same state, so nothing in D9 forbids it. **Not made.**

**Flag 8 — step 18's scope.** §1.1 above. No new module exports a `*_VERSION` const; two existing
telemetry modules export schema-version constants that predate this pass. Whether step 18 covers
those is V's reading.

---

## 11. DEFECTS FOUND AND LEFT ALONE

1. **`validateManifest`'s verdict is advisory and always was.** It now has a production caller and
   can make a row `persisted_partial`, which is D17's rule. It still cannot *reject* a manifest, and
   no column has a CHECK behind it. A null `index_version` would still be stored — it would simply
   also be classified partial.
2. **The `RERANK_BACKEND` typo** is on the do-not-touch list and was not touched.
3. **`bedrockOnlyChat` and `tracedChat` attach no attempts.** Unchanged by this pass, carried
   forward from the previous issue's list.
4. **`lib/sql-guard-core.ts` was not edited**, and both committed assertions on its literal are
   intact — re-read and asserted byte-identical in `reconciler-races.test.ts`.

```
$ git diff HEAD --stat lib/sql-guard-core.ts lib/opd-audit-changelog.ts lib/__tests__/lvc-judge-attribution.test.ts lib/__tests__/lvc-judge-pinning.test.ts
```

(no output — all four untouched)

5. **`lib/multi-query.ts:133` and its comment are untouched.** The comment still does not quote the
   statement the determinism pin greps for, and `multi-query-telemetry.test.ts` now asserts the
   literal appears exactly once in the file — so a comment that put it back would fail here as well.

---

## 12. WHAT THIS REPORT DOES NOT ASSERT

No canary date. No overhead thresholds. No A/A pilot. Nothing prepared for C0.5, C0.6, C1, C2, Q1 or
F1. `park/lvc-arm-c-unshipped-11-aug-2026` was neither merged nor read. Nothing deployed, nothing
pushed. The engine is frozen and nothing about ranking changed: no scoring rule, prompt, suppression,
formulary or low-value-care state was edited, and `npm run changelog:coverage` is green without an
entry being added.


---

# PART II — THE CORRECTION ISSUE (committed in `177adc9`)

Unchanged below except the one sentence named in its preamble.


**Second issue, 12 August 2026**, correcting the issue committed in `90d8db1`. Against
`CDMSS-RERANK-TELEMETRY-PRD-v2.1-11-AUG-2026.md` and
`CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md`, and following
`CDMSS-RERANK-TELEMETRY-BUILD-VERDICT-12-AUG-2026.md`.

The first issue's numbers were written from memory; nine of its claims were false and six of those
were counts. Where a correction changes a number, the new number carries its command. Where a
command was run against a specific commit, the commit is named — several of the first issue's
figures were true of the baseline and were attached to the wrong tree.

**⚠️ A BLANKET CLAIM THAT USED TO STAND HERE HAS BEEN REMOVED.** It read "every number below was
re-measured for this issue, and the command that produced it is printed beside it", and it was false
of at least five numbers in this part. A claim about a report's own method is not checkable by
reading the report, which is what makes it worth nothing and worth removing. Check any individual
row instead.

---

## 0A. WHAT THIS ISSUE WITHDRAWS

The first issue of this report is in git history at `90d8db1` and is not rewritten there. These are
the claims it made that this issue withdraws, and where each is now answered.

| # | Withdrawn claim | Where it stood | Corrected in |
|---|---|---|---|
| 1 | "The retrieval path executes byte-identically to `fc28e0f`" | §0 | §0, §9 |
| 2 | "no caller passes one" | §0 | §0 |
| 3 | "a source pin holds the two copies together" (also compiled into `next.config.mjs:8`) | §11 flag 1 | §11 flag 1, §15 pin 5 |
| 4 | Test 63 listed as written and green | §12 | §12, §18 flag |
| 5 | "38 directories. 29 export a `POST`." | §3 | §3 |
| 6 | "Four [pins changed], all preserving the same invariant" | §15 | §15 |
| 7 | "All four [unbroken pins] pin `return attachTransportAttribution(...)`" | §15 | §15 |
| 8 | "roughly forty of the seventy-three named tests" | §0 | §0, §12 |
| 9 | "Three edits" to `batchCounters()` | §10.1 | §10.1 |
| 10 | The architecture map "wrote 88,840 bytes" | §2 | §2 |
| 11 | The CHECK-slice pin "passed on nothing" | **not in the report** — see note | §15 pin 3 |
| 12 | Steps 9, 11 and 13 claimed built; step 14 claimed not built | §0, §12 | §12 |

**A note on row 11.** The verdict places "sliced to end-of-file and passed on nothing" in §9. That
sentence is not in the report file at either issue — `grep -n "passed on nothing"` returns nothing
against `90d8db1`. It was said in the covering message that accompanied the commit, which is not a
record anyone reads later but was wrong all the same. §15's wording was the accurate one and is
kept; it is now backed by a measurement rather than by an impression (§15 pin 3).

Two of those — 1 and 3 — would have changed a decision. Claim 3 was also a false sentence in
shipped code; the code change that makes it true is in this pass (§15 pin 5).

---

## 0. THE HEADLINE, BEFORE ANYTHING ELSE

**This build is PARTIAL. It is green, it is coherent, and its scoring behaviour is unchanged — but
it is not the whole kickoff.** Steps 1 to 13 and 18 of the kickoff's twenty-two are built, three of
them only partly (§12). Steps 14 to 17 — the lifecycle writes at the callers, the worker
declaration, the settlement wiring and the reconciler — are **NOT built**, and neither are the ten
C0 query texts, the overhead measurement, nor **50 of the 73 named tests**. §12 lists every
omission by number, and the 50 is that list counted, not an estimate:

```bash
node -e '
const r=(a,b)=>Array.from({length:b-a+1},(_,i)=>a+i);
const W=[...r(3,9),11,13,30,...r(35,38),45,46,50,57,61,66,68,69,71];   // §12, written and green
const A=r(1,73).filter(n=>!W.includes(n));
console.log("written",W.length,"absent",A.length,"total",W.length+A.length,"dups",W.length-new Set(W).size);'
# written 23 absent 50 total 73 dups 0
```

A clean partition of 1..73, no overlap and no gap. The first issue said "roughly forty"; its own
§12 list said 50, and §12 was the right one.

**Three things follow, and V should read all three before deciding anything else.**

1. **No top-level caller supplies telemetry, and ranking is unchanged — but the tree is not
   byte-identical to `fc28e0f`.** The first issue said "the retrieval path executes byte-identically
   to `fc28e0f`" and "no caller passes one". Both are withdrawn. What is true:

   - **Ranking, scores and the retrieved set are unchanged.** Nothing in this commit reads a
     capture to decide an order, a threshold or a slice.
   - **No route sets `opts.telemetry` or `input.telemetry`**, so `auditOpdNote` declares nothing
     and `defaultRecall` captures nothing. That is the sense in which the lifecycle is inert.
   - **Thirteen in-tree call sites do pass the new trailing argument**, and every one of them
     evaluates to `undefined` today, because the two constructors are conditioned on a field no
     route sets (`lib/opd-note-audit.ts:1501-1502`, `lib/lvc.ts:205`, each `tele ? … : undefined`):

     ```bash
     grep -rn "capture)\|Capture)" lib/retrieve.ts lib/multi-query.ts lib/lvc.ts \
       lib/opd-note-audit.ts lib/rerank.ts | grep -v "if (" | grep -v "capture?:"
     # 13 lines
     ```

     `lib/retrieve.ts:408`, `:589` · `lib/multi-query.ts:231`, `:328` · `lib/lvc.ts:284` ·
     `lib/opd-note-audit.ts:647`, `:692`, `:1550`, `:1554` · `lib/rerank.ts:321`, `:332`, `:352`,
     `:354`. The verdict counted six; thirteen is what the tree holds under the definition "a call
     site that passes a capture in the new trailing position". The conclusion is the verdict's,
     unchanged: the value is `undefined` at every one of them.

   - **`lib/llm.ts` is changed unconditionally, behind no optional parameter**, and the retrieval
     path reaches it — the rerank judge through `governedChat` at `lib/rerank.ts:450`, `expandQuery`
     at `lib/expand.ts:25`. Three changes, none of them a seam: `attempts: []` becomes
     `[...attempts, localAttemptSuccess()]` on the intended-local arm, `[...attempts]` becomes
     `[...attempts, localAttemptSuccess()]` on the substitution arm, and a new
     `attachTransportFailureAttribution(lastErr, …)` statement runs before the three terminal
     dispositions. The attribution object the retrieval path returns is therefore different, and a
     thrown error now carries an added non-enumerable property. `git diff fc28e0f HEAD -- lib/llm.ts`
     is the whole of it; §9 states the same change as an achievement, and the two sections now agree.

   The stopping point itself was deliberate: the opt-in boundary rather than a half-wired lifecycle,
   because a declaration with no settlement and no reconciler leaves every row stranded at
   `retrieval_complete` forever, which is worse than no telemetry.

2. **⚠️ A PRODUCTION BUILD NOW FAILS WITHOUT `CDMSS_TELEMETRY_HMAC_KEY`.** This is the one change
   in the commit that is NOT inert. It is D8 as specified. See §11, which also reports a finding
   about that guard that the kickoff could not have known.

3. **"2940 green" does not cover the manifest path.** Six of the seven new modules — everything
   that builds a manifest and writes it — are imported by no test at all. §12.1 states this
   plainly, with the command.

---

## 1. Commits, document hashes, and the two SHAs

| | |
|---|---|
| Preparatory (documentation + allowlist only) | `a2a8f4d1befce394b37c10a9b023aa6c742c30dd` |
| Build commit (first issue of this report) | `90d8db1befc17e1fd6a3aa7d5e5b8612f590ed4f` |
| Correction commit (this issue) | *on top of `90d8db1`, not an amend — see `git log` on `exp/rerank-telemetry`* |
| Branch | `exp/rerank-telemetry`, **not pushed** |
| Base | `fc28e0fdce015e9e303944e4197b19534c31c383` |

`90d8db1` is **not amended.** The first issue of this report stays in history exactly as it was
written, and this correction sits on top of it, so the record shows what was withdrawn rather than
quietly replacing it.

```
850249857454f190e52c9f9687eda64d176e1911ec439025ed1af0ee70305d95  CDMSS-RERANK-TELEMETRY-PRD-v2.1-11-AUG-2026.md
281c8cde0a07e0feadd55bbf388d94092447e6264d46b88b4c29346ffb04560f  CDMSS-RERANK-TELEMETRY-ONPATH-CC-KICKOFF-v11-11-AUG-2026.md
```

**HARNESS SHA vs SERVED SHA.** The harness SHA is the build commit above. **The served deployment
SHA is not recorded here and is not mine to record.** A clean local tree proves nothing about what
Vercel is serving; the served SHA is canary-era, and this build neither deployed nor targeted a
canary. Nothing here was run against the production database.

---

## 2. Gate — nine commands, re-run in full for this issue

| # | Command | Result |
|---|---|---|
| 1 | `npm test` | **GREEN — 2940/2940** (2887 at `fc28e0f` + 45 at `90d8db1` + 8 in this pass; 0 fail, 0 skipped) |
| 2 | `npm run typecheck` | **GREEN** — `tsc --noEmit`, exit 0, no diagnostics |
| 3 | `npm run build` | **exit 1 plain, exit 0 with the key — see below** |
| 4 | `npm run architecture:check` | **GREEN** — 8 rules + coverage; 39 subsystems, 16 registered, 23 unregistered |
| 5 | `npm run architecture:map` | **GREEN** — `wc -c lib/architecture/map.generated.ts` → **88,842** |
| 6 | map determinism (`git diff --exit-code`) | **GREEN** — regeneration is byte-identical |
| 7 | `npm run reasoning:registry` + `git diff --exit-code` | **GREEN — the registry file did NOT change** (88,737 bytes; 30 prompts · 7 rubrics · 36 builders · 19 features) |
| 8 | `npm run reasoning:governance` | **GREEN** — 0 ungoverned model calls; parallel stores folded |
| 9 | `npm run changelog:coverage` | **GREEN** — all 19 shipped engine versions documented (30 versioned entries) |

**⚠️ COMMAND 3, EXACTLY AS RUN, WITH BOTH EXIT CODES.** Eight of the nine gates pass as the kickoff
writes them. The ninth does not, and that is the D8 guard firing correctly against an environment
the kickoff did not anticipate — not a defect in the build. `vercel env pull` has written
`VERCEL="1"` and `VERCEL_ENV="production"` into this machine's `.env.local`, Next.js loads
`.env.local` into `process.env` before evaluating `next.config.mjs`, and D8's three clauses are
therefore all true for a *local* build.

```bash
$ npm run build >/dev/null 2>&1; echo $?
1
# Error: CDMSS_TELEMETRY_HMAC_KEY is required for a production build. …
#     at <unknown> (next.config.mjs:14:9)

$ CDMSS_TELEMETRY_HMAC_KEY=local-gate-key-not-a-secret npm run build >/dev/null 2>&1; echo $?
0
```

I did **not** change D8's predicate to make the plain command pass. See §11, finding 1.

**The map byte count.** The script's own completion message says 88,840. The file is 88,842 bytes;
the script under-reports by two. The table quotes `wc -c`, which is the file.

New tests by file: `transport-failure-attribution` 21 · `retrieval-telemetry-core` 25 (rewritten,
was 17) · `migrate-retrieval-telemetry-parity` 12 · `telemetry-non-exposure` 4 ·
`telemetry-key-guard` 8 (this pass). **Two units are in play and they are not the same number.**
"2940 tests" counts **test cases** executed by `node --test`. "23 of 73 written" counts the
kickoff's **named test requirements** in §6. One named requirement can be several cases — test 57
alone is eight.

---

## 3. The two counts I verified for myself

The kickoff said not to carry these on its word. **Both figures are commit-sensitive, and the first
issue attached the baseline's figures to the tree that changes them.** This commit adds the 39th
directory and the 30th `POST`, which is what §5.1 describes.

```bash
# at fc28e0f — the baseline the kickoff was written against
git ls-tree -d --name-only fc28e0f app/api/admin/ | grep -c "migrate-"          # 38
git grep -lE "export (async )?function POST" fc28e0f -- 'app/api/admin/migrate-*/route.ts' | wc -l  # 29

# at 90d8db1 — the tree this report describes
ls -d app/api/admin/migrate-*/ | wc -l                                          # 39
grep -l "export async function POST\|export function POST" app/api/admin/migrate-*/route.ts | wc -l # 30
```

**38 directories and 29 `POST`s at `fc28e0f`, matching the kickoff. 39 and 30 at `90d8db1`, because
this build adds `app/api/admin/migrate-retrieval-telemetry/`.** There is no migration runner and no
ledger; nothing reads `migrations/*.sql`, which is why migration 0035 has never been applied and
cannot be.

---

## 4. Entry-point and route taxonomy (PRD §5 step 1)

`RETRIEVAL_ROUTES` (10) and the role set (5) are declared in `lib/retrieval-telemetry-core.ts`.

| Route | Class | Entry point |
|---|---|---|
| `opd_audit_worker` | worker | `/api/opd-audit/worker` — the nightly cron |
| `opd_audit_run` | manual | `/api/opd-audit/run` |
| `opd_audit_mini_backfill` | backfill | `/api/admin/opd-audit-mini-backfill` |
| `opd_dosing_backfill` | backfill | `/api/admin/opd-dosing-backfill` |
| `opd_rescore_direction` | backfill | `/api/admin/opd-rescore-direction` |
| `lab_batch` | lab | `lib/lab-batch.ts` |
| `mcp_tools` | lab | `lib/mcp-tools.ts` |
| `lvc_judge_aa` | lab | `/api/admin/lvc-judge-aa` |
| `script` | manual | `scripts/*.mjs` |
| `unknown_route` | unknown | anything unnamed — **never** the nearest match |
| `reconciler` | reconciler | **invocation table only** — a separate `InvocationRoute` type, so a reconciler row can never appear on a retrieval row |

**Roles** — `primary`, `normative_channel`, `lvc_recall`, `lab_direct`, `lab_multi_query`.

**Confirmed by reading, as instructed:** the two admin routes `opd-dosing-backfill` and
`opd-rescore-direction` build `reuse` **unconditionally**, so they return at the reuse guard and
never retrieve. They are out of scope **by construction**, not by omission. Neither can reach a
fresh audit, so no stop-and-report was triggered.

---

## 5. The schema

### 5.1 What runs, and what is documentation

`app/api/admin/migrate-retrieval-telemetry/route.ts` is what runs. It is `runtime = 'nodejs'`,
gated by `requireAdmin` with the `isAdminUnlocked` fallback, and returns a `steps` record.
`migrations/0035_opd_audit_retrieval_telemetry.sql` is **documentation** and says so in its first
five lines.

**Every CHECK value list is GENERATED** from the exported constants — `RETRIEVAL_PERSISTENCE_STATES`,
`RETRIEVAL_ROLES`, `OUTCOME_REQUIRED_STATES`, `OUTCOME_EITHER_STATES`, `INVOCATION_KINDS`,
`INVOCATION_CLOSURE_STATES`, `TELEMETRY_FAILURE_PHASES`, `RUN_SCOPED_FAILURE_PHASES`,
`NON_TERMINAL_PERSISTENCE_STATES`. Nothing is hand-typed in the route. A test asserts the route's
source does **not** contain the state names.

The statements live in `retrievalTelemetryDdl()` in `lib/retrieval-telemetry-core.ts` rather than
inline in the route, because a generated statement cannot be verified by reading the route's
source — the values are not in it. That is what lets the parity test compare **real output**
against the mirror instead of comparing two pieces of prose. This is not what §4.2 forbids: the
`.sql` file is still hand-typed and is never generated.

### 5.2 Parity pin output

`lib/__tests__/migrate-retrieval-telemetry-parity.test.ts` — **12/12 green**. It asserts, in both
directions, that every statement the route runs is in the `.sql` and vice versa; that the statement
counts match; that the CHECK value sets are identical and equal the constants; that neither side
can pass on an empty slice; and that all three `COMMENT ON TABLE` bodies survive their own embedded
semicolons.

**The splitter respects single-quoted strings, and that is not a nicety.** A naive `;` split would
have torn each `COMMENT ON TABLE` body in two at *"Retention 90 days from started_at; the purge
is…"* and compared two half-statements that match nothing on either side — passing by accident.

### 5.3 The one permitted difference

```
ALTER TABLE opd_audit_retrieval_telemetry ALTER COLUMN retrieval_role SET NOT NULL
```

Applied by the route **only when the table is empty**, reporting `applied, table empty` or
`skipped, table not empty` in `steps`. An explicit step, not a `DO` block, so the decision is
visible in the response. The `.sql` cannot branch, so it states the rule in prose. This is the only
statement the two artefacts do not share, and it is named in the parity test's allowed-difference
list and nowhere else.

### 5.4 The stop rule

The route's first action is `to_regclass`, then a row count. **If the table exists with rows it
changes nothing**, returns **409** with `halted: 'table_not_empty'`, the row count and a
`persistence_state` histogram, and waits for a signed legacy-data policy. The halt precedes every
schema statement, and a test asserts that ordering rather than merely that the halt exists.

This matters concretely: the state vocabulary goes from the eight values the original 0035 declared
to fourteen and **drops `not_eligible`**, so a pre-existing row carrying that state would make the
`ADD CONSTRAINT` fail. The honest response to that is a decision by V, not a migration that quietly
rewrites history.

### 5.5 The DDL, as implemented

Verbatim in both artefacts. Reproduced here in outline; the byte-exact text is
`migrations/0035_opd_audit_retrieval_telemetry.sql`, held to the route by the parity test.

**`opd_audit_retrieval_telemetry`** — the 30 columns 0035 declared, unchanged, **plus** the 17
D2 additions (`retrieval_role`, `retrieval_outcome`, `retrieval_error_class`,
`persistence_settled_at`, `row_revision`, `expansion_served_model`, `expansion_attempts`,
`rerank_not_served_batches`, `rerank_soft_failed`, `served_backend`, `rerank_backend_downgraded`,
`fused_candidate_count`, `hydrated_candidate_count`, `index_version`, `active_backfill_run_id`,
`active_backfill_target`, `active_backfill_state`) and `ALTER COLUMN app_source SET DEFAULT
'standalone'`.

`trace_id` is **0035's existing `trace_id TEXT NULL`**. No column was added and no naming question
was opened.

**One deviation from the kickoff's literal DDL, stated:** the `CREATE TABLE` carries **no inline
`persistence_state` CHECK**. The original 0035 declared one inline with the eight old values.
Keeping it would put the state vocabulary in two places in one migration — the inline copy and the
named constraint D2 requires be DROPped and re-ADDed — and a reader would have to check the two
agree. There is one home for it: the named constraint. On a fresh table the DROP is a no-op and the
ADD installs it; on an existing table the pair replaces whatever was there. Both paths end
identically, and the parity test covers both artefacts.

**Three CHECKs**, each DROP-then-ADD so a second run cannot error: `…_persistence_state_chk` (14
values), `…_role_chk` (5 values, unconditional — a NULL role passes a CHECK by SQL's own rules,
which is exactly why the NOT NULL is a separate conditional step), and `…_outcome_chk` (the
`started`/required/either partition).

**14 indexes** — 8 on the retrieval table, 3 on `opd_retrieval_invocations`, 3 on
`opd_retrieval_telemetry_failures`. Every one `IF NOT EXISTS`.

**`opd_retrieval_invocations`** and **`opd_retrieval_telemetry_failures`** exactly as D2 specifies,
including `opd_rtf_run_chk`, which requires a run id and role on the three run-scoped phases and
permits their absence on `invocation_start` and `closure`.

### 5.6 The three table comments

They differ, and each says what its own table holds. Only `opd_audit_retrieval_telemetry` names
`uid`; the other two say **NO PATIENT IDENTIFIER**. Retention anchors differ — `started_at` on the
first two, `observed_at` on the failure table, **which has no `started_at`**. All three state that
the purge is operator-scheduled and NOT implemented here. A test asserts all of this, including
that the failure table's comment does not contain the string `from started_at`.

---

## 6. Retention, access and deletion — the §4.2 statement

- **Retention.** 90 days, declared per table in `COMMENT ON TABLE` with the correct anchor column
  named in each.
- **Deletion.** Operator-scheduled purge. **Owed and unimplemented, and named as such in the route
  header and all three comments.** Not a trigger. Automating a delete against a table that may hold
  the only evidence of an unreconciled incident is a decision, not a default. A patient erasure that
  removes an `opd_note_audits` row must remove the rows here carrying the same `uid`; the FK is
  `ON DELETE SET NULL` so losing the audit does not destroy the reconciliation record, and `uid` is
  what the erasure must target, deliberately and by name.
- **Access. The control that applies is the admin gate — the same control `opd_note_audits`
  itself carries.** §4.2 requires controls *no weaker than* `opd_note_audits`, and that is what
  this is.

**`lib/sql-guard-core.ts` was NOT edited.** Its `BLOCKED_RELATIONS` literal is byte-identical, and
the two committed assertions on it — `provider-switch-unit-d.test.ts:257` (in the test titled
*"lib/sql-guard-core.ts was NOT edited by this build"*) and `prognosis-outcomes-core.test.ts:341` —
are untouched and green. Adding the telemetry tables to that list would be **stronger** than §4.2
requires, since `opd_note_audits` is not on it either. If the blocklist is the right long-term home
for these tables, that is V's ruling on the defect list (§13, item 1), not this build's to take.

**Non-exposure** (`lib/__tests__/telemetry-non-exposure.test.ts`, 4/4): a scan of every `.ts`/`.tsx`
under `app/` and `lib/` finds no `FROM`/`JOIN` against the three tables outside an exact-path
allow-list. It also asserts that **no non-admin route under `app/` mentions a telemetry table at
all**, and it proves its own matcher on synthetic text first, so its silence means something.
**Stated limit:** a source-text search cannot see a dynamically composed table name. It proves the
tables are absent from every *literal* query in `app/` and `lib/`, and no more. It does not cover
`.mjs` scripts, Metabase, or the Lab connector's tool description. It asserts nothing about
`lib/sql-guard-core.ts`.

---

## 7. The atomicity declaration (§4.5, required as a declaration)

**The audit write and the final telemetry link are NOT transactional, and cannot be here.**

The precise reason: `lib/db.ts` exports `sql` as a `Proxy` with only an `apply` trap over a bare
function target, so the driver's own `transaction` method is not reachable — and even if it were,
it could not span the application logic between the audit insert and the telemetry link.

**What replaces atomicity:** idempotent updates, an explicit `row_revision` guard, per-role
isolation, and a reconciler. Every mismatch is reported rather than smoothed over.
`lib/retrieval-telemetry-store.ts` states this in its header and nothing in this build claims
atomicity anywhere. **The reconciler that completes this story is NOT built (§12).**

---

## 8. Update precedence, transitions, canonicalization, column classification

**Precedence, exactly as D12 orders it**, in `applyTerminalState`:

1. identical-content no-op — **does not** increment `row_revision`
2. expected-revision check — rejected and logged, **never retried blindly**
3. transition check — terminal states never transition
4. apply, and increment

The order matters: checking the revision first would burn a revision on a write that changed
nothing, and the next caller would then see a conflict that was really a no-op.

**Transitions** (`ALLOWED_TRANSITIONS`) are exactly D12's table. Two placements are easy to get
backwards and are commented at the declaration:

- **`retrieval_complete -> aborted` is deliberately ABSENT.** A run that wrote its terminal manifest
  did not abort; what is unknown is the audit's fate, and that is `persistence_unknown`.
- **`started -> audit_generation_failed` is deliberately PRESENT.** D11 puts the primary terminal
  write at step 12 and `auditOpdNote` can throw at steps 7, 8 or 9, so a row that never reached its
  terminal write is still `started` when the audit fails. Forbidding this would leave the only
  honest settlement unreachable. Its `retrieval_outcome` is null on that path, which is why the
  outcome CHECK permits either for that state.

**Canonicalization** — one function, `canonicalJson`. Keys sorted recursively at every depth, array
order preserved, `undefined` omitted in objects and **rejected** in arrays, non-finite numbers
rejected. Rejected rather than dropped or nulled because dropping changes the length and nulling
changes the value — either way two manifests that differ would compare equal, which is the one
thing the no-op check must never do.

**Column classification** — `COLUMN_CLASSIFICATION` in the core, four groups
(`immutable_insert`, `mutable_terminal`, `revision_metadata`, `derived`), derived from the final
DDL. The equality projection is `mutable_terminal`. Manifest operational timestamps are excluded: a
retry reuses the originally stamped manifest, so comparing `completed_at` would make every retry
look like new content.

---

## 9. Attribution — the five §4.4 conditions, each with its test

**This build modifies `chatWithFallback` unconditionally, on every call, with or without a
capture.** That is the same fact §0 now states, and the two sections agree; the first issue asserted
it here as an achievement and denied it there. The change is not behind an optional parameter and
is not a seam. `git diff fc28e0f HEAD -- lib/llm.ts` is the whole of it: two `try` blocks added
around the two local `create` calls (the calls themselves not rewritten), one
`attachTransportFailureAttribution(lastErr, …)` statement added before the terminal dispositions,
and `attempts` gaining a `localAttemptSuccess()` entry on both local arms.

None of the five §4.4 conditions is asserted without a test behind it. All live in
`lib/__tests__/transport-failure-attribution.test.ts` (21/21) and
`lib/__tests__/transport-attribution-traceless.test.ts`.

| § | Condition | Test |
|---|---|---|
| 1 | Request parameters byte-equivalent | *nothing in the failure path touches the outbound request object* — `attachTransportFailureAttribution(params` absent; the Vertex strip/`baseMax`/`+8192` construction pinned unchanged |
| 2 | Provider selection and fallback order unchanged | *the two terminal throws are BYTE-IDENTICAL* — both `throw lastErr;` literals intact; `throw attachTransportFailureAttribution(lastErr` asserted **absent** |
| 3 | Retry behaviour unchanged | *retry policy is unchanged* — `timeoutMs: tierCeilingMs(...)` ×2, `maxTries,` ×2, capture rides the existing `onAttemptFailure`, which `createWithRetry` already wraps |
| 4 | Existing callers behaviourally compatible | *failure evidence is a SEPARATE property* — the failure shape has neither `dispatched_provider` nor `dispatched_model`, so `resolveJudgeAttribution` in `lib/lvc.ts` cannot reach it even by accident; the untouched `lvc-judge-attribution.test.ts` is green |
| 5 | No parent trace ID introduced | *the traceless route stays traceless* — `governedChat(undefined, 'rerank_judge'` pinned; `chatWithFallback` must not `startTrace` |

**The design choice that made condition 2 free.** The failure evidence attaches **once, before the
three dispositions**, rather than at each of them. That keeps both `throw lastErr;` statements
byte-identical, so the committed guards that pin them still assert the terminal behaviour did not
move — instead of being rewritten to accommodate this build. The phase is selected from the *same
two conditions those throws test*, and a test pins the selector against the throws so they cannot
drift.

**D14 as built.** New `CdmssTransportFailureAttribution` on its own property
(`cdmss_transport_failure_attribution`), with its own **immutable** helper (`writable: false,
configurable: false`, in a try/catch — first writer wins, because the frame closest to the failure
knows most about it) and its own reader. `TransportAttempt.tier` gains `'ollama'` and its comment
now says it names the **provider attempted**, not a ladder position. `lib/trace.ts` gained new
re-exports and nothing else.

**Both holes closed.** The intended-local arm reported `attempts: []` **while making a real
request**; it now records the local call as the attempt it is. A thrown dispatch carried no
evidence at all; it now carries the full ladder history, so a call that exhausted a cloud ladder
and then failed locally is distinguishable from a call that was never made.

**`tracedChat` is untouched**, asserted by test. D14 scopes failure attribution to the traceless
arm, and the retrieval path never reaches the traced one — `rerank_judge` and `expandQuery` both
dispatch with an undefined trace id. That `tracedChat` attaches no attempts is a real defect and is
on the defect list (§13, item 2) rather than fixed here.

---

## 10. The stage mapping, the counters, and the downgrade

### 10.1 `batchCounters()` — before and after

**Before** (`lib/retrieval-telemetry-core.ts` at `fc28e0f`):

```ts
if (b.served_route_class === 'vertex') c.vertex += 1;
else if (b.served_route_class === 'openrouter') c.openrouter += 1;
else if (b.served_route_class === 'local') c.local += 1;
else c.unattributed += 1;                      // ← the bare else
```

**After:**

```ts
if (b.served_route_class === 'vertex') c.vertex += 1;
else if (b.served_route_class === 'openrouter') c.openrouter += 1;
else if (b.served_route_class === 'local') c.local += 1;
else if (b.served_route_class === 'not_served') c.not_served += 1;
else if (b.served_route_class === 'unattributed') c.unattributed += 1;
// a null or absent class increments NOTHING
```

**Four edits, all required to compile** — the first issue said three and missed the parameter type:

```bash
git diff fc28e0f 90d8db1 -- lib/retrieval-telemetry-core.ts | grep -E "^[-+].*batchCounters|^[-+].*const c = \{|^[-+].*not_served: number"
```

| # | What changed | Old | New |
|---|---|---|---|
| 1 | parameter type | `m: RetrievalManifest` | `m: Pick<RetrievalPayload, 'batches'>` |
| 2 | return-type annotation | six fields | seven — `not_served: number` added |
| 3 | initialiser | `{ vertex: 0, openrouter: 0, local: 0, failed: 0, unattributed: 0, retries_429: 0 }` | the same with `not_served: 0` |
| 4 | branch chain | bare `else` | two explicit arms, no `else` |

Without the fix, `not_served` and a null class would both have landed in the bare `else` and been
reported as unattributed — three different facts merged into one column, which §2 forbids.

**The two orphan columns finally have a writer**, plus the third: `rerank_429_attempts` ←
`retries_429`, `rerank_unattributed_batches` ← `unattributed`, `rerank_not_served_batches` ←
`not_served`, wired through `counterColumns()` in `lib/retrieval-capture.ts`. Both existing columns
would otherwise have stayed at zero forever.

**The apparent contradiction, stated so nobody reads the counter as permission.** The type permits
`served_route_class: null` on a batch defensively, `batchCounters` counts a null as **nothing**, and
`validateManifest` **rejects** a null on any batch it sees. Those are not in conflict: the type is
defensive, the validator is the contract (A6). A batch record exists only where a request was
planned, so a null there is a defect. The explicit null belongs at **stage** level only.

### 10.2 The Cohere-to-judge downgrade (A10)

Built as required. On the env-default path an unhealthy Cohere raises `RerankBackendError` and
`lib/rerank.ts` falls through to the judge. `capture.rerankBackendDowngraded = true` is set at the
fall-through; `rerankJudge` then stamps `servedBackend = 'judge'` and
`expectedBatchCount = ceil(n / JUDGE_BATCH)`, **overwriting** the intended count of 1.

That overwrite is the whole point: under §7's never-waived reconciliation, every row on this path
would have been `persisted_partial` **by construction**, and since §2 records that we do not know
whether `RERANK_BACKEND` is set for Preview, this is exactly a canary-era path.
`expected_batch_count` is derived from `served_backend`, never from `intended_backend`.

**`JUDGE_BATCH` was not exported and is not imported by any test** (D16). `judgeBatchBoundaries()`
is a module-private helper so the soft-failure synthesis can account for planned requests without a
second reference to the constant.

**⚠️ The end-to-end downgrade test (kickoff test 70) is NOT written** — see §12.

### 10.3 The stage mapping as implemented

`servedClassOf()` in `lib/retrieval-capture.ts` is the single home for D16's rule. Provider success
→ that provider's class. Proven non-delivery → `not_served`, **and only with proof**. Otherwise
`unattributed`. A skipped stage → the explicit stage-level null. A Bedrock completion →
`unattributed` (it cannot serve the judge; if one appears, telemetry is wrong about the world and
it is never quietly mapped to a plausible class).

`parse_failure` **preserves** provider, model, attempts and token usage at both sites that can
produce one — the rerank batch and variant generation — because a completion arrived and cost
tokens. `isPriceableClass()` encodes §4.6: `local` and `not_served` are unpriced; `unattributed`
and parse failures are priced from their preserved usage.

---

## 11. Flagged, not decided

**1. D8's guard predicate is true for a LOCAL build on this machine.** `vercel env pull` writes
`VERCEL="1"` and `VERCEL_ENV="production"` into `.env.local`, and Next.js loads that file into
`process.env` before evaluating `next.config.mjs`. So the three clauses D8 specifies cannot
distinguish a real Vercel production build from a local `next build` on a machine that has pulled.
**I kept D8's condition exactly as specified** and did not add a fourth clause, because the
predicate is V's to define. The consequences: plain `npm run build` fails locally until a throwaway
key is set, and `.env.example` now documents that. V's options are to tighten the predicate (a
non-empty `VERCEL_URL` would discriminate), to have every developer set a local key, or to accept
it. **The flag itself stands unchanged — this is still V's ruling.**

**⚠️ The first issue justified leaving it alone with "a source pin holds the two copies together."
That pin did not exist.** Two copies of a deploy-blocking predicate, one inlined in
`next.config.mjs` and one typed in `lib/telemetry-key-guard.ts`, with nothing holding them
together — and a comment in each file telling the next reader that something did. The comment at
`next.config.mjs:8` shipped. It was the one false sentence in this build that was compiled into
running code.

```bash
git grep -n "telemetryKeyMissingInProduction" 90d8db1 -- '*.ts' '*.mjs'
# 90d8db1:lib/telemetry-key-guard.ts:23:export function telemetryKeyMissingInProduction(...)
# 90d8db1:next.config.mjs:8:// `telemetryKeyMissingInProduction` in lib/telemetry-key-guard.ts, and a source pin asserts...
```

One definition and one comment about it. Nothing imported the module.

**The pin exists as of this pass**, written as kickoff test 57 in
`lib/__tests__/telemetry-key-guard.test.ts` (8/8). It extracts both conditions by balanced-paren
scan, normalizes `process.env.X` and `env.X` to one spelling and nothing else, and asserts they are
equal — so a change to either copy alone fails. It also asserts each is the same three clauses and
has no fourth, and that the inlined copy still throws. Both comments are true now, and neither was
deleted to make them true. §15 pin 5 carries the mutation check that proves the pin is not vacuous.

**2. D16's `not_served` mapping for the Cohere soft-failure conflicts with its own proof rule, and
the conflicting case is the only reachable one.** D16's table assigns `not_served` to "Cohere
entered and soft-failed"; the same decision says `not_served` requires failure attribution as
proof. Cohere is a raw `fetch` and never reaches `chatWithFallback`, so it can *never* carry that
attribution. Every **declared** Cohere failure throws a typed `RerankBackendError`, which
propagates (explicit path) or downgrades to the judge (env-default path) — neither reaches the
soft-fall. The only path that arrives there is a **generic** throw, where non-delivery is not
strictly proven. **I implemented the table as written** (`provenNotServed: true` on the synthesised
evidence) and flagged the tension rather than substituting my own rule. The alternative — typed
errors → `not_served`, generic → `unattributed` — satisfies both statements and is available if V
prefers it.

**3. `active_backfill_target` has no matching field on `BackfillRun`.** D2 names the column;
`lib/backfill-runs-core.ts:21` declares `id`, `worker`, `model`, `day_from`, `day_to`, `cursor`,
`n_per_tick`, `status`, `source`, counters, `last_error`, `updated_at` — and no `target`. I mapped
it to `run.model`, on the reading that what a backfill *targets* is the `bedrock:<id>` /
`vertex:<id>` string it grades against, which is also what an overlap analysis needs. Named as an
inference at the call site, not presented as a schema field.

**4. `lib/architecture/manifests.ts` needed no edit.** It is on the file contract's edit list, but
none of the seven new `lib/*.ts` modules exports a `*_VERSION` const, so none became a
coverage-bearing subsystem, and `retrieval-telemetry-core` was already in `UNREGISTERED`.
`architecture:check` is green without touching it. One fewer deviation, reported so its absence
from the diff is not read as an omission.

**5. Kickoff test 63 — write it now, or leave it absent?** Test 63 asks for **this build's own**
assertion that `lib/multi-query.ts` still contains the fail-open literal, so that a later refactor
sees two failures rather than one puzzling pin in a determinism file. This pass did **not** write
it. What it did instead was restore the pin that already exists: the first issue's doc comment at
`lib/multi-query.ts:124` quoted the literal in prose, which satisfied
`retrieval-llm-determinism.test.ts:34` on its own and made that pin vacuous. The comment is
rewritten and no longer quotes it; §15 pin 6 carries both halves of the mutation check.

So the guard is real again, but it is still **one** pin in a file about determinism, which is
exactly the fragility test 63 exists to remove. **V's call:** write 63 now as a second, independent
assertion, or leave it on the absent list. It stays on the absent list until then.

---

## 12. NOT BUILT — every omission, by kickoff step and test number

**Kickoff steps 14, 15, 16 and 17 are not built, and three steps claimed built are partial.** The
first issue's step accounting was wrong in both directions; this is the corrected table.

| Step | Status | What holds |
|---|---|---|
| **Step 9** | **PARTIAL** — claimed built | Five of six placeholder call sites exist. `lib/mcp-tools.ts` is untouched (`git diff --quiet fc28e0f 90d8db1 -- lib/mcp-tools.ts` → clean), so the sixth is missing |
| **Step 11** | **PARTIAL** — claimed built | The retrieval-outcome recording is built where the files were edited. `labRetrieve`'s two catch arms in `lib/mcp-tools.ts` are **not** instrumented, same untouched file |
| **Step 13** | **PARTIAL** — claimed built | The `lvc.ts` seam (D7) is built. The route wiring is **absent**: `app/api/appropriateness/route.ts` is untouched, so nothing constructs the `telemetry` input the seam reads |
| **Step 14** | **PARTIAL** — claimed not built | The invocation store, the failure store, `TelemetryDeclarationError` and predeclared-run threading into `auditOpdNote` all **exist**. Missing: the two worker declaration shapes (D10), the re-audit reshape, and the 503 branch in all three worker modes |
| **Step 15** | **PARTIAL** | `writeRetrievalTerminal` and the D11 order **are** built inside `auditOpdNote`. Missing: any caller that sets `opts.telemetry`, and the non-enumerable handle on the returned audit |
| **Step 16** | **NOT BUILT** | `onPersisted` at the seven `saveOpdAudit` expressions, and every owner in the D9 matrix. `settleRetrievalTelemetry` and `outcomeForSaveResult` exist; **nothing calls them from a save site** |
| **Step 17** | **NOT BUILT** | The reconciler route, its cron entry, the two cron-count test updates (`provider-switch-unit-d.test.ts:270`, `ipd-worker-batch-and-model.test.ts:57` — both still read 16 and are green because `vercel.json` was not touched) |
| **Step 19** | **NOT BUILT** | The cost query text and all ten PRD §8 query texts |
| **Step 21** | **NOT BUILT** | **All five PRD §6.5 overhead numbers, and the three extra measurements.** Not measured, not estimated. V cannot set the guardrails from this report |
| **Step 18** | vacuously satisfied | No new module exports a version constant, so none became coverage-bearing (§11 flag 4) |

```bash
for f in lib/mcp-tools.ts app/api/appropriateness/route.ts lib/mcp-server.ts \
         lib/lab-batch.ts lib/opd-audit-store.ts vercel.json lib/sql-guard-core.ts; do
  git diff --quiet fc28e0f 90d8db1 -- $f && echo "UNTOUCHED  $f" || echo "CHANGED    $f"; done
# UNTOUCHED for all seven
```

**Sites not instrumented:** `labRetrieve` in `lib/mcp-tools.ts` (both arms, so roles `lab_direct`
and `lab_multi_query` have no producer), `app/api/appropriateness/route.ts` (so `lvc_recall` has no
producer either), `lib/mcp-server.ts` and the two MCP routes, `lib/lab-batch.ts`,
`lib/opd-audit-store.ts`, and both scripts. `vercel.json` untouched.

**Tests, recounted as a partition of 1..73** (the command is in §0). Two moves since the first
issue: **63 leaves the written list** — no test in this build ever asserted it, and the only pin on
that literal predates the build — and **57 joins it**, written in this pass.

- **Absent, 50:** 1–2 (instrumentation-off proof for all six functions), 10, 12, 14–29, 31–34,
  39–44, 47–49, 51–56, 58–60, 62–65, 67, 70, 72–73.
- **Written and green, 23:** 3–9, 11, 13, 30, 35–38, 45 (partial), 46, 50, **57**, 61, 66, 68–69, 71.

**Two families are owed and are deliberately NOT stubbed:** §6.1 ranking invariance and §6.3
lifecycle/concurrency. A stub that passes against absent code is worse than a named gap, because it
reads as coverage.

**Consequently, three report items cannot be filled and are not filled:** item 11
(instrumentation-off proof), item 16 (ranking-invariance evidence), item 19 (the five overhead
numbers). Item 13 (the D9 owner matrix *as wired*) has nothing wired to report.

### 12.1 What "2940 green" covers, and what it does not

**Everything that builds a manifest and writes it is imported by no test.** Six of the seven new
modules — 1,018 of their 1,047 lines — have zero test importers. The seventh, `telemetry-key-guard`,
gained one in this pass and is the whole of the change.

```bash
for m in retrieval-capture retrieval-telemetry-store retrieval-invocation-store \
         retrieval-telemetry-failure-store retrieval-settlement opd-audit-runtime-config \
         telemetry-key-guard; do
  printf "%-36s tests=%s  anywhere=%s\n" "$m" \
    "$(grep -rlE "from '\.\./${m}(\.ts)?'" lib/__tests__ | wc -l | tr -d ' ')" \
    "$(grep -rlE "from '\.{1,2}/${m}(\.ts)?'" lib app scripts | wc -l | tr -d ' ')"; done
```

| module | test importers at `90d8db1` | after this pass | importers anywhere | lines |
|---|---|---|---|---|
| `retrieval-capture` | 0 | 0 | 8 | 358 |
| `retrieval-telemetry-store` | 0 | 0 | 3 | 344 |
| `retrieval-invocation-store` | 0 | 0 | 3 | 106 |
| `retrieval-telemetry-failure-store` | 0 | 0 | 2 | 80 |
| `retrieval-settlement` | 0 | 0 | 1 | 87 |
| `opd-audit-runtime-config` | 0 | 0 | **0** | 43 |
| `telemetry-key-guard` | 0 | **1** | **0 → 1** | 29 |

Nineteen exported symbols have no executing test: `createTelemetryCapture`, `buildRetrievalPayload`,
`servedClassOf`, `counterColumns`, `evidenceFromCompletion`, `evidenceFromError`, `errorClassOf`,
`declareRetrievals`, `writeRetrievalTerminal`, `applyTerminalState`, `addDeclaredRetrievals`,
`bumpTelemetryWriteFailure`, `closeInvocation`, `startInvocation`, `recordTelemetryFailure`,
`failurePhasesForRun`, `settleRetrievalTelemetry`, `outcomeForSaveResult`, `EQUALITY_PROJECTION`.

**The apparent coverage is source-text reads and path strings**, not execution: a test that greps
`lib/retrieval-capture.ts` for a symbol name proves the name is present, not that the function
works. §8 of this report describes update precedence, state transitions and canonicalization as
settled behaviour. They are **written**. They are **not demonstrated**. The 45 new test cases at
`90d8db1` cover transport attribution, the migration route's parity with its documentation mirror,
and non-exposure — three things that are all checkable without running the manifest path, which is
why they were checkable at all before the lifecycle was wired.

This is the true reading of the gate. It is not a defect in the code; it is the size of what §12's
50 absent tests were going to cover.

---

## 13. Defects found and left alone

1. **`lib/sql-guard-core.ts`'s blocked-relation list may be the right long-term home for the three
   telemetry tables.** Not acted on — A8 and D3 forbid editing that file, and two committed tests
   assert its literal. V's ruling.
2. **`tracedChat` attaches attribution with no attempt list.** Real, and out of scope: D14 scopes
   failure attribution to the traceless arm, and widening the traced arm is a transport change on a
   path this workstream has no measurement for.
3. **`bedrockOnlyChat` attaches no attempts either.** Same class, same reason.
4. **The four in-scope swallowing sites are load-bearing and remain so.** `defaultRetrieve` and
   `normativeChannelRetrieve` now record `retrieval_failure` before returning `[]`, but they still
   return `[]` — an audit still scores a note as if the corpus had nothing to say. That behaviour is
   unchanged by design (constraint 1); it is now merely *visible*.
5. **The `907,045 ms`-class invocation** the worker route header records is still unexplained. Not
   touched, not inferred from.

---

## 14. Statement on PRD §2 — the six prohibited inferences

**This report asserts none of the following six**, and neither does any code, comment or test name
in this commit:

1. That all 21 local fallbacks came from reranking.
2. That 24 calls recovered.
3. That all 537 stored audits came from the worker.
4. That no batch-failure marker means every score was present and numeric.
5. That a provider-backfill cron tick performed retrieval work.
6. That process-local `inFlightAtError` measures project-wide concurrency.

On (5) specifically: `active_backfill_state` exists precisely so a tick can never be counted as a
workload, and it is recorded as `'idle'` — a measurement — rather than left absent.

No number in this report is compared to the single night of console logs from 10–11 August.

---

## 15. Pins changed — old and new, side by side

**The first issue said "four". Four is the number of pins I could account for as *narratives*; it is
not the number of assertions that changed.** The count below is derived mechanically instead of
recalled. Definition: an **assertion line** is any line in the three edited test files containing
`assert.`, with leading and trailing whitespace stripped and nothing else normalized — interior
whitespace is significant, because one of these pins asserts a column's alignment inside the
migration SQL and collapsing runs of spaces hides that change. Lines are compared as a multiset, so
a pure move is not counted and a duplicate that vanished is.

```js
// The whole of it. Run against each of the three files, BASE=fc28e0f HEAD=90d8db1.
const lines = (src) => src.split('\n').filter((l) => l.includes('assert.')).map((l) => l.trim());
const a = lines(gitShow(BASE, f)), b = lines(gitShow(HEAD, f));
// multiset difference both ways: removed = a \ b, added = b \ a, counting duplicates
```

```text
=== lib/__tests__/retrieval-telemetry-core.test.ts
    assertion lines: 59 at fc28e0f -> 110 at 90d8db1 ;  removed 21, added 72
=== lib/__tests__/transport-attribution-traceless.test.ts
    assertion lines: 57 at fc28e0f -> 58 at 90d8db1  ;  removed  1, added  2
=== lib/__tests__/rerank-backend.test.ts
    assertion lines: 77 at fc28e0f -> 79 at 90d8db1  ;  removed  1, added  3
=== TOTAL: 193 assertion lines at fc28e0f -> 247 at 90d8db1; removed 23, added 77
```

**23 assertion lines removed, 77 added.** The full removed and added sets are printed in §15.1 —
every one, not a sample. Seven of the removals are re-pointed pins with a named successor and are
narrated below as 1 to 7; **three of those seven appear in this report for the first time** (5, 6
and 7 — the first issue omitted them entirely). The remaining sixteen removals are the state
vocabulary and validator assertions that the rewrite from 8 states to 14 replaced wholesale; they
are in §15.1, not narrated, because their successor is the whole rewritten file.

Pins **8 and 9 are new in this pass** and did not exist at `90d8db1`.

**1. `transport-attribution-traceless.test.ts:220`**

```js
// OLD
assert.equal((body.match(/attempts: \[\.\.\.attempts\]/g) || []).length, 3);
// NEW
assert.equal((body.match(/attempts: attempts\b/g) || []).length, 0,
  'the live array is never handed to an attribution');
assert.equal((body.match(/attempts: \[\.\.\.attempts/g) || []).length, 7, ...);
```

*Invariant:* every attribution takes a **copy**, so a later push cannot rewrite a returned record.
The old count enumerated one exact spelling; D14 adds two sites that copy as
`[...attempts, localAttemptSuccess()]`. The new form asserts the invariant **directly and more
strongly** — no attribution anywhere receives the live array.

**2. `rerank-backend.test.ts:332`**

```js
// OLD
assert.ok(audit.includes('defaultRetrieve(query, mini, opts.evalNormativeLeg, opts.rerankBackend)'));
// NEW
assert.ok(/defaultRetrieve\(query, mini, opts\.evalNormativeLeg, opts\.rerankBackend[,)]/.test(audit));
assert.ok(/defaultRetrieve\(query, mini, opts\.evalNormativeLeg, opts\.rerankBackend, primaryCapture\)/.test(audit));
assert.ok(/rerank\(query, hits\.map\([\s\S]{0,200}?\)\), opts\.rerankBackend, undefined, capture\)/.test(retrieveSrc));
```

*Invariant:* `opts.rerankBackend` reaches retrieval and cannot be silently dropped by a refactor.
**Strengthened:** it now pins the backend's **position** (4th in `defaultRetrieve`, 3rd in
`rerank`) and that the capture is strictly trailing, so a capture can never displace it.

**3. `retrieval-telemetry-core.test.ts:52` (the CHECK slice)**

```js
// OLD — sliced from the first `persistence_state IN (` to the next `));`
const block = sql.slice(sql.indexOf('persistence_state IN ('), sql.indexOf('));', ...));
// NEW — anchored on the constraint NAME, bounded by `;`, asserted non-empty
const body = constraintBody(read(MIGRATION), 'opd_audit_retrieval_telemetry_persistence_state_chk');
```

*Invariant:* the runtime list and the constraint are one fact. **This one was broken before I
touched it**, and here is the measurement rather than the impression:

```bash
# replay the fc28e0f pin against the fc28e0f migration, verbatim
git show fc28e0f:migrations/0035_opd_audit_retrieval_telemetry.sql | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const a=s.indexOf("persistence_state IN ("), b=s.indexOf("));",a), block=s.slice(a,b);
  console.log("file",s.length,"start",a,"delim",b,"slice",block.length,
              "states",[...block.matchAll(/'"'"'([a-z_]+)'"'"'/g)].map(m=>m[1]).length);});'
# file 8333 start 6331 delim -1 slice 2001 states 8
```

`delim -1` is the whole finding: `));` is absent, so `slice(6331, -1)` runs to the last byte and the
2,001-byte slice matched all eight expected states, in order —
`started`, `completed_unpersisted`, `persisted_complete`, `persisted_partial`,
`telemetry_persistence_failed`, `audit_persistence_failed`, `aborted`, `not_eligible`.

So the pin was **unbounded, not empty**. It was doing real work over an accidental region — which
is worse than a dead pin, because it looks alive: every assertion in it passed, on bytes nobody
chose. There are now three such blocks, so anchoring on the constraint name is
also necessary. A second test pins the outcome CHECK's two blocks the same way, and
`constraintBody` asserts non-empty — neither can pass vacuously.

**4. `retrieval-telemetry-core.test.ts:155` (the privacy pin)**

```js
// OLD — one slice, `RetrievalManifest` … `/** Structural validation`, no emptiness guard
// NEW — declarationBody() per declaration, asserted non-empty and >200 chars, over BOTH
//       RetrievalPayload and OperationalTelemetry; plus a proof the matcher can fire;
//       plus TelemetryCapture absent from the core; plus the intersection shape assertion
```

*Invariant:* no manifest field can hold clinical text. **Strengthened four ways.** It cannot pass
on an empty slice; it covers both field-bearing declarations; a companion test proves the ban loop
*can* detect a banned field; and `StampedRetrievalManifest` — a one-line alias with no field list —
is asserted to be exactly the intersection, rather than given a third ban loop that would pass
vacuously forever.

**5. `retrieval-telemetry-core.test.ts` — the `telemetry_schema_version` whitespace re-point**
*(absent from the first issue entirely)*

```js
// OLD
assert.ok(read(MIGRATION).includes('telemetry_schema_version     INTEGER NOT NULL'));
// NEW
assert.ok(read(MIGRATION).includes('telemetry_schema_version INTEGER NOT NULL'));
```

*Invariant:* the column exists and is `NOT NULL`. What changed is five spaces — the rewritten 0035
aligns its column list differently. This is the pin that made me change how §15 is counted: a
whitespace-normalizing diff reports it as unchanged, and it is exactly the kind of edit that a
recalled list of "four pins" never contains. **The re-point weakens the pin slightly** (it no longer
notices a column-alignment change) and that is honest: alignment was never the fact it stood for.

**6. The `CREATE INDEX IF NOT EXISTS` count — deleted here, re-created at 14 elsewhere**
*(absent from the first issue entirely)*

```js
// OLD — retrieval-telemetry-core.test.ts
assert.equal((sql.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, 6, 'every index is guarded');
// NEW — migrate-retrieval-telemetry-parity.test.ts:171, and it now counts BOTH sides
const inFile  = (read(SQL_FILE).match(/CREATE INDEX IF NOT EXISTS/g) || []).length;
const inRoute = routeStatements().filter((s) => s.startsWith('CREATE INDEX')).length;
assert.equal(inFile, 14, '8 on the retrieval table, 3 on invocations, 3 on failures');
assert.equal(inRoute, 14);
```

*Invariant:* every index is `IF NOT EXISTS`, so the migration is re-runnable. **Strengthened:** the
number moved 6 → 14 because the build adds two indexes to the retrieval table and six across the
two new tables, and the successor counts the executed route and the documentation mirror
*separately*, so the mirror cannot quietly drop one. It also moved file, which is why a
per-file reading of the diff loses it.

**7. `retrieval-telemetry-core.test.ts:152` → `:263` — the whole-object `batchCounters` `deepEqual`**
*(absent from the first issue entirely)*

```js
// OLD — line 152, six fields
assert.deepEqual(c, { vertex: 1, openrouter: 0, local: 1, failed: 1, unattributed: 1, retries_429: 3 });
// NEW — line 263, seven fields, called on the manifest rather than a pre-built object
assert.deepEqual(batchCounters(m), {
  vertex: 1, openrouter: 0, local: 1, not_served: 0, failed: 1, unattributed: 1, retries_429: 3,
});
```

*Invariant:* the counter object is exactly these fields with exactly these values — a whole-object
`deepEqual`, so a new counter cannot be added silently. The kickoff predicted this one by line
number. It is the assertion the `not_served` column breaks, and it broke.

**8. NEW IN THIS PASS — `telemetry-key-guard.test.ts`, the D8 source pin (kickoff test 57)**

```js
// OLD — did not exist. Two comments claimed it did.
// NEW — both conditions extracted by balanced-paren scan, normalized to one spelling, compared
assert.equal(normalize(inlinedCondition()), normalize(typedCondition()),
  'the D8 predicate is written twice and the copies have drifted — change both or neither');
assert.equal((c.match(/&&/g) || []).length, 2, `${where}: three clauses, no fourth`);
```

*Invariant:* the two copies of a deploy-blocking predicate cannot drift. **Mutation-checked**, so
this one is not taken on trust either — dropping `.trim()` from the inlined copy alone:

```text
$ # next.config.mjs: `!String(process.env.CDMSS_TELEMETRY_HMAC_KEY ?? '').trim()`
$ #              ->  `!process.env.CDMSS_TELEMETRY_HMAC_KEY`
$ npx tsx --test lib/__tests__/telemetry-key-guard.test.ts
not ok 6 - 57 pin — next.config.mjs and telemetry-key-guard.ts express the SAME condition
not ok 7 - 57 pin — both copies are the SAME THREE CLAUSES, and there is no fourth
# pass 6 / fail 2                                     (mutation reverted; tree clean)
```

**9. NEW IN THIS PASS — `lib/multi-query.ts:124`, the comment that made an existing pin vacuous**

The pin itself is untouched and predates this build: `retrieval-llm-determinism.test.ts:34` asserts
`mqSrc.includes('return [];')`. The first issue's doc comment **quoted that literal in prose**, so
the file contained it twice and the assertion matched the comment. The comment is rewritten to say
what the statement does without quoting it; the statement at line 133 is unchanged, and so is the
test. Both halves measured:

```text
$ grep -c 'return \[\];' lib/multi-query.ts        # 2 at 90d8db1  ->  1 now

# at 90d8db1, with the STATEMENT deleted and the comment left in place:
$ npx tsx --test lib/__tests__/retrieval-llm-determinism.test.ts
# pass 3 / fail 0        <-- the pin passed over a file with no fail-open statement in it

# after this pass, same deletion:
not ok 3 - multi-query generateQueryVariants: … prompt + fail-open untouched
  error: 'fail-open (→ []) preserved'
# pass 2 / fail 1        <-- the pin is load-bearing again        (mutation reverted; tree clean)
```

*Invariant:* the fail-open behaviour survives a refactor. It was not being guarded at `90d8db1`;
it is now. Kickoff test 63 asked for a **second** pin on the same literal in this build's own tests
and is still absent — see §11 flag 5, which is V's.

**Expected to break, did NOT — four pins, and the report was wrong about what two of them assert.**

| Pin | What it actually asserts |
|---|---|
| `gemini-openrouter-bridge.test.ts:180` | count **2** of `return attachTransportAttribution\(await llm\.chat\.completions\.create\(params, reqOpts\), \{` |
| `provider-error-core.test.ts:182` | the same regex, count **2** |
| `openrouter-timeout.test.ts:233` | `src.includes('await llm.chat.completions.create(params, reqOpts)')` — a **shorter** string; plus a count of 2 at `:239` |
| `vertex-retry-parity.test.ts:336` | `LLM.includes('await llm.chat.completions.create(params, reqOpts)')` — the same shorter string; plus a count of 2 at `:339` |

Only two pin the long literal. The first issue said all four did, and cited
`vertex-retry-parity.test.ts:330`, which is a `trace.ts` assertion, not this one. **The conclusion
is unchanged and still holds:** D14 wraps that expression in a `try`/`catch` *without rewriting it*,
so all four pass untouched, and `git diff --quiet fc28e0f 90d8db1` reports all four files
UNTOUCHED. The reason was wrong for half the set.

**And the kickoff did not expect these four to break.** It names exactly one of the four files —
`gemini-openrouter-bridge.test.ts` — and names it for a *different* assertion: "counts
`dispatched_provider: 'ollama'` occurrences in `lib/llm.ts`" (kickoff line 1064). That count is
still 2 and that assertion also passes. The other three files appear nowhere in the kickoff. They
were at risk because they read `lib/llm.ts`, not because anyone predicted them.

`reasoning-enforcement.test.ts` did not fire.

### 15.1 The full assertion diff

Every removed and added assertion line across the three edited test files, `fc28e0f` → `90d8db1`.
Not a sample.

```diff
=== lib/__tests__/retrieval-telemetry-core.test.ts   (59 -> 110; removed 21, added 72)
- assert.equal(RETRIEVAL_PERSISTENCE_STATES.length, 8);
- assert.equal(isTerminalState('started'), false);
- assert.equal(TERMINAL_PERSISTENCE_STATES.length, RETRIEVAL_PERSISTENCE_STATES.length - 1);
- assert.equal((sql.match(/CREATE INDEX IF NOT EXISTS/g) || []).length, 6, 'every index is guarded');
- assert.equal(/CREATE INDEX (?!IF NOT EXISTS)/.test(sql), false);
- assert.deepEqual(validateManifest(manifest([batch(0), batch(1)])), []);
- assert.ok(validateManifest({ ...manifest([batch(0)]), manifest_schema_version: 99 }).includes('manifest_version_unrecognized'));
- assert.ok(validateManifest({ ...manifest([batch(0), batch(1)]), expected_batch_count: 7 }).includes('batch_count_mismatch'));
- assert.ok(validateManifest(manifest([batch(0), batch(0)])).includes('duplicate_batch_index'));
- assert.ok(validateManifest(manifest([batch(0, { candidate_end: 0 })])).includes('bad_candidate_boundaries'));
- assert.ok(validateManifest(manifest([batch(0, { finite_score_keys: 9 })])).includes('score_keys_exceed_expected'));
- assert.ok(validateManifest(bad).includes('unattributed_with_model'));
- assert.deepEqual(validateManifest(good), []);
- assert.equal(counters.vertex, 3, 'and the counters are order-independent');
- assert.deepEqual(c, { vertex: 1, openrouter: 0, local: 1, failed: 1, unattributed: 1, retries_429: 3 });
- assert.equal(new RegExp(`^\\s*${banned}\\??:`, 'm').test(iface), false, `${banned} must not be a manifest field`);
- assert.equal(vertex.prompt_tokens, 100);
- assert.equal(TELEMETRY_SCHEMA_VERSION, 1);
- assert.equal(MANIFEST_SCHEMA_VERSION, 1);
- assert.equal(HMAC_KEY_VERSION, 'k1');
- assert.ok(read(MIGRATION).includes('telemetry_schema_version     INTEGER NOT NULL'));
+ assert.notEqual(start, -1, `${constraintName} must be present in the migration`);
+ assert.notEqual(end, -1, `${constraintName} must be terminated — a slice to EOF is not a slice`);
+ assert.ok(body.trim().length > 0, `${constraintName} sliced to nothing — this test may not pass vacuously`);
+ assert.equal(inSql.includes('not_eligible'), false,
+ assert.equal(RETRIEVAL_PERSISTENCE_STATES.length, 14);
+ assert.equal(blocks.length, 2, 'the required set and the either set');
+ for (const b of blocks) assert.ok(b.trim().length > 0, 'neither block may be empty');
+ assert.deepEqual(required, [...OUTCOME_REQUIRED_STATES]);
+ assert.deepEqual(either, [...OUTCOME_EITHER_STATES]);
+ assert.ok(/persistence_state = 'started' AND retrieval_outcome IS NULL/.test(body),
+ for (const s of a) assert.equal(b.has(s), false, `${s} is in both halves of ${label}`);
+ assert.equal(union.size, all.size, 'the three sets cover exactly the fourteen');
+ for (const s of all) assert.ok(union.has(s), `${s} is in no set — the CHECK would reject every row carrying it`);
+ assert.ok(either.has('audit_generation_failed'),
+ assert.equal(required.has('audit_generation_failed'), false);
+ assert.deepEqual([...NON_TERMINAL_PERSISTENCE_STATES], ['started', 'retrieval_complete']);
+ for (const s of NON_TERMINAL_PERSISTENCE_STATES) assert.equal(isTerminalState(s), false);
+ assert.equal(TERMINAL_PERSISTENCE_STATES.length, RETRIEVAL_PERSISTENCE_STATES.length - 2);
+ assert.equal(TERMINAL_PERSISTENCE_STATES.length, 12);
+ assert.equal(isTerminalState('not_eligible'), false, 'the removed state is terminal for nothing');
+ assert.equal(/CREATE INDEX (?!IF NOT EXISTS)/.test(sql), false, 'every index is guarded');
+ assert.throws(() => telemetryHmac('   ', 'x'), /secret is required/);
+ assert.throws(() => telemetryHmac('\t\n ', 'x'), /secret is required/);
+ assert.ok(telemetryHmac(' s ', 'x'), 'a key with real content is still usable, trimmed or not');
+ assert.equal(one('vertex').vertex, 1);
+ assert.equal(one('openrouter').openrouter, 1);
+ assert.equal(one('local').local, 1);
+ assert.equal(one('not_served').not_served, 1);
+ assert.equal(one('unattributed').unattributed, 1);
+ assert.equal(one('not_served').unattributed, 0, 'a proven non-delivery is NOT an attribution gap');
+ assert.equal(one('unattributed').not_served, 0, 'and an attribution gap is not proof of non-delivery');
+ assert.equal(nulled[k], 0, `a null class must not increment ${k}`);
+ assert.equal(all.vertex + all.openrouter + all.local + all.not_served + all.unattributed, 5);
+ assert.deepEqual(
+ assert.deepEqual(batchCounters(m), {
+ assert.equal(batchCounters(m).retries_429, 2, 'the number this workstream exists to produce');
+ assert.equal(batchCounters({ batches: [] }).retries_429, 0);
+ assert.equal(batchCounters(inCompletionOrder).vertex, 3, 'and the counters are order-independent');
+ assert.notEqual(start, -1, `${decl} must exist — this pin may not pass because the name moved`);
+ assert.notEqual(end, -1, `${decl} must be a braced declaration`);
+ assert.ok(body.trim().length > 0, `${decl} sliced to nothing`);
+ assert.ok(body.length > 200, `${decl} is suspiciously short — did the slice find the real body?`);
+ assert.equal(new RegExp(`^\\s*${banned}\\??:`, 'm').test(body), false,
+ assert.equal(/^\s*query\??:/m.test(body), true, 'a banned field IS detectable by this matcher');
+ assert.equal(src.includes('TelemetryCapture'), false,
+ assert.ok(read('lib/retrieval-capture.ts').includes('TelemetryCapture'), 'it lives in the capture module');
+ assert.ok(keys.has('operational'));
+ assert.ok(new RegExp(`^\\s*${k}\\??:`, 'm').test(body), `${k} must be declared in RetrievalPayload, not grafted on`);
+ assert.ok(new RegExp(`^\\s*${k}\\??:`, 'm').test(opBody), `${k} must be declared in OperationalTelemetry`);
+ assert.ok(/export type StampedRetrievalManifest = RetrievalPayload & \{ operational: OperationalTelemetry \};/
+ assert.ok(RETRIEVAL_ROUTES.includes('unknown_route'));
+ assert.equal((RETRIEVAL_ROUTES as readonly string[]).includes('reconciler'), false,
+ assert.ok((INVOCATION_ROUTES as readonly string[]).includes('reconciler'));
+ assert.equal(INVOCATION_ROUTES.length, RETRIEVAL_ROUTES.length + 1);
+ assert.equal(routeClassOf('reconciler'), 'reconciler');
+ assert.deepEqual([...RETRIEVAL_ROLES],
+ assert.ok(RETRIEVAL_ROUTES.includes('lvc_judge_aa'));
+ assert.equal(buckets.find((b) => b.provider === 'vertex')!.prompt_tokens, 100);
+ assert.equal(isPriceableClass('vertex'), true);
+ assert.equal(isPriceableClass('openrouter'), true);
+ assert.equal(isPriceableClass('unattributed'), true, 'a completion may have arrived and been billed');
+ assert.equal(isPriceableClass('local'), false);
+ assert.equal(isPriceableClass('not_served'), false, 'proven non-delivery cannot have cost money');
+ assert.equal(isPriceableClass(null), false);
+ assert.equal(buckets.find((b) => b.provider === 'not_served')!.priceable, false);
+ assert.equal(unattributed.priceable, true);
+ assert.equal(unattributed.prompt_tokens, 80, 'a parse failure keeps the usage it really spent');
+ assert.equal(TELEMETRY_SCHEMA_VERSION, 2, 'the on-path build changes columns');
+ assert.equal(MANIFEST_SCHEMA_VERSION, 2, 'and manifest fields');
+ assert.equal(HMAC_KEY_VERSION, 'k1', 'the key did not rotate');
+ assert.ok(read(MIGRATION).includes('telemetry_schema_version INTEGER NOT NULL'));

=== lib/__tests__/transport-attribution-traceless.test.ts   (57 -> 58; removed 1, added 2)
- assert.equal((body.match(/attempts: \[\.\.\.attempts\]/g) || []).length, 3);
+ assert.equal((body.match(/attempts: attempts\b/g) || []).length, 0,
+ assert.equal((body.match(/attempts: \[\.\.\.attempts/g) || []).length, 7,

=== lib/__tests__/rerank-backend.test.ts   (77 -> 79; removed 1, added 3)
- assert.ok(audit.includes('defaultRetrieve(query, mini, opts.evalNormativeLeg, opts.rerankBackend)'),
+ assert.ok(/defaultRetrieve\(query, mini, opts\.evalNormativeLeg, opts\.rerankBackend[,)]/.test(audit),
+ assert.ok(/defaultRetrieve\(query, mini, opts\.evalNormativeLeg, opts\.rerankBackend, primaryCapture\)/.test(audit),
+ assert.ok(/rerank\(query, hits\.map\([\s\S]{0,200}?\)\), opts\.rerankBackend, undefined, capture\)/.test(retrieveSrc),
```

**The unit is a line, not a statement**, and several entries above are the first line of a
multi-line assertion whose message ran onto the next one — `assert.deepEqual(` on its own is the
clearest case. A statement-level count would be smaller. I did not make one, so I am not quoting
one: 23 and 77 are line counts under the definition at the top of this section, and that is all
they are.

---

## 16. Instrumented files and diff summary

**Two commits now. Both stats below are from `git show --stat`, not from memory.**

**Build commit `90d8db1`** — `git show --stat 90d8db1 | tail -1`:

```text
29 files changed, 5199 insertions(+), 348 deletions(-)
```

**28 files, +4,547 / −348 excluding this report**, which is the figure the first issue quoted and
the one figure in its §16 that was right: 29 − 1 = 28 files, 5,199 − 652 = 4,547 insertions.

**Correction commit (this pass)** — three files, and only two of them are code:

| File | Change |
|---|---|
| `lib/__tests__/telemetry-key-guard.test.ts` | **created**, 167 lines (`wc -l`) — kickoff test 57, 8 cases |
| `lib/multi-query.ts` | **6 insertions, 5 deletions** — the doc comment at `:124` only; line 133 untouched |
| `CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md` | this rewrite |

The report's own line delta is self-referential — it cannot be printed inside the file it counts.
`git show --stat HEAD` on `exp/rerank-telemetry` is the authority for it, and the two code figures
above are exact and were read from `git diff --stat` before the commit was made.

**Created at `90d8db1` (11):** `lib/retrieval-capture.ts`, `lib/retrieval-telemetry-store.ts`,
`lib/retrieval-invocation-store.ts`, `lib/retrieval-telemetry-failure-store.ts`,
`lib/retrieval-settlement.ts`, `lib/opd-audit-runtime-config.ts`, `lib/telemetry-key-guard.ts`,
`app/api/admin/migrate-retrieval-telemetry/route.ts`, and three test files.

**Edited (17):** `lib/retrieval-telemetry-core.ts`, `lib/transport-attribution-core.ts`,
`lib/llm.ts`, `lib/trace.ts`, `lib/retrieve.ts`, `lib/rerank.ts`, `lib/expand.ts`,
`lib/multi-query.ts`, `lib/opd-note-audit.ts`, `lib/lvc.ts` (the D7 seam and `defaultRecall` only),
`migrations/0035_…sql`, `next.config.mjs`, `.env.example`, `lib/architecture/map.generated.ts`, and
three tests.

**Every file is on the section 4 authorized list.** `lib/opd-audit-changelog.ts` and the two
low-value-care test files were not edited. `lib/sql-guard-core.ts` was not edited. `vercel.json`
was not edited. No engine bump, no scoring changelog entry.

**The preregistered grace: `WORKER_MAX_DURATION_SECONDS + RECONCILER_GRACE_SECONDS = 800 + 1800 =
2,600 seconds`,** fixed in `lib/opd-audit-runtime-config.ts` and recorded **here, now, before any
canary opens.** It cannot be tuned afterwards to make a gate pass; changing it restarts the window.
It is **conservative for most rows and deliberately so**: 800 is the highest `maxDuration` among the
instrumented routes, so a row from one of the 300-second routes waits 2,600 seconds before
reconciliation when its own route could not have run for more than 300. One grace for every row is
the choice, because a per-route grace is a tuning surface and this value must not be one.

---

## 17. What V does next

1. **Decide whether to continue this build.** It is a partial delivery. §12 is the remaining work,
   and it is at least as large as what is here. §12.1 is why the green gate does not shrink it:
   the manifest path has no executing test, so "continue" means writing the 50 absent tests as much
   as it means writing steps 14 to 17.
2. **Rule on the five flags in §11** — flag 1, which affects every developer's local build; flag 2,
   which changes what a canary would record on the Cohere path; and flag 5, whether kickoff test 63
   is written now or stays absent.
3. **Do not deploy this commit as-is without setting `CDMSS_TELEMETRY_HMAC_KEY` in Vercel
   Production.** The build will fail otherwise. That is D8 working, not a defect.
4. **Do not run the migration route yet.** The schema is ready and idempotent, but nothing writes to
   it, so applying it now buys nothing and starts a 90-day retention clock on empty tables.
5. **Nothing was pushed.** `exp/rerank-telemetry` and `park/lvc-arm-c-unshipped-11-aug-2026` are
   both local-only, for the same reason: a preview build is a second SHA on the same Flash quota,
   and the canary needs one.

No canary date is recommended. C0 was not started, and C0.5, C0.6, C1, C2, Q1 and F1 were not
built, prototyped or prepared for.
