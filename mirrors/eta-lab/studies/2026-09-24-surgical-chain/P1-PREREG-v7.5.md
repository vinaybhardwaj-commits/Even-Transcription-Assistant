# SURGICAL-CHAIN-LINKER P1: pre-registration v7.5 (linker, 24 Sep 2026): ONE pipeline for all 37 items in the class comparison (refuter #726)

Amends rule G2(1) of `P1-PREREG-v7.4.md`; everything else in v7.4 stands. **No real pair scored, no patient text sent.**

## H1. Why v7.4 G2(1) is changed
G2(1) fixed the pipeline per item (right within an item), but it lets the pipeline differ **between classes**: only the 4 fully covered items (2 positives, 2 no-procedure negatives) would run on production text and the other 33 on research-pipeline (HIST) text. That would put production-versus-HIST text differences into the positives-versus-N2 comparison. The parity study found whisper-level text variance (a clean fail on one clip set, "within noise" by 0.001 on another), so the difference is not negligible for a content score.

## H2. The rule, fixed now
1. **The pre-registered class comparison (positives against same-week N2, v7.2 D1) scores ALL 37 items on HIST text**, for every shortlisted room of every item. This adds the 4 fully covered items' shortlisted rooms to the transcription job: **10 room-windows, 5.7 audio-hours**. **Total job: 99 room-windows, 47.5 audio-hours at the pre-registered plus or minus 10 minutes** (v7.4 had 89 windows and 41.8 hours).
2. **Production text on those 4 items is a SECONDARY check**, scored with the same question and the same rules and reported beside the primary result; it is never pooled with it. It also gives a small direct HIST-versus-production comparison of link scores on identical items (4 items, 10 room-windows): a descriptive number, no test.
3. The rest of v7.4 stands: an item is `INCOMPLETE` if any shortlisted room lacks a transcript over at least half the window; source and pipeline state are recorded per item; HIST text is mining only (ruling 146).
4. **Order.** The transcription job may be staged, positives and N2 first (they carry the comparison), then N1 (descriptive only, v7.2 D1). The pilot on the 4 fully covered items on production text (after Fable's yes on prescription text as a Jev input, v7.3 E4) is a pipeline exercise and not a result.
