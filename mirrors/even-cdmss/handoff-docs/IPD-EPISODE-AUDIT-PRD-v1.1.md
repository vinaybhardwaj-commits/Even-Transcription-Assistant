# IPD Episode Audit — PRD v1.1 (2026-09-02)

**Status:** SPEC. All design decisions settled with V on 2026-09-01 and 2026-09-02. Zero open design issues. All grounding paths resolved. Ready for kickoff (§15).
**Supersedes:** `IPD-EPISODE-AUDIT-PRD-v1.0.md` in full. Where the two conflict, this document wins.
**Repository:** `github.com/vinaybhardwaj-commits/Even-CDMSS`. Next.js 15 App Router, npm, `node:test`, Vercel (bom1). **Branch `ipd-episode-audit` off `main`** (decision 31). The gate is the CI sequence in §14.
**Companions (REQUIRED reading for the builder):**
- `handoff-docs/EVEN-DB-REFERENCE-2026-09-01.md` — measured schema reference.
- `handoff-docs/EVEN-DB-REFERENCE-ADDENDUM-2026-09-02.md` — corrections measured on 2026-09-02. Where the addendum conflicts with the reference, the addendum wins.

---

## 0. Why

The IPD Audit section grades one discharge summary at a time. A discharge summary is written after the fact. It can be internally coherent and still be a poor account of the admission. The current engine cannot tell, because it never sees the rest of the stay.

The rest of the stay is in database 13. Measured on 2026-09-02 with exact joins: 1,349 admissions, 797 closed, 446 closed with progress notes. Of those 446, 411 have lab orders, 445 have billing rows, and 338 have a stored discharge extraction. Length of stay is short: 25 episodes at 0 days, 135 at 1 day, 218 at 2 to 3 days, 61 at 4 to 7 days, 7 at 8 to 14 days.

This PRD specifies a second IPD engine. It assembles the whole episode, builds a blinded expectation of how the admission should have run at each day boundary, compares real against expected, and reports where the real course left the expected one.

---

## 1. Decisions log

### 1.1 Settled with V on 2026-09-01 (v1.0, carried forward)

1. **Daily checkpoint regeneration.** An expected next-24-hours course at each day boundary, from everything known before that boundary.
2. **Two-pass scoring: blinded scores plus unblinded commentary.** Scores are produced with the outcome withheld. Commentary is produced with the outcome visible and never touches a number.
3. **Discharged episodes only.** Live episodes are out of scope.
4. **Single build through to the UI.** Mitigated by decision 12.
5. **Amazon Bedrock.** Haiku for checkpoints. Opus for diff, fidelity, and commentary. Model ids from environment variables.
6. **Checkpoint budget: daily for the first 7 days, then one episode-level checkpoint.** Refined in decision 24.
7. **Both score sets, computed independently.** Changed by decision 14. See there.
8. **Commentary is stored and shown on drill-in only**, behind a visible outcome-aware label.
9. **New tables, not an extension of `ipd_discharge_audits`.** (orchestrator)
10. **Findings carry an evidence tier and an `unassessable` verdict.** (orchestrator)
11. **Author attribution is two-layer.** (orchestrator)
12. **Ships behind `IPD_EPISODE_AUDIT_ENABLED`, default off.** The flag stays off until V reviews 20 episodes.

### 1.2 Settled with V on 2026-09-02 (v1.1)

13. **Discharge summary source: require an existing extraction.** An episode qualifies only when `discharge_extracted_cases` holds a row for its `ip_uid`. The new engine does not fetch PDFs and does not call Gemini. The nightly discharge worker grows the cohort. Reason: the summary is a PDF, and the extraction already exists for 338 of 446 candidate episodes.
14. **`care_value_index` is not computed by the episode engine.** The episode audit stores the divergence score set only. The UI shows the sibling `ipd-discharge-audit/0.2` score, joined on `ip_uid`, labeled as the discharge engine's score. Reason: `computeScorecard` needs findings in the discharge engine's shape, which the episode findings do not have. Decision 7's intent, two independent scores, is met by two independent engines.
15. **Blinding: two Opus passes.** Pass A1 scores divergence with no discharge summary at all. Pass A2 runs the fidelity check with the full extracted summary. V chose this over field-level withholding.
16. **Fidelity findings count in `divergence_index`.** A1 and A2 findings share one penalty. V chose this over a separate `fidelity_index`. Recorded trade-off: A2 findings are written with the outcome visible, so the headline score is not fully outcome-blind. The UI labels A2 findings as fidelity findings so a reader can subtract them.
17. **Drop the `kx_medicine_items` join.** Order events carry `ordered_item_name` and `service_type`. No category field. Reason: the join resolves 1.9 percent of blank pharmacy categories.
18. **Citations by retrieval per checkpoint.** Before each checkpoint, call the existing `retrieve()` with a query built per §3.3.2, top 8 chunks. `citation_ids` are `mksap_chunks` ids.
19. **Worker route, no cron in v1.** A route mirroring `app/api/ipd-audit/worker`. No `vercel.json` change. The orchestrator triggers it by hand for the validation run. A cron entry is a separate commit after V's clinical gate.
20. **Skip records live in a new table `ipd_episode_skips`.** Retried each tick until 14 days after discharge.

### 1.3 Orchestrator decisions on 2026-09-02 (design authority, recorded for audit)

21. **Never rewrite an id prefix.** `IPNO-n` and `IP-n` are different patients in 585 of 585 tested cases. Every join is exact on `encounter_id`. This is a hard constraint and a source-read test (§13 item 12).
22. **Closure comes from `kx_discharge_summary_records`.** `kx_ip_admissions` has no discharge column. Join `d.ipd_no = a.encounter_id`. `discharge_date_time` and `discharge_type` come from that row.
23. **No `uhid` hash.** The repo never hashes. PHI stays in database 13 and is joined at render time. The new tables store `encounter_id`, `ip_uid`, and `member_id` only, like `ipd_discharge_audits`.
24. **Checkpoint budget refined.** Daily checkpoints for `day_index` 0 to `min(los_days, 6)` inclusive, plus one episode-level checkpoint. LOS 0 gets one daily. LOS 1 gets two. LOS 6 or more gets seven. Reason: 78 percent of episodes close within 3 days, so the day 1 and day 2 checkpoints carry most of the signal.
25. **Episode-level checkpoint input.** All events except the discharge event. It predicts the remaining course and disposition from the last documented moment.
26. **`los_days = floor(hours between admission_date_time and discharge_date_time / 24)`.**
27. **Engine version `ipd-episode-audit/0.1`.**
28. **Prompt-size control.** Pharmacy billing rows roll up to one event per (day, `ordered_item_name`) with a count. Other billing rows stay one per row, capped at 60 per day by `order_date_time`, with a truncation note. Labs are one event per `order_no`.
29. **Progress notes are read by a new reader**, not by `fetchProgressNotes` in `lib/readmission/db13.ts`. That reader orders by `created_at`, which matches the clinical time in 20 percent of rows, and does not select the author fields.
30. **Note text passes through the repo's existing de-identifier** before it reaches an event summary or a prompt.

### 1.5 Decision 33 — omission is a database question (V, 2026-09-02, after fix round 6)

33. **Whether an expected action happened is decided by CODE, not by the model.** The checkpoint model proposes what to expect, emits a machine-checkable `matcher` and a `proposed_severity` for each expectation while it is still blinded, and reasons about what it cannot check. A deterministic resolver (`lib/ipd-episode/resolve-core.ts`) then answers whether it happened, by lookup against the assembled event list.

**The evidence for the change.** Three runs of IP-1286 on byte-identical checkpoints (`md5(expected_course)`, `md5(retrieval_query)`, `md5(citation_ids)` each `distinct = 1`) produced `divergence_index` 96, 100 and 80. Across those runs **zero** findings had an empty `evidence_basis` and **zero** rested on a Tier C source, yet the judge emitted 0, 12 and 11 `unassessable` verdicts, ten of them citing Tier A. The Haiku layer was reproducible; the entire spread sat in the Opus diff pass, on a question that is not a judgement.

**The four resolutions**, recorded on every resolver finding in a new `resolution` field, together with the matcher that decided it:

| resolution | condition | verdict |
|---|---|---|
| `present` | a matching event exists at or after the entry's `by_day` | `concordant` |
| `absent_class_present` | no match, and the data class IS represented in this episode | `divergent`, at the severity proposed at generation |
| `absent_class_missing` | no match, and the class is not represented at all | `unassessable` — **the only path that may produce it** |
| `ambiguous_confounded` | the class exists but cannot settle this question | `context_dependent` |

