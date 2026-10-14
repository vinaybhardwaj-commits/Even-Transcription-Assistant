# Pre-op Risk Agent — B7 validation pack

**27 Aug 2026 · branch `feature/preop-risk-agent` · engine `preop-risk/0.1` · both rails ship OFF.**
For V, before either flag is flipped and before the branch is merged.

Everything below was measured, not estimated. The extraction arm ran locally through the
same provider path production uses; the narrative arm ran on a Vercel Preview against
production Neon and real Bedrock. Nothing in the extraction arm wrote a byte.

---

## 0 · The recommendation, first

| Rail | Recommendation |
|---|---|
| `PREOP_SURFACE_ENABLED` | **Flip it.** The board and case page are deterministic, dark-tested and unchanged by any of this. |
| `PREOP_NARRATIVE_ENABLED` | **Flippable on the evidence below**, at V's discretion. 15/15 narratives valid, model derived, zero snapshot versions minted, and it cannot touch a score by construction. |
| `PREOP_EXTRACT_ENABLED` | **Do not flip.** Two independent reasons, §3 and §5. The rail works; it is not yet trustworthy enough to move a clinical tier. |

The extraction rail is not broken and it is not useless — it resolved the one input the PRD
named as mFI-5's ripening input and the PAC template cannot capture. It is *not
reproducible*, and it produced a tier-moving false positive of a specific, fixable kind.
Both are §5.

---

## 1 · The golden set

Per the kickoff: the PAC-covered cohort, re-pulled first (the scraper had been a day
behind), plus the four hand-computed mockup patients and the booking-only synthetics.

**The real half** — every surgical episode belonging to a patient the UHID bridge reaches a
KareXpert PAC report for, whatever its surgery date. Drawn by `fetchPacCoveredEpisodes`,
which shares its projection and its row mapper with the sweep's own episode query, so this
is a measurement of production and not of a second implementation that resembles it.

| | |
|---|---|
| Episodes | **57** |
| Patients | **54** (was 52 on 26 Aug — the new bridged count) |
| With a PAC report inside the episode window | 55 |
| With any text for the extraction rail to read | **48** |
| PAC reports in the table, all / bridged / cohort | 98 / 95 / 54 |

The refreshed field-by-field coverage is an addendum to
`PREOP-PAC-COVERAGE-26-AUG-2026.md`. Headline: the map is unchanged and still yields
**49/98 reports with ≥1 instrument input, but only 12/54 in the surgical cohort**.

**The synthetic half** is `lib/__tests__/preop-mockup-cases.test.ts`: Shobha K, Manjunath R,
Farhan S and Lakshmamma H, reproduced byte-for-byte from the approved mockup, plus two B7
additions — Lakshmamma run through **both** rail states (byte-identical, as a booking-only
patient must be), and Shobha run through both to show what the rail is *for*.

For the record, the live upcoming board — the thing V will actually look at — is **15
episodes**, all AMBER. It was 19 on 26 Aug; four surgeries have since happened.

---

## 2 · Board tier counts, extraction OFF vs ON

Over the 57 golden-set episodes:

| Tier | Rail OFF | Rail ON |
|---|---|---|
| CRITICAL | 1 | 1 |
| RED | 2 | **3** |
| AMBER | 51 | **50** |
| GREEN | 3 | 3 |

**One case changes tier**, AMBER → RED. It is `ZOo0P72ArYhQCZStdjs5`, and §5 is about it.

On the live 15-episode board, measured through the worker's `?rails=` probe on a Preview:
`rails=none` → `{"AMBER": 15}`; `rails=extract,narrative` → `{"AMBER": 15}`. Identical.

---

## 3 · The score-equality proof

The D4 claim is not "the flag changes nothing" — the flag is *supposed* to change coverage.
The claim is that **no score moves without an input status moving**, because the arithmetic
never sees a model.

