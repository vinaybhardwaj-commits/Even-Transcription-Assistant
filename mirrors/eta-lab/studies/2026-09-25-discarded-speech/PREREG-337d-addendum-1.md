# Ruling 337d: PRE-REGISTRATION ADDENDUM 1 (split-speaker, 25 Sep 2026, ~08:45 IST; before ANY service is called on these windows)
Origin: eta-refuter #1929 (HOLD). `PREREG-337d.md` (72e1394) stands except as changed here.

**The flaw.** The original positive controls were the 10 guard-accepted windows, whose accepted segments are ALL English; the plan forced them to Indic. Passing "REAL in >= 7 of 10" would test what forced-Indic ASR does to English speech, not whether the test detects faint INDIC speech that Silero missed.

**The fix.** New positive controls with KNOWN INDIC speech, chosen by `indic_controls.py` and frozen in `indic_controls_frozen.json` (before any service call):
- qualifying segment = engine sravaani/indicconformer, label kn or hi, dominant script = that language's script, readability score >= 0.60 (features only, no text used); window = >= 60 s of qualifying segments;
- TIER 1 (the low-SNR condition of the refused windows): >= 80 % of the window's qualifying segments follow the router's FIXED-WINDOW fallback plan, i.e. Silero heard nothing and the router still recovered Indic speech. 215 such windows exist, 211 in the rooms of the 30;
- SELECTION: the 10 rooms with most tier-1 windows among the 30's rooms, one tier-1 window per room drawn with seed 20260930 (kn 4, hi 6); measured over the union of the window's qualifying segments (first 300 s: 842 s in 25 chunks), with the window's OWN language forced (single language).
**Separation criterion, replaced:** the 10 INDIC POSITIVES must be REAL in >= 7 of 10 AND the 14 noisy no-text windows in <= 1 of 14. The 10 English accepted windows are still run (last, forced to Indic) and reported DESCRIPTIVELY, no pass/fail.
Everything else (arms, thresholds 5 words / 0.60 / 5 s / 20 %, K bands 6 and 2, chunking, diarizer) is unchanged. Caveat stated: the positives were transcribed by the same engine family as arm A1, so A1 agreeing on them shows detection power, not independence; the diarizer and A2 (whisper) are independent of that.
`plan_frozen.json` is regenerated (it now carries `indic_controls_sha256`); `discarded_logic.py` docstring updated (sha in the plan). No service has been called on any of these windows.