`vitals` and `imaging` are never represented: neither is in the KX mirror (reference §1.7 — "treat radiology as unavailable"; the Even-native `chart_*` layer's encounter namespace does not join). Confounds are enumerated in code — a bundled billing line can hide a dispensed drug, a panel order can contain an analyte without naming it, an operative step inside a recorded procedure is not separately billed.

**Consequences.** §3.4's diff pass no longer emits `omission` findings; it keeps `commission`, `timing` and `sequencing`, and the appropriateness judgement on those. §3.5's fidelity pass is unchanged. §4.2 is additionally enforced as a postcondition in the other direction (§4.2a below), and is exempted for resolver findings, since an absence has nothing to cite by definition.

### 1.6 Decision 35 — commentary leaves the pipeline (V, 2026-09-03, after fix round 11)

**Amends decision 2.** Pass B no longer runs as stage 6 of the audit. The pipeline ENDS at the fidelity pass; the audit row is written with `commentary` NULL; pass B runs **on demand**, the first time an episode's detail page is opened, and caches to the `commentary` column.

**The evidence for the change.** On IPNO-416 pass B cost **107 s of a 314 s run** — 57.5 s plus a 49.4 s retry — and produced nothing: both attempts were rejected. It had also failed on the preceding episode. It is the only pass whose output does not enter the score, and the only one that is read exclusively on drill-in. A third of the audit's wall clock was being spent, on every episode in a 446-episode cohort, generating prose that most episodes will never have read.

**What this decision does NOT change.** Pass B is still the outcome-aware pass (§3.6) and still the only one that may read how the admission ended. Its validation rules from decision 2 are unchanged: **no scores, no verdicts, no new findings** — every annotation is checked against the stored finding ids and a commentary that invents one is refused whole.

**The properties the on-demand path must have:**

| property | where it is enforced |
|---|---|
| a NULL commentary is never a failure and never blocks scoring | the audit row is written complete without it; nothing reads `commentary` to decide `scoring_status` |
| idempotent | an existing commentary never reaches the model, **and** the write is `WHERE commentary IS NULL`, so two simultaneous first opens cannot produce two commentaries |
| admin-gated | `ADMIN_TOKEN` or an admin session, as every other admin route here |
| never fatal | a failed generation is a 200 with `commentary: null` and a reason, not an error page |
| the outcome-aware label (§10 item 5) is shown verbatim | above the block in **every** state — generating, generated and failed |

**One input had to be persisted.** Pass B runs long after assembly has exited, and `admission_context` was the only input it needed that was built during assembly and never stored. It is now a column on `ipd_episode_audits`. A row audited before this decision has none, and the route says so plainly rather than reaching back into db13 to reconstruct one.

### 1.7 Resolver findings are grouped, never truncated (round 12 item 2, V's instruction 2026-09-03)

*Not numbered as a decision: V gave this as a round-12 item, not as a numbered decision, and I am not going to assign one on V's behalf.*

IPNO-416 produced **112 findings, 79 of them from the resolver** — 71%. `MAX_FINDINGS_PER_PASS = 30` caps the two model passes and neither reached it, so the cap did not bind where the volume was. The resolver is deterministic code: capping it by truncation would drop real findings silently, which is the one thing a deterministic layer must never do.

Instead, **one finding per expectation CLASS**. A daily checkpoint re-states the same standing expectation every day; those members collapse into a single finding that states how often it recurred, and every member stays addressable on `grouped_refs` / `grouped_days`. **Nothing is discarded.**

The grouping key is `section | matcher (kind + lowercased, de-duplicated, sorted terms) | resolution | verdict`, with an entry that carries no matcher falling back to its normalised item text. `resolution` and `verdict` are in the key deliberately: a matcher-only key would merge a day the thing happened into a group saying it did not, the moment the resolver becomes day-aware — concordant-erasure, which this engine has already had to fix once.

Both counts are stored, `n_resolver_grouped` and `n_resolver_ungrouped`. Reporting only the first hides the collapse; reporting only the second describes an episode nobody is shown.

### 1.8 Round 13 — the budget, the ladder, and the digest (V's instruction 2026-09-04)

*Not numbered as decisions, on the round-12 precedent: V gave these as round items and I am not
going to assign decision numbers on V's behalf.*

**The failure.** IP-1483 (LOS 7, 8 checkpoints) ran the diff pass three times, each ending
`bedrock TIMEOUT after 110000ms (attempt 3/3)` at ~332 s, and the third began at +763.7 s inside an
`maxDuration` of 800. The invocation was killed with **no audit row and no skip row** — the same
class of loss as round 11's `::jsonb` cast, reached from a different direction.

**Item 1 — a wall-clock deadline reaches the model calls.** The worker derives `deadlineAt` from
its own `maxDuration` less a 40 s persist reserve and threads it to every call. `callModel` refuses
to begin a call when less than one worst case remains, and the refusal is a returned `error`, so
the episode lands as a recorded `diff_failed` skip (§8) rather than a dead invocation. The worst
case is **derived** — `totalBudgetMs('bedrock', 'utility')` = 332,250 ms — never typed here; IP-1483
measured 332,735 ms and 331,818 ms on consecutive attempts, so the derivation is the observed
number. The deadline and the budget remaining at each attempt are recorded on `stage_timings`.

**Item 2 — the nested ladder is gone.** `governedChat` already runs the provider ladder; this
engine wrapped it in `TRANSPORT_ATTEMPTS = 3`, making nine provider attempts of a call that can
cost 332 s each. `TRANSPORT_ATTEMPTS` is now **1**. The reasoning this file already applied to
truncation applies unchanged to a timeout: a retry at the same size gets the same timeout.

**Item 3 — the diff pass reads a digest, not the courses.** Since decision 33 A1 emits no
omissions, so it does not need matchers, rationales, proposed severities or citation ordinals. It
receives item text, deduplicated across checkpoints, grouped by category, with the earliest
`by_day`. **One field is kept beyond "item text only": the entry ref**, because §3.4 requires
`checkpoint_ref` non-null, the uncited cap resolves that ref against `entryRefs`, and citation
inheritance (round 11 item 8) uses the same lookup — a digest line with no ref would break all
three. The representative ref is the earliest member that carries citations, and only the earliest
outright when no member carries any, so grouping cannot discard evidence that exists.
`diff_prompt_chars` and `digest_entries` are stored.

**MEASURED ON IP-1483, and it is smaller than it looks.** The expectations block fell 50,887 →
20,485 chars (−60%), but the whole prompt fell only 246,859 → ~216,486 (−12.3%), because **the
real course is 90.4% of what remains**. Deduplication barely fired: 125 entries collapsed to 123
distinct, since the checkpoint model states the same expectation in different words each day
("Serum creatinine and electrolytes (K, Na) to assess…" vs "Renal function test (creatinine, urea,
electrolytes…)"). That is the same defect V raises for resolver grouping in round 14 item 4, and
the digest will inherit whatever subject-level key that builds.

**WHAT STILL BINDS, stated rather than raised.** The diff call is classified `utility` —
110 s per attempt, the class `lib/bedrock.ts` documents as "a short bounded call (critic,
classifier, expansion). Seconds." IPNO-416's diff took **212,402 ms** and succeeded only because a
first attempt timed out and a second came in under the ceiling. The driver is generation time
against `max_tokens: 16000` (416 emitted 18,829 chars), not input size, so no amount of prompt
shaping reaches it. `PROVIDER_BUDGETS.bedrock` already carries `audit_ipd` (200 s × 1) and `audit`
(380 s × 1), and `bedrock.ts` says "an audit-class caller passes its own". This engine has never
passed one. **Nothing was raised — this is the flag V's instruction asked for.**

### 1.9 Round 14 — eleven items (V, 2026-09-04)

*Items, not numbered decisions, on the round-12 precedent — except item 10, which V framed as an
amendment to earlier decisions and is recorded as one below.*

| # | Change |
|---|---|
| 1 | **Billing records dispensing, not administration.** The diff prompt now says so at length; a same-timestamp batch is rendered as ONE POSTING rather than a flat list of drug names; and a `commission` finding whose evidence is billing-only, on a day the notes do not corroborate, is capped at `minor` **with the caveat written into its statement**. Corroboration is deliberately weak — any note that day — because "does the note support this" is a judgement and this layer refuses to make judgements. |
| 2 | **Class presence is day-scoped.** `classIsRepresented` takes the expectation's own window. Where the class is silent in that window, "not done" and "not recorded" are indistinguishable and the verdict is `unassessable`. What day-scoping would have swallowed is raised directly instead: `missingDischargeDayNote` reports **no progress note on the discharge day** as a Tier A `major` documentation finding. A handover does not count; a LOS-0 stay raises nothing. |
| 3 | **Matching respects the expectation's day.** The old day test was an `if` with an **empty body** — `byDay` reached the function and did nothing, so every "present" statement read day 0. The window now opens on the day the expectation was FORMED. `by_day` stays a statement about lateness, which is a `timing` question, not an eligibility test. |
| 4 | **Grouping on the subject, not the term list.** Purpose clauses, qualifiers and parentheticals are cut; what remains is canonicalised to concepts. An escalation entry groups on its trigger, not the action it routes to. **Measured on IPNO-416: 79 expectation entries → 45 classes (was 68), and the round-13 digest 79 → 43 (was 67).** The six stent findings become two. |
| 5 | **Clinical shorthand, expanded before any negative is asserted.** Every expansion was read off the real notes, not recalled — `C/S/B` resolved as *Case Seen By* from its own context. Additive and whole-token only. |
| 6 | **Panels that contain the analyte resolve it PRESENT and name the panel.** A KFT covers creatinine, urea and electrolytes; a CBC explains nothing about them. Only a panel this table cannot enumerate remains a confound, and it names what it might be hiding. |
| 7 | **`retrieval_offtopic` fires.** Two changes: each excerpt is judged on its TITLE (a 1,100-character body borrows the query's own vocabulary — which is why paediatric oncology in an adult nephrology case counted as on-topic), and the threshold is a QUARTER, not a majority. Four of eight had reported `false` on every checkpoint of IPNO-416. |
| 8 | **The retrieval query is the accumulated problem list.** Day 3's note read, in full, "Follow-up visit Clinicaly better. Euvolemic Blood pressure stable. Urine output adequate" — so the query kept only the OT surgery name, retrieval returned eight stent documents, and the checkpoint expected stent monitoring six times. Notes are now walked most-recent-backward under a shared character budget. |
| 9 | **A field whose NAME says it holds a person never enters the note summary.** `ot_asst` held a theatre assistant's full name in a row marked `de_identified = TRUE` (the name is not reproduced here — this repository is public). Matched on the field name, not the value — the lesson from the retrieval whitelist directly above it: a value-based rule can only remove the names someone has already seen. Attribution is unaffected; it reads real columns. |
| 11 | **The engine declares itself audit-class.** See §1.10. |

### 1.10 Decision 36 — the severity cap, narrowed (V, 2026-09-03; amends round 6 item 1 and round 4 item 8)

On IPNO-416 **all 58 major findings were capped** — 19 by the uncited-expectation rule, 39 by the
literature-only rule, stacked on one ceiling. With the 8-point term unreachable, `divergence_index`
degenerates to 100 − 4 × (divergent count): severity stops carrying information and any duplication
defect maps one-for-one onto the headline number.

And the caps bit hardest on the best findings. *No stent assessment in any of seven progress notes*
and *no note at all on the discharge day* rest on the record and cite no guideline, because none is
needed to observe that a note is missing.

**A finding keeps its blinded proposed severity, `major` included, if it has EITHER at least one
citation (literature counts) OR corroborating Tier A evidence in `evidence_basis`.** Only a finding
with neither is capped to `moderate`. `citation_provenance` is still classified and counted, so
"how much of this score rests on guidelines" stays answerable; it simply no longer silences
anything. `severity_before_cap`, `capped` and `capped_count` are unchanged.

**Recomputed on IPNO-416's stored findings: `capped_count` 58 → 10, `divergence_index` 48 → 20,**
with the 13 divergent findings now 7 major + 6 moderate rather than almost all moderate.

### 1.11 Decision 37 — the call class, and the guard that was too eager (V, 2026-09-03/04)

The three Opus passes declare `PROVIDER_BUDGETS.bedrock.audit` (380 s, one attempt). This is a
**misclassification fix, not a new ceiling**: the engine passed no class, so `bedrockGenerate`
defaulted it to `utility` — 110 s, the class documented as "a short bounded call (critic,
classifier, expansion). Seconds." `lib/bedrock.ts` already said an audit-class caller passes its
own; this one never did.

