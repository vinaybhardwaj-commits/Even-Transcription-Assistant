# ETA — M5 VERDICT · ENGINE QUESTION STILL OPEN
**14 September 2026 · Orchestrator · ruling**

## 1. M5 is accepted as measurement and rejected as a verdict

The alignment work is sound: global word-level Levenshtein, 2,367 matches against edit distance 447,
difflib correctly rejected at ratio 0.30 with its false 1,705-word route-only block named and kept. The
§1.3 newline correction (982, not 966) is accepted, and so is the M4 flag that `\w` had been dropping
Indic vowel signs. The decomposition closes exactly: 795 − 110 + 62 + 235 = 982.

**But the decision rule I wrote into the M5 kickoff was wrong, and M5 is what proves it.** I said: if
`whisper_only` clusters in (a) and (b), route is right to suppress; if it clusters in (c), route is
dropping real content. (c) came back dominant at 521 of 795 characters — and that is not evidence of
dropping, for two reasons M5 itself supplies.

**First: rule (b) was blind by construction.** It could only consult route's `language_timeline`, which
carries **4** language changes against a clip with **26** non-English passages. The 388 characters of
romanised Indic sitting in (c) are the (b) case that (b) could not see. A bucket defined by a broken input
cannot carry a verdict.

**Second, and dispositive: the `replace` blocks were not examined.** M5's own "Not checked" list names
them. 53 blocks carry 242 whisper words against 220 route words. If route rendered those passages in native
script, a unit-cost aligner with no script-awareness pairs some native-script route tokens against whisper's
Latin ones as `substitute` and leaves whisper's surplus unpaired as `whisper_only` — producing precisely the
signature M5 reports. Route emitting native script and route emitting nothing are opposite verdicts with the
same alignment fingerprint. Until the blocks are scripted, the 795 characters do not distinguish them.

## 2. The synthetic clip cannot decide the engine question at all

Whisper looped **3 times, 51 characters** on this clip. On real room audio on 13 September it looped in
roughly **44% of non-empty jobs** — 1,126 jobs, 4,363 repeat segments, 404 in-segment loops. The clip
under-represents whisper's known failure mode by orders of magnitude, so a comparison run on it measures
route's costs against almost none of whisper's. Route's entire measured benefit here is 51 characters of
suppressed repetition, bought at 8.30× wall-clock. That ratio is an artefact of the fixture, not a finding.

**No engine verdict will be issued from synthetic audio.** The 13 Sep whisper arm on real windows already
exists; route's arm on the same windows does not, and it costs about 57 minutes of Mini time for ten
windows. That measurement is now the only thing that can close S7's Whisper probe question.

## 3. Findings that stand on their own, independent of the bake-off

**Route's `language_timeline` reports 4 changes for 26 non-English passages.** Whatever the engine verdict,
this is a defect. If the timeline drives per-segment engine selection, it explains both the missing Indic
text and much of the 8.30×; if it is recorded after the fact, it is still unusable as the input to any gate,
sanitize rule or audit that consumes it. PRD v1.2 S16's score step must not depend on it until it is fixed.

**Whisper romanises Indic speech.** 625 characters across 9 spans are Kannada, Tamil and Telugu rendered in
Latin letters. Whether or not route drops them, whisper's output is not in the script the encounter
transcript needs, which is a mark against treating whisper-alone output as the slow lane's decode.

## 4. Ruled

1. **M5 closes as measurement. The engine question stays open.** PRD v1.2 S22 remains provisional.
2. **M6 is issued** (`ETA-M6-SCRIPT-CENSUS-CC-KICKOFF-14-SEP-2026.md`): a script census of the 53 replace
   blocks, the 20 whisper_only spans in context, the per-segment engine selection across all 32 segments,
   and the timeline verbatim. Read-only, no Mini service calls, no git. It decides §1's fork.
3. **M7, the real-audio arm, is the decisive experiment** and is queued behind the S1 merge, not before it.
   Ten real room windows through route, against the 13 Sep whisper measurement on the same windows.
4. **Route's language timeline is logged as a defect** against the router, not against this round's build.
