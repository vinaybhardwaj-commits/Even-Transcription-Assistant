# Phase L pilot (ruling 183): 5 room-days, 10 cards (vj-link, 24 Sep)

No names, no transcript text, no patient data here. Cards (with doctor names) and clips: box `~/eta-data/voice-linkage/pilot/cards/` (copy on voice-lab-1 `~/vj/link/cards/`), validated with surg-page's `check_cards.py` (10 link cards, OK). Tiers live in `pilot/key-public.json`, never on the cards.

## Result
- **Zero HIGH, zero MED. All 10 links are LOW.** If cross-day comparison could count (it cannot yet: K4, no agreed link), 3 would be MED.
- Criteria per link: T = ruling-194 criterion 1, R = recurring voice >= 70% of the doctor's consults heard in the room, X = >= 1 prescribed drug or test named in this voice's words, J = Jev term (frozen rule 7). Cross-day = pending.
- Criterion 1 (ruling 194: excess >= 2 over the shifted null, top 3 by z, mutual exclusivity, stable at all 3 tolerances 180/300, 240/360, 300/480 s, n >= 5): only **2 of 653 (doctor, room-day) pairs** on 19/22/23 Sep pass it (both on 22 Sep: OPD 3 and Cardiology), and only one is on a pilot room-day (22 Sep Cardiology, the doctor is not one of my two links there).

## Room-days (chosen by transcribed speech minutes, full clinic day, PQM available; not tuned)
22 Sep OPD 4 (401 min speech), 19 Sep OPD 1 (339), 22 Sep Cardiology OPD (317), 23 Sep Cardiology OPD (288), 23 Sep OPD 7 (230). Before 18 Sep there is no production transcript, so 1 Aug-17 Sep room-days cannot get step 3 or 4 yet.

## Links (2 per room-day: the best voice x doctor pair by voice-timing excess, and the best pair of a different doctor)
| card | room-day | tier now → if cross-day passed | criteria | edge stable, n | recurring | Rx by this voice | Jev Q1; LQ; paired control | cross-day |
|---|---|---|---|---|---|---|---|---|
| 9e9964 | yhh6kexm r1 | LOW → LOW | ---- | 0/3, n=13 | 7/12 | 0/8 | doctor 0.81; LQ 0.33; ctrl 0.18 | - |
| a9b0ce | yhh6kexm r2 | LOW → MED | -RX- | 0/3, n=8 | 5/5 | 1/3 | doctor 1.00; LQ 0.56; ctrl 0.56 VOID | 0.419 |
| 36d160 | f4hzv5sj r1 | LOW → LOW | ---- | 0/3, n=9 | 5/9 | 0/7 | doctor 0.96; LQ 0.56; ctrl 0.52 VOID | - |
| 65fb97 | f4hzv5sj r2 | LOW → LOW | --X- | 0/3, n=21 | 6/11 | 2/15 | doctor 0.99; LQ 0.66; ctrl 0.56 VOID | 0.897 |
| 387f6b | djmbtzph r1 | LOW → MED | -R-J | 0/3, n=12 | 8/9 | 0/12 | doctor 0.84; LQ 0.56; ctrl 0.46 | - CONFLICT |
| 5b4488 | djmbtzph r2 | LOW → LOW | -R-- | 1/3, n=8 | 5/5 | 0/3 | doctor 0.90; LQ 0.67; ctrl 0.52 VOID | 0.419 |
| e9bc54 | tp4hcf8s r1 | LOW → MED | -RX- | 0/3, n=3 | 3/3 | 1/1 | doctor 0.89; LQ 0.52; ctrl 0.60 VOID | - CONFLICT |
| 5ed3d4 | tp4hcf8s r2 | LOW → LOW | ---- | 0/3, n=4 | 2/3 | 0/0 | doctor 0.63; LQ 0.04; ctrl 0.05 | - |
| 216c5d | u6kdhc3b r1 | LOW → LOW | --X- | 0/3, n=16 | 7/12 | 1/12 | doctor 0.97; LQ 0.72; ctrl 0.51 VOID | 0.897 |
| a6d278 | u6kdhc3b r2 | LOW → LOW | ---- | 0/3, n=9 | 3/6 | 0/0 | doctor 0.57; LQ 0.17; ctrl 0.09 | - |

