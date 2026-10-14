# CDMSS Pre-op Risk Agent — Slice-1 Build Plan

**26 Aug 2026 · branch `feature/preop-risk-agent` · merge to main only when every gate below is green and V has verified live.**
Companion docs (same folder / `docs/handoff/`): `CDMSS-PREOP-RISK-AGENT-PRD-v1.1-LOCKED-26-AUG-2026.md` (the contract) and `PREOP-RISK-AGENT-MOCKUP-v1-26-AUG-2026.html` (**V-APPROVED 26 Aug — binding UI spec; §3 of the mockup is tier rule v0; deviations need V**).

House rules in force: every GitHub action + DB migration runs through Claude Code · migrations as admin routes (grants belong in migrations — the migration runner is the only owner-privileged path on Vercel) · model/provider labels DERIVED from the call, never typed · a stated guarantee is not an implemented one — prove each on production · born-instrumented.

## Naming (fixed)

- Engine: `PREOP_ENGINE_VERSION = 'preop-risk/0.1'` (version bump = A/B boundary, forward-only).
- Tables: `preop_findings` (live row per episode: episode key = `surgery_cases._doc_id`, individual_uid, computed snapshot json, tier, review state `reviewed_at/reviewed_by/reviewed_version`) · `preop_finding_versions` (append-only, readmit-R8.1 pattern: closed capture-reason set `overwrite|replay`, idempotent same-trace saves).
- Pure cores (no DB / fetch / clock): `lib/preop-instruments-core.ts` (RCRI, mFI-5, age-adjusted Charlson — point/range/not-computable; ranges from unknown inputs) · `lib/preop-tier-core.ts` (tier rule v0 exactly as mockup §3) · `lib/preop-assemble-core.ts` (input assembly + source precedence LAB/PAC > BOOKING > EXTRACTED; conflict tagging) · `lib/preop-pac-map-core.ts` (the one-template KareXpert key→semantic map as a reviewed TS constant — no table) · `lib/preop-versions-core.ts` · `lib/preop-extract-core.ts` · `lib/preop-narrative-core.ts`. Orchestration in `lib/preop/run.ts` + `lib/preop/store.ts` (mirror `lib/readmission/`).
- Routes: `/api/preop/worker` · `/api/care/preop/list` · `/api/care/preop/case` · `POST /api/care/preop/review` · `/api/admin/migrate-preop`.
- Flags (all ship OFF): `PREOP_SURFACE_ENABLED` (chooser tile + page + read routes, each gating independently) · `PREOP_EXTRACT_ENABLED` · `PREOP_NARRATIVE_ENABLED`.
- Cron: hourly day window, default `30 0-16 * * *` UTC (06:00–22:00 IST) — **covenant: the cron interval must clear the route's `maxDuration`; any change to one moves the other in the same commit.**

## Data sources (db13, all verified 26 Aug)

`surgery_cases` (anchor; `individual_uid`; NO uhid) · booking comorbidities + OPD/ClinicalState · `parameter_digital_values` (Eka labs) · `kx_clinical_template_pac_reports` (PAC; 95 rows, one template, `component_json` key/value array with opaque keys — `iu87`=diagnosis, `za`=procedure, `yudo`=sex, vitals as nested JSON; `note`=flattened text ending in fitness conclusion) · **UHID bridge `individuals.kx_uhid`** (91/94 map; 52 in cohort; `old_kx_uhids` for history). PAC capture reality: ASA 5/95, Mallampati 0/95, METs ~1 — the assembler must treat these as usually-absent; the S2 set waits on the capture ask (PRD §9.3).

## Builds and gates

**B0 — Branch + docs land.** Create `feature/preop-risk-agent` from main; copy the three handoff docs into `docs/handoff/`; commit. *Gate: branch pushed, docs visible on GitHub.*

**B1 — Pure cores + migration.** Instruments, tier rule v0, assembly/degradation logic, versions-core; `preop_findings` + `preop_finding_versions` DDL via `/api/admin/migrate-preop`. Tests must include the mockup's hand-computed cases verbatim (Shobha RCRI 2→Class III 6.6% / mFI 2/5 / CCI 4 with the v1→v3 range progression; Manjunath 3→Class IV 11%, CRITICAL by both escalation clauses; Farhan RCRI 1–2 → AMBER via lower-bound + boundary-crossing floor; Lakshmamma booking-only ranges). *Gate: full suite green, tsc clean; every mockup number reproduced exactly.*

**B2 — Assembler + worker.** Episode detection from `surgery_cases` (upcoming window), input assembly from all structured sources incl. the UHID bridge, snapshot compute + write-through versions rail; worker route with the readmit auth guard, wired to cron. *Gate: double-tick idempotency (second sweep writes nothing) proven live; one new input (feed a lab) mints exactly one new version; lane-count-style tally of episodes/tiers reported to V before any UI ships.*

**B3 — PAC mapping.** `preop-pac-map-core.ts` built by reading the live template rows; parser tolerant of blanks; unit tests against ≥3 real payload shapes (fixtures anonymised). *Gate: mapped-field coverage table for the 52 cohort PAC reports produced and shown to V (exact ASA/airway/weight counts replace the ILIKE estimates).*

**B4 — UI.** Chooser tile + board + case page **pixel-faithful to the approved mockup** (tiles, needs-review band, tier bands, dense rows, range chips dashed, PAC verdict banner verbatim-quoted, provenance chips incl. pink EXTRACTED, timeline, dark narrative panel rendered visibly OFF, honesty footers). Care-cookie gate; `PREOP_SURFACE_ENABLED` gates tile, page and read routes independently. *Gate: tsc + tests green; Chrome-verify LIVE with flag on for admin — type-checks pass but data-shape bugs only show at runtime (SREWS `surgeryDateKey` lesson).*

**B5 — Extraction rail (dark).** ClinicalState-B2-pattern extraction of instrument inputs from booking/OPD/PAC text; per-input provenance + confidence; below floor ⇒ UNKNOWN. *Gate: with `PREOP_EXTRACT_ENABLED=0`, output identical to B2/B4 state; with =1 on the golden set, scores change ONLY via input-status changes, every EXTRACTED chip shows confidence + source text.*

**B6 — Narrative rail (dark).** Readmit-narrative posture; prose written from the factor table; model label derived from the call. *Gate: flag off ⇒ dashed OFF panel; flag on ⇒ narrative renders, **flag-off/on instrument scores byte-identical** (the D4 proof).*

**B7 — Golden-set validation + handover.** Golden set = the 52 PAC-covered cohort patients + synthetic booking-only cases; produce the validation pack (board counts by tier, hand-checked score sample) for V. *Gate: V validates counts and sample → V flips `PREOP_SURFACE_ENABLED` → live smoke → **merge `feature/preop-risk-agent` → main`.** Extraction/narrative flags stay OFF until V separately flips them post-validation.*

Out of scope (S2+): Schedule/Calendar views · ask route · richer review workflow · Pulse API · ARISCAT/Caprini/STOP-BANG · tier calibration changes (4-week review) · EVEN_HOSPITAL HCU PDF digitization (separate pipeline task) · SREWS supersession.
