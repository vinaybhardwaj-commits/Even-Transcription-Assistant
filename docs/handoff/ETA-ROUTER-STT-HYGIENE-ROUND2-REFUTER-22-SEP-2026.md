# ETA — router STT hygiene round 2 (F1, F2). REFUTER VERDICT. 22 Sep 2026

`~/eta-router` `vinay/router-stt-hygiene` **@ `fe2fca3`** (builder lx), on top of `d4cc9ca`. `router_server.py` +122/−35, `test_stt_hygiene.py` +61. Reviewed in my own detached worktrees `/tmp/refute-rsh` and `/tmp/refute-rsh-mut`. Production `:8083` was not touched and no live server was started: the change is pure functions. The MiniBot whisper-shim was not edited. Real-data runs printed counts only.

## PASS

Both round-1 findings are fixed as ordered. What remains is low, and one item is worth a small follow-up.

### F1 — the word-set rule is gone; only identical-after-fold contiguous segments are dropped
Probes on `collapse_segments` (my own inputs):

| case | kept |
|---|---|
| swapped-dose pair | 2/2 |
| morning / night pair | 2/2 |
| "Yes." / "Yes.", 2.1 s apart | 2/2 |
| "Yes." / "Yes.", speakers A and B | 2/2 |
| "Take two." then "Take two tablets at night." | 2/2 |
| "Yes." / "Yes.", no speaker, 0.3 s apart | 1/2 (by design: the router's segments carry no speaker today) |
| "okay okay" ×3, within 1.5 s | 1/3 |

Mutation R7 (word-set rule restored) is **killed**. Idempotence fuzz: 0 of 2,000 lines and 0 of 2,000 segment lists change on a second pass.

**Re-measure (counts only):** on the same **897 runs** as round 1, the strict rule matches **2,186** consecutive line pairs, exactly the round-1 "identical after folding" target. lx's 2,191 is the same count on today's **905** runs. Stored text has no timings, so the 1.5 s gap rule cannot be applied here; 2,186 is an upper bound on what the router would drop.

### F2 — numbers are not collapsed as repeated words
"take one one one after food", "take two two two tablets", "5mg 5mg 5mg", "१० १० १०", and Devanagari and Kannada-script three-times are all **kept**. R5 (phrase minimum 8 → 1) is **killed**.

### FINDING 1 (low, follow-up worth doing) — the number list is incomplete
Collapsed to one word: thirteen–nineteen (except fifteen), sixty–ninety, lakh, and Hindi gyarah, bees and sau. The English cardinals are a closed set and cheap to complete. Real data: **0** triples of any unlisted number word in 906 runs.

### FINDING 2 (low) — a repeated phrase that contains a number still collapses
"one tablet one tablet one tablet" → "one tablet". The order asked only for the word-repeat case, and a three-times phrase is usually a Whisper loop. Real data: **3 lines** in 906 runs.

### Mutations — 13 of 18 killed
Killed: R1, R4, R5, R7, G1 (gap 1.5 → 100), S1 (no speaker check), N1–N4, N6, N8, E1 (kept span not extended).
Survived, all low:
- **R7b**: a prefix match counts as a duplicate. Nothing pins "a longer line that extends the previous one is kept"; my probe shows it is kept today.
- **G2**: an unknown gap is treated as small. Moot today: every router segment has `start_s` and `end_s`.
- **S2**: speaker only on one side. Moot today: no speaker field.
- **N5, N7**: individual list entries (Devanagari *teen*, romanised *mooru*) are unpinned. The tests sample one entry per list.

### Still open outside this repo
The shim (`~/.local/bin/whisper-shim.py`, MiniBot) still has the word-set rule and the number collapse. The router skips its own pass on `shim_collapse: true`, so shim-collapsed text keeps the old behaviour. The fix is the shim owner's.

## Gate
`python -m unittest discover` (temp `ETA_JOBS_DIR`): **110 passed**.

## Jev — condensed diff, none of my findings in its context
Scores 6.6–7.4.
- **testQuality 6.6**, "changed behaviour lacks coverage" — **confirmed** by R7b and N5/N7.
- **correctness 6.8**, "an unsafe assumption" — **consistent** with Findings 1–2. The generic text names neither.
- **documentation 6.6** — **discounted**: I sent Jev a condensed diff with the code comments removed.
- **changeability 6.9**, "hidden dependencies" — **consistent**: the same rules live in the shim, which is not changed.
