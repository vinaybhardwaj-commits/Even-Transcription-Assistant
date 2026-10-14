# CDMSS rerank telemetry: addendum v6, the pooler suffix

**13 August 2026.** Three corrections to `123041b`. The measurement cannot run without the
first, and the second is the reason the guard I asked for would not have fired.

---

## 0. Authority and preflight

Governs all work after `123041b47afb96ebc140c0fcda43d48dde4f9e49` on
`exp/rerank-telemetry`. Continues addendum v5. Every settled decision stands.

```text
branch:  exp/rerank-telemetry
HEAD:    123041b47afb96ebc140c0fcda43d48dde4f9e49
tree:    clean
```

`origin/exp/rerank-telemetry` is at `cdc9c34`. Two commits will be unpushed when this
lands. That is expected.

**Pass 5 was correct on all eight fixes it was given.** These are defects found afterwards,
and fix 1 below is mine, not the build's.

---

## 1. Fix 1. `neonEndpointId` must strip a trailing `-pooler`.

Neon's pooled host carries a `-pooler` suffix. The function returns the host's leading
label unmodified, so a real connection string parses to `ep-…-pooler` while the operator
sets the bare id.

Measured, not reasoned:

```
parse of the branch pooled URL   ->  ep-young-moon-aofuyr1u-pooler
CDMSS_OVERHEAD_DB_ENDPOINT       ->  ep-young-moon-aofuyr1u
                                     expectedEndpoint !== actualEndpoint
                                     every request returns endpoint_mismatch
```

`grep -n "pooler" app/api/admin/telemetry-overhead/route.ts` returns nothing.

**This is my error.** When I extracted the endpoint from `.env.local` I stripped `-pooler`
in my own command, handed V the bare id, and never told the build to normalise the same
way.

### The fix

Strip **one** trailing `-pooler`, case-insensitively, after the label is matched and before
it is returned. Do not strip it from the middle. Do not strip anything else.

Normalise the two environment values the same way, so an operator who sets either form
gets the same behaviour.

### Why in the code and not in the variables

Neon exposes `ep-x` and `ep-x-pooler` for the **same compute**. Normalising makes the
denylist in fix 2 catch both forms of the production host. Telling V to set the variables
with `-pooler` instead would leave the denylist blind to the direct host, which is the
worse of the two failures.

---

## 2. Fix 2. The denylist does not fire on production's pooled host.

Same root cause, higher severity.

```
production pooled host parses to    ep-super-union-aoys3lle-pooler
CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT   ep-super-union-aoys3lle
                                    not equal -> forbidden_endpoint does NOT fire
```

The request still refuses, at `endpoint_mismatch`, so nothing is exposed today. But the
guard that exists specifically to catch the production case does not catch it, and if both
variables were ever set to production values the route would run.

Fix 1 closes this. **Prove it with a test that uses a pooled host**, not by inspection.

---

## 3. Fix 3. The test fixtures are not shaped like real Neon hosts.

```
lib/__tests__/telemetry-overhead-guard.test.ts:26   FAKE_ENDPOINT  = 'ep-measure-branch-000001'
lib/__tests__/telemetry-overhead-guard.test.ts:30   OTHER_ENDPOINT = 'ep-production-primary-999999'
```

Neither carries `-pooler`, so no test ever sees a realistic pooled host and the whole class
above was invisible.

This is the same shape of error as the `u` username in pass 5: an unrealistic fixture hid a
real behaviour. Two passes in a row.

### The fix

Add pooled variants to the fixture set and cover, at minimum:

- Branch **pooled** host with the bare id expected. Must **pass** all guards.
- Branch **direct** host with the bare id expected. Must **pass**.
- Branch pooled host with the **pooled** id expected. Must **pass**.
- Production **pooled** host. Must refuse **`forbidden_endpoint`**, not `endpoint_mismatch`.
- Production **direct** host. Must refuse **`forbidden_endpoint`**.
- A host whose label merely contains `pooler` in the middle, for example
  `ep-pooler-test-000001`. Must **not** be truncated.

Use hostnames of the real form throughout:
`ep-<label>[-pooler].c-2.ap-southeast-1.aws.neon.tech`.

---

## 4. Fix 4. A comment records a conclusion the build retracted.

`app/api/admin/telemetry-overhead/route.ts:411-416` says two of the three paste mistakes
leak and that a dropped `postgresql://` prefix does **not**. The build report to V says all
three leak, and says the two-of-three reading was a retracted first draft.

Measured against the real driver, with three usernames:

```
user=u             dropped scheme      PW=no      <- the misleading case
user=u             wrapped in quotes   PW=LEAK  HOST=LEAK
user=u             leading psql        PW=LEAK  HOST=LEAK
user=neondb_owner  dropped scheme      PW=LEAK  HOST=LEAK
user=neondb_owner  wrapped in quotes   PW=LEAK  HOST=LEAK
user=neondb_owner  leading psql        PW=LEAK  HOST=LEAK
user=cdmss_user    all three           PW=LEAK  HOST=LEAK
```

`u:` parses as a URL scheme, so that one username alone hides the leak. The real user is
`neondb_owner`. **All three shapes leak.**

The code is safe either way, because nothing error-derived reaches the body. The comment is
wrong on the highest-severity item, in the place the next reader looks first.

### The fix

Correct the comment to say all three leak with any realistic username, and record **why**
the `u` case does not: a single-letter username parses as a URL scheme and the driver takes
a different, non-leaking path. That fact is the useful part and it is what made the first
reading wrong.

---

## 5. File contract

### Edit

```text
app/api/admin/telemetry-overhead/route.ts
lib/__tests__/telemetry-overhead-guard.test.ts
.gitignore                                            add the v6 exception line
CDMSS-RERANK-TELEMETRY-ONPATH-BUILD-11-AUG-2026.md    Part XIII, above Part XII
```

### Add to the commit, unedited

```text
CDMSS-RERANK-TELEMETRY-ADDENDUM-v6-13-AUG-2026.md
```

### Do not touch

Everything else. No new imports, so `lib/architecture/map.generated.ts` must not move. v1
section 9's map pre-gate applies.

---

## 6. Attack your own work

Report every attack, including those that broke nothing.

- Revert fix 1. The pooled-branch case must fail.
- Revert fix 1. The production-pooled case must fail on `forbidden_endpoint`.
- Feed `ep-pooler-test-000001`. It must not be truncated to `ep`.
- Feed a label ending `-pooler-pooler`. Decide and state what it does, and test it.
- Feed the pooled host with the pooled id expected, and with the bare id expected. Both
  must pass.
- Confirm no refusal body gained a field.
- Confirm `-pooler` stripping cannot be used to make two different endpoints compare equal.

---

## 7. Gate, report, commit

Gate: v1 section 9 in full, including the map pre-gate.

Report a new **Part XIII**, above Part XII. It carries the four fixes with their tests, the
attack results including failures, and a plain statement that pass 5 was correct on
everything it was asked to do.

Commit: one scoped commit, parent exactly `123041b`, no amend, no rebase, no `git add -f`.

**Do not push. V pushes. Do not run the measurement.**

---

## 8. After this lands

V's variables stay exactly as they are, bare ids, no `-pooler`:

```text
CDMSS_OVERHEAD_MEASURE              1
CDMSS_OVERHEAD_DB_ENDPOINT          ep-young-moon-aofuyr1u
CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT   ep-super-union-aoys3lle
DATABASE_URL                        the branch string, Preview, exp/rerank-telemetry
```

Push both commits, let the Preview rebuild, then take the measurement per Part XI section 8.

The route expires 2026-08-20.