## What the numbers say (plain)
1. **Timing alone does not link a doctor to a room** on these busy days (lx #691/#699/#739 reproduced): segmentation match and edge alignment pass few pairs and about half of passers are chance. Continuous alignment (speech presence) was no better. The discriminator that works is a *voice*: one recurring voice heard in the minutes when doctor D's queue consult runs, versus the other busy minutes and versus the +-2/3 h shifted null (contrast column in key-public.json; every link beats its own shifted null on the mean, 10 of 10 also beat the shifted max).
2. **Rx content is weak evidence**: only English-script drug/test words are matched; the doctor names 0-2 drugs per consult aloud. Rx hit counts per link are 0-2 of 0-21.
3. **LQ is nearly useless as a discriminator**: the paired control (same turns, another doctor's drug list) said yes (>= 0.5) on 6 of 10 links, so LQ is void there; Q1 says "doctor" (0.57-1.0) for every recurring voice, which it would also do for a nurse. Jev term met on 1 of 10 (387f6b). vj-refuter's K2/L2 (report field, not a tier term) looks right.
4. **Two real signals**: (a) doctor F092's two links (65fb97 19 Sep OPD 1, 216c5d 23 Sep OPD 7) are the same voice across days and rooms (cos 0.90) and both match that doctor's stored room-mic voiceprint (0.61, 0.64; ruling 182 said stored prints mostly fail, so this is the exception). (b) **K1 confirmed**: the same Cardiology voice (cos 0.98) is linked to two *different* doctors on 22 and 23 Sep (387f6b, e9bc54): at least one link is wrong, probably a room-resident nurse or attendant. Both cards say so in the evidence.
5. Clips: per turn (single non-overlap turn by the diarizer, 4-5 s, per-turn ECAPA cos >= 0.60 to the voice centroid, from 3 different consults where they exist (2 cards have 1-2), seeded draw, seed 24092026+link no.; contrast turns from another voice with cos < 0.30). 40 clips, 916 KB mp3.

## Disclosures (choices to refute)
- arm_a needs an energy log (only from 23 Sep); before that it was fed a *speech-presence* log from the stt_turn cues. lx's parameters unchanged.
- ECAPA runs on 2 turns per minute (the longest turn of each minute, >= 1.5 s, first 5 s): voice-lab-1 was at load 30-50. Voices = average-linkage clusters cut at cos 0.30, core = cos >= 0.45 to the cluster centroid; the cut was set once from one unlabelled room-day's pair-cosine distribution and then fixed for all. No truth was used anywhere.
- A voice is "heard" in a minute if >= 1 sampled core turn falls in it, so absolute presence is a floor; contrast vs the same measure outside is what is used.
- Rank in the room: first link = highest voice-timing excess among doctors with >= 3 room-active consults and >= 30 in-consult minutes; the second link is the best pair of a different doctor on a different voice (else the same voice, flagged competing in the key). Nothing is hand-picked.
- Cross-day evidence is reported but does not count (K4). Anchors are stored centroids (information only).
- `jev_link.py` hash gate: the LQ header quotes the freeze awk command, so the frozen text (sha12 04545aae3478) includes the blank line before the real BEGIN marker; the gate emulates awk exactly. Jev ran on de-identified text (surgery-review-v2 deid.py), Q1 + LQ + paired control per link, 30 calls; stamps freeze b961291ae64c and LQ 04545aae3478.
- Card contract: exactly surg-page's fields plus `batch: 0` (pilot). Tiers only in key.json / key-public.json.

## Reproduce (box + voice-lab-1)
stage.py -> pqm_pull.py (lx) -> rx_pull.py (mb-rx join) -> edge.py / align.py / align2.py / rxscore.py (box) -> fetch_pilot.py -> embed_link.py -> voicelink.py -> assemble.py (voice-lab-1) -> jev_link.py -> finalize.py (box).
