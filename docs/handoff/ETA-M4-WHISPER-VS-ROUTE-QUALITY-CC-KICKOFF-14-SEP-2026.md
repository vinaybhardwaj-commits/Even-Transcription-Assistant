# ETA — M4 (REVISED): DOES route's 8.3x BUY QUALITY? — CC KICKOFF
**14 September 2026 · Session: `scribe3` · Mini only. READ-ONLY: no code change, no env change, no restart.**
**Supersedes the first M4 kickoff, which you correctly refused to guess your way past.**

## 0. Two corrections, both mine

1. **The file I named does not exist in any working tree.** `STT-SANITIZE-REPEAT-RATIO-13-SEP-2026.md`
   lives only on **PR #1** of `Even-Scribe-Architecture`, which was never merged. I read it from the pull
   request and then cited it as if it were checked out. Your search was right and so was the stop.
2. **Even on that branch it contains no definition to look up.** Its §6 asks a builder to *report back*
   "repeat-ratio definition … and the threshold used". It was always an open item. **So I define it here.**

## 1. The definitions — use exactly these, invent nothing

**Normalise** both transcripts identically before measuring: lowercase; collapse runs of whitespace to one
space; strip punctuation except `.`, `?` and `!`; tokenise on spaces.

**A. Phrase loop (the primary measure — works on joined text, so both paths can be compared).**
A *loop* is a maximal run in which one n-gram of **n = 3 to 12 words** repeats **3 or more times back to
back** with no tokens in between. Three, not two: PR #1 records the observed signature as "phrases loop,
often three times", and two repeats occur in ordinary speech.
- `loops` = number of such runs.
- `redundant_words` = words in loops beyond the **first** occurrence of the n-gram.
- `redundant_chars` = characters those redundant words occupy in the raw joined text.
- `collapsed_text` = the raw text with each loop reduced to one occurrence of its n-gram.
- **`repeat_ratio` = redundant_chars ÷ total_chars of the raw joined text.**

**B. Repeated sentence (supplementary, also on joined text).** Split on `.`, `?`, `!`. Count runs of
**2 or more consecutive identical** normalised sentences; report the count and the characters beyond the
first occurrence. This carries the spirit of "consecutive identical segments" without needing segments.

**C. Consecutive identical segments — `route` ONLY.** You are right that the two sides cannot be compared
on segments: whisper-alone returns one joined `text`, and the router's segments are VAD spans of up to 30 s
rather than whisper's own. **Do not manufacture segments for the whisper side and do not re-run whisper in
another response format.** Report C for `route` alone, labelled as route-only, and say in one line that it
has no counterpart on the whisper side.

**No threshold.** PR #1 leaves it open and one synthetic clip is not the place to set it. Report the ratios;
the threshold is a separate decision on real room audio.

## 2. Inputs

Reuse the two saved M3 transcripts: `scratchpad/m2/m3-whisper.json` and `scratchpad/m2/m3-route1.json`.
**First copy both to `/Users/vinaybhardwaj/dev/Even-Transcription-Assistant/docs/handoff/scratch/`** — they
sit under `/private/tmp`, which macOS clears, and they are the evidence for this ruling. They are `say`
output, not consultation audio, so keeping them is safe. Name the copies in your report.

## 3. Report, side by side

For each path: total chars · loops · redundant_words · redundant_chars · **repeat_ratio** · chars after
collapsing · repeated-sentence count and chars. Plus, route only, measure C.

**THE KEY NUMBER — partition whisper-alone's 966 extra characters into two plain numbers:**
how many fall inside text that rule A or B removes, and how many survive collapsing as content that
`route` simply did not produce.

## 4. A null result is a valid result — do not work around it

This clip is clean `say` speech. Whisper's loops are provoked by **silence, noise and code-mix**, which a
synthetic clip largely lacks. **Zero loops on both sides is an expected and useful outcome** — it means this
clip cannot settle the question and the decisive comparison must run on real room audio. Report that
plainly if it happens. Do not hunt for a threshold or a rule that produces a non-zero number.

## 5. Do not

Judge clinical or linguistic quality · recommend an engine, setting or architecture · change code, env,
models or config · restart a service · send any request to the Mini's services (this order needs none) ·
run git in the app repo · quote more than short fragments (safe here: the clip is synthetic — say so if you
quote any).

## 6. Report

`docs/handoff/ETA-M4-WHISPER-VS-ROUTE-QUALITY-14-SEP-2026.md` (overwrite your stop report; file only, no
commit), at most 450 words: the two-column table · the §3 partition as two plain numbers · the scratch copy
paths · what you did not check.