| | |
|---|---|
| Cases where anything at all changed | 14 / 57 |
| …with a score change | 14 |
| …with a tier change | 1 |
| …with a **provenance-only** change (source moved, status did not) | **0** |
| **Score changes with no input status change to explain them** | **0** |

Zero is the number that matters, and it is zero by construction rather than by luck: every
row of the 14 carries its input changes beside its score changes, and the harness would
have printed an unexplained row if one existed.

The **provenance-only** count is zero for a reason worth recording, because it was not zero
when this was first measured. An anaesthetist writing *"NO KNOWN COMORBIDITIES"* makes the
model assert twelve absences at once — every one of which agreed with the booking form and
moved no score, and every one of which was, briefly, taking the input's *source* over from
BOOKING to EXTRACTED. Source is inside the snapshot fingerprint. Flipping the flag would
have minted a version row on every such case: a step in a clinical timeline that says
nothing happened. The rule now is that an extraction which **agrees** with the form's
silence corroborates and does not take the input over. Only a dissent can move it.

### The 14 cases that moved

| Episode | Input changes | Instruments | Tier |
|---|---|---|---|
| `Vz75C16vPJ6N4O3YHD2l` | functional_status unknown→present · hemiplegia absent→present | mFI-5, CCI | AMBER |
| `ejOS2hzyOQlVUtGvPz1w` | functional_status unknown→absent · hypertension absent→present | mFI-5 | AMBER |
| `m5J6qGldAR8HlXGItOYs` | hypertension absent→present | mFI-5 | AMBER |
| `0eJY1KtOAwfSQusu9u4e` | hypertension, dementia, connective_tissue absent→present | mFI-5, CCI | RED |
| `sZXyDyNSot2IRDGaEQ3y` | any_tumour absent→present | CCI | AMBER |
| `k8iNQ1FMEDZz51FCNShE` | cerebrovascular absent→present · functional_status unknown→present · hemiplegia absent→present | RCRI, mFI-5, CCI | AMBER |
| `3sdaqPm5ADJudacoTLZT` | functional_status unknown→present | mFI-5 | AMBER |
| `cKDt9ClbPvZ9kUbzpKgB` | hypertension absent→present | mFI-5 | AMBER |
| `My8F6GpnStZo2t8C2jxh` | functional_status unknown→absent | mFI-5 | AMBER |
| **`ZOo0P72ArYhQCZStdjs5`** | **peptic_ulcer absent→present** | **CCI** | **AMBER → RED** |
| `hRwMa4j2htD8H63CGIGM` | functional_status unknown→absent | mFI-5 | AMBER |
| `hKm9Ps8exetvR4PHuSBp` | functional_status unknown→absent | mFI-5 | AMBER |
| `rOesR54thmSqUMD8QrK7` | functional_status unknown→absent | mFI-5 | AMBER |
| `XFGkGD9sDHlwzXnmN1kb` | dementia unknown→absent | CCI | AMBER |

---

## 4 · Anti-flap

Three passes over the same 57 episodes and the same source text.

| Pass | Model calls | Result |
|---|---|---|
| 1 · cold | **48** | the reading is taken |
| 2 · warm, pass 1's stored readings threaded in | **0** | **every fingerprint identical to pass 1** |
| 3 · cold again, cache discarded | 48 | the self-agreement measurement — see §5 |

**Pass 2 made zero model calls and produced zero fingerprint drift.** That is the anti-flap
gate: an extraction is keyed on the fingerprint of its *source text*, so a board that has
stopped moving costs nothing and mints nothing. Proven again on production for the
narrative rail, by row count, in §6.

---

## 5 · Why the extraction flag should stay OFF

### 5.1 The rail does not agree with itself

Pass 3 re-read the identical text with the identical prompt at temperature 0. **19 of the
48 cases — 40% — returned a different set of readings from pass 1.**

Not marginal differences. Two examples, both on unchanged text:

- `SV6qaj935VBxImllY6vy`: pass 1 returned **twelve** absences off *"NO KNOWN COMORBIDITIES"*.
  Pass 3 returned **none**.
