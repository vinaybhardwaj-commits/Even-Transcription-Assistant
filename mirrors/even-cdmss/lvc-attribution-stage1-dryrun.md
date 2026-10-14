# LVC Rule Attribution Fix — Stage 1 dry run (READ-ONLY) · STOP for orchestrator review

**Engine:** `opd-note-audit/0.81.8` · **Date:** 20 Jul 2026 · **Commit: none** (Stage 1 commits nothing; the v3.1 matcher + updated tests + dry-run script are in the working tree only). **Green gate with the working-tree matcher: ✅ typecheck · architecture · governance · test 1260/1260.** **No DB write of any kind** — one read of `lvc_recommendations` + `opd_note_audits`; recompute is offline over stored findings (`matchLvcRule` is pure; no live re-audit).

> **Headline:** the fix behaves exactly as D1/D2 specify and is perfectly score-invariant — but the corpus consequence is bigger than the PRD's ~832 estimate: **3,536 of 4,576 attributions (77%) fall to null**, because the self-mined corpus is saturated with duplicated single-token keywords, making **40 of 111 rules structurally unmatchable** — including, notably, **the serratiopeptidase rule the kickoff named as the must-keep-working example (39 attributions → 0)**, because *four* rules share that bare keyword. And the three coding rules' phrase rewrite wins **zero** findings — no 0.81.8 finding text contains the full phrases. Numbers below; decision is yours.

## Grounding answers (§2)

