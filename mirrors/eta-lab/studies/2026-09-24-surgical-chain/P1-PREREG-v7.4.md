# SURGICAL-CHAIN-LINKER P1: pre-registration v7.4 (linker, 24 Sep 2026): transcript sourcing for link 3 (hist-miner #689, #709)

Addendum to v7.3a; nothing earlier is edited. **No real pair scored, no patient text sent anywhere.** Inputs: hist-miner's shortlist for the 37 blind items and its transcript-coverage counts (box files `link3_shortlist.json`, `link3_prod_span.json`).

## G1. What the coverage counts say
Every item has a top-3 (or shorter) energy shortlist of candidate rooms (sizes: 28 items with 3, 6 with 2, 3 with 1). The shortlist is a gate, not a placement (validated 6/15 top-1, 14/15 top-3 on longer consults). **Production text exists in every shortlisted room for only 4 of the 37 items (2 positives, 2 no-procedure negatives); in some but not all for 7; in none for 26.** Production text in some candidate room exists for 13 items (5 positives, 8 no-procedure negatives, no advised-not-done item); the other 24 (15 positives, 7 no-procedure negatives, 2 advised-not-done) have none.

## G2. Rules, fixed now
1. **Same pipeline per item.** All shortlisted rooms of one item are scored on text from the **same** pipeline. An item with production text in every shortlisted room is scored on production text; every other item is scored on research-pipeline (HIST) text for **all** its shortlisted rooms. Mixing sources inside an item is not allowed: a room with production text could otherwise win on pipeline, not on content.
2. **INCOMPLETE.** An item is scoreable only if every shortlisted room has a transcript covering at least half of the pre-registered window (consult plus or minus 10 minutes). Otherwise it is `INCOMPLETE`: reported, and counted neither accepted nor rejected (a room with no text may be the true one, so it is not a loser).
3. **Source is recorded per item** (`production` or `hist`, with the engine and flags version and the before/after 24 Sep 04:39 gate state, v7.2 D3), and every link-3 table is split by source.
4. **HIST text is mining only** (ruling 146): it may find and score a candidate link, but anything that reaches a rater or becomes a label is re-transcribed on the production room path first.

## G3. What this needs, and what runs first
- **Scoring on production text needs no new audio:** 4 items (2 positives, 2 no-procedure negatives), once Fable has confirmed prescription text as a Jev input (v7.3 E4). It exercises the route and the margin rule; it is not a result.
- **The other 33 items need 89 room-windows** (every shortlisted room), about **41.8 audio-hours at plus or minus 10 minutes** (hist-miner's 64-window figure covers only the 24 items with no production text; the same-pipeline rule adds the 9 partly covered ones). The window stays plus or minus 10 minutes (v7.3a); a shorter window would need a v7.5 first.
- **Who runs it** is Fable's call between hist-miner's routers, hist-bulk's queue (priority windows) or both.
