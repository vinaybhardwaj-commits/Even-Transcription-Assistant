# Source-Authority — Post-Activation Re-measure (M2/M3 before/after)

**Baseline:** main @ `a5cc2fb` · **Date:** 20 Jul 2026 · **Zero-Vertex** (SQL + local-reranker retrieve, no audit re-run). · **Action taken:** activated the quarantined guideline batch. **No weight changed — HALT for that decision.**

> **Headline:** Activation worked and is clean — the 1,267 guideline chunks are now live, cite with real NBK links, and do **not** disturb non-appropriateness retrieval. But the re-measure shows activation is **necessary and not sufficient**: Tier-A went from *unretrievable* (pool 0/19) to *marginally retrievable* (pool **2/19**), yet still reaches the cited top-8 in **0/19** scenarios. The blocker is **retrieval relevance and guideline breadth, not primarily the weight** — even with weights **off**, guidelines rank 10–15 (below the top-8 cut). This reframes the pre-registered "targeted authority weight" as **necessary-but-insufficient**, not the decisive lever.

---

## Activation (done)

`corpusActivate('bookshelf', 'bookshelf')` — flipped all **1,267** `labq:bookshelf` chunks → real source **`bookshelf`**, 0 left quarantined. *(The single-statement UPDATE tripped Neon's serverless HTTP timeout — updating `source` on 1,267 rows forces 1,267 pgvector-index writes — so it was executed as 13 × 100-row batches, each committing first-try; identical end state.)*

**Citation render (PR1 SL3):** a `bookshelf`/`NBK7232` chunk renders `url = https://www.ncbi.nlm.nih.gov/books/NBK7232/`, labelled "Expert Panel Report 3 … · NBK7232" — live NBK link, **not** mislabelled PMID. ✅

## Before → after

### M1 — corpus composition
| Tier | Active before | Active after |
|---|---|---|
| **A** | 55 (0.0025%) | **522 (0.0234%)** — 467 guidelines + 55 choosing-wisely |
| C | 179,619 | 180,419 (+800 Endotext) |
| quarantined Tier-A | 467 | **0** |

### M2 — retrieval authority probe (19 appropriateness scenarios; weight isolated; local rerank)
| Measure | Before | After |
|---|---|---|
| Tier-A in candidate pool | 0 / 19 | **2 / 19** |
| Tier-A in cited **top-8**, weights OFF | 0 / 19 | **0 / 19** |
| Tier-A in cited **top-8**, weights ON | 0 / 19 | **0 / 19** |
| demoted out of top-8 **by the weight** | 0 | **0** |
| mean (Tier-A rank − Tier-B textbook rank), weights on | n/a | **+11** (guideline ~11 ranks below textbook) |
| aggregate top-8 tier mix, weights ON | — | A 0 · B 22 · C 94 · D 36 |

Both pool hits were pediatric-asthma scenarios matching EPR-3, landing at **rank 14 and 10** (weights on) with a textbook at rank 1. Weighting slightly *raised* the guideline (EPR-3's title contains "Guidelines" → 0.95, above StatPearls 0.90 / journals 0.80) but nowhere near the top-8 cut.

### M3 — authority-cited rate (persisted runs — frozen)
| Measure | Before | After |
|---|---|---|
| runs citing ≥1 Tier-A | 0 / 42 | 0 / 42 |
| appropriateness/efficiency findings citing Tier-A | 0 / 39 | 0 / 39 |

**Unchanged by construction** — persisted `appropriateness_runs` were audited *before* activation, so their frozen `sources[]` cannot retroactively include the new chunks (and "no audit re-run" was a gate). The live forward-looking authority signal is **M2's weights-on top-8 = 0/19**.

### Sanity — non-appropriateness surfaces undisturbed
| Query | bookshelf in top-8, before | after |
|---|---|---|
| CAP empiric antibiotics | 0 | 0 |
| iron-deficiency anemia workup | 0 | 0 |
| ischemic stroke thrombolysis | 0 | 0 |

Top-8 identical (StatPearls/journals) — the 1,267 additive chunks don't crowd unrelated topics. ✅

## Interpretation (the read for the weight decision)

The pre-registered hypothesis was: activate, and semantic relevance carries guidelines into the cited top-K despite the 0.80–0.95 weight. **The data says no, for two structural reasons the weight can't fix:**

1. **Coverage/breadth gap (dominant):** a guideline reached the pool in only **2/19** scenarios. The 4-book seed (asthma / HTN / preventive / endocrine) doesn't cover most appropriateness demand (celiac, DVT, cellulitis, syncope, chest pain…); USPSTF/JNC would cover HTN/screening but none of the 19 scenarios are squarely those. **17/19 have no Tier-A to rank at all.**
2. **Retrieval-relevance gap:** where present, guidelines rank **10–15 even weights-off** — the reranker + bi-encoder favour focused textbook/StatPearls chunks over long-form guideline prose. The weight *compounds* this (+11 ranks vs textbooks) but is not the gate: removing it does **not** put guidelines in the top-8 here.

**Therefore the targeted claim-type authority weight is necessary-but-insufficient.** It can only re-rank Tier-A already in the pool (2/19), and would need a large boost to lift rank ~12 past 8; it cannot address the coverage gap or the relevance gap. The bigger levers are **guideline breadth** (more books covering appropriateness demand) and **guideline chunk retrievability**.

## Gates

| Gate | Result |
|---|---|
| Green gate | ✅ typecheck · architecture · governance · **test 1260/1260** |
| ₹0 / zero-Vertex | ✅ SQL + nomic embeds + local llama3.1:8b rerank; no audit re-run, no Pro/Flash |
| Read-only except the authorised activation | ✅ no `source-quality.ts` edit, no weight change; only commit is the probe's tierOf |
| Reversible | ✅ re-quarantine flip: `UPDATE mksap_chunks SET source='labq:bookshelf' WHERE source='bookshelf'` (non-destructive). *Note: `corpusDelete('bookshelf')` as written targets `labq:`/`lab:` sources, not the bare `bookshelf` real source — bare-name deletion is intentionally not wired, since it would footgun real sources like `statpearls`.* |
| Scoped commit; frozen cores untouched | ✅ `b7dd3db` |

## HALT — decision for the orchestrator/V

Activation is **done and net-positive-additive** (guidelines now retrievable + citeable where relevant; zero disturbance elsewhere; no regression → keep activated). But the re-measure shows the **authority-in-top-8 rate is still 0/19**, and the pre-registered targeted weight would move only the 2/19 where a guideline is even poolable. **No weight changed.** The decision — targeted authority weight, guideline-breadth expansion (PR2+ connectors targeting appropriateness demand), guideline-chunk retrieval treatment, or some combination — is yours, now on real before/after numbers.