- `hKm9Ps8exetvR4PHuSBp`: pass 1 returned eight absences. Pass 3 returned a single
  reading — *congestive heart failure* **PRESENT**.

The anti-flap gate is the only thing standing between that and a clinical timeline full of
version rows that mean nothing. It holds: the stored reading stands, the moved inputs are
flagged `unstable`, and the card says so. But a gate that catches a defect is not the same
as not having the defect. **A rail that answers differently 40% of the time should not be
deciding a pre-operative tier.**

Two things this is *not*. It is not the reasoning cap: the cap (512 tokens, §7) made the
calls 7× faster and both passes ran under it. And it is not fabrication — see 5.3.

### 5.2 The one tier change is a false positive, of a nameable kind

`ZOo0P72ArYhQCZStdjs5` — 75 M, major wound debridement — moved **AMBER → RED** because the
Charlson index went 4 → 5. The input that moved was *peptic ulcer disease*, absent → present,
confidence 0.80, on this verbatim span:

> **"TAB RABEPRAZOLE 20 MG"**

Rabeprazole is a proton-pump inhibitor. It is prescribed for reflux, for gastritis, and for
gastroprotection alongside NSAIDs and antiplatelets far more often than for a documented
ulcer. **The model inferred a Charlson diagnosis from a drug name, and it moved a
75-year-old into the RED band.** (His surgery was on 5 Aug, so this particular case is
history — but the reading is not, and the next 75-year-old on a PPI is not.)

The same case shows the failure mode is not general. Two other readings on the same patient
are exactly right, and both are drug-derived:

- *"TAB TELMA 40 MG"* → hypertension on medication, PRESENT. Telmisartan is an
  antihypertensive; the mFI-5 item **is** "hypertension requiring medication". The drug is
  the definition, not evidence for a separate diagnosis.
- *"TAB VOGLIBOSE 0.3 MG"* → insulin-treated diabetes, ABSENT. An oral agent, and the
  target's own definition says to call it absent when the record states oral treatment.

So the fix is specific rather than a retreat: **a medication may establish an input whose
definition IS the medication, and may never establish a diagnosis it merely suggests.**
That is a prompt rule plus a gate, and it belongs in the next slice, not in a hotfix
tonight.

### 5.3 What the rail does well, so the decision is not one-sided

- **Zero fabrications in 48 calls.** Every proposal's span occurred verbatim in the field it
  named. The anti-fabrication gate fired zero times, and the polarity marker fired zero
  times.
- **It reads what a deterministic map cannot.** The cohort writes *"NO KNOWN COMORBIDITIES"*,
  *"NO COMORBIDS"*, *"NO KNOWN COMORBS"* and *"NO COMORBBIDITIES"* — four spellings of one
  fact, one of them misspelt, in free text. No regex was ever going to hold that.
- **8 of the 9 UNKNOWNs it resolved were functional status** — the mFI-5 ripening input the
  PRD (§3) named and the PAC template does not capture, read out of prose like *"good effort
  tolerance"* and *"not ambulating since 15 days"*. That is the rail's actual purpose,
  working.
- **11 form-negatives overturned**, mostly hypertension-on-medication (4) read off a
  medication list the booking form never asked about.

Two of those wins need a clinician's eye rather than mine, and they are in the sample below:
*"good effort tolerance"* is exercise capacity, which is adjacent to but not identical with
ADL dependence; and *"CONSCIOUS AND ALERT"* (confidence 0.80, right on the floor) says
nothing about dependence at all and still collapsed an mFI-5 range.

---

## 6 · The narrative rail

Run on a Vercel Preview against production Neon, real Bedrock, `PREOP_NARRATIVE_ENABLED=1`.

| | |
|---|---|
| Narratives written | **15 / 15** upcoming episodes |
| Valid by CODE's citation check | **15 / 15** |
| Model, read back off each call's own trace | `bedrock:global.anthropic.claude-opus-4-6-v1` |
| Model disagreements refused (DEC-2) | 0 |
| Per-tick latency, 3 narratives | 22–30 s |
| **Snapshot versions minted by writing 15 narratives** | **0** |