1. **`lib/opd-lvc-classify-core.ts`** — matcher v3 confirmed: `matchRule` (was :158; tiebreak `tok === winTokens && … id < winId` — lowest-id ASC), `keywordMatches` (AND across a phrase's tokens, whole-word `\b…\b`), `bestMatchedTokens` (longest matched phrase per rule), `ruleKeywords` (deduped/lowercased), `stampLvcMetadata` (:105 — skips informational + non-low-value; additive, "never touches verdict/confidence/domain"), `classifyLvcFinding` (:179 — stamped rows pass metadata through; older rows fall back to `matchRule`), `matchLvcRule` (:121, backfill entry). One shared implementation ✓ (D4 respected — the edit is in `matchRule` only).
2. **`lib/opd-note-audit.ts`** — `getLvcRules()` at :77: exactly `SELECT id, keywords, category FROM lvc_recommendations WHERE status = 'active'`, 5-min cache (`_lvcRulesCache`, 300_000 ms), 2 s timeout race, fail-safe `[]` ✓. `stampLvcMetadata` called at :376 with `lvcRules` fetched at :360.
3. **`lib/opd-audit-changelog.ts`** — `EngineChange` fields verbatim: `engine: string | null` · `date: string` (YYYY-MM-DD IST) · `scoring: boolean` · `title: string` · `points: string[]` · `why: string` · `plain?: string`. House style: newest-first, `plain` = clinician-facing headline, long concrete `points`.
4. **`app/admin/opd-audit/how-it-works/page.tsx`** — renders the changelog automatically (`OPD_AUDIT_CHANGELOG.map(…)` at :459; versioned filter at :223) ✓; `rule_ref` appears **0 times** in the guide ✓. (Flag: "Choosing Wisely / RAND framing" at :345 — see Deviations.)
5. **Tests** — `lib/__tests__/opd-lvc-classify-core.test.ts` (sole file covering the matcher): 14 tests incl. `'matcher v3: longest matched phrase wins; tie → lowest id'` (encoded the removed tiebreak), `'bare 1-token keyword over-matches under OR'`, `'OR across keywords'`, `'AND within a keyword'`, `stampLvcMetadata`/`classifyLvcFinding`/gate tests.

**Corpus cross-check vs the kickoff's measured facts:** 111 active rules, `category` NULL on all 111 ✓ · 12,222 findings ✓ · 4,678 low-value non-informational ✓ · stored `rule_ref` non-null 4,554 ✓-consistent.

## The change (working tree only, not committed)

`matchRule` v3 → v3.1: track whether ≥2 rules tie at the best token count; `return tied ? null : winner`. Winner-selection otherwise identical (longest matched phrase). No fork — engine stamp, read-time fallback, backfill all flow through it. Not a regression toward v2: OR-across-keywords and the 744-unmatchable fix are untouched (unit tests assert both).

## The seven Stage-1 numbers

Recompute over stored 0.81.8 findings, same rules for both arms. "OLD" = v3 (HEAD snapshot via `git show`), "NEW" = v3.1, "NEW+DATA" = v3.1 + the Stage-2 phrase rewrite of the three coding rules (in-memory preview; no SQL run).

| # | Question | Result |
|---|---|---|
| 1 | Lose attribution → null | **3,536** of 4,576 attributed (77.3%); `ehrc-00d4fe18…`: **all 1,355 → null** (identical with the data fix) |
| 2 | Re-attach to a different rule | **0** — *provably zero by construction for the matcher change*: v3.1 selects the same longest-phrase winner or nulls a tie; it can never promote a different rule. Empirically 0 with the data fix too (wherever a coding rule tied, ≥2 other rules were also in the tie). Top-10 destinations: n/a |
| 3 | Rules completely unmatchable | **40 of 111 structurally unmatchable** (every keyword's token-set duplicated by another rule → every match is a guaranteed tie). Includes all 3 coding rules, `ehrc-a097c781…` (serratiopeptidase), both `unindicated investigation` twins, the safety-netting family, the NSAID-duplication family. Full list in `.corpus-eval/lvc-attribution/dryrun.json → q3`. Empirically 20 rules that held ≥1 attribution now hold 0 |
| 4 | Largest single rule's share | old **29.6%** (`ehrc-00d4fe18…`, 1,355/4,576) → new **13.3%** (`cwus-aace-003` vitamin-D testing, 138/1,040) — **above the ~10% target**, flagged |
| 5 | Invariance proof | **PERFECT.** Fields diffed per finding (all 12,222, fresh-stamp): `subject` 0 · `rationale` 0 · `verdict` 0 · `confidence` 0 · `domain` 0 · `informational` 0 · `signal_type` 0 · `lvc_category` 0 · **`rule_ref` 3,536** (the only differing field). `lvc_category` distribution across all 12 categories byte-identical (antibiotic 632 · imaging 313 · supplement_polypharmacy 641 · therapeutic_duplication 110 · systemic_steroid 45 · gi_ppi_prokinetic 171 · antihistamine_allergy 545 · nsaid_analgesic 178 · cough_cold_fdc 12 · cough_expectorant 69 · unindicated_investigation 343 · other 1,619). Verdict distribution identical (low-value 4,912 · context-dependent 5,614 · uncertain 1,099 · high-value 597). Domain distribution identical (appropriateness 7,427 · prescribing_safety 4,795) |
| 6 | Pre-`0.81.4` read-time change | versions 0.1–0.81.3: **10,736 rows · 9,630 eligible findings · 7,210 would change read-time attribution — all → null**, 0 re-attach. No stored data touched (D4 consequence, display-only) |
| 7 | 20 kept-attribution samples | In `dryrun.json → q7_kept_samples` (subject + rule statement, ≤2 per rule for spread). Ready for V. Includes at least two questionable keeps worth V's eye (e.g. *"Mismatch between presenting complaint and documented diagnoses"* → the bronchitis-antibiotics rule) — exactly what the spot-check is for |

**Attribution-rate summary:** old 4,576/4,678 attributed (97.8%) → new **1,040/4,678 (22.2%)**. The 3,536 nulls are honest per D1 ("null is an acceptable and honest outcome"), but the scale is a corpus-authoring fact the review should see plainly.

## Flags for the review (not deviations from the build — consequences of it)

1. **The serratiopeptidase guarantee fails on this corpus.** D1 promises "a single rule matching **alone** on an uncommon word still wins" — but `serratiopeptidase` appears as a bare keyword in **4 rules** (`ehrc-a097c781…`, `ehrc-70cfc786…`, `ehrc-e83536f4…`, `ehrc-9aa9be1a…`), so every serratiopeptidase finding is a guaranteed tie → null. **39 old attributions → 0.** The mechanism is exactly as settled; the promised example fails on data, not code. Fixing it means deduping/rephrasing those rules' keywords — a data change beyond the three authorized coding rules. Decision needed.
2. **The coding-rule phrase rewrite wins zero findings.** No 0.81.8 finding text contains `diagnosis without coding` (or the two 4-token variants) as whole words. The three rules go from 1,741 combined attributions to 0 either way; the rewrite is still worth doing for future-proofing, but it rescues nothing on this corpus.
3. **Largest-rule share lands at 13.3%,** above the ~10% target — the residual concentration is `cwus-aace-003` (vitamin-D testing), which wins legitimately (sole longest-phrase matches).
4. **Stored vs recomputed-OLD mismatch: 738 findings (15.8%).** Stored `rule_ref`s were stamped against the rules table *as of each audit's run time*; the self-mined corpus has grown since, so recompute-over-current-rules differs. The old-vs-new comparison above holds rules constant (correct isolation), but **Stage 3's re-stamp will therefore change more rows than the tie-nulls alone** — the snapshot (D3) covers this, and the before/after counts in Stage 3 will show it.
5. **Doctor-facing guide accuracy (out of scope, per kickoff §7):** how-it-works :345 says appropriateness findings use *"Choosing Wisely / RAND framing"* — Choosing Wisely was retired in 2023 and the 44 derived rules cite a dead URL. Raised for a separate decision, not fixed here.

## Test movement

`'matcher v3: longest matched phrase wins; tie → lowest id'` → renamed `'matcher v3.1: longest matched phrase wins when it wins alone; any top-specificity tie → null'`. The tie assertion flips `['a-tie']` → `[null]` (the removed behaviour is the defect). Added: a 2-token tie → null (D2 is not 1-token-specific) and a lone-1-token-win (D1 guarantee, corpus caveat above). No test deleted; all other expectations unchanged — notably `'bare 1-token keyword over-matches under OR'` still passes, because a sole matcher still wins under v3.1. Suite 1260/1260.

## Inferred identifiers (verbatim, for validation — §9)

Tables/columns: `lvc_recommendations(id, keywords, category, statement, status)` · `opd_note_audits(id, uid, engine_version, findings)` · findings JSONB fields `subject, rationale, verdict, confidence, domain, informational, signal_type, rule_ref, lvc_category`. Values: `status = 'active'` · `engine_version = 'opd-note-audit/0.81.8'` · pre-0.81.4 versions `opd-note-audit/0.1 … 0.81.3`. Rule ids: `ehrc-00d4fe18-8c9c-4cde-ad1e-4cd2cb02991b` · `ehrc-19d73d33-266b-4b8a-86a5-c35075c0556c` · `ehrc-1f74a581-36e0-40e7-979b-ec52f3efe085` (the kickoff's short forms are prefixes of these). Functions: `matchRule`, `matchLvcRule`, `stampLvcMetadata`, `classifyLvcFinding`, `getLvcRules`, `parseKeywords` (keywords decode: array | JSON string | CSV — mirrored in the dry-run script). Fail-safe honoured: the dry run aborts loudly on 0 rules / 0 rows rather than reporting silent nulls.

## Artifacts

- Dry-run script: `scripts/lvc-attribution-dryrun.mjs` (working tree, uncommitted; `--old` takes the HEAD snapshot of the core so OLD/NEW run side-by-side without a production fork).
- Results: `.corpus-eval/lvc-attribution/dryrun.json` + `dryrun-perfinding.json` (gitignored).
- Working-tree diff: `lib/opd-lvc-classify-core.ts` (matchRule v3.1 + doc comments) · `lib/__tests__/opd-lvc-classify-core.test.ts` (tie expectation).

**STOP.** Stage 2 (commit matcher + data-fix SQL + changelog) and Stage 3 (snapshot + re-stamp) await your go-ahead. The Stage-2 SQL, verbatim, would be:

```sql
UPDATE lvc_recommendations SET keywords = '["diagnosis without coding"]'::jsonb            WHERE id = 'ehrc-00d4fe18-8c9c-4cde-ad1e-4cd2cb02991b';
UPDATE lvc_recommendations SET keywords = '["diagnosis documented without code"]'::jsonb   WHERE id = 'ehrc-19d73d33-266b-4b8a-86a5-c35075c0556c';
UPDATE lvc_recommendations SET keywords = '["diagnosis documented without coding"]'::jsonb WHERE id = 'ehrc-1f74a581-36e0-40e7-979b-ec52f3efe085';
```

*(Keywords-column type is inferred as jsonb from `parseKeywords` accepting arrays; if live Neon shows text, the cast drops to a JSON string literal. Not run.)*
