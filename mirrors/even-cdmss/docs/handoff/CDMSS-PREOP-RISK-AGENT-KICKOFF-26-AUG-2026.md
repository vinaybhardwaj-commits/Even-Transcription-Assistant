# Claude Code kickoff — Pre-op Risk Agent, Slice 1 (B0–B2)

Paste this into Claude Code (Opus 5) in `~/dev/Even-CDMSS`.

---

You are building the **Pre-op Risk Agent** in Even-CDMSS. Work on a **new branch — nothing lands on main until every gate passes and V verifies live.**

**First, sync and read (in this order):**
1. `git fetch origin && git checkout main && git pull` (git-sync-before-coding rule).
2. From the Daily Dash EHRC folder (`~/Library/Mobile Documents/com~apple~CloudDocs/Even Documents/Daily Morning Meeting/Daily Dash EHRC/`), read:
   - `CDMSS-PREOP-RISK-AGENT-PRD-v1.1-LOCKED-26-AUG-2026.md` — the contract. Zero open decisions; do not reopen any.
   - `PREOP-RISK-AGENT-MOCKUP-v1-26-AUG-2026.html` — **V-approved, BINDING UI spec** (open it in a browser too). Its §3 is tier rule v0; its hand-computed scores are acceptance tests.
   - `CDMSS-PREOP-RISK-AGENT-BUILD-PLAN-26-AUG-2026.md` — the build order B0–B7 with gates, fixed naming, cron covenant.
3. Study the sibling pattern you are mirroring: `lib/readmission/` (run.ts, store.ts), `app/api/readmission/worker/route.ts` (auth guard, maxDuration covenant, sweep-is-the-retry), `lib/readmission-versions-core.ts` (R8.1 versions rail), `components/care/ReadmissionsBoard.tsx`, and how `READMISSIONS_SURFACE_ENABLED` gates chooser + page + routes independently.

**This kickoff covers B0–B2 only.** B3–B7 get their own kickoffs after V reviews the B2 tally.

**B0 — Branch + docs.** Create `feature/preop-risk-agent` from up-to-date main. Copy the three docs above into `docs/handoff/` and commit ("preop-risk: land PRD v1.1-LOCKED + approved mockup + build plan"). Push the branch.

**B1 — Pure cores + migration** (per Build Plan naming, exactly):
- `lib/preop-instruments-core.ts` — RCRI (Lee: 0.4/0.9/6.6/11%), mFI-5, age-adjusted Charlson. Inputs are tri-state (present/absent/unknown); unknowns ⇒ the instrument returns a **range** (computed at both extremes) + missing-input list; all-unknown floor ⇒ not-computable (should be ~never).
- `lib/preop-tier-core.ts` — tier rule v0 **exactly as mockup §3**: per-instrument severity bands; range scores its confirmed LOWER bound, flooring at AMBER when the upper bound crosses a severity boundary; composite = max severity; CRITICAL = RED on ≥2 instruments OR any RED with no finalized PAC ≤72h; needs-review = unreviewed RED/CRITICAL with surgery ≤7d.
- `lib/preop-assemble-core.ts`, `lib/preop-versions-core.ts` (R8.1 pattern), `lib/preop/store.ts` DDL via `/api/admin/migrate-preop`: `preop_findings` + `preop_finding_versions`.
- Tests MUST reproduce the mockup's four synthetic cases byte-for-byte (Shobha, Manjunath, Farhan, Lakshmamma — values and range progressions are in the mockup and Build Plan B1).
- No LLM anywhere in B1. Cores take no DB/fetch/clock.

**B2 — Assembler + worker.** Episode detection from `surgery_cases`, inputs from booking/OPD/ClinicalState + `parameter_digital_values`, PAC presence via the UHID bridge (`individuals.kx_uhid` → `kx_clinical_template_pac_reports.uhid`; PAC *content* mapping is B3 — B2 only uses existence + status + created_at + the fitness `note` tail for the verdict banner). Worker `/api/preop/worker`: readmit auth guard byte-for-byte, idempotent on `(dedup_key, PREOP_ENGINE_VERSION='preop-risk/0.1')`, cron `30 0-16 * * *` UTC with the **maxDuration↔interval covenant in the same commit**. Everything dark: no UI, no flags flipped.

**Gates before you stop:** full suite green + tsc clean · migration run live via the admin route · worker double-tick idempotency proven on production (second tick writes nothing) · feed-one-input version-mint proven · report to V: episode count, tier tally, PAC-linked count (expected ~52 of the PAC reports linking via the bridge), and any surprises.

**Rules in force:** migrations + all git through you, never V's terminal · grants belong in migrations · model/provider labels derived, never typed (no models in B0–B2 anyway) · a stated guarantee is not an implemented one — prove each gate on production · Next.js 15: dynamic route `params` are `Promise<>` (local tsc misses it) · advisory module: nothing you build overrides the anaesthetist's PAC verdict.

**Report back** in the usual build-report format: what shipped (commits), gates with evidence, deviations (should be none), and the B2 tally for V's validation.
