# Source-Authority — Measure-First Report (M1/M2/M3)

**Spec:** `CDMSS-SOURCE-AUTHORITY-MEASUREMENT-SPEC-20-JUL-2026.md` · **Baseline:** main @ `645bf45` · **Date:** 20 Jul 2026 · **Read-only, zero Vertex, no writes, no activation, no weight edit.**

> **Headline:** All three numbers point the same way — **the bottleneck is availability, not the weight.** Active Tier-A authority is **55 chunks (0.0025% of the corpus)** — `choosing-wisely` only; the USPSTF/JNC/EPR-3 guideline content (**467 chunks**) is quarantined. Across 19 appropriateness scenarios a Tier-A source reached the candidate pool **0 times**, and across 42 persisted runs Tier-A was cited **0 times**. The weight inversion the spec flagged (guideline 0.95 < textbook 1.00) is **real in code but currently moot** — there is almost no Tier-A in the active corpus for it to demote. **Per the spec's decision tree: the fix is activation; the targeted weight becomes measurable (and likely needed) only after.**

---

## Pre-flights §5 (reported before the first commit)

1. **Tier lock — confirmed against real labels.** The active corpus has **no `guidelines`-labelled source at all**; active Tier-A is *entirely* `choosing-wisely` (55 chunks; books `CW-<society>`: National Cancer Grid of India, AAFP, ICMR-AMR, AACE, ACR). USPSTF (NBK37637)/JNC7 (NBK9630)/asthma EPR-3 (NBK7232) exist **only** in `labq:bookshelf` (quarantined). Locked mapping:
   - **A** — `choosing-wisely`, `guidelines`, and `labq:bookshelf` guideline books (EPR-3/JNC/USPSTF). *(Endotext in the same batch → C, not A.)*
   - **B** — `mksap-19`, `textbook` (Tintinalli's EM 9e, Goodman's Neurosurgery), Harrison's/Cecil/Goldman/NMS.
   - **C** — `statpearls`, `uptodate`, medscape, aafp; quarantined Endotext.
   - **D** — `pubmed` (bulk), `europepmc`, `openfda`, unknown.
2. **Scenario set — no new gold, no re-audit.** Reused `appropriateness_runs` `mode ∈ {check, pathway}` real clinical vignettes with `n_sources > 0` (deduped, test rows excluded) → **19 distinct scenarios**. All `de_identified = true` (PHI out).
3. **retrieve() offline + pool inspectable + ₹0.** Two findings, both resolved:
   - The production reranker's default backend is **`judge` → `governedChat({gemini: geminiUtilityModel()})` → Vertex Gemini Flash**, and the free `bge` model is **not** pulled on the mini. So a naive `useReranker:true` would spend Vertex. **Resolution:** the probe deletes `GCP_SA_KEY` (asserts `geminiConfigured() === false`) so the judge reranker runs on **local llama3.1:8b — zero Vertex**; embeddings stay on nomic.
   - retrieve() returns only the trimmed top-K, so to see the pre-trim pool the probe calls `topK:30, useReranker:true, useSourceWeights:false` and re-sorts by `rerank_score × computeSourceQualityWeight` **exactly as retrieve.ts does** — isolating the weight's effect on a single reranked pool (no double-rerank, production pool boundary marked at 24, cited cut at 8).

## M1 — corpus composition by authority tier (SQL, ₹0)

| Tier | Active chunks | % active | Quarantined (`labq:bookshelf`) |
|---|---|---|---|
| **A — appropriateness authority** | **55** | **0.0025%** | **467** (USPSTF 74 + JNC 100 + EPR-3 293) |
| B — board-review textbooks | 21,333 | 0.96% | 0 |
| C — clinical reference | 179,619 | 8.04% | 800 (Endotext) |
| D — primary lit / regulatory | 2,032,808 | 91.0% | 0 |
| **total** | **2,233,815** | | 1,267 |

Active Tier-A is *only* `choosing-wisely` (55). **If active Tier-A ≈ 0, the bottleneck is activation, not the weights** — and it is: 55 of 2.23M.

## M2 — retrieval authority probe (production retrieve(), weights on vs off; local rerank; ₹0)

19 distinct appropriateness scenarios, `topK:8, useReranker:true, hybrid:true`, weight isolated:

| Measure | Value |
|---|---|
| Tier-A in the candidate pool (any of 24) | **0 / 19** |
| Tier-A in cited top-8, weights **OFF** | 0 / 19 |
| Tier-A in cited top-8, weights **ON** | 0 / 19 |
| Tier-A retrievable but **demoted out of top-8 by the weight** | **0** |
| mean (Tier-A rank − Tier-B textbook rank), weights on | n/a (no Tier-A retrieved) |

**A Tier-A source never even entered the pool** on the active corpus. The weight cannot demote what is not retrieved, so on today's corpus the weight's effect on authority is **unmeasurable/moot** — consistent with M1 (55 chunks). *(The weight inversion is real in `source-quality.ts`; it will only bite once guidelines are retrievable — see below.)*

## M3 — authority-cited rate on persisted runs (SQL + label check, ₹0)

| Measure | Value |
|---|---|
| Runs citing ≥1 Tier-A source | **0 / 42** |
| Cited-source tier distribution (all runs) | A **0** · B 60 · C 132 · D 153 |
| Appropriateness/efficiency findings citing Tier-A | **0 / 39** |

Not one persisted appropriateness/pathway run cited a Tier-A authority source — the honest authority-coverage analogue of coverage-deficit, and it is **0%**.

## Gates §4

| Gate | Result |
|---|---|
| Green gate | ✅ typecheck · architecture (8 rules + coverage) · governance (0 ungoverned) · **test 1260/1260** |
| ₹0 / zero Vertex | ✅ SQL + nomic embeddings + **local llama3.1:8b rerank** (`GCP_SA_KEY` deleted, `geminiConfigured()` asserted false); no audit re-run |
| Read-only | ✅ no corpus writes, no `corpusActivate`, no `source-quality.ts` edit |
| PHI out | ✅ scenarios `de_identified=true`; artifact JSON in gitignored `.corpus-eval/` |
| Scoped commit | ✅ probe script only; frozen cores untouched |

## What the numbers decide (spec §3) — HALT for orchestrator/V

The three tiers of evidence agree: **thin active Tier-A (55) + lots quarantined (467) + 0% authority-cited.** This is squarely the spec's first branch:

- **Fix = ACTIVATION.** Turn on the quarantined USPSTF/JNC/EPR-3 (judged by *authority*, not the coverage-deficit thinness that shelved them — that was the wrong lens, as the spec anticipated). This is the necessary first move; "do nothing" is excluded by the 0% authority-cited rate.
- **Targeted weight = a probable, not-yet-proven, follow-up.** M2 shows the weight is *currently* moot, but it does **not** clear the weight post-activation: once the 467 guideline chunks are retrievable they compete with a dense active Tier-B textbook layer (21,333 chunks), and the arithmetic (guideline 0.95 < textbook 1.00, applied after rerank) means a co-retrieved textbook at equal relevance outranks the guideline. **Re-run M2/M3 after activation** — they become non-trivial once Tier-A is retrievable — to decide whether the claim-type-conditional authority weight is also required.
- **Do NOT** global-re-tier (would degrade factual/diagnostic retrieval) and do not change any weight or activate anything in this task.

**Recommendation: activate the quarantined guideline batch, then re-measure M2/M3 to decide on the targeted weight.** No weight changed, nothing activated — HALT for the go.
