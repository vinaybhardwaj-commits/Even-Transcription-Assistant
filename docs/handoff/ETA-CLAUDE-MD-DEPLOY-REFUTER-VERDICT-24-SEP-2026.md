# ETA-Refuter — CLAUDE.md 9036e9b: PASS (Fable ruling 33)

**Branch:** `vinay/train-24sep-eve` @ `9036e9b`, parent `a30186c` (production).
**Scope:** `CLAUDE.md` only, +3/−3, no code. Matches the claim exactly.
**Author:** scribe, who correctly declined to put it in a production push without a verdict.

Delivered on the bus as #108. This is the filed copy.

---

## Verdict: PASS

The corrected line is true, and I proved it independently of the commit message.

## What the commit changes

Line 39 said a push to `vinay/s1-auto-drain` "produces only a PREVIEW (`target: null`)" and "does
NOT ship". That has been false since 22 Sep. The commit states the production fact, keeps the
19 Sep preview history as history, scopes `vercel promote` to "ship a commit the branch does NOT
point at" (line 40), and turns "you do not deploy" into "push to `s1-auto-drain` only when the
Orchestrator's order names that push" (line 43).

## Evidence — verified via the Vercel API, not from the commit message

Both cited deployments check out:

| deployment | sha | target | source | ref |
|---|---|---|---|---|
| `dpl_EnpLbxzcSn4L8kyEZbjRrAaHrh2R` | `a30186c` | `production` | **`git`** | `vinay/s1-auto-drain` |
| `dpl_E5vWkHYqddiELAyBQVmswUSrN8bM` | `086e341` (22 Sep) | `production` | **`git`** | `vinay/s1-auto-drain` |

Both hold `evenscribe.app` and `www.evenscribe.app`.

**`source: "git"` is the load-bearing field, and scribe picked the right discriminator.** A
`vercel promote` *also* creates a `target: production` deployment — the doc itself says so on
line 40 — so `target` alone cannot separate an auto-deploy from a promote. `source: "git"` can.

**A natural control beats both cited ids.** Sha `a30186c` appears **twice** in the deployment
listing: as `vinay/train-24sep-pm` → `target: null` (preview), and as `vinay/s1-auto-drain` →
`target: production`. Identical commit, identical tree, different branch, different target. The
**branch** decides production, not the content.

Across the 20-deployment window the separation is total: **2/2** `s1-auto-drain` refs →
production; **18/18** other refs (trains, refuter-verdicts, `ci/**`, feature branches) →
`target: null`.

Timing claim holds: build → ready **64.5 s** (`a30186c`) and **43.1 s** (`086e341`), so "about a
minute after the push" is fair.

## No stale duplicate left behind

I grepped the whole file and the repo at that commit. Line 41 still references `target: null` and
`request_promote` returning 422 — that stays **correct**, because non-`s1-auto-drain` pushes really
are previews. It is consistent with the new line 39, not a leftover.

`9036e9b` itself built as `target: null` on `vinay/train-24sep-eve`, so reviewing it cost nothing.

## Not verified, flagged as harmless

The retained history that pushes were previews until 21 Sep (`843e7b2`, 19 Sep) predates the
listing window I could see. It is the prior doc's own claim, kept and explicitly marked no longer
true, so nothing acts on it.

## Why this mattered

A pane following the old line would have treated a push to `vinay/s1-auto-drain` as staging. It is
a production deploy. This verdict is cited later the same day in the D1 review, where a stray local
`vinay/s1-auto-drain` 151 commits behind origin turned out to be a rollback hazard precisely
because of what ruling 33 established.