That last row is the B6 D4 proof, by row count on production. Five consecutive ticks:

```
tick 1   updated 2 · unchanged 13   narratives 3 valid, 12 deferred by the per-tick cap
tick 2   updated 0 · unchanged 15   3 reused, 3 valid, 9 deferred
tick 3   updated 0 · unchanged 15   6 reused, 3 valid, 6 deferred
tick 4   updated 0 · unchanged 15   9 reused, 3 valid, 3 deferred
tick 5   updated 0 · unchanged 15   12 reused, 3 valid, 0 deferred
```

The two updates on tick 1 are real: nothing had swept since 26 Aug and the calendar moved.
After that the board is steady, every subsequent tick writes **nothing** to a finding row,
and the narrative rail fills in three at a time behind its cap without ever touching a score.

A sample, exactly as the case page renders it (this is the whole paragraph, verbatim):

> This is a 30-year-old male presenting for a unilateral total hip replacement today, which
> is notably young for this procedure [F1][F2][F3]. His mFI-5 scores 2 to 3 out of 5, driven
> by the presence of diabetes mellitus and COPD or pneumonia, indicating a higher-than-
> expected frailty burden for his age [F6][F8][F9]. The Charlson Comorbidity Index is 2,
> reflecting contributions from chronic pulmonary disease and uncomplicated diabetes, and it
> should be noted that the mFI-5 and Charlson index share comorbidity inputs so these are
> correlated rather than independently confirmatory [F10][F11][F12][F16]. …

16 citations, all 16 resolving to one of 16 computed facts.

**What the model was shown**: the computed snapshot and nothing else — the factor tables,
the bounds, the missing list, the tier. Not the patient's name. Not the UHID. Not the source
prose. **Not the anaesthetist's conclusion**, which the page quotes verbatim in its own
banner and which no model paraphrases, because the surest way to keep a model from rewriting
a fitness verdict is never to show it one. The facts record only *that* a conclusion exists.

**One thing for V to rule on.** "…which is notably young for this procedure" is an editorial
gloss. Its citations are honest — F1, F2 and F3 do say 30, male, and total hip replacement —
but the *judgement* that this is notable is the model's, not the table's. Code cannot catch
this class: every sentence cites, and every citation resolves. If V wants it gone, the fix is
one line in the prompt, and it is worth deciding before the flag flips rather than after.

---

## 7 · The reasoning cap, measured

The first golden-set pass ran uncapped. Gemini 2.5 Pro spent **1,727 and 1,794 completion
tokens** on inputs whose entire source text averaged **140 characters**, at **43 s and 48 s**
per call — against a 60 s per-leg ceiling and an hourly cron.

`PREOP_EXTRACT_THINKING_BUDGET = 512` (env-overridable) fixed it: **4.5–8 s per call, 4–57
output tokens**, no measurable change in what came back. This is not a quality trade — the
task is to copy a verbatim span and name which of a fixed list it asserts — and every gate
that matters runs in code afterwards regardless.

The worker's box, with both rails on: 180 s of model budget checked **before** each leg
starts, plus the slowest deterministic tick ever measured (55 s) = 235 s against a 300 s
`maxDuration` on an hourly cron. The measured combined arm ran in **37 s**.

---

## 8 · Ten hand-checkable cases

The ten golden-set cases with the most model readings. `SCORED` marks a reading that
actually reached an instrument; everything else was proposed, kept, displayed, and moved
nothing. Every span is verbatim from the field named beside it.

