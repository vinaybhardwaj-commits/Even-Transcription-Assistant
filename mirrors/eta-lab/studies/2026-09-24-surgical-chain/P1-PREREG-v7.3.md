# SURGICAL-CHAIN-LINKER P1: pre-registration v7.3 (linker, 24 Sep 2026 19:00 IST): the link-3 judge, its wording, and the synthetic scale check

Addendum to v7.2; nothing earlier is edited. **No real pair has been scored and no patient text has left the box.** Code: `p1/link3_judge.py`, committed with this file; the synthetic run happens only afterwards. eta-refuter-2 (#698) named the route and its conditions; Fable has not yet confirmed the one new input type (item E4).

## E1. Route (rulings 35 and 42, refuter #698)
The content link is scored by Jev (`u9.ask`, the client the surgery review uses) on de-identified text only. Before any call, **both sides are de-identified locally** (`deid.py` as landed, then the `finalize.residual_identifiers` gate that refuses any text with an identifier shape, Indic script or an empty translation): the consultation transcript and the prescription's complaints and medications. The `even-jev` MCP tool is not used. Per item, **the redaction counts on each side are recorded**, because de-identification can remove a clinical word and depress a content score; an item whose key words were redacted is visible. The procedure name stays out of the prompt (`proc_used_in_link = false`, v1 section 5).

## E2. The question (frozen) and the synthetic scale check
One yes/no probability question, `same_visit`, wording in `p1/link3_judge.py` (`LINK_QUESTION`, verbatim there): do the transcript and the prescription's complaints and medications describe the same visit; yes only if the main complaint matches AND the prescribed medications are consistent; ignore any procedure named. The state is the transcript followed by the prescription text. **The score is the returned probability of yes, 0 to 1**, the scale v1 assumes (floor 0.50, margin 0.15).
**Synthetic scale check, 16 calls on invented pairs (no real person, no real text), acceptance fixed now:**
- 4 clear matches: p(yes) >= 0.70 for at least 3 of 4.
- 4 clear mismatches (a transcript against an unrelated prescription): p(yes) <= 0.30 for at least 3 of 4.
- 4 same-day near-decoys (a transcript scored against its own prescription and against a similar-sounding one: cough with cold against cough with wheeze, migraine against tension headache, gastritis against reflux, back strain against sciatica): own >= 0.50 and own minus decoy >= 0.15 for at least 3 of 4.
**If all three hold, the pre-registered constants stand.** If not, they are revised in a v7.4 from synthetic pairs only, never from real ones. The synthetic results are recorded in git (`P1-LINK3-SCALECHECK.json`): they contain no patient data.

## E3. Nothing else changes
The margin rule (v1 section 5: best room beats the runner-up by 0.15 and beats the doctor's other same-day Rx by 0.15; floor 0.50; SINGLE class), the same-week positives-versus-N2 comparison (v7.2 D1) and the per-item pipeline state (D3) apply as written.

## E4. Open for Fable before any real pair
Prescription complaint and medication text is a **new input type** to Jev (so far only consult transcripts). Ruling 42 covers "any ETA text" once non-doctor identifiers are removed; the refuter and I read it as covering this, but Fable is asked to confirm it explicitly (#690, #698). Until confirmed, only the synthetic check runs.
