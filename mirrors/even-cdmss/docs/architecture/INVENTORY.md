# Architecture Inventory — the guarded boundaries (Slice 1, Phase 0)

*A scoped boundary map: only the modules the four `architecture:check` rules guard — not a full
census. Enforced on every push/PR by `.github/workflows/ci.yml` → `npm run architecture:check`
(`scripts/architecture-check.mjs`). 13 Jul 2026.*

## The planes and their edges

| Module | Plane | Allowed IN (imports) | Allowed OUT (who may import it) |
|---|---|---|---|
| `lib/clinical-state/**` | Pure clinical core (per-encounter patient model) | zod, other clinical-state, pure lib peers (`ccb-dossier-core`, `investigations`, `concordance-core`), **`import type` only** from `doc-audit-core` (outbound clinical→audit projection) | member-state, DDx surface, audit shadow |
| `lib/member-state/**` | Spine (Plane-1 longitudinal patient projection) | clinical-state (value + type), `lib/as-of-core` (pure temporal), pure lib peers, db/fetch wrappers in the wired sibling only | opd-longitudinal (advisory reads the snapshot), CCB, care surfaces |
| `lib/opd-note-score-core.ts` | Score arithmetic (the ONLY place score maths lives) | `import type` from `value-score-core` | the audit engine + dashboards. **Advisory/longitudinal may NOT import it** |
| `lib/opd-longitudinal-core.ts`, `lib/opd-longitudinal*.ts` | Advisory (informational lane — never scores) | member-state views, finding **types/identity** (`stampFindingIdentity`, `OpdFinding`) from `opd-note-audit-core` | triage lane, the audit store's post-INSERT pass |
| `lib/opd-triage-core.ts` | Advisory triage (label-only lane primitives) | finding types from `opd-note-audit-core` | triage routes/UI |
| `lib/as-of-core.ts` | Pure temporal primitive (created Slice 1 Part A) | nothing (leaf) | anyone — deliberately neutral so the spine never reaches into the advisory core |

## The one-way rules, in plain language

1. **Pure clinical cores never reach up into the app** — nothing under `clinical-state/`,
   `member-state/`, `opd-note-score-core`, `opd-longitudinal-core` imports `app/` or `components/`.
2. **Advisory never imports score arithmetic** — the longitudinal/triage lane may share finding
   *types and identity* (from `opd-note-audit-core`) but can never touch `opd-note-score-core`.
   That is the precise line that keeps "informational" provably non-scoring.
3. **The spine runs no audit/score logic** — `member-state/`/`clinical-state/` may take
   **`import type`** from audit modules (shape-sharing is fine) but never a **value** import of
   `opd-note-score-core`, `opd-note-audit(-core)`, `opd-longitudinal*`, or `formulary*`.
   The one historical crossing (`applyAsOfCut` value-imported from `opd-longitudinal-core`) was
   relocated to `lib/as-of-core.ts` in Slice 1 Part A.
4. **The spine doesn't couple to an unbuilt prediction layer** — a tripwire for the day P8 exists.

Type-only sharing is allowed everywhere; value/logic imports are what the rules police.

## How to add a boundary check

Open `scripts/architecture-check.mjs` — the rules are a declarative array at the top:
`{ id, name, sourceGlobs, forbid (RegExps over the normalised import path), valueOnly }`.
Add one entry; `npm run architecture:check` picks it up, CI enforces it on the next push.
`valueOnly: true` gives the rule the `import type` allowance (rule 3's semantics).

## The five clinical-semantics tests (behavioural companions)

`lib/__tests__/architecture-*.test.ts` — ratified invariants the import rules can't express:
no resolution from silence · prescribed ≠ taking · audit findings never become patient facts ·
adjudication retains original evidence · advisory never wears the scored-band palette.
