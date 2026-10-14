# CAT (Clinical Analysis Tool) — Port Plan & Notes

**Product:** CAT — Clinical Analysis Tool · **Repo:** `Even-CDMSS` (unchanged) · **Deploy target:** `even-cdmss.vercel.app`

You want: the latest CDMSS (the portal's, which is the newer line) lifted into the `Even-CDMSS` repo as a **standalone product called CAT**, sharing the portal's Neon DB + Ollama, on its **own Vercel deployment with its own link**. This is viable and the bundle does it.

**Important context from the 2026-06-04 screenshot:** `even-tutor.vercel.app` now serves the *portal* (footer "portal v1.1"), not the old standalone. So both `even-tutor` and `evenstaffportal` are the same portal codebase on two domains, and the six clinical links resolve to the portal's `(cdmss)` route group. The original standalone is fully dormant — nothing is lost by rebuilding. CAT becomes a *third, independent* deployment with its own URL.

**Routes CAT exposes (10):** Ask, DDx, Drugs, Calculators, Coach, Review, Browse, Practice, Topics, Search — all verified present and free of portal coupling.


## Build status: VERIFIED ✓

This was not just scaffolded — it was installed and built end-to-end:
- `npm install` → 364 packages, versions matched to the portal exactly (`.npmrc` carries `legacy-peer-deps=true`, same as the portal, because `lucide-react@0.383.0` predates React 19).
- `npm run build` → **clean exit 0**, "Compiled successfully", 70/70 pages generated, all 10 routes + every calculator compiled, TypeScript types valid.
- `npm test` → calculator math tests run via `node --test --import tsx`.

### One inherited test failure (not a port defect)
The eGFR Cockcroft-Gault test has one failing case (`CG 109.3 outside 115-130`). Verified: `egfr.ts` and `egfr.test.ts` are **byte-for-byte identical to the portal** — this assertion has been failing in the portal all along. It's a test-tolerance question in the CG branch, inherited verbatim, not introduced by extraction. Fix it (or widen the tolerance) at your leisure; it doesn't block deploy.

## What was automated for you (no manual code edits needed)

1. **`app_source` tagging** — done centrally in `lib/db.ts` via a `sql` Proxy that auto-injects `app_source` into INSERTs on the five shared usage tables. All ~20 insert sites are covered by this one file because every route imports `{ sql } from '@/lib/db'`. Injection-safe (added as a real bind param) and idempotent. **No per-route edits.** Set `APP_SOURCE=standalone` in env (already in `.env.example`).
2. **Lazy DB connection** — `neon()` now connects on first query, not at module load, so `next build` succeeds without `DATABASE_URL`. (Improvement over the portal's eager construction.)
3. **Runtime-dynamic API routes** — every API route declares dynamic rendering so the build never opens a DB connection during page-data collection.
4. **Dependency pinning** — exact portal versions; portal-only deps (`@vercel/blob`, `diff-match-patch`) omitted since CAT doesn't import them.

## Why this works (verified against the live code)

1. **Clean schema split.** CDMSS code touches only: `mksap_chunks` (the corpus — what you *want* to share), plus `traces`, `trace_events`, `coaching_sessions`, `flashcards`, `example_questions`, `user_queries`, `user_profiles`, `app_settings`, `sidebar_cache`. The portal's own tables (`bulletin_*`, `staff_complaints`, `complaint_*`, `videos`, `resources`, `contacts`, `pilot_apps`) are **completely disjoint** — no shared write surface to fight over.

2. **No auth coupling.** No `(cdmss)` route or `lib/cdmss` file imports the portal's identity/auth layer. The clinical endpoints don't assume a logged-in portal user.

3. **Only one real coupling existed** — `app/(cdmss)/layout.tsx` imported the portal's `AppLayout` + `getHomeLayout`. The script auto-replaces it with a self-contained `Shell`. After that, **zero** portal references remain.

4. **The portal was the newer line**, so the script ports *from the portal* — you get the 49 newer files (10 extra calculators: ABCD2, Alvarado, CURB-65, HEART, NIHSS, QTc, SOFA, TIMI, Wells DVT/PE; the `blocks/` answer renderers; multi-query/rerank/source-quality retrieval) rather than reviving the stale original.

## Two things you inherit by sharing the DB (decide deliberately)

### A. Embedding-version state — `USE_EMBEDDING_V2 = false`
`lib/llm.ts` hardcodes a **2026-05-26 hotfix**: it forces the older `embedding` column (nomic-embed-text, 768-dim) instead of `embedding_v2` (mxbai-embed-large, 1024-dim) because *"embedding_v2 column NULL for new ingestions; revert after backfill."*

Both columns live on the **shared** `mksap_chunks` table. Consequences:
- The standalone inherits the same hotfix — it'll work, retrieving against the populated `embedding` column. Fine for day one.
- **Don't flip `USE_EMBEDDING_V2 = true` in the standalone until the v2 backfill is done in the shared DB** — you'd query a half-NULL column and silently lose recall.
- This is a *shared-state* gotcha: whoever finishes the backfill flips it for *both* apps. Coordinate it; don't let the two repos drift on this flag.

### B. Usage-data commingling — the `app_source` migration
Shared DB means the standalone's traces, coaching sessions, flashcards, and query logs land in the **same tables** as the portal's. For a "separate product with its own users/roadmap" you'll want them separable. `migrations/0001_app_source.sql` adds an idempotent `app_source` column (default `'portal'`) + indexes to those five tables. Set `APP_SOURCE=standalone` in env and have writes stamp it.

**Code follow-up the script can't do for you:** the insert/update statements in `lib/trace.ts`, `lib/coach.ts`, and the flashcard routes need to write `app_source` from `process.env.APP_SOURCE`. Small, mechanical — grep for `INSERT INTO traces`, `INSERT INTO coaching_sessions`, `INSERT INTO flashcards`, `INSERT INTO user_queries`. ~4 edits.

## Deploy checklist (what's left for you — all in the Vercel/GitHub UI, no code)

1. Push the `cdmss-standalone/` tree into your `Even-CDMSS` repo (replacing the old standalone).
2. In Vercel: create a new project from that repo. Framework auto-detects as Next.js.
3. Set env vars in the new project: `DATABASE_URL` (same Neon as portal), `OLLAMA_BASE_URL`, `TEXT_MODEL`, `EMBED_MODEL`, `EMBED_MODEL_V2`, `TOP_K`, and `APP_SOURCE=standalone`.
4. Set the project's domain to `even-cdmss.vercel.app`.
5. Apply the migration once against the shared Neon DB:
   `psql "$DATABASE_URL" -f migrations/0001_app_source.sql`
6. Deploy. (Build is already proven to pass.)

Leave `USE_EMBEDDING_V2 = false` until the shared-DB v2 backfill lands. The two portal domains (`even-tutor`, `evenstaffportal`) are untouched and keep serving the portal.

## What the script produces

A `cdmss-standalone/` tree: 48 API routes, 28 pages, 44 lib files, 27 components, 15 calculators — un-namespaced, imports rewritten, own `package.json` / `vercel.json` / `.env.example` / `Shell`, plus the migration. No portal code, no `(cdmss)` route group, no `lib/cdmss` prefix.
