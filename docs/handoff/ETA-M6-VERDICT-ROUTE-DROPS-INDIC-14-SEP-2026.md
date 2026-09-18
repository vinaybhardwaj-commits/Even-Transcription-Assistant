# ETA — M6 VERDICT: route drops Indic speech, and the mechanism is identified
**14 September 2026 · Orchestrator · ruling. Closes the fork M5 left open.**

## 1. The fork is closed, and my earlier lean was right for a reason I had not earned

M5 left two hypotheses with the same alignment fingerprint: route transcribed the Indic passages **in
native script** (so whisper's surplus was a spelling difference), or route emitted **nothing** for them.
M6 separates them decisively:

- Route's entire 900-second output holds **17 Kannada tokens, 103 characters**, all inside one segment.
  **Zero** Devanagari, Tamil or Telugu. Whisper-alone holds **no native script at all**.
- Only **5 of the 53 `replace` blocks** pair Latin whisper text with non-Latin route text — 66 characters
  against 103, all in that same segment.
- Of the **625 characters** of romanised Indic whisper produced, **0** sit within 5 route tokens of any
  non-Latin route token. **All 625** sit where route's output is Latin-only.

**Route did not render those passages in another script. It does not have them.** The transliteration-pair
hypothesis accounts for 66 characters out of 795.

## 2. The mechanism — a defect, not a tuning problem

From `~/eta-router/router_server.py`, read-only:

- **`:439–443`.** When whisper's English passes `looks_real_english`, an Indic result overrides it only if
  it contains Indic script **and** is at least `max(24, 1.8 × whisper chars)` long — where *whisper chars*
  is the whole **segment's** English text.
- Segments run to ~30 s. A 6–11 s Kannada passage inside a mostly-English 30 s segment **can never** be
  1.8× the length of that segment's full English text. IndicConformer therefore cannot win unless a segment
  is almost entirely Indic.
- **Result: 0 of 32 segments went to IndicConformer.** Whisper took 30, SraVaani 2.
- **`:394`** compounds it: IndicConformer stops after the first candidate (`kn`) when English looks real and
  that candidate returned nothing.
- **`:504–505`** builds the language timeline **after** each segment's engine has already been chosen. So
  the timeline does not drive selection — **my earlier suspicion that it did is withdrawn.** It is a symptom
  (4 changes recorded against 26 non-English passages), not a cause.

**The unit is wrong, not the constant.** Lowering 1.8× would be tuning around a wrong denominator — the
same error as the throughput arithmetic I got wrong on 14 Sep. The comparison is per **segment**; the
phenomenon is per **passage**. The honest fixes are to segment finely enough that a code-switch gets its
own segment, or to run the override per detected Indic-script span. Either is a router change.

**Second defect, smaller:** segment 11 was won by SraVaani with **Latin-only text labelled `und`** —
`guess_indic_lang` returns `und` when no Indic script is present. A third engine romanising Indic speech
and reporting "undetermined" is the same disease.

## 3. What this does and does not decide

**Decides:** as configured today, **route is an English transcriber with an Indic path that almost never
fires.** For code-mixed OPD speech — the actual clinical input — it emits nothing where whisper at least
emits a romanised approximation. That is a worse failure than a loop, because a loop is visible and a
silence is not.

**Does not decide the engine question.** Whisper's answer to the same audio is romanised Indic, which is
not the script the encounter transcript needs, and on **real** room audio whisper loops in ~44% of
non-empty jobs (13 Sep: 1,126 jobs, 4,363 repeat segments). Both arms are unacceptable for different
reasons. **PRD v1.2 S22 stays provisional.**

## 4. Ruled — and a reordering, with the reason stated

The tempting move is to fix the router first and measure after. **Rejected.** This clip is
English-dominant by construction; whether the override bug actually fires on real OPD speech depends on how
Indic-dominant real segments are, and that is unmeasured. Fixing first and measuring after would design
around an unmeasured constant — the error this programme has now made three times.

1. **M7 goes ahead next as scoped** — ten real room windows through route, against the 13 Sep whisper
   measurement on the same windows — **extended to record, per segment: the winning engine, the detected
   language, and a script census of the output.** One run then answers three questions: does the override
   bug fire on real speech, what is whisper's real loop rate on these windows, and what is route's.
2. **The router fix waits on M7's evidence** and is scoped then, at the segmentation boundary rather than
   the threshold.
3. **Route's language timeline is withdrawn as a suspected cause** and logged instead as an unreliable
   output: 4 changes against 26 passages. Nothing may consume it as ground truth — not a gate, not a
   sanitize rule, not S16's score step.
4. **M6 is accepted as measurement.** Its script-census method — first-letter-of-Unicode-name per token,
   predominance by characters of script-bearing tokens — is the method M7 reuses, unchanged, so the two are
   comparable.

## 5. Owed, not forgotten

IndicConformer's and SraVaani's **losing** outputs are discarded per segment and are not in the route JSON.
If M7 shows the bug firing on real audio, capturing those losing outputs becomes the cheapest possible
evidence of what route is throwing away, and needs Mini calls to retrieve.
