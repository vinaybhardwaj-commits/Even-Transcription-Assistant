# Phase L extension to 9-15 Sep (ruling 247a) and batch 1b (vj-link, 24 Sep night)

No names, no text. PHI-free ids/numbers: `extension/`. Cards/audio: box `~/eta-data/voice-linkage/batch1b/` (key in `batch1b-key/`).

## What was added
- **9-15 Sep, 29 room-days, 973 windows**: these days have diarizer segments in Neon but NO production clip key and NO production transcript. Audio rebuilt from R2 chunks (`rebuild_window.py` / `rebuild_room_days.py`, kit/clip_fetch_core method: output-side seek, gap-closed concat, no padding). **Feasibility test** against 3 windows that have production clips: length equal to 0.1 s, lag <= 20 ms, normalised correlation 0.96-0.99 at the start, middle and end (no drift). 973 of 973 windows rebuilt, none refused.
- Turns = diarizer segments (`stage_seg.py`, text empty), PQM pulled for 9-15 Sep, no Rx (empty), dense ECAPA on the T4 (`embed_gpu.py`), edge alignment + voicelink real and placebo. No Rx step and no Jev on these days: a link there cannot be HIGH.
- Grouping over **70 room-days** (9-24 Sep), complete linkage (every pair cos >= 0.85).

## Result
| | 41 room-days (18-24 Sep) | 70 room-days (9-24 Sep) |
|---|---|---|
| voice groups | 82 | 122 |
| cross-day groups | 23 | 36 |
| staff candidates among them | 20 | 35 |
| cross-day + exclusive + n >= 5 | 3 | 1 |
| HIGH / MED (before Jev) | 1 / 2 | **0 / 1** |
| largest group | 27 room-days, 15 doctors | 27 room-days, 15 doctors |
- **The batch-1 HIGH and both MED voices become staff candidates**: the HIGH voice recurs on 4 room-days and matches 3 different doctors; the MED voices on 5 and 4 room-days matching 4 and 3 doctors. The only surviving MED is doctor F092 (2 room-days, 496 core turns; no Rx text on those days), the one whose stored room-mic voiceprint matched 0.61/0.64.
- K1 (a recurring voice is staff, not the doctor) at scale: 35 of 36 cross-day voice groups match more than one doctor.
- The placebo suite (`REPORT-PLACEBO.md`) covers 18-24 Sep only; it was not re-run on 70 room-days.

## Cards
- **Batch 1 evidence v3**: the cross-day line ("each time the best match is this doctor") was true on 18-24 Sep only and false with 9-15 Sep added. Replaced on all 60 cards, uniformly (tier-blind), from the 70-room-day grouping: `fix_evidence_v3.py`. IDs, clips, audio unchanged.
- **Batch 1b** (`overnight_cards.py` on the 70-room-day tree, then `fix_evidence_v2.py` and `_v3.py`): 60 link cards + 1 pair, **0 HIGH, 1 MED, 59 LOW**; 29 of the 60 are on text-less days (prescription line "not checked", production line "no label"); 31 of 60 have clips from fewer than 3 consults; 16 are staff candidates. Fable chooses batch 1 or 1b.

## Disclosures
- Segment times are window-relative to the gap-closed clip; the chunks are contiguous (`gap_before_ms` 0) so wall-clock offsets are right, but a window with a real gap would shift later segments early by the gap. Not checked window by window.
- 9-15 Sep have diarizer turns with no text: voice presence and cross-day are unaffected, Rx and Jev are absent; those cards say so.
- 16-17 Sep have chunks but no diarization: not included. 1-8 Sep and Aug: no diarized windows in Neon.
