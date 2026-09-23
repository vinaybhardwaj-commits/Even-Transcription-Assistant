# WAN Lab tab — REFUTER VERDICT. 23 Sep 2026

`wan-lab-tab` **@ `71e6de0`** (builder lab-mover), repo `~/dev/What-Are-Next`. Order: `~/dev/_fable/orders/WAN-LAB-TAB.md`. Own detached worktree `/tmp/refute-wan`; nothing pushed, no lab content copied, no database touched.

## PASS-WITH-FIXES — the public-repo hazards are all closed; the reader handles a missing token and not a broken one

### What is closed, checked rather than taken from the order

| the order's constraint | state |
|---|---|
| no token committed (repo is PUBLIC) | ✅ tree searched for `github_pat_｜ghp_｜ghs_｜gho_`: none |
| no lab content committed | ✅ one match, `src/lib/lab/ledger.ts`, and it is a **path string** (`getFileRaw("ledger/ETA-FINDINGS-LEDGER.md")`), not content |
| never send the token to the client | ✅ read in exactly one place, `src/lib/lab/github.ts:24`, inside a module that begins `import "server-only"` |
| do not store lab file contents in Neon | ✅ no `insert into｜drizzle｜db.insert` anywhere under `src/lib/lab/` |
| do not expose eta-lab publicly | ✅ **both doors shut** — see below |
| do not change auth | ✅ `PUBLIC` unchanged; the lab pages are not added to it |

**All five lab modules** (`bus`, `github`, `ledger`, `orders`, `studies`) open with `import "server-only"`. That is a build-time guarantee, not a convention: a client component importing one fails the build.

**Both doors.** `/lab` is inside the passcode middleware — `PUBLIC = ["/login", "/api/auth/login", "/api/mcp"]` and the matcher exempts only static assets. The third entry is the one worth chasing, because `/api/mcp` now carries `lab_get_file`, which returns raw eta-lab content. It is not open: `authed()` requires a bearer or `?k=` match against `MCP_TOKEN` and **returns false when that env var is unset** (fail-closed when unconfigured), and it is enforced as the **first statement of `POST`** (`route.ts:75`), before the body is even parsed. Checked, not assumed.

**Seven importers of `lib/lab`, none of them a client component**: six server page components under the authed `(app)/lab` route group, plus `src/lib/mcp/registry.ts` behind the token above.

### FINDING — "not connected" covers the token being absent, never the token being broken

`getFileRaw` and `getTree` wrap their work in a `try` whose `catch` recognises exactly one error and rethrows the rest:

```
src/lib/lab/github.ts
  } catch (e) {
    if ((e as Error).message === "LAB_NOT_CONNECTED") return notConnected();
    throw e;
  }
```

and the only thing that raises `LAB_NOT_CONNECTED` is `gh()` finding no token. Everything else propagates:

| state | result |
|---|---|
| `LAB_GITHUB_TOKEN` unset or blank | `{connected:false, reason}` — the order's requirement, met |
| token **expired or revoked** → GitHub 401 | `throw new Error("GitHub 401 fetching …")` — **rethrown, the page throws** |
| rate-limited (403), GitHub 5xx | same |
| GitHub unreachable / DNS / TLS — `fetch` rejects | same |

The tests mirror the split exactly. `github.test.ts` has **five** cases for the absent half (`isLabConnected` false, three readers returning not-connected *without calling fetch*, and blank-treated-as-unset — that last one is good work), and on the connected side it covers the happy path, a 404, the 60 s cache and the tree mapping. **No case covers a non-404 error status, and none covers `fetch` rejecting.**

**Why this is not an edge case.** `LAB_GITHUB_TOKEN` will be a GitHub PAT. Expiry is the *normal end state* of a PAT, not a failure mode — so "set but no longer working" is where this token eventually lands, by default, with no one doing anything wrong. On that day the lab pages do not show "not connected"; they throw. The order asked for a clear not-connected state so the tab degrades visibly, and the degradation is built for only one of the two ways it can arrive.

**Fix, and it is small:** widen the catch to return a not-connected result for any failure, with a **distinct reason** so the two stay separable — "not configured" and "configured but unreachable" are different messages to whoever reads the page, exactly as `attribution: "none"` plus an error code keeps "nobody matched" apart from "nobody was compared" on the diarize branch. Two tests pin it: a 401 and a rejecting fetch.

### OBSERVATION — the order's own verification step writes to the database