**Checkpoints stay `utility`.** They generate in 15–35 s (IP-1483's slowest, 40.2 s), so 110 s is
~3× their worst observed time and three cheap retries are the right posture for a short call.
Moving them to 380 s × 1 would trade three chances at a 35 s call for one.

**`audit`, not `audit_ipd`.** 200 s is below IPNO-416's measured 212,402 ms diff, so `audit_ipd`
would still have failed the one episode that passed; and `audit_ipd` is sized against the sibling
IPD analyze (`IPD_ANALYZE_LEGS`), so sharing it would couple this engine's ceiling to changes made
for the discharge engine's reasons.

**AND THIS CORRECTED ROUND 13.** The round-13 guard refused whenever a whole class worst case did
not fit — which had already broken the commentary route: its box is 300 s, one `utility` call's
worst case is 332 s, so pass B would have been refused on **every** episode. The guarantee that
matters is that a call cannot outlive the box, and that is better kept by BOUNDING the call to the
time available than by declining to make it. `planAttempt` now shrinks to fit, with one attempt
ceilinged at what remains, and refuses only below a 60 s viability floor — where a judge pass on a
150–200 KB prompt has no realistic chance.

### 1.12 Decision 38 — the divergence index is a RATE (V, 2026-09-03; amends §6.1 and decision 9)

`divergence_index = round(100 − 100 × penalty / (8 × expectations_evaluated))`, floored at 0.
`penalty` is unchanged: 8·major + 4·moderate + 1·minor over `divergent` findings from both passes.

**Why.** IP-1483 (LOS 7, penalty 113) and IPNO-495 (LOS 11, penalty 198) both floored at 0 under
the old total and reported the same band — a 76% difference in absolute penalty rendered as one
indistinguishable number. Every stay of about a week or more was going to read identically, so the
longer the admission the less the score could say about it.

**THE DENOMINATOR: findings with a verdict other than `unassessable`.** V named
`expectations_evaluated` and invited a different choice with reasoning; this is that reasoning.

- *Not the ungrouped expectation entries.* Round 12 collapses a standing expectation restated on six
  days into one finding. Counting the six divides by work the episode did not do and flatters every
  long stay — the defect this decision exists to remove.
- *Not the resolver's classes alone.* Penalty also comes from the diff and fidelity passes, and a
  fidelity finding is measured against the record rather than an expectation. A denominator smaller
  than the population generating the numerator is not a rate.
- *Not every finding.* An `unassessable` finding is one the pipeline COULD NOT measure. Counting
  those pays an episode for the questions it failed to answer and rewards a thin record — the
  "confident 100" failure `scoring_status` exists to prevent.

**The rate is bounded by construction**: penalty accrues only on `divergent` findings, at most 8
each, and every divergent finding is assessable — so `penalty ≤ 8 × expectations_evaluated` and the
index cannot leave 0…100. The floor is now a belt on a fastened belt.

**`penalty_total` and `expectations_evaluated` are stored and shown beside the band**, with
`n_divergent`. The rate bands the episode; the counts say how much there is to read.

### 1.13 Decision 37 — the bands, settled (V, 2026-09-03)

| band | rate | meaning |
|---|---|---|
| no divergence found | ≥ 95 | under a twentieth of expectations diverged |
| minor divergence | 88–94 | up to about a tenth |
| moderate divergence | 80–87 | up to a fifth |
| substantial divergence | < 80 | more than a fifth |

The old 90 / 70 / 45 were set against a TOTAL, where 45 meant "55 penalty points" and any episode
with seven major findings could reach it. Against a rate the same numbers mean something else
entirely: 45 would require 55% of every expectation evaluated to have diverged at major severity,
which no real admission will do. Left unchanged, `substantial divergence` would have become
unreachable — the mirror image of the defect decision 38 exists to fix.

**ANCHORED TO WHAT A PROPORTION MEANS, NOT FITTED TO THE FIVE EPISODES MEASURED.** Five cases
cannot support a fitted scale, and fitting one would repeat the error the band itself was
introduced to avoid — reading a precision into the instrument that it does not have. Each boundary
is a plain fraction of the worst an episode could have scored, and should be argued in those terms
or not at all.

The one number the data did settle is the top boundary. It was proposed at 97 and moved to 95
because **nothing measured reached 97**: the best of the five (IPNO-416) sat at 92, so a 97
threshold would have made `no divergence found` as unreachable as `substantial` had been. 95 leaves
a genuinely clean admission somewhere to land.

**IP-1286 sits at 79 — one point inside `substantial` — with `band_uncertain` true. That is the
mechanism working, not a boundary to tune away.** Its penalty is 95 across 56 evaluated
expectations, and the measured repeat spread of 5 penalty points moves it to 80, across the line.
The flag exists to say exactly that; moving the threshold to quiet it would replace a reported
uncertainty with a hidden one.

Settling `minor` at 88 also made 87 a near-boundary value, so IP-1313 and IP-1483 (both 87) join
IP-1286 as `band_uncertain`. Three of five read as near-boundary. The band NAMES are unchanged for
all five under either threshold set; only the honesty flag moved.

**The five, as stored on 2026-09-04:**

| | LOS | index | band | uncertain | penalty | evaluated | divergent |
|---|--|--|---|--|--|--|--|
| IPNO-416 | 3 | 92 | minor | – | 48 | 72 | 7 |
| IP-1313 | 0 | 87 | moderate | yes | 34 | 33 | 9 |
| IP-1483 | 7 | 87 | moderate | yes | 110 | 109 | 18 |
| IP-1286 | 2 | 79 | substantial | yes | 95 | 56 | 19 |
| IPNO-495 | 11 | 75 | substantial | – | 237 | 119 | 38 |

⚠️ Those rows were written under the PROVISIONAL 97 / 90 / 80. Bands are identical under the
settled thresholds; `band_uncertain` for IP-1313 and IP-1483 is stored `false` and would be `true`
if recomputed. `band_uncertain` is a derived column — a pure function of the stored index, penalty
and denominator — so it can be refreshed without running a model. Left as stored, and flagged,
rather than written to on no instruction.

### 1.13a The `band_uncertain` copy carries no number

The UI said "±5 repeat-run spread" and "within 5 points of a band threshold". Both were measured in
PENALTY points on a 51-expectation episode — about 1.2 index points there, less on a longer stay —
so quoting ±5 against the rate overstated the noise roughly fourfold, and any single figure is
wrong for every episode but one. The copy now states the test itself: *this episode's own penalty,
moved by the measured spread, would put it in a different band*, and says why it is computed per
episode. A source-read test forbids a fixed index window in either surface.

**And the repeat spread keeps the units it was measured in.** IP-1286's five runs spread 5 PENALTY
points. As a rate that is 100 × 5 / (8 × evaluated) — about 1.2 index points on its 51 expectations,
less on a longer episode. Restating "±5" against the new scale would have quadrupled the claimed
noise, so `PENALTY_REPEAT_SPREAD = 5` keeps penalty units and `bandIsUncertain` converts, asking
whether the measured wobble would actually change the band. A row stored before round 15 has no
denominator to convert with and falls back to the old fixed window.

### 1.14 The worklist has read "not scorable" for every episode since round 9

`dbf07b9a` added `divergence_band`, `band_uncertain` and `scoring_status` to the INSERT and to the
list page, and never to `episodeWorklist`'s SELECT. `r.divergence_band` was therefore `undefined`
on every row, `DivergenceChip` took its "no band was stored" branch, and the whole worklist read
*not scorable* on a table full of scored episodes. Nothing failed and nothing threw. Found while
wiring the round-15 counts in beside the band — which cannot sit beside a band that never renders.

A source-read test now holds the query and the page's field accesses together: every `r.<field>`
the page reads must be named in the SELECT.

### 1.15 Round 16 — real names redacted, and the cause recorded (V, 2026-09-03)

Three real people's names were on this branch, in a PUBLIC repository: two clinicians used as test
fixtures since the build commit, and two staff names inside the merged database reference. A
theatre assistant's name had also been quoted in round 14's own explanation of why staff names must
not be stored — removed in `d935ccb3` before this round.

**THE CAUSE: the reference document was added by the orchestrator without a personal-data review.**
`handoff-docs/EVEN-DB-REFERENCE-2026-09-01.md` was merged in by the kickoff to serve as the
evidence base for the join keys and coverage figures, and nothing read it for personal data first.
The fixtures then followed the document — the build used the names it found there. One unreviewed
document seeded every later occurrence.

**The next person adding a document to this repository must read it for personal data before
committing it.** That is the whole lesson, and it is cheaper to apply than the history rewrite it
cost this time.

The document STAYS: it is the evidence base for §3.2.3's column lists and §12's grounding facts,
and removing it would strand every number that cites it. Both of its examples keep their substance
— a role placeholder sitting in a name field, and spelling drift in a free-text author field — with
the values removed. `Dr Dietician` is retained deliberately: it is a ROLE, not a person, and it is
the defect the example exists to show.

Fixtures now use `Dr Testperson Alpha` and `Dr Testperson Beta` — two distinct synthetic
identities, because several tests turn on the two authors being different people.

History was rewritten on `ipd-episode-audit` and `handoff/ipd-episode-audit` so that no commit on
either branch contains a real name. Nothing had merged and only one machine had pulled them, which
is what made a force-push safe; the standing no-force-push rule was suspended by V for these two
branches and this purpose only.

### 1.16 Round 17 — final tidy before merge (V, 2026-09-03)

| # | Change |
|---|---|
| 1 | **The escalation gate is code now.** It was prompt-only: `run.ts` pushed every trigger into the resolver with the MODEL'S matcher, and the pipeline behaved only because `prompts.ts` suggests `{"kind":"other"}` in the escalation slot. A model returning `{kind:'drug', terms:['noradrenaline']}` would have had "if SBP < 90 → noradrenaline" resolved as a drug lookup — no order, pharmacy data present, therefore **divergent**. A patient who never became hypotensive, marked as denied a vasopressor. An escalation trigger is a CONDITIONAL and this mirror carries no vitals, so its antecedent cannot be evaluated; it now always resolves `absent_class_missing` / `unassessable`, keyed on `ESCALATION_SECTION` so no repeated literal can drift from the gate. This was the last hard constraint on the engine resting on a prompt. |
| 2 | Fixture patient renamed to `Testpatient Gamma`, matching `Testperson Alpha` / `Beta`. |
| 3 | `applyLiteratureCap` and the `INDEX_REPEAT_SPREAD` alias deleted, with the two scoring tests that exercised the dead cap. The two CONTRACT tests are kept: they assert the cap is *absent* from the chain, which is the half that still guards something. `entryWasUncited` loses its `@deprecated` — it is live, feeding `n_uncited_entries`. |
| 4 | `bandIsUncertain`'s doc no longer cites a 45 threshold, which has not existed since decision 37, nor a fixed index window, which decision 38 replaced. |
| 5 | **`app_source` written, `de_identified` dropped** — see below. |
| 6 | `episodeAuditById` names its 64 columns instead of `SELECT *`, with a test that the list and the DDL match in both directions. |

**Decision 39 — the two assertion columns (round 17 item 5).**

`app_source` is now **written** from `process.env.APP_SOURCE`, the idiom `lib/db.ts`,
`appropriateness-runs.ts` and `audit-suppression-store.ts` already use. Preview and production
share one `DATABASE_URL` (decision 31), so which deployment produced a row is a real question about
the data, and a column that answers it earns its place.

`de_identified` is **dropped**. It was `DEFAULT TRUE`, never written by the pipeline, and therefore
`TRUE` on every row whatever ran — an assertion column asserting nothing. Worse, it read `TRUE`
throughout the period when `real_course` was carrying a theatre assistant's name in an OT note
(round 14 item 9): the one thing it claimed was the one thing that was not true. A column that can
only ever agree with itself invites a confidence nobody has checked, which is the failure
`scoring_status` exists to prevent one level up. De-identification is enforced where it happens —
the Deidentifier in assembly, the column allow-lists in `db13.ts`, `isPersonFieldName`, and the
source-read tests that hold all three — and it is checkable there.

### 1.17 Decision 40 — the branch is SQUASH-merged (V, 2026-09-03; amends §14)

§14 said *"V merges `ipd-episode-audit` into `main` with a merge commit, no squash, no rebase"*.
That is amended: the branch is **squash-merged as one commit**.

**The reason is the history, not the shape.** The fixture patient name that round 17 replaced with
`Testpatient Gamma` is clean at the tip, but it is still present in the blobs of 24 of the branch's
27 commits, because it was there from the build commit onward. (The old value is deliberately not
written here: quoting it in the document that explains why it must not reach `main` would put it
straight back into the one commit the squash carries there — which is exactly what happened on the
first draft of this paragraph.) A merge commit carries
that history onto `main`; a squash does not. The alternative was a third force-push and rewrite,
and a squash reaches the same place without one.

What is lost is the round-by-round commit trail. That is a real loss and it is accepted knowingly:
the reasoning it carried is in this document, section by section, and the branch itself survives
unmerged for anyone who wants to read the sequence.

### 1.18 Round 18 — the last round (V, 2026-09-03)

| # | Change |
|---|---|
| 1 | `store.ts`: the decision-27 JSDoc had been orphaned by round 17's `APP_SOURCE` insertion — it sat above the wrong declaration and left the engine-version constant undocumented. Reunited. |
| 2 | **The residual escalation gap.** Round 17 gated the resolver path and `dropJudgedOmissions` gates judge-authored omissions, but a judge-authored `commission`, `timing` or `sequencing` finding pointed at an escalation entry still scored — "noradrenaline was started late" against `cp-d2/escalation/1`, worth 8 points, resting on whether SBP ever fell below 90, which nothing here knows. Such findings are rewritten to `unassessable` and counted in `n_escalation_unassessable`. **`enforceUnassessable` needed an exemption for them**, or it overturned the gate one line later — the gated finding carries a Tier A basis, so the §4.2a rule read it as a model hedge and returned it to `context_dependent`, back in the denominator. Code-established verdicts are exempt for the same reason resolver `absent_class_missing` findings are. |
| 3 | The migration route's `DROP COLUMN IF EXISTS de_identified` is the **only destructive statement** in a route that is otherwise additive-only, and it now says so at length: what it drops, why nothing depends on it, and that a future DROP must carry its own note. A reader skimming the route is entitled to assume it cannot destroy data; from that line on the assumption is wrong, so it is stated rather than inferred. |
| 4 | The DDL column-extraction regex in the contract test was coupled to two-space indentation and an uppercase type token; a column declared differently would have vanished from `declared` and quietly weakened the bidirectional check. Loosened, and the extraction is now itself asserted — a set comparison is vacuously green if one side comes back short. |

### 4.2a `unassessable` must be earned (added 2026-09-02, decision 33)

A finding may carry `unassessable` only if its `evidence_basis` is empty or every cited source is Tier C. Anything else is rewritten to `context_dependent` in code and counted in `n_unassessable_rejected`. Resolver findings with `resolution = 'absent_class_missing'` are exempt: that gap was established by code rather than claimed by a model.

### 1.4 Settled with V on 2026-09-02, after v1.1 was drafted

31. **Build on branch `ipd-episode-audit`, not on main.** V chose this over the direct-to-main standing rule for this build. The builder creates the branch from the current `main`, commits there, and pushes the branch. Vercel builds a preview deployment. Preview and Production share the same `DATABASE_URL`, `METABASE_API_KEY`, and Bedrock variables (V confirmed), so the migration and the validation run on the preview URL write to the real Neon database. The branch merges to `main` after the orchestrator's verification in §14 passes and before V's clinical gate. The flag is off throughout, so the merge shows nothing to clinicians.

---

## 2. Pipeline

Seven stages. Each stage writes its output before the next stage starts.

1. **Select.** Find closed episodes that qualify. §3.1.
2. **Assemble.** Build the real course with per-claim provenance. §3.2.
3. **Checkpoint.** For each checkpoint: retrieve citations, then generate the blinded expected course with Haiku. §3.3.
4. **Diff (A1).** Opus compares real against expected. No discharge summary. §3.4.
5. **Fidelity (A2).** Opus compares the extracted discharge summary against the real course. §3.5.
6. **Comment (B).** Opus, outcome visible, prose only. §3.6.
7. **Persist.** One `ipd_episode_audits` row, N `ipd_episode_checkpoints` rows. §7.

---

## 3. Stage specifications

### 3.1 Select

An episode is a row of `kx_ip_admissions`. It qualifies when all of the following hold:

1. A row exists in `kx_discharge_summary_records` with `ipd_no = encounter_id` and `discharge_date_time` not null. If more than one row matches, take the one with the latest `_create_time`.
2. At least one row exists in `kx_clinical_template_progress_reports` with the same `encounter_id`.
3. A row exists in `discharge_extracted_cases` with `ip_uid = encounter_id`. Prefer `extraction_version = 'doc-extract/2'`, then `'doc-extract/1'`, then the latest `extracted_at`.
4. No row exists in `ipd_episode_audits` for `(encounter_id, engine_version)`.

If condition 1, 2, or 3 fails, write or update an `ipd_episode_skips` row with the failed condition and do not audit. If the episode's discharge is more than 14 days old and it is still skipped, stop retrying it. Condition 4 failing is a silent skip with no row.

Process qualifying episodes in ascending `discharge_date_time`.

### 3.2 Assemble the real course

The real course is an ordered list of events. Every event carries provenance. No event exists without a source record.

#### 3.2.1 Event schema

```json
{
  "event_id": "string",
  "occurred_at": "ISO 8601 UTC",
  "day_index": 0,
  "event_type": "admission|initial_assessment|note|order|lab_order|handover|ot_note|transfer|discharge",
  "summary": "string",
  "detail": {},
  "author_name": "string or null",
  "author_role": "string or null",
  "responsible_clinician_id": "string or null",
  "provenance": {
    "source_table": "string",
    "source_record_id": "string",
    "source_timestamp": "ISO 8601 UTC"
  },
  "evidence_tier": "A|B|C"
}
```

#### 3.2.2 Time base

`day_index` 0 starts at `kx_ip_admissions.admission_date_time`. Each boundary is 24 hours after the previous one. Store UTC. Display Asia/Kolkata.

Clinical timestamp per source, in this order:

| Source | Timestamp |
|---|---|
| admission | `kx_ip_admissions.admission_date_time` |
| note, handover, ot_note, initial_assessment | `progressnote_date_time` inside `component_json` (epoch milliseconds, see below), then `g_creation_time` (epoch milliseconds) |
| order | `kx_billing_records.order_date_time` |
| lab_order | `kx_lab_reports.sample_collection_date_time`, then `booking_date_time` |
| transfer | `kx_ip_transfers.created_at` |
| discharge | `kx_discharge_summary_records.discharge_date_time` |

`component_json` is `text` holding a JSON array of `{"name": ..., "valueString": ...}` objects. `progressnote_date_time` is the `valueString` of the element whose `name` is `progressnote_date_time`. It is present on 100 percent of progress notes. Read it with `jsonb_array_elements(component_json::jsonb)`.

**Never use `_create_time`, `_update_time`, or `created_at` for clinical ordering.** `_create_time` is the mirror write time. `created_at` agrees with the clinician-stated time within a minute on 20 percent of rows and is null on 148.

If no clinical timestamp resolves, set `evidence_tier` to C and exclude the event from checkpoint input.

#### 3.2.3 Sources and joins

All joins are exact on the id. **Do not transform, trim a prefix, or rewrite any id.** See decision 21.

| Event type | Source table | Join | Tier |
|---|---|---|---|
| admission | `kx_ip_admissions` | `encounter_id` | A |
| note | `kx_clinical_template_progress_reports` | `encounter_id` | A |
| order | `kx_billing_records` | `visit_id_admission_id = encounter_id AND patient_type = 'IP'` | A |
| lab_order | `kx_lab_reports` | `visit_id = encounter_id` | A |
| discharge | `kx_discharge_summary_records` | `ipd_no = encounter_id` | A |
| initial_assessment | `kx_clinical_template_initial_assessment_adults` | `encounter_id` | B |
| handover | `kx_clinical_template_shift_handovers` | `encounter_id` | B |
| ot_note | `kx_clinical_template_ot_notes` | `encounter_id` | B |
| transfer | `kx_ip_transfers` | `encounter_id` | B |

Column allow-lists per table. Select only these. A source-read test enforces it (§13 item 13).

- `kx_ip_admissions`: `encounter_id, uid, admission_date_time, admission_type, admit_source, ward, ward_type_name, billing_category, admitting_doctor_speciality, current_treating_doctor_speciality, treating_department_name, treating_sub_department_name, facility_name, admitting_doctor_id, current_treating_doctor_id, remarks, member_id`
- `kx_clinical_template_progress_reports` and the three other template tables: `_doc_id, encounter_id, facility_id, template_name, status, finalized_by_username, current_treating_doctor_id, ordering_doctor_id, g_creation_time, component_json`. OT notes add `surgery_name, surgeon`. Handovers add `handed_over_by, received_by, handover_route`.
- `kx_billing_records`: `_doc_id, visit_id_admission_id, order_date_time, service_type, department, service_item_name, ordered_item_name, ordered_qty, quantity, net_amt, status, order_no`
- `kx_lab_reports`: `_doc_id, visit_id, order_no, service_name, sub_department, priority, booking_date_time, sample_collection_date_time, report_date, icd_diagnosis`
- `kx_ip_transfers`: `_doc_id, encounter_id, created_at, transfer_type, transfer_reason, ward, vacant_ward_name, care_type, recommending_doctor_speciality`
- `kx_discharge_summary_records`: `_doc_id, ipd_no, discharge_date_time, discharge_type, admission_date_time, treating_doctor_speciality, _create_time`

Never select `patient_name, patient_age, patient_gender, birth_date, telecom, uhid, patient_mobile, mobile_no, age, gender, age_gender, address_details, kin_name, kin_contact, primary_email_address, secondary_email_address`. `uhid` is read only at UI render time, by the existing `namesForIpUids` pattern in `lib/ipd-audit/db13.ts`.

Order event rules (decision 17 and 28): pharmacy rows (`service_type = 'Pharmacy'`) roll up to one event per (day, `ordered_item_name`) with a count in `detail`. Other rows are one event each, capped at 60 per day, with `detail.truncated_count` on the last kept event. No category field.

Note event rules: `summary` is the concatenation of every `valueString` in `component_json` whose value is non-empty, excluding the names `esfewqf, Inver43, fycjtkuvyj, liubf, observationId, doctor_id, tag_data`. The text passes through the existing de-identifier used by `lib/stay-library` before storage. `author_role` is the `valueString` named `role`.

#### 3.2.4 Discharge summary

The discharge event carries `discharge_type` in `detail` and the extracted case (`extracted_json`) in `detail.extracted_case`. Assembly stores the whole event. Blinding is applied when inputs are built, per §3.3.3 and §3.4.1. Do not build a second assembly path.

### 3.3 Checkpoints (Haiku, blinded)

#### 3.3.1 Budget (decision 24)

| `los_days` | Daily checkpoints | Episode-level |
|---|---|---|
| 0 | day 0 | 1 |
| 1 | days 0, 1 | 1 |
| 2 to 5 | days 0 to `los_days` | 1 |
| 6 or more | days 0 to 6 | 1 |

#### 3.3.2 Retrieval (decision 18)

Before each checkpoint, call `retrieve(query, { ... })` from `lib/retrieve.ts` with default normative sources and `k = 8`. Build `query` from, in order: `treating_department_name`, `admission_type`, `admit_source`, admission `remarks`, and the first 400 characters of the most recent note or initial assessment summary before the cutoff. Number the returned chunk excerpts 1 to k in the prompt. `citation_ids` are the chunk `id` values. On retrieval failure, proceed with no excerpts and record `retrieval_failed = true` on the checkpoint row.

#### 3.3.3 Blinding rule

The day N checkpoint receives: the admission event, and every other event with `occurred_at` strictly earlier than the start of day N. Nothing else.

It never receives: the discharge event, the extracted case, `discharge_date_time`, `discharge_type`, `los_days`, any event with `day_index >= N`, or any other checkpoint.

The episode-level checkpoint receives every event except the discharge event (decision 25). Same exclusions otherwise.

Build every input by filtering the assembled event list. Record `input_cutoff_at` and `input_event_count` on the checkpoint row.

#### 3.3.4 Output schema

```json
{
  "expected_diagnostics": [{"item": "string", "by_day": 0, "rationale": "string", "citation_ids": []}],
  "expected_therapeutics": [{"item": "string", "by_day": 0, "rationale": "string", "citation_ids": []}],
  "expected_monitoring": [{"item": "string", "frequency": "string", "rationale": "string", "citation_ids": []}],
  "escalation_triggers": [{"trigger": "string", "action": "string", "citation_ids": []}],
  "expected_los_days": 0,
  "expected_disposition": "string",
  "uncertainty": ["string"]
}
```

An entry with an empty `citation_ids` is allowed. §4.4 caps any finding built on it.

### 3.4 Diff pass A1 (Opus, outcome-blinded)

#### 3.4.1 Input

Every event except the discharge event, plus all checkpoints. No extracted case. No `discharge_type`, `los_days`, `discharge_date_time`, readmission, or mortality field.

Recorded limit: the event list ends where documentation ends, so A1 can infer approximate duration. It cannot see the disposition.

#### 3.4.2 Finding schema

```json
{
  "finding_id": "string",
  "pass": "divergence|fidelity",
  "finding_type": "omission|commission|timing|sequencing",
  "verdict": "divergent|context_dependent|unassessable|concordant",
  "domain": "diagnostics|therapeutics|monitoring|escalation|documentation|disposition",
  "day_index": 0,
  "checkpoint_ref": "string or null",
  "statement": "string",
  "severity": "minor|moderate|major",
  "evidence_tier": "A|B|C",
  "evidence_basis": [{"source_table": "string", "source_record_id": "string", "source_timestamp": "..."}],
  "author_name": "string or null",
  "author_role": "string or null",
  "responsible_clinician_id": "string or null",
  "lvc_category": "string or null",
  "citation_ids": []
}
```

- **omission**: a checkpoint expected an action and no matching event exists.
- **commission**: an event happened that no checkpoint expected and no later evidence justifies.
- **timing**: the expected action happened later than expected.
- **sequencing**: expected actions happened in an order that inverts a stated dependency.

A1 findings carry `pass = 'divergence'` and a non-null `checkpoint_ref`.

`lvc_category` uses `LVC_CATEGORIES` from `lib/opd-lvc-classify-core.ts` (12 values). Populate only on commission findings in the therapeutics or diagnostics domains. Validate with `asCategory()` from the same file.

### 3.5 Fidelity pass A2 (Opus, summary visible)

Input: every event including the discharge event, and the full extracted case. No checkpoints.

Output: findings in the §3.4.2 schema with `pass = 'fidelity'`, `domain = 'documentation'`, `finding_type = 'commission'`, `checkpoint_ref = null`. One finding per clinical claim in the extracted case that no assembled event supports. `evidence_basis` cites the discharge record and, where relevant, the events that contradict the claim.

A2 must not emit findings in any other domain. Findings that break this rule are dropped in code and counted in `n_dropped_invalid`.

### 3.6 Commentary pass B (Opus, outcome-aware)

Input: everything, including the outcome and all findings from A1 and A2. Output:

```json
{
  "narrative": "string",
  "outcome_context": "string",
  "findings_context": [{"finding_id": "string", "note": "string"}]
}
```

This pass emits no scores, verdicts, severities, or new findings. It may annotate findings that A1 or A2 produced. If the output contains a numeric score field or a `finding_id` that does not exist, retry once. On second failure, store null.

### 3.7 Model calls

Every call goes through `governedChat(traceId, label, params, { bedrock: model })` from `lib/trace.ts`. No other client. `params` is an OpenAI-style chat request. JSON is parsed by a local `extractJsonObject` in the engine's pure core, following the pattern in `lib/lvc-value-core.ts`.

Models come from environment variables, validated with `assertKnownBedrockModel` before any work starts:

| Variable | Default | Used by |
|---|---|---|
| `IPD_EPISODE_CHECKPOINT_MODEL` | `global.anthropic.claude-haiku-4-5-20251001-v1:0` | §3.3 |
| `IPD_EPISODE_JUDGE_MODEL` | `global.anthropic.claude-opus-4-6-v1` | §3.4, §3.5, §3.6 |

Prompts are top-level `const` template literals named `IPD_EPISODE_CHECKPOINT_SYSTEM`, `IPD_EPISODE_DIFF_SYSTEM`, `IPD_EPISODE_FIDELITY_SYSTEM`, `IPD_EPISODE_COMMENTARY_SYSTEM`, in one pure file, so the reasoning registry picks them up. See §11 for the registration steps.

---

## 4. Evidence tiers and the unassessable verdict

### 4.1 Tiers

| Tier | Sources |
|---|---|
| A | `kx_ip_admissions`, `kx_clinical_template_progress_reports`, `kx_billing_records`, `kx_lab_reports` order metadata, `discharge_extracted_cases` with `kx_discharge_summary_records` |
| B | `kx_clinical_template_initial_assessment_adults`, `kx_clinical_template_shift_handovers`, `kx_clinical_template_ot_notes`, `kx_ip_transfers` |
| C | lab result values, radiology reports, medication administration times, pre-admission outpatient notes |

Tier C sources are absent or near-absent in the mirror.

### 4.2 The grading rule

A finding whose `evidence_basis` is empty or contains only Tier C sources cannot carry `divergent`. Code rewrites it to `unassessable` and increments `n_unassessable`. This is a code validation after the model returns, not a prompt instruction.

### 4.3 Unassessable findings are reportable

They are an output. The UI lists them under their own heading.

### 4.4 Uncited expectations

**Amended by V on 2026-09-02 (fix round 6 item 1). The text below supersedes the original rule, which read: "capped in code at `severity = 'minor'` and `verdict = 'context_dependent'`."**

An A1 finding is *grounded* when **both** the finding itself and the checkpoint entry it is measured against carry a non-empty `citation_ids`. An ungrounded finding is capped **in severity only**, at `severity = 'moderate'` — never `major`. **Its verdict is not touched**, and it may hold any verdict including `divergent`. This cap does not apply to A2 findings.

Why the verdict override was removed: rewriting an ungrounded finding's verdict to `context_dependent` did not weaken it, it deleted it. On IP-1286 nine of thirteen `concordant` findings were erased, because "the course matched the expectation" is a conclusion about the record, and an expectation's citations say nothing about whether it matched. A citation bears on how much weight a divergence should carry — severity — and on nothing else.

This ceiling is **the same ceiling** as §4.4a. A finding subject to both lands on `moderate` and stops there; the two do not stack down to `minor`.

### 4.4a Non-normative evidence (added 2026-09-02, decision on the widened corpus)

Retrieval is not restricted to the normative allowlist, so a citation may be a guideline (a standard) or a journal or textbook passage (evidence). A finding whose citations are **all** non-normative may hold any verdict, including `divergent`, but is capped at `severity = 'moderate'` — never `major`, because `major` asserts serious harm against a standard and literature is not one. A single normative citation lifts the ceiling. Each finding records `citation_provenance` as `normative | literature | mixed`, null when it cites nothing.

---

## 5. Author attribution

- **Author** = `finalized_by_username` plus the `role` value from `component_json`.
- **Responsible clinician** = `current_treating_doctor_id`.

Every note-derived finding carries both. Documentation-domain findings attribute to the author. All other domains attribute to the responsible clinician.

Normalize `finalized_by_username` by trimming whitespace and collapsing `Dr.` to `Dr`. Do nothing more.

---

## 6. Scoring

### 6.1 Divergence index

```
penalty = 8 * n_major + 4 * n_moderate + 1 * n_minor
divergence_index = max(0, 100 - penalty)
```

Only findings with `verdict = 'divergent'` contribute, from both passes (decision 16). Counters stored: `n_findings, n_divergence_pass, n_fidelity_pass, n_omission, n_commission, n_timing, n_sequencing, n_divergent, n_context_dependent, n_unassessable, n_concordant, n_low_value, n_dropped_invalid`. `n_low_value` is the count of findings with a non-null `lvc_category`.

### 6.2 Completeness

```
completeness_pct = round(100 * sources_present / 9)
```

The nine sources are the five Tier A sources and the four Tier B sources in §4.1. A source is present when at least one row joined. Selection requires three of them, so the floor is 33.

### 6.3 Care value index

Not computed here (decision 14). The UI joins `ipd_discharge_audits` on `ip_uid = encounter_id` with `engine_version = 'ipd-discharge-audit/0.2'` and shows `care_value_index` and `band` under the label `Discharge engine score`. If no row exists, show `not audited by discharge engine`.

---

## 7. Data model

Three new tables. All additive. No existing table changes.

### 7.1 `ipd_episode_audits`

| Column | Type |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `audited_at` | timestamptz not null default now() |
| `app_source` | text |
| `engine_version` | text not null |
| `encounter_id` | text not null |
| `ip_uid` | text not null |
| `member_id` | text |
| `facility_name` | text |
| `speciality` | text |
| `admitted_at` | timestamptz |
| `discharged_at` | timestamptz |
| `los_days` | integer |
| `discharge_type` | text |
| `extraction_version` | text |
| `divergence_index` | integer |
| `completeness_pct` | integer |
| `n_findings` … `n_dropped_invalid` | integer, one column per counter in §6.1 |
| `checkpoint_count` | integer |
| `evidence_tiers` | jsonb, `{"A": [tables present], "B": [...], "C": []}` |
| `real_course` | jsonb |
| `findings` | jsonb |
| `commentary` | jsonb |
| `model_checkpoint` | text |
| `model_judge` | text |
| `trace_id` | text |
| `de_identified` | boolean default true |

Unique index on `(encounter_id, engine_version)`.

`speciality` = `current_treating_doctor_speciality`, else `admitting_doctor_speciality`. `facility_name` from the admission row.

### 7.2 `ipd_episode_checkpoints`

| Column | Type |
|---|---|
| `id` | uuid primary key default gen_random_uuid() |
| `episode_audit_id` | uuid references `ipd_episode_audits(id)` on delete cascade |
| `day_index` | integer not null |
| `checkpoint_type` | text not null, `daily` or `episode` |
| `generated_at` | timestamptz not null default now() |
| `input_cutoff_at` | timestamptz not null |
| `input_event_count` | integer |
| `retrieval_query` | text |
| `retrieval_failed` | boolean default false |
| `citation_ids` | integer[] |
| `expected_course` | jsonb |
| `status` | text, `ok` or `error` |
| `error_detail` | text |
| `model` | text |
| `trace_id` | text |

Index on `episode_audit_id`.

### 7.3 `ipd_episode_skips`

| Column | Type |
|---|---|
| `encounter_id` | text not null |
| `engine_version` | text not null |
| `reason` | text not null, one of `no_discharge_summary, no_notes, no_extraction, diff_failed, fidelity_failed` |
| `first_seen` | timestamptz not null default now() |
| `last_seen` | timestamptz not null default now() |
| `attempts` | integer not null default 1 |
| `discharged_at` | timestamptz |

Primary key `(encounter_id, engine_version)`. Upsert on conflict: set `reason`, `last_seen = now()`, `attempts = attempts + 1`.

### 7.4 De-identification

No `uhid`, patient name, age, gender, birth date, mobile, or address in any of the three tables. `real_course[].summary`, `findings[].statement`, and `commentary` pass through the existing de-identifier. Names are joined at render time only.

---

## 8. Failure modes

Every path degrades to a recorded no-op. No path returns a 500. No path writes a wrong value.

| Condition | Behavior |
|---|---|
| No discharge summary row | Skip. Reason `no_discharge_summary`. |
| No progress notes | Skip. Reason `no_notes`. |
| No extraction | Skip. Reason `no_extraction`. |
| Skipped and discharge older than 14 days | Not selected again. Row stays. |
| Metabase query fails | Abort this episode. No audit row. No skip row. Log. Continue to the next episode. |
| Retrieval fails | Checkpoint proceeds with no excerpts. `retrieval_failed = true`. |
| Bedrock call fails | Retry twice with exponential backoff. Then checkpoint row `status = 'error'` and continue. |
| Unparseable JSON | Same as a call failure. |
| Every checkpoint errored | Skip. Reason `diff_failed`. No audit row. |
| A1 fails after retries | Skip. Reason `diff_failed`. No audit row. |
| A2 fails after retries | Skip. Reason `fidelity_failed`. No audit row. |
| B fails after retries | Audit row written with `commentary = null`. |
| B output has a score field or an unknown `finding_id` | Retry once. Then null. |
| Finding fails the Tier C rule | Rewrite to `unassessable`. Count. |
| A2 finding outside documentation domain | Drop. Count in `n_dropped_invalid`. |
| Unknown `lvc_category` value | Set null. |
| No clinical timestamp for a record | Tier C. Excluded from checkpoint input. |
| Already audited at this version | Silent skip. |
| Worker lock held | Return `{ok: true, locked: true}`. Do nothing. |

---

## 9. Feature flag

`IPD_EPISODE_AUDIT_ENABLED`, read as `process.env.IPD_EPISODE_AUDIT_ENABLED === '1'` at request time. Default off.

When off: every UI route in §10 returns 404, and the link from the IPD Audit page is not rendered. The worker route still runs. The flag gates the interface, not the pipeline.

---

## 10. UI

Inside the existing IPD Audit section, mirroring its page shell.

**List** at `/admin/ipd-audit/episodes`: encounter, speciality, length of stay, `divergence_index`, discharge engine score with band, finding counts, completeness. Sortable on divergence index and discharge engine score. Server component, admin cookie gate, direct store calls, same as `app/admin/ipd-audit/page.tsx`.

**Detail** at `/admin/ipd-audit/episodes/[id]`, in this order:

1. Header: `divergence_index`, discharge engine score labeled `Discharge engine score`, completeness percentage, patient name resolved at render time by the existing `namesForIpUids` pattern.
2. Timeline of the real course grouped by day, each event showing its source table.
3. Findings grouped by day. Each shows pass (`divergence` or `fidelity`), type, domain, severity, verdict, evidence tier, author, responsible clinician.
4. A block titled **Could not assess** holding `unassessable` findings.
5. A collapsed block titled **Outcome-aware commentary**, with this text verbatim above the content: `This commentary was written with knowledge of the patient outcome. The scores above were not.`
6. A collapsed block per checkpoint showing the expected course and its citations.

Empty findings copy: `No divergence found against the expected course.`

Entry point: a link `Episode audits` on `app/admin/ipd-audit/page.tsx`, rendered only when the flag is on. Add `/admin/ipd-audit/episodes` to the `match` array of the IPD entry in `components/Shell.tsx`.

---

## 11. File contract

**Create ONLY these files:**

- `migrations/0051_ipd_episode_audits.sql` — the three tables in §7, all `IF NOT EXISTS`.
- `app/api/admin/migrate-ipd-episode-audits/route.ts` — idempotent admin route issuing the same DDL, gated like `app/api/admin/migrate-ipd-audits/route.ts`, returning `{ok, steps}`.
- `lib/ipd-episode/db13.ts` — database 13 readers via `metabaseQuery`, column allow-lists from §3.2.3, exact joins only.
- `lib/ipd-episode/assemble-core.ts` — pure: event building, day index, ordering, roll-ups, blinding filters.
- `lib/ipd-episode/assemble.ts` — impure: calls readers and the de-identifier, returns the course.
- `lib/ipd-episode/checkpoint-core.ts` — pure: budget, retrieval query builder, prompt, output parsing.
- `lib/ipd-episode/checkpoint.ts` — impure: `retrieve()` and `governedChat`.
- `lib/ipd-episode/judge-core.ts` — pure: A1, A2, B prompts, parsing, Tier C rule, uncited cap, A2 domain drop, commentary validation, penalty math, completeness.
- `lib/ipd-episode/judge.ts` — impure: the three Opus calls.
- `lib/ipd-episode/prompts.ts` — the four prompt constants from §3.7.
- `lib/ipd-episode/store.ts` — Neon reads and writes, `IPD_EPISODE_ENGINE_VERSION`, extraction reader by `ip_uid`, skip upsert, sibling score lookup.
- `lib/ipd-episode/run.ts` — pipeline orchestrator for one episode.
- `app/api/ipd-episode/worker/route.ts` — mirrors `app/api/ipd-audit/worker/route.ts`: `maxDuration = 800`, `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, auth by `x-vercel-cron` or `CRON_SECRET` or admin cookie, `?max=` default 2 cap 5, sequential processing, `app_settings` lock key `ipd_episode_lock` with the same TTL mechanics as the IPD worker, `?encounter=` to run one named episode.
- `app/admin/ipd-audit/episodes/page.tsx` and `ui.tsx`.
- `app/api/ipd-episode/commentary/route.ts` — **added by decision 35 (2026-09-03).** Not in the
  original contract, because pass B was stage 6 of the pipeline when this list was written. The
  decision that moved it out of the pipeline is what requires a route for it to run on.
- `app/admin/ipd-audit/episodes/[id]/page.tsx` and panel components in that folder.
- `lib/__tests__/ipd-episode-*.test.ts` — tests per §13.

**Additive edits ONLY:**

- `lib/reasoning/manifest.ts` — add the four prompt ids to `PROMPT_MANIFESTS` with `maturity: 'draft'`.
- `lib/__tests__/reasoning-registry.test.ts` — update the count invariant for four new prompts.
- `data/reasoning-registry/prompts.generated.json` — regenerate with `npm run reasoning:registry`.
- `lib/architecture/map.generated.ts` — regenerate with `npm run architecture:map`.
- `app/admin/ipd-audit/page.tsx` — the flag-gated link.
- `components/Shell.tsx` — the `match` entry.
- `.env.example` or the environment typing file, if one exists — the three variables in §3.7 and §9.

**UNTOUCHED (hard):**

- `opd_note_audits` and every OPD engine file.
- `lib/ipd-audit/*`, `ipd_discharge_audits`, `discharge_extracted_cases`, and the discharge engine. Read only.
- `lib/value-score-core.ts` and every scoring policy module.
- `lib/trace.ts`, `lib/bedrock.ts`, `lib/bedrock-core.ts`, `lib/llm.ts`, `lib/retrieve.ts`, `lib/metabase.ts`, `lib/db.ts`.
- `lib/admin-gate.ts`, `lib/admin-cookie.ts`, every auth guard.
- `vercel.json`, `.github/workflows/*`.
- `package.json`, `package-lock.json`. No new dependencies.

---

## 12. Grounding facts (resolved 2026-09-02)

| Fact | Value |
|---|---|
| Repository | `github.com/vinaybhardwaj-commits/Even-CDMSS` |
| Discharge engine | `lib/ipd-audit/run.ts` (`runIpdAudit`), store `lib/ipd-audit/store.ts`, db13 readers `lib/ipd-audit/db13.ts`, billing `lib/ipd-audit/billing.ts` |
| `care_value_index` formula | `lib/value-score-core.ts` `computeScorecard`. Not used by this engine (decision 14). |
| `uhid` hash | Does not exist. Omission posture (decision 23). |
| Bedrock | `lib/bedrock.ts`, allowlist `BEDROCK_MODELS` in `lib/bedrock-core.ts`, env `BEDROCK_REGION, BEDROCK_ROLE_ARN, BEDROCK_OIDC_AUDIENCE, GCP_SA_KEY`. Engines call `governedChat` only. |
| Neon | `lib/db.ts` `sql`, env `DATABASE_URL` |
| Database 13 | `lib/metabase.ts` `metabaseQuery`, `DB13 = 13`, env `METABASE_URL, METABASE_API_KEY` |
| Worker pattern | `app/api/ipd-audit/worker/route.ts` |
| Migration pattern | `migrations/0013_ipd_discharge_audits.sql` plus `app/api/admin/migrate-ipd-audits/route.ts` |
| Retrieval | `lib/retrieve.ts` `retrieve(query, opts)`, chunk `id` is the citation id |
| lvc enum | `lib/opd-lvc-classify-core.ts` `LVC_CATEGORIES`, `asCategory` |
| De-identifier | the `Deidentifier` used by `lib/stay-library/core.ts` |
| Render-time names | `namesForIpUids` in `lib/ipd-audit/db13.ts` |
| Flag pattern | `process.env.X_ENABLED === '1'` |
| Prompt registry | `scripts/reasoning-registry-gen.mjs`, manifest `lib/reasoning/manifest.ts` |

---

## 13. Tests

Pure-core tests under `lib/__tests__/`, `node:test`, no database, no network. About 32 cases.

1. Day index: admission at 23:50, event at 00:10, correct index. UTC storage.
2. Blinding cutoff: the day N input excludes every event at or after the boundary. Admission event always included. Six cases including boundary equality.
3. Episode-level input excludes the discharge event and nothing else.
4. Checkpoint budget: `los_days` 0, 1, 2, 5, 6, 7, 30 produce 1, 2, 3, 6, 7, 7, 7 daily plus 1 episode.
5. Divergence index: penalty math, floor at zero, non-divergent verdicts contribute nothing, A1 and A2 findings both count.
6. Tier C rule: only-C rewritten, mixed A and C not rewritten, empty basis rewritten.
7. Uncited cap: applies to A1 with an uncited entry, does not apply to A2.
8. A2 domain drop: a fidelity finding in therapeutics is dropped and counted.
9. Completeness: nine-source denominator, all present, minimum three present.
10. Author attribution: documentation finding to author, therapeutics finding to responsible clinician. `Dr.` normalization.
11. Commentary rejection: score field rejected, unknown `finding_id` rejected.
12. **Source-read: no id rewriting.** Read `lib/ipd-episode/db13.ts` and `assemble-core.ts` as text and assert none of `replace(`, `IPNO-`, `ERN-`, `regexp_replace(` appear.
13. **Source-read: PHI.** Read `lib/ipd-episode/db13.ts` and assert none of the forbidden columns in §3.2.3 appear, and that `_create_time` appears only in the discharge summary tiebreak.
14. Timestamp preference: `progressnote_date_time` from the `{name, valueString}` array wins over `g_creation_time`. `created_at` and `_create_time` never used.
15. Pharmacy roll-up: three rows of one item on one day become one event with count 3. Non-pharmacy cap at 60 with truncation note.
16. Skip retry window: a skip with discharge 15 days old is not selected.
17. Model env: an unknown model id fails before any work.

---

## 14. Verification plan

**Builder gate, before push, in this order (the CI sequence):** `npm run architecture:check`, `npm run architecture:map` then `git diff --exit-code lib/architecture/map.generated.ts`, `npm run reasoning:registry` then `git diff --exit-code data/reasoning-registry/prompts.generated.json`, `npm run reasoning:governance`, `npm run changelog:coverage`, `npm run typecheck`, `npm test`, `npm run build`. All green or no push.

**Orchestrator, after the branch push, in order:**

1. Fetch the branch and read the diff against `main`. Confirm the file contract in §11: only listed files created, only listed edits, nothing in the UNTOUCHED list changed.
2. Watch the Vercel preview deploy for branch `ipd-episode-audit` to READY. Record the preview URL. All steps below run against it.
3. Run `/api/admin/migrate-ipd-episode-audits` on the preview URL through V's admin session. Confirm `{ok: true}` and the three tables in Neon.
4. Validate every inferred SQL string from the builder report against database 13 and Neon.
5. Run the worker on the preview URL with `?max=2` repeatedly until 20 episodes are audited, flag off.
6. Recompute `divergence_index` for 3 episodes from the stored `findings` by independent query. Demand exact agreement.
7. Confirm no forbidden column value appears in any of the three tables.
8. Confirm every daily checkpoint row has `input_cutoff_at` equal to the day boundary and `input_event_count` equal to the count of events before it. This is the blinding proof.
9. Confirm no finding with only Tier C evidence carries `divergent`.
10. Confirm every audited `encounter_id` exists in `kx_ip_admissions` with the same `ip_uid` in `discharge_extracted_cases`.

**MERGE (V):** when steps 1 to 10 pass, V merges `ipd-episode-audit` into `main` with a merge commit, no squash, no rebase, and deletes the branch. The production deploy then carries the feature with the flag off. If any step fails, the fix goes to the same branch and steps 1 to 10 run again.

**VALIDATION GATE (V, blocking):** V reviews the 20 audited episodes on production. The flag stays off until he says otherwise. The cron entry waits for the same word.

---

## 15. Kickoff (paste into Claude Code)

```
Read handoff-docs/IPD-EPISODE-AUDIT-PRD-v1.1.md fully and build it exactly.
Read handoff-docs/EVEN-DB-REFERENCE-2026-09-01.md and
handoff-docs/EVEN-DB-REFERENCE-ADDENDUM-2026-09-02.md. Both are REQUIRED.
Where the addendum conflicts with the reference, the addendum wins.
v1.1 supersedes v1.0 in full. Ignore any v1.0 copy you find.

All design decisions are settled in PRD section 1. Do not re-open them.
If something is unsettled, flag it prominently in your report. Do not improvise.

BRANCH: start on this machine's `main` as it is. Do not pull or reset main.
Run:
  git checkout main
  git push origin main            (so the orchestrator's baseline matches yours)
  git fetch origin handoff/ipd-episode-audit
  git checkout -b ipd-episode-audit
  git merge --no-edit origin/handoff/ipd-episode-audit
The merge brings in only the three handoff-docs files named above. Then read
them. Commit on ipd-episode-audit only. Never commit to main. Push with `git push -u origin ipd-episode-audit` ONLY when the full
gate in PRD section 14 passes: architecture:check, architecture:map
regenerated and committed, reasoning:registry regenerated and committed,
reasoning:governance, changelog:coverage, typecheck, npm test, npm run build.
If any step fails, fix before any push. Do not merge. Do not open a pull
request. The orchestrator verifies the preview deployment and V merges.

GROUND YOURSELF FIRST. Read these before writing code:
- lib/ipd-audit/run.ts, store.ts, db13.ts, billing.ts: inherit the persistence
  pattern, the metabaseQuery usage, the PHI posture (names joined at render
  time, never stored), and namesForIpUids.
- app/api/ipd-audit/worker/route.ts: mirror its maxDuration, auth, lock, and
  ?max= mechanics exactly.
- lib/trace.ts governedChat, lib/bedrock-core.ts BEDROCK_MODELS and
  assertKnownBedrockModel, lib/lvp-operator-core.ts and lib/lvp-operator.ts for
  the model-env-var pattern.
- lib/reasoning/manifest.ts and scripts/reasoning-registry-gen.mjs: how a
  prompt constant is registered.
- lib/retrieve.ts retrieve(): the citation source.
- lib/stay-library/core.ts: the Deidentifier you must reuse. Do NOT reuse its
  created_at ordering.
- lib/opd-lvc-classify-core.ts: LVC_CATEGORIES and asCategory.
- migrations/0013_ipd_discharge_audits.sql and
  app/api/admin/migrate-ipd-audits/route.ts: the migration pattern.
- lib/__tests__/ipd-audit-billing.test.ts: the source-read test pattern.

FILE CONTRACT = PRD section 11 exactly. Create only the listed files. Additive
edits only where listed. The UNTOUCHED list is hard.

HARD CONSTRAINTS:
- Never rewrite, trim, or transform an encounter id. IPNO-n and IP-n are
  different patients. Every join is exact. A source-read test enforces this.
- Select only the columns in PRD 3.2.3. Never select a PHI column. A
  source-read test enforces this.
- Never order clinical events by _create_time, _update_time, or created_at.
  Use progressnote_date_time from the component_json {name, valueString}
  array, then g_creation_time.
- Every model call goes through governedChat with { bedrock: model }. No
  other client. assertKnownBedrockModel before any work.
- No new dependencies. No changes to vercel.json, package.json, auth guards,
  lib/ipd-audit/*, lib/trace.ts, lib/retrieve.ts, lib/value-score-core.ts.

SQL/SCHEMA HONESTY: your sandbox has NO live database. Every query and every
column name you write is INFERRED, including those copied from the reference
documents. (a) Every such path is fail-safe: an error degrades to a recorded
skip or an empty result, never a 500 and never a wrong value. (b) List EVERY
SQL string and column name VERBATIM in your report. The orchestrator validates
each against the live system before any user sees this feature.

NORMATIVE DETAILS (restated so nothing is guessed):
- Engine version: ipd-episode-audit/0.1
- Selection: kx_ip_admissions a; closure = kx_discharge_summary_records d with
  d.ipd_no = a.encounter_id AND d.discharge_date_time IS NOT NULL (latest
  _create_time if several); notes = kx_clinical_template_progress_reports with
  the same encounter_id; extraction = discharge_extracted_cases with
  ip_uid = encounter_id, prefer doc-extract/2, then doc-extract/1, then latest
  extracted_at. Skip reasons: no_discharge_summary, no_notes, no_extraction,
  diff_failed, fidelity_failed. Retry skips until 14 days after discharge.
- Joins: kx_billing_records.visit_id_admission_id = encounter_id AND
  patient_type = 'IP'; kx_lab_reports.visit_id = encounter_id; all
  kx_clinical_template_* and kx_ip_transfers on encounter_id.
- los_days = floor(hours(admission_date_time -> discharge_date_time) / 24).
- Checkpoints: daily for day_index 0..min(los_days, 6) inclusive, plus one
  episode-level. Day N input = admission event + events with occurred_at
  strictly before the start of day N. Episode-level input = every event except
  the discharge event. No checkpoint ever sees the discharge event, the
  extracted case, discharge_type, los_days, or discharge_date_time.
- Retrieval per checkpoint: retrieve(query, defaults) k=8; query from
  treating_department_name, admission_type, admit_source, remarks, and the
  first 400 chars of the latest note before the cutoff. citation_ids = chunk
  ids. Retrieval failure -> proceed, retrieval_failed = true.
- Pass A1 (divergence): every event except discharge + all checkpoints. No
  extracted case, no discharge_type, no los_days, no discharge_date_time.
  Findings pass = 'divergence', checkpoint_ref non-null.
- Pass A2 (fidelity): every event including discharge + full extracted case,
  no checkpoints. Findings pass = 'fidelity', domain = 'documentation',
  finding_type = 'commission', checkpoint_ref = null. Any other domain is
  dropped in code and counted in n_dropped_invalid.
- Pass B (commentary): everything. Prose only. A score field or an unknown
  finding_id -> retry once -> null.
- divergence_index = max(0, 100 - (8*major + 4*moderate + 1*minor)) over
  findings with verdict = 'divergent' from BOTH passes.
- completeness_pct = round(100 * sources_present / 9).
- Tier C rule: evidence_basis empty or only Tier C -> verdict rewritten to
  unassessable in code. Uncited-entry cap: A1 finding on a checkpoint entry
  with empty citation_ids -> severity minor, verdict context_dependent. Not
  applied to A2.
- Enums: finding_type omission|commission|timing|sequencing; verdict
  divergent|context_dependent|unassessable|concordant; domain
  diagnostics|therapeutics|monitoring|escalation|documentation|disposition;
  evidence_tier A|B|C; pass divergence|fidelity; lvc_category from
  LVC_CATEGORIES, only on commission findings in therapeutics or diagnostics.
- Order events: pharmacy rows roll up per (day, ordered_item_name) with a
  count; other rows one each, capped at 60 per day with a truncation note. No
  category field. No kx_medicine_items join.
- Note summary: concatenate non-empty valueString values from component_json,
  excluding names esfewqf, Inver43, fycjtkuvyj, liubf, observationId,
  doctor_id, tag_data. Pass through the stay-library Deidentifier.
- Author = finalized_by_username (trim, Dr. -> Dr) + role valueString.
  Responsible clinician = current_treating_doctor_id. Documentation findings
  attribute to the author, all others to the responsible clinician.
- Models: IPD_EPISODE_CHECKPOINT_MODEL default
  global.anthropic.claude-haiku-4-5-20251001-v1:0; IPD_EPISODE_JUDGE_MODEL
  default global.anthropic.claude-opus-4-6-v1. Prompts are top-level consts
  IPD_EPISODE_CHECKPOINT_SYSTEM, IPD_EPISODE_DIFF_SYSTEM,
  IPD_EPISODE_FIDELITY_SYSTEM, IPD_EPISODE_COMMENTARY_SYSTEM in
  lib/ipd-episode/prompts.ts, registered in lib/reasoning/manifest.ts.
- Tables: ipd_episode_audits (unique on encounter_id, engine_version),
  ipd_episode_checkpoints, ipd_episode_skips (pk encounter_id,
  engine_version). Columns per PRD section 7. No uhid, no names, no age, no
  gender, no mobile, anywhere.
- UI: /admin/ipd-audit/episodes and /admin/ipd-audit/episodes/[id]. Both
  return 404 unless process.env.IPD_EPISODE_AUDIT_ENABLED === '1'. The
  discharge engine score is read from ipd_discharge_audits where
  ip_uid = encounter_id and engine_version = 'ipd-discharge-audit/0.2' and
  labeled "Discharge engine score". Commentary block carries the verbatim
  label in PRD section 10.
- Worker: app/api/ipd-episode/worker/route.ts, maxDuration 800, ?max= default
  2 cap 5, sequential, app_settings lock key ipd_episode_lock, ?encounter= to
  run one episode. No cron entry. Flag gates the UI only.

REPORT: branch name and sha; each gate step and its result; every SQL string and column name
verbatim; the four prompt texts verbatim; confirmation that every checkpoint
and pass input is built by filtering the single assembled event list;
confirmation that no id is rewritten anywhere; the migration route V must
run; any deviation or flagged decision, prominently, at the top.
```