| Episode · patient · procedure | Reading | Span |
|---|---|---|
| **`ZOo0P72ArYhQCZStdjs5`** · 75 M · Wound debridement (major) · CCI 4→5, **AMBER→RED** | **SCORED** peptic_ulcer_disease PRESENT 0.80 | `pac_other_history`: "TAB RABEPRAZOLE 20 MG" ⚠️ |
| ” | diabetes_mellitus PRESENT 1.00 | `pac_other_history`: "TAB VOGLIBOSE 0.3 MG" |
| ” | insulin_treated_diabetes ABSENT 1.00 | `pac_other_history`: "TAB VOGLIBOSE 0.3 MG" |
| ” | hypertension_on_medication PRESENT 1.00 | `pac_cvs_note`: "TAB TELMA 40 MG" |
| `ejOS2hzyOQlVUtGvPz1w` · 46 F · Lap chole + open hernia mesh · mFI 1–2→2 | **SCORED** functional_status_dependent ABSENT 0.90 | `pac_other_history`: "good effort tolerance" |
| ” | **SCORED** hypertension_on_medication PRESENT 1.00 | `pac_cvs_note`: "TELMA AM" |
| ” | diabetes_uncomplicated PRESENT 0.80 | `pac_endo_note`: "SINCE 5 YEARS - TAB GLYCOMET GP1 1-0-1" |
| `hKm9Ps8exetvR4PHuSBp` · 58 F · L4-5 laminectomy + fusion · mFI 0–1→0 | **SCORED** functional_status_dependent ABSENT 0.80 | `pac_examination`: "CONSCIOUS AND ALERT" ⚠️ |
| ” | 7 further absences, all agreeing with the booking form, none scored | `pac_other_history`: "CLAIMS NO COMORBIDITIES" |
| `hRwMa4j2htD8H63CGIGM` · 35 F · Lateral internal sphincterotomy · mFI 0–1→0 | **SCORED** functional_status_dependent ABSENT 0.90 | `pac_other_history`: "GOOD EFFORT TOLERANCE" |
| `rOesR54thmSqUMD8QrK7` · 27 M · Cystoscopy · mFI 0–1→0 | **SCORED** functional_status_dependent ABSENT 0.90 | `pac_other_history`: "GOOD EFFORT TOLERANCE" |
| `My8F6GpnStZo2t8C2jxh` · 42 F · Wide local excision · mFI 0–1→0 | **SCORED** functional_status_dependent ABSENT 1.00 | `pac_other_history`: "GOOD EFFORT TOLERANCE" |
| `KL6Xphc64tD2oJnGNlYt` · 30 M · Mallet finger correction · unchanged | 19 absences, none scored | `pac_other_history`: "NO KNOWN COMORBS" |
| `ST0GJpgqN84y8xcNvDsO` · 28 M · Cystoscopy / RIRS · unchanged | 19 absences, none scored | `pac_other_history`: "NO COMORBIDS" |
| `SV6qaj935VBxImllY6vy` · 45 M · Arthroscopic rotator cuff repair · unchanged | 12 absences, none scored | `pac_other_history`: "NO KNOWN COMORBIDITIES" |
| `9r4tLOzaean6T28MKdbQ` · 40 F · FESS + septoplasty · unchanged | diabetes + hypertension, both already known | `pac_endo_note`: "OHA" · `pac_cvs_note`: "ON TELMA H" |

Two ⚠️ rows are the ones I would put in front of an anaesthetist first: a PPI read as an
ulcer, and "conscious and alert" read as functional independence.

Note how many rows are *proposed and not scored*. That is the precedence rule working: the
booking form had already answered, the model agreed, and the reading is shown as
corroboration rather than replacing anything.

---

## 9 · Extraction hit and miss

| | |
|---|---|
| Cases with any text to read | 48 / 57 |
| Cases where the model returned a reading | 24 |
| Cases where a reading cleared the 0.80 confidence floor | 24 |
| **UNKNOWNs actually resolved** | **9** — functional_status ×8, dementia ×1 |
| Form-negatives overturned | 11 — hypertension ×4, hemiplegia ×2, and one each of dementia, connective tissue disease, any tumour, cerebrovascular disease, peptic ulcer |
| Proposals rejected by a gate | **0** |
| Polarity marks | **0** |
| Inputs flagged `unstable` | 0 in a single pass; **19 cases would flag on a re-read** (§5.1) |

