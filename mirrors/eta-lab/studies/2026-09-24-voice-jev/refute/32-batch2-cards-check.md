# 32. Batch 2 (vj-link #1690, 40 cards) check. vj-refuter, 25 Sep ~05:45 IST
Verdict: PASS for 39 of 40 cards. H05 card (96e0fc): MUST-FIX F1 before seeding. H04 card: PASS with a scoring note (N1). Nothing goes to surg-page until F1 is fixed and re-checked.

## Checked and passing
- Audio: all 160 clips re-cut by me from their windows with the stated ffmpeg settings: 160 of 160 byte-identical (anchored 12, special 8, low 140). The anchored cards have 0 enrolment-session clips.
- Text: no tier words in any card.
- numpy 1.26.4 -> 2.2.6: the dtree84 centroids equal the dtree_ext centroids on all 70 older room-days (max abs diff < 1e-6; same cluster ids).
- New Ankit g088 (OPD 1, 16-17 Sep): own TONOR print 0.625 / 0.629; best other print 0.387 / 0.306; R1 margins 0.238 / 0.323. It meets the frozen rule, so it is shown.
  - Ankit = ONE known-answer unit (g013 + g077 + g088). Ankit counts correct only if V is right on every Ankit card, and all answers are reported.
- g034 / g017: unchanged from refute/29.
- Not independently reproduced this round: the R4 placebo figures and the 80-room-day group count. I report them as vj-link's numbers.

## F1, MUST-FIX: the H05 card presents audio from times Manoj was not consulting
For each card day I checked whether the voice speaks inside Manoj Kumar S's own queue consults (called..completed, pilot/pqm) in that room-day:

| day | cluster | Manoj consults | OPD 4 tape has speech during them | voice total | voice inside Manoj consults |
|---|---|---|---|---|---|
| 16 Sep (H05 day) | c35 | 9 | 8 | 2,802 s | 448 s (16%) |
| 19 Sep (clip k0) | c40 | 10 | 5 | 710 s | 698 s (98%) |
| 17 Sep (clip k1) | c20 | 9 | **0** | 4,929 s | **0 s** |
| 11 Sep (clip k2) | c96 | **0** | 0 | 1,941 s | **0 s** |

- Clips k1 (17 Sep) and k2 (11 Sep) come from a voice talking in OPD 4 at times when Manoj was not consulting there. On 17 Sep his 9 consults fall where the OPD 4 tape has no speech at all; on 11 Sep he had no consults.
- Presenting them as "this voice is proposed as Manoj" invites a wrong "yes".
- The card's "same voice is heard in OPD 4 on 6 other days" family (cos >= 0.70) is an OPD 4 regular voice, not shown to be Manoj.
- Correction to my own step: I first read "0 consults" from the linker's pairs list. The linker simply omits a doctor with no recording overlap, so pqm is the source for these counts.
- Fix:
  - H05 clips only from Manoj's own consult windows, on days other than 16 Sep, where the c35 family voice speaks inside them. 19 Sep qualifies (698 s); any other day must show >= 5 s inside his consults.
  - Remove the "6 other days" family sentence, or replace it with: "the same voice is also heard in OPD 4 at times when this doctor had no consults".
  - Keep "weaker than a stored voiceprint".
- Disclosure for Fable (no change to the frozen H05 verdict): on the H05 day itself only 16% of c35's speech falls in Manoj's consults. The PASS says "the H05 encounter's main voice is the 19 Sep c40 voice", and c40 fits Manoj on 19 Sep (98%), but c35 is mostly a room-regular voice. V's blind answer on a corrected card decides.

## N1, H04 card (b0b8b4, 13 Sep OPD 7 c30 -> Prathik, ordinary)
- All 3 clips come from 13 Sep OPD 7, a day the frozen rule's R3 lists as "neither evidence nor minting audio" for Prathik.
- An ordinary card may show it. But per R3, a "yes" from V on this card cannot by itself make Prathik an anchor (rule v2 §4) or supply minting audio. Any Prathik anchor would need a V-confirmed voice from a non-R3 day.
- Recorded before any verdict.

