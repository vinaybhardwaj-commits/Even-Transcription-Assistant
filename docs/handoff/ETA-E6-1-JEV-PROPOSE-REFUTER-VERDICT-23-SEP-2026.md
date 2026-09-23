# ETA — E-6.1, Jev proposes where acoustics proposed none. REFUTER VERDICT. 23 Sep 2026

`vinay/e6-1-jev-propose` **@ `b05ac71`** (builder lx), one commit on `4129768`. Order: Fable, relayed by V. Own detached worktree `/tmp/refute-e61`, HEAD asserted, clean after every run. No flag enabled, no migration, no database touched.

## PASS-WITH-FIXES — one demonstrated finding, and it is the plan's own J-A failure

**The design is Fable's order and I am not reopening it.** What follows is what the implementation permits, measured against a safety principle the plan states in its own words.

### FINDING — a run in which the acoustics heard nothing at all still proposes an encounter

**Demonstrated**, not argued. Three probes, every one acoustically `unjudged` (`reason: "no_energy_evidence"`), with a textbook Jev consultation on top — a U2 start of 0.95 on the greeting, a U2 end of 0.95 on the closing:

```
proposed = 1   speech_probes = 0   unjudged_ms = 180000   closed_by = "content_boundary"
```

**An encounter is proposed from zero acoustically-confirmed speech.** Three minutes the gate could not confirm contained any sound at all, asserted as a consultation on transcript text alone.

**Why nothing stops it.** `eligible()` requires only `j && inConsultation(j) && !inAcoustic(i)` — Jev's judgement and the absence of an acoustic encounter. It never asks what the acoustic gate made of the probe. The trim then removes only `non_speech` from the edges:

```
while (a <= b && probes[a]!.verdict === "non_speech") a++;
while (b >= a && probes[b]!.verdict === "non_speech") b--;
```

`unjudged` is deliberately kept — `encounter-fusion.test.ts:276` says so, with the rationale **"no evidence is not silence"**. That reasoning is right, and in the case it tests the run still contains `speech_probes: 3`. It does not cover the run that contains **none**.

**Why the state is reachable, from this programme's own record.** Both halves are documented here:
1. A window whose level log is thin or missing makes the acoustic gate return `unjudged` — the same `no_samples` / `thin_coverage` condition behind the level gate's `unknown` that I reviewed on the diarize branch this morning.
2. Whisper producing text for a silent window is a failure mode this programme has chased all week — residual loops, the `low_signal` marker, the assembled-collapse fix.

Put together: **thin level log + hallucinated transcript = a consultation that never happened**, carrying a real start and end time, with `origin: 'jev'`.

**This is PLAN-v3's own J-A finding.** §1.1: *"Jev judges meaning; acoustics judge sound. Never ask Jev whether text was invented from silence or noise."* §3 records J-A as the one real-data FAIL: *"a text-only judge cannot tell invented-from-silence text from speech."* A proposal resting on zero speech-judged probes asks Jev exactly that question.

**The trigger is the obvious next step, which is what makes this worth raising now.** The replay found 0 proposals on 3 room-days because U2 start maxes at **0.86** against a `START_P` of 0.9, and lx flags (e) that `END_P` and `JEV_MIN_RUN` are provisional. The natural response to "nothing fires, and the ceiling is 0.86" is to lower the threshold — and that is the moment this path opens. The feature is inert today and the reason it is inert is the reason it will be tuned.

**Fix, minimal, and it does not reopen the order.** Require at least one probe in the surviving run to be acoustically `speech`. The order says Jev may propose *"even without an acoustic boundary"* — it does not say *without acoustic evidence of sound*, and the two are different claims. An encounter nobody heard is not an encounter. That keeps §1.1 intact: acoustics judge sound, Jev judges meaning. One line, one test, and the test should be the all-unjudged case above, which currently has no coverage.

### Credit — the row carries the evidence for its own weakness

`speech_probes: 0` and `unjudged_ms: 180000` are **stored on the encounter**, so a reader can filter these out without new plumbing. That is the same discipline as `centroids_offered` on the diarize branch: the claim carries what is needed to check it. Worth saying, because it turns my finding from "undetectable" into "unfiltered", which is a much smaller problem — and it means E-7 can exclude zero-speech proposals from its comparison today, whatever is decided about the rule.

### What holds

- **The constants are pinned** — `JEV_MIN_RUN` 3, `END_P` 0.9, `FUSION_VERSION` `encounter-fusion-v1.1` all asserted.
- **A Jev-unjudged probe breaks the run** (`:239`), so a gap in Jev's own answers cannot be spanned. Note this is *Jev*-unjudged, a different thing from the acoustic `unjudged` in the finding — the two words carry different meanings in this file, which is itself worth a comment.
- **No proposal inside an acoustic encounter** (`inAcoustic`), so the two mechanisms cannot double-count.
- **A second start before an end abandons the run** as `unclosed` rather than merging two patients.
- lx's five flags (a)–(e) are all genuine interpretation calls the order left open, and each is the reading I would have taken. (b) in particular — requiring both markers and inventing no end — is the conservative choice.

### Their evidence, quoted as theirs

Gate `20260923T120959Z-b05ac71-24330` on the E2E box, rc=0, 188 files, 4177 passed, 1 skipped, build compiled. 15/15 mutants killed, each confirmed against a baseline through the same harness — and **two survived a first pass** (an end at exactly 0.9, and U1 "none" at the caution band), both closed with tests. I did not re-run their gate. Their replay result — 0 proposals, 0 runs even opened, start maxing at 0.86, and 7 of 14 truth consults containing no transcribed probe at all — is reported honestly as proving nothing either way, which is the correct reading.

## Verdict: PASS-WITH-FIXES
The implementation is careful, the interpretation flags are the right ones, and the stored row already carries what is needed to detect the weakness. The finding is that "acoustics then trims it" — the order's own safety clause — does not constrain the case where the acoustics heard nothing, and that is the case the plan's J-A finding warns about by name. It is one line, it is not urgent while the rule is inert, and it should be closed **before `START_P` is lowered**, because lowering it is what makes the path live.