**Insulin status — the RCRI ripening input — was resolved on zero cases.** The rail proposed
it four times and every proposal was *absent*, inferred from an oral agent; not one patient
in the golden set had insulin documented in a field this rail reads. That is a capture
finding, not a rail finding, and it belongs on the same governance list as PRD §9.3.

---

## 10 · What is on production right now

| | |
|---|---|
| `preop_findings` | 19 rows (15 upcoming + 4 whose surgery has passed) |
| `preop_finding_versions` | 3 |
| Rows carrying a narrative | **15**, all valid, all `bedrock:…claude-opus-4-6-v1`, all fresh against their snapshot |
| Rows carrying an extraction | **0** — every extraction measurement was a dry run |
| `PREOP_SURFACE_ENABLED` in production | **unset** |
| `PREOP_EXTRACT_ENABLED` in production | **unset** |
| `PREOP_NARRATIVE_ENABLED` in production | **unset** |
| Migration `0043` (rail columns) | **run**, twice, idempotent |

The 15 narratives are inert: the case route only serves when the surface flag is on, and the
case page only renders a narrative when the narrative flag is on. They were written by a
Preview tick so that "flag on ⇒ narrative renders" could be proven rather than asserted, and
they will be there ready if V flips the flag.

---

## 11 · Flagged for V

1. **The weak-form-negative ruling.** The kickoff says an extraction may only fill an input
   that is UNKNOWN; A1-6, ratified in the same kickoff, calls a closed-world absence a
   *weak* form-negative. Read strictly, the binding mockup breaks — Shobha K's ischaemic
   heart disease and hypertension are both pink EXTRACTED chips against a booking form that
   enumerated neither, and this module would score her RCRI 1 where the mockup says 2. So a
   deterministic **assertion** is immovable and a **silence** is the one absence a cited,
   above-floor extraction may overturn. The strict reading is one line away in
   `resolveInputs`, and the code says so at the line.
2. **A sixth deterministic source exists and is unmapped.** `individuals-prescriptions.comorbidities`
   is not free text — it is a structured array of `{comorbidity: {uid, name}}` ("High BP",
   "Thyroid Disorder"), filled on 9 cohort rows. It belongs in the deterministic map, not in
   the extraction rail. Flagged, not built.
3. **The OPD narrative source yields approximately nothing.** Wired because the kickoff names
   it; measured across the 855 non-draft cohort prescriptions, `relevant_medical_history` is
   filled on **0** and `doctor_notes` on **1**.
4. **`preop-assemble/1` was deliberately not bumped.** The resolution rule changed; the
   flag-off reading did not, proven by whole-snapshot equality and by the four mockup
   patients reproducing unchanged. The constant is inside the fingerprint, and bumping it
   would have minted a version row for every episode saying nothing happened.
5. **The narrative's editorial gloss** (§6) — cited, resolvable, and still the model's
   judgement rather than the table's.
6. **Three PAC UHIDs still do not bridge** to an Even individual (98 reports, 95 bridged).
   Unchanged since 26 Aug and still not blocking anything.

---

## 12 · The merge, in order

The Build Plan has V flipping `PREOP_SURFACE_ENABLED` before the merge. That cannot work —
a production flag cannot turn on code that is not on production. The order is:

1. V validates this pack.
2. **Merge `feature/preop-risk-agent` → main with all three flags OFF** (fast-forward, no force).
3. Verify the production deploy is green and `cat.evenos.app/care/preop` still **404s**.
4. **V flips `PREOP_SURFACE_ENABLED`** in Vercel production env.
5. Prod smoke: board renders · a case renders · Mark-reviewed round-trips · the chooser badge
   equals the needs-review count.
6. `PREOP_EXTRACT_ENABLED` and `PREOP_NARRATIVE_ENABLED` stay OFF until V decides separately,
   on §5 and §6.
