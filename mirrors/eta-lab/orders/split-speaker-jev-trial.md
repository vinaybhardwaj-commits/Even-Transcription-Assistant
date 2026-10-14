# ORDER — split-speaker — Jev prompt trial: can it tell real speech from noise, by the words?

Read the findings ledger first. V suggested using Jev. **Jev reads text, not audio** — it cannot compare
voices or hear anything. But it is explicitly built to judge *"is this transcript garbage"*, and that
is a second, independent signal for the noise-as-speech problem: Silero judges the **sound**, Jev
would judge the **words**. Speech recognisers hallucinate stock phrases on silence and fan noise;
real consultation text looks different.

## Step 0 — check the material exists before anything else
Do the segments we care about **have transcript text at all?** The 7,548 closed-hours segments were
diarized, but transcription is a separate pipeline and 2,513 windows have no clip. Count, for:
(a) closed-hours segments with any transcript text; (b) clips V affirmed in v1–v6 with transcript text.
**If either set is too small to trial on, stop and say so** — then the plan needs transcription first,
and that is a different conversation.

## If the material exists — prompt trial only, nothing wired
Use Jev from this pane directly (the `even-jev` MCP is installed on the Mini).
- **Labelled truth, free:** closed-hours segment text = **noise by construction** (no consultation
  happens 21:00–07:00). V-affirmed clip text = **real speech** (he only affirmed when a voice was
  present and identifiable).
- **Write 3–4 candidate `noul` questions** asking whether the text is genuine human conversation or
  a speech recogniser's output on noise/silence. Criteria must describe concrete situations, not
  degrees. No worked examples inside the instructions.
- Run them on **a small fixture set** — 5–10 of each class, covering the hard edges: very short real
  utterances ("haan", "okay"), and noise that produced plausible-looking words.
- Record question ids, wording, probabilities and confidence in
  `docs/handoff/scratch/jev-prompt-trials-21-SEP-2026.md`.
- Report which wording **separates** the two classes, and where it fails.

## Hard constraints from the Jev skill
- **English only.** Many consults are Hindi, Kannada or code-mixed. Translate first, or exclude and
  **count what you excluded** — do not let untranslated text quietly depress the result.
- **Strip the state to what matters.** Pass the segment text and nothing else — no names, no room,
  no timestamps. Accuracy falls with noise, and it keeps patient context out of the call.
- **Log metadata only** — question ids, probabilities, token counts. Never the text in logs or reports.
- This is a **trial, not a benchmark.** Do not report precision/recall as if it were production-ready;
  a real bench on a large labelled set comes later, before anything is wired.

## Not allowed
Wire nothing into production. Change no flag. Enrol nobody. Do not print transcript text anywhere,
including the trial file — ids and probabilities only.

## Output
Step 0 counts; the winning wording and its separation; the failure cases by kind; excluded-language
count. Append the Step 0 counts to the ledger. CAP 250 words.