## vj-link #1694 rebuild (crossed with F1): H05 card 93a018 FAILS F1
- vj-link applied the strict R3 reading (no clip from 19 Sep OPD 4 or 23 Sep OPD 5/7). I accept it; it matches refute/31.
- The new clips come from 17 Sep (0% of the voice inside Manoj's consults), 11 Sep (0 consults) and 21 Sep (9%, and no 4-8 s turn fully inside a consult). All 3 clips are outside his consults.
- Days qualifying under the strict reading (share of the family voice inside Manoj's consults):
  - 22 Sep c183: 445 s (37%), 33 candidate turns
  - 24 Sep c80: 301 s (7%), 24 turns
  - 10 Sep c86: 158 s (15%), 10 turns
- F1 fix v2 was sent (#1695-ish): clips must be core turns, 4-8 s, fully inside Manoj's called..completed windows, cos >= 0.60, with the card text disclosing the second-voice possibility.
- H04 272724 has the same clips as b0b8b4, so N1 stands.
- Reading: only 19 Sep (98%) looks like Manoj's own voice. The OPD 4 family is probably two people.

## H05 card v3 df1994 (vj-link #1701): PASS. F1 CLOSED. Batch 2 CLEARED for surg-page's addendum seed
- The 3 doctor clips were checked independently (emb meta -> turn -> my own pqm consult windows), not from the key:
  - 22 Sep rd_yhh6kexm turn 2165, core c183, cos 0.75
  - 24 Sep rd_cujhuhvj turn 2530, core c80, cos 0.669
  - 10 Sep rd_7wqp76af turn 1375, core c86, cos 0.673
  - Each lies FULLY inside a Manoj called..completed window.
- The contrast clip (22 Sep, turn 4316) is outside his consults and in no core.
- Re-cut: 4/4 byte-identical. No reference day, no 16 Sep clip.
- Text: consult-only disclosure present; "may be more than one person" present; no family-days sentence; no similarity quoted on line 1.
- vj-link's family definition (cos >= 0.60 to c35) was flagged before the run and matches the test's bar. Accepted.
- H04 card 6d399a: the same 4 clips as b0b8b4 (re-cut 4/4 identical, all from 13 Sep OPD 7). N1 stands.
- Folders: batch2-anchored 3 + batch2-special 2 (df1994, 6d399a) + batch2-low 35 = 40 cards, all carrying "batch": 2.
- Superseded ids 96e0fc, 93a018 and b0b8b4 are not in the folders.

## Correction to my #1699 (surg-page #1700): blind-first hides the EVIDENCE lines, not the doctor's name
- The name, room and date are always shown, by design (lab-viewer #1154); this was also true for batch 1b.
- My refute/26 "blind-first a0" means: V answers before seeing the evidence lines (similarity, known-voice label). It does not mean V answers without seeing the name.
- Scoring caveat, added before any verdict: the known-voice strata test CONFIRMATION of a named doctor ("is this Dr X?"), so a yes-bias is possible.
  - The only in-card guard is the contrast clip.
  - The LOW controls, where the proposed name is a timing guess that is right about 42% of the time, give V's rate of saying "no" to a wrong name. I report the known-voice k/n next to V's "yes" rate on the LOW controls.
- No page change requested. A name-blind design would be Fable's decision.

## Batch-2 addendum seed (surg-page #1703, ~/eta-data/doctor-voice-check/batch2, 05:15): PASS, ready for Fable to publish
- FILES.txt: 160 rows. All 160 match the delivered mp3 in batch2-{anchored,special,low}/audio, by sha256 and bytes; 0 bad.
- seed_docs.json: 40 docs, each identical to its source card on every source field. H05 = df1994, H04 = 6d399a. Superseded ids are absent.
- Live seed: 0 shared ids with batch1b-anchors.
- Page tools/doctor-voice-check/page.html is unchanged, sha d5d1116c13d9.
- 4 known-voice first lines: 66175d (Ankit g088), 9d2c75 (Dibyendu), ae82a5 (Poornima), df1994 (H05 candidate). The fourth is expected.
- Blind-first Chromium check: surg-page's counts (0/40 evidence visible before the first answer; 40/40 first verdicts blind:true). Not re-run by me.

## Ruling 314 re-check (06:0x): no card needs moving
The known-voice line is already evidence line 0 on 66175d, 9d2c75, ae82a5 and df1994. The H04 ordinary card 6d399a mentions "not a known answer" in its last line (line 3). It is not a known-voice card, and moving that line would mislabel it. The seed stays as passed; surg-page was told not to edit.
