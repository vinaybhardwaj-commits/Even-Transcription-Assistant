# r414.2 FROZEN Jev wording (split-speaker, 25 Sep 2026, before any run)

Single source: `jevcfg414.py` (sha256 posted to eta-refuter + bus BEFORE the run).
Model: jev-latest (trials answered on jev-1.13.0). Batches of 8 items.
SOURCES = THE PAGE SEEDS V SEES (#2834; equivalence to my scoring sheets verified
200/200 + 106/106 texts and langs, hashes in the bus post): label200
~/eta-data/readability/r1/label-page-seed/seed_docs.json (id L001..L200), ba106
~/eta-data/pair-label/ba106/seed_docs.json (id P001..P106), rate20 seed2 (R01..R20).
Gloss keys = those ids. Shapes accepted by build_batches: label200 {L###: str}; ba106
{P###: {"A": .., "B": ..}} (lab-viewer shape) or [gA,gB]; rate20 excerpt-grain
{R##: str} or line-grain [per NON-EN line] joined by \n.

## Binding rule discovered in trials (why wording must not drift)
Multiple items may share one state ONLY if each question's instructions name its state
key ("Answer ONLY about the state entry named L###"). Without it, Jev sees the whole
state and every answer collapsed flat (~P 0.25-0.35, one class dominated, conf ~0.2).
That failure mode is reproduced in JEV-414-TRIALS.md and is why the `{K}` substitution
is part of the frozen artifact, not the caller.

## label200 — version lv1.2 (choice; lv1.1 + eta-refuter #2838 fix 1 + readable tweak, Fable 415b adopted)
State entry: `claimed_lang`, `text`, `gloss_en`.

instructions: "One line from a clinical speech-to-text transcription: claimed language,
original text, literal machine English gloss. Judge the LINE ITSELF (not gloss
quality): is it usable as a transcription of real speech in this corpus? Answer ONLY
about the state entry named {K}; ignore every other entry in the state."

- readable — "Coherent clinical speech in the claimed language and its usual script; the line itself reads as a sensible sentence (the gloss may help)."
- romanised_readable — "An Indic language written in Latin letters that a fluent reader of that language can follow; imperfect spelling or spacing is fine."
- garbled — "Not coherent in any language: word salad, looped repeats, fragments, or a gloss that shows nonsense."
- wrong_language — "Fluent, coherent text whose language or script is plainly not the claimed language. Claim 'und' means the engine gave no language; there, coherent clinical speech in English or in any Indic language is readable (or romanised_readable). Only a non-clinical register (song lyrics, verse, video or subtitle phrases, stock lines such as 'thank you for watching') is wrong_language."
- cannot_tell — "Too short or ambiguous to judge either way."

Gate unit settled by Fable 415/415b: usable = {readable, romanised_readable} vs not =
{garbled, wrong_language}; V unsure/skip excluded; Jev cannot_tell on a judged item =
NOT agreeing, count reported beside the gate (guard #2838(c)).

## ba106 — version bv1.2 (choice; bv1.1 + eta-refuter #2838 fix 2, Fable 415b adopted)
State entry: `claimed_lang`, `text_A`, `text_B`, `gloss_A`, `gloss_B`. Blind A/B,
position of old vs re-run NOT given (same blindness as the human sheet).

instructions: "Two candidate transcriptions A and B of the SAME utterance are given, each
with a literal machine English gloss. You cannot hear the audio. Judge which
candidate is more plausible as a transcription of a real clinical utterance in the
claimed language. Do NOT prefer a candidate for being fluent if it reads like a
generic stock phrase unrelated to a clinical conversation (greetings to viewers,
subscriptions, lyrics, repeated sentences). If you cannot tell which is closer,
answer cannot_tell. Answer ONLY about the state entry named {K}; ignore every
other entry."

- A_better — "A is clearly more usable as a transcription of the utterance than B."
- B_better — "B is clearly more usable as a transcription of the utterance than A."
- same — "Both candidates are each readable, coherent transcriptions of the utterance with no clear edge to either."
- neither_readable — "Neither candidate can be read as a transcription of anything: if both are unusable, choose this and not same."
- cannot_tell — "The comparison cannot be decided from the material."

## rate20 — version rv1.1 (choice)
State entry: `langs`, `text` (the excerpt's lines joined), `gloss_en`.

instructions: "An excerpt of several lines from an ambient room transcription, with
its claimed languages and a literal machine English gloss. Is the excerpt readable as
clinical speech by someone who knows the language? Answer ONLY about the state entry
named {K}; ignore every other entry."

- yes — "The excerpt reads as coherent clinical speech (native script or romanised) throughout."
- partly — "Only some lines are usable; the rest is filler, loops, or broken."
- no — "The excerpt is not usable: incoherent, looped, or nonsense per the gloss."
- cannot_tell — "Too short or ambiguous to judge."

## Output contract
`merge_answers.py` writes per set, 0600: `{KEY: {label, conf, probs, version, batch}}`
under `~/eta-data/readability/jev414/`. Keys: label200 `L001..L200` (sheet order),
ba106 `P001..P106`, rate20 the seed R ids. lab-viewer stratification: consumes the
label200 + ba106 files directly (ids + label + conf only, no text).
Merge aborts on: missing answer file, DROPPED key (observed real), duplicate, choice
outside the frozen criteria, wrong count. Nothing is retried silently.
