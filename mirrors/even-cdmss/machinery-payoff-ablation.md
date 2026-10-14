# Machinery-Payoff Retrieval Ablation — IPD, 25 gold cases (measured, NOT a gate decision)

> **Study only.** No engine/prompt/gold/route/migration/prod-write. The three arms are produced ONLY through the `AnalyzeDeps` seam (`deps.retrieveHits`/`deps.enrichHits`); `analyzeCase` is byte-unchanged. Bench: the **25 frozen gold cases** (`ipd-audit-gold/2.0`, hash-pinned loader), **K=1** per arm, scored with the shipped **S4.1 semantic matcher** (`scripts/ipd-s4-theme-rescore.mjs` run verbatim per arm). Model, prompts, temperature, env held constant across arms.

> **Read the distribution as the primary result.** At n=25 nearly every mean delta is a statistical tie; that is expected, not a failure. This study is **hypothesis-generating, not conclusive.** The gate decision is the orchestrator's.

> **Cohort provenance.** This runs the **25 gold cases**, not the "paired-60" the original spec named: recall/precision-vs-gold is only defined where gold themes exist, and the paired-60 (a citation-support cohort) intersects gold/2.0 in **only 3 cases** — so an n=60 recall/precision study would need a scorer the study forbids. Confirmed by the orchestrator (Option 1). Citation-support was also unusable here because arm A produces zero citations, so it could only ever compare B vs C, never answer "does retrieval help".

**Config (constant across arms):** analyze model `gemini-2.5-pro`, extract model `gemini-2.5-pro`, `DOC_AUDIT_CITE_GATE=1` · `DOC_AUDIT_AUDIT=1` · `PROGNOSIS_AUDIT=0`. Cases scored in all three arms (paired set): **25/25**.

## 1. Per-arm results (accuracy measure = material recall vs gold/2.0)

| Arm | Retrieval | Material recall | Precision | Findings/doc | ev / est / ∅ | Sources/doc | ₹/doc | IIE vs A |
|---|---|---|---|---|---|---|---|---|
| **A** | none | 0.42 | 0.88 | 5.56 | 0 / 4.52 / 1.04 | 0 | ₹16.15 | — |
| **B** | current (defaults) | 0.34 | 0.87 | 5.44 | 4.04 / 1.04 / 0.36 | 19 | ₹23.08 | -0.012 |
| **C** | pooled only | 0.35 | 0.80 | 5.76 | 3 / 2.32 / 0.44 | 8 | ₹21.13 | -0.0145 |

IIE = (recall_arm − recall_A) / (₹/doc_arm − ₹/doc_A). Accuracy measure named inline: **material recall** (no MCQ accuracy exists for this task).

## 2. Paired deltas with 95% CI (bootstrap, 25 paired cases, 10k resamples)

A delta whose CI crosses zero is a **TIE** — reported as such, not as a bare point difference.

| Delta | Recall | Precision |
|---|---|---|
| B − A (retrieval on) | -0.084 [-0.146, -0.020] | -0.007 [-0.112, 0.100] — TIE |
| C − A (pooled vs none) | -0.072 [-0.142, -0.004] | -0.075 [-0.182, 0.031] — TIE |
| B − C (enrichment payoff) | -0.011 [-0.067, 0.043] — TIE | +0.068 [-0.016, 0.156] — TIE |

Cost/doc deltas: B−A ₹6.93 · C−A ₹4.98 · B−C ₹1.95.

## 3. Per-case win/loss on material recall (the decision-critical output)

Sole wins: **A 8 · B 4 · C 4** · all-tie 1/25. Part-of-a-tie: A 8 · B 5 · C 6.

Pairwise recall (win/tie/loss): **B vs A** {"win":6,"tie":5,"loss":14} · **C vs A** {"win":5,"tie":9,"loss":11} · **B vs C** {"win":9,"tie":8,"loss":8}.

| Case | Speciality | A recall | B recall | C recall | Winner(s) |
|---|---|---|---|---|---|
| IPD-G-01 | Ear Nose and Throat | 0.27 | 0.36 | 0.27 | B |
| IPD-G-02 | Ear Nose and Throat | 0.50 | 0.50 | 0.38 | A=B |
| IPD-G-03 | Emergency Medicine | 0.40 | 0.20 | 0.40 | A=C |
| IPD-G-04 | Emergency Medicine | 0.50 | 0.25 | 0.25 | A |
| IPD-G-05 | Emergency Medicine | 0.67 | 0.33 | 0.17 | A |
| IPD-G-06 | General Surgery | 0.50 | 0.38 | 0.25 | A |
| IPD-G-07 | General Surgery | 0.40 | 0.30 | 0.50 | C |
| IPD-G-08 | General Surgery | 0.33 | 0.44 | 0.33 | B |
| IPD-G-09 | General Surgery | 0.56 | 0.22 | 0.22 | A |
| IPD-G-10 | General Surgery | 0.33 | 0.25 | 0.33 | A=C |
| IPD-G-11 | General Surgery | 0.33 | 0.44 | 0.44 | B=C |
| IPD-G-12 | General Surgery | 0.20 | 0.30 | 0.20 | B |
| IPD-G-13 | General Surgery | 0.38 | 0.38 | 0.50 | C |
| IPD-G-14 | General Surgery | 0.56 | 0.33 | 0.33 | A |
| IPD-G-15 | Internal Medicine | 0.50 | 0.33 | 0.67 | C |
| IPD-G-16 | Internal Medicine | 0.57 | 0.57 | 0.43 | A=B |
| IPD-G-17 | Obstetrics and gynecology | 0.50 | 0.25 | 0.25 | A |
| IPD-G-18 | Obstetrics and gynecology | 0.15 | 0.31 | 0.46 | C |
| IPD-G-19 | Orthopedics | 0.20 | 0.20 | 0.20 | A=B=C |
| IPD-G-20 | Orthopedics | 0.43 | 0.43 | 0.29 | A=B |
| IPD-G-21 | Orthopedics | 0.44 | 0.33 | 0.33 | A |
| IPD-G-22 | Pediatrics | 0.40 | 0.20 | 0.40 | A=C |
| IPD-G-23 | Pediatrics | 0.43 | 0.14 | 0.14 | A |
| IPD-G-24 | Urology | 0.56 | 0.33 | 0.56 | A=C |
| IPD-G-25 | Urology | 0.50 | 0.75 | 0.50 | B |

## 4. Provider / model routing (per arm — identical by construction)

- **A**: analyze `gemini-2.5-pro` (Vertex Gemini), cite-gate critic `gemini-2.5-flash` (Flash), extract `gemini-2.5-pro`.
- **B**: analyze `gemini-2.5-pro` (Vertex Gemini), cite-gate critic `gemini-2.5-flash` (Flash), extract `gemini-2.5-pro`.
- **C**: analyze `gemini-2.5-pro` (Vertex Gemini), cite-gate critic `gemini-2.5-flash` (Flash), extract `gemini-2.5-pro`.

## 5. Notes

- Arm A produces findings with **no citations** (no retrieval), so its cite-or-label split is estimate/∅ only — recall/precision are still defined because the S4.1 matcher scores finding **subjects** against gold themes, independent of citations. This is why the gold-recall study (not citation-support) is the one that can answer "does retrieval help".
- Not counted in any arm (equally understated everywhere): the idealised-pathway Flash skeleton (`lib/doc-audit.ts`, untraced upstream) and utility passes. All arms share it.
- Extract is shared across arms (retrieval only affects analyze); extract ₹ is identical in every arm's ₹/doc.