`package.json` defines `"build": "node scripts/migrate.mjs && node scripts/seed.mjs && next build"`. The order's verification asks the reviewer to "grep .next output", and a reviewer running `npm run build` to produce it **runs migrations and a seed** from a review worktree. Pre-existing and not this branch's doing; flagged because the order points straight at it. I ran `npx next build` alone.

### What I did NOT prove

**The `.next` canary grep is UNPROVEN in my sandbox.** I built with `LAB_GITHUB_TOKEN=<canary>` so the grep could actually fail — a grep for an unset value passes unconditionally and proves nothing — but `next build` never completed: page-data collection dies on `No database connection string was provided to neon()`, my worktree having no `DATABASE_URL` (and I do not read `.env*`). Both arms of my token-set/token-unset comparison failed for that same environmental reason, at different pages only because collection order differs; **I briefly read that as a differential and it was not one.** Reported so nobody mistakes it for evidence either way. What stands in its place is stronger than a grep: the token is read in one module, that module is `server-only`, and no client component imports it.

## Verdict: PASS-WITH-FIXES
Nothing in this branch can leak the token or lab content into the public repo or to an unauthenticated caller, and I went looking specifically for that. The one real gap is that the fail-closed state answers only the question "is a token configured?" and not "does the configured token work?", and a PAT will eventually make that the live question.

---

# ADDENDUM — my review was scoped narrower than the change, 23 Sep 16:10

I reviewed this branch before reading lab-mover's own bus message (id 3, 14:57 — it sat unread behind the bus defect recorded separately). Their message states the change is **32 files, +7178/−1415**. My verdict above examined the security-critical surface — the token, `server-only`, the auth boundary, Neon writes, client importers — and **not** the other files. Stating that plainly rather than leaving the scope implied.

Two things from the wider change, now checked:

- **Markdown rendering of lab content is safe.** The new `react-markdown` + `remark-gfm` path renders text fetched from the private repo. No `rehype-raw`, no `dangerouslySetInnerHTML`, no `allowDangerousHtml` anywhere under `src/components/lab/` or `src/lib/lab/` — react-markdown escapes HTML by default, so repo content cannot inject script into the page. This was worth checking precisely because that content is data I treat as untrusted, and rendering it is the one place that assumption could have been broken.
- **`drizzle/0003_dapper_vulture.sql` is `ALTER TYPE "public"."link_type" ADD VALUE 'lab';`, bare.** On Neon's PG 16 this is transaction-safe, since the new value is not used in the same transaction. Two properties worth naming anyway: it is **irreversible** — an enum value cannot be dropped, so there is no down migration — and it lacks `IF NOT EXISTS`, so a manual re-run errors rather than no-ops. Drizzle's journal prevents that in the normal path; the note matters only for a hand-run. Not a blocker. **V runs `npm run db:migrate`;** it is applied nowhere yet.

Everything in the verdict above stands unchanged. The FINDING (the reader handles an absent token and not a broken one) is unaffected by any of this.

## The `.next` token grep: now PROVEN, and with a control

Closed using the detail from lab-mover's own bus message, which I had not read when I wrote the verdict: `npx next build` needs only a **fake** `DATABASE_URL` to get past static construction. With `DATABASE_URL=postgres://fake…` and `LAB_GITHUB_TOKEN=<canary>`:

- **The build completed** — `✓ Generating static pages (17/17)`, route table printed, **rc=0**, 194 MB of output. (Stated explicitly because my two earlier attempts died at page-data collection and produced a directory that a grep walks happily while proving nothing.)
- **POSITIVE CONTROL — the grep can find things.** `LAB_GITHUB_TOKEN` 2 hits, `not connected` 10, `ask Fable` 2. A grep that returns nothing is only evidence once it has been shown capable of returning something.
- **The canary token VALUE appears in zero files** — not in `.next/static`, not in `.next/server`, nowhere.
- **The variable NAME appears only in `server/`** (`app/api/mcp/route.js`, `chunks/568.js`) and never under `.next/static`, and **no lab reader** (`isLabConnected`, `getFileRaw`) is present in any client chunk.

The order's stated verification is therefore satisfied on its own terms, and by the stronger reading: not merely "the token is absent from the client bundle" but "the code that reads it is absent too". Note the value could not have been inlined in any case — Next inlines only `NEXT_PUBLIC_*` — so the meaningful result is the second one, and `server-only` is what guarantees it rather than the grep.
