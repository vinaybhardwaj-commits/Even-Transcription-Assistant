# vj-refuter: Phase L placebo suite (vj-link ec8d4b2, REPORT-PLACEBO.md): my P1-P4 are ANSWERED; verdict on the tiering

- P1 (stronger placebo): 14 full-pipeline placebos (8 hour shifts +-4..7 h; 6 date offsets). Smallest possible empirical p = 0.067.
  - Complete linkage: HIGH real 1 vs placebo 0-1 (p = 0.133); cross-day exclusive links 3 vs 2-7 (p = 0.87); MED 2 vs 2-7 (p = 1.0); groups 82 vs 54-83 (p = 0.133).
- P2 (chaining): complete linkage gives the same 1 HIGH + 2 MED. The largest group is still 27 room-days / 15 doctors, with every pair at cos >= 0.85: a genuinely uniform voice (ambient, announcement or shared source), correctly a staff candidate. The chaining concern is resolved; the uniform voice is real.
- P3 (dominant speaker): all 3 HIGH/MED voices are rank 1 in their doctor's consults, but placebo links are too (median 58%, max 100%), so it does not discriminate.
- P4: the Rx base rate is reported in the placebo summary.

## Verdict (Phase L tiering, batch 1)
- The TIERING carries no evidence above chance at the count level. vj-link's own conclusion agrees ("No auto-accept on this evidence").
- The batch 1 page is acceptable ONLY as a human review: V's blind first verdict (a0) is the entire precision signal.
- Required (Fable):
  (1) HIGH auto-accept stays OFF for Phase L until a real tier count exceeds all 14 placebos;
  (2) minting only from V-agreed links (ruling 183 already);
  (3) no "HIGH/MED" framing anywhere V can see (already true on the cards: uniform text, no tier words).
- The one HIGH (Cardiology, Dr Nischal N. Hegde per the card) stays plausible on the voice evidence (not production's voiceprinted doctor) but is not established by the tiering.

## RETRACTION + update after vj-link's 9-24 Sep extension (#1207, #1213)
- RETRACTED: my refute/23 reading that the batch 1 HIGH (Cardiology c93, JKJxJj) was "plausible, a second Cardiology doctor". On 70 room-days the same voice recurs on 4 room-days and matches 3 different doctors: a STAFF CANDIDATE, the dedicated-assistant case (K1). Production's 0% clinician share fitted "not Dibyendu", but not "a doctor". The two MED voices are also staff candidates (4 and 3 doctors).
- Extended totals: 122 groups, 36 cross-day, 35 staff candidates; HIGH 0, MED 1 (doctor F092 = Ankit, whose stored room-mic voiceprint matched independently at 0.61 / 0.64).
- Batch 1 (evidence v3): the false cross-day claim ("each time the best match is this doctor") is gone from all 60 cards; the line now reports the 9-24 Sep span honestly; no Jev line and no tier words. BUT the seed ~/eta-data/doctor-voice-check/batch1/seed_docs.json (21:54) PREDATES the v3 cards (22:27), so it is STALE and must be re-seeded before any publish.
- Batch 1b (vj-link's replacement on 70 room-days): pre-check PASS. 61 docs (60 link + 1 pair); 0 tier words, 0 Jev, 0 false cross-day claims; only the allowed fields; the key is outside the page dir. Key: 2 MED entries, both F092 (vj-link reports "1 MED": probably one group carded on its two room-days; worth a line in the report), 76 LOW.
- Recommendation: publish batch 1b (not batch 1) with blind-first ON. It has no false HIGH, and its one MED is the only link with independent voiceprint support. Batch 1's former HIGH/MED would put three staff voices in front of V as "proposed doctors".
- Batch 1b MED count: the key's 2 MED rows are ONE group (g077, F092 = Ankit): link card ebed0b plus card 5d5809 (checked: see its kind). Consistent with vj-link's '1 MED'. Placebo not re-run on 70 room-days (report line 21). 29/60 cards are on text-less days (Rx 'not checked').
- The batch 1b MED is INDEPENDENTLY CONFIRMED (my check). Group g077 = rd_ftfpqnpc c110 (OPD 1, 10 Sep) + rd_x76wyxwt c30 (OPD 7, 12 Sep). Its cluster centroids match Ankit's stored room-mic print (ankit-opd7-tonor) at cos 0.664 and 0.670, vs Banerjee 0.06-0.08 and Salanki 0.17-0.18.
  - Neither room-day is the enrolment session (bs_rjf49y3d, OPD 7, 10 Sep AM), so this is not circular.
  - The 0.61/0.64 in vj-link's report came from other (pilot) room-days of the same doctor. This group is now verified on its own.
  - It is the one Phase L link with evidence beyond the (chance-level) tiering.

## vj-link's ANCHORED-stratum proposal (#1223): refuter assessment
- Seeds verified: both voice-check seeds (batch 1 v3, batch 1b) equal their current cards 61/61, were built after them, and carry no tier/key fields. Batch 1b's seed says "batch": 2 (vj-link intended 1); harmless if published alone.
- Per-member cosines to the stored V-verified room-mic prints (my recompute from vj-link's cluster centroids):
  - g071 vs Salanki (OPD 5): 10 Sep 0.938, 11 Sep 0.929, 12 Sep 0.917, 19 Sep 0.919, 23 Sep 0.910, 24 Sep 0.895.
    - 10 and 12 Sep ARE Salanki's enrolment days (sessions bs_zkww73aq / bs_m4dkgcku), so those two are partly circular. The 4 NON-enrolment days are 0.895-0.929, equally high, so the anchor is GENUINE.
  - g013 vs Ankit: 0.55-0.69 over 9 room-days (6 >= 0.60), OPD 1 and OPD 7 (cross-mic vs a TONOR print). A moderate anchor.
  - g077 vs Ankit: 0.664 / 0.670 (not enrolment days). A moderate anchor.
- Scope note: g071 places Salanki in OPD 5 on 23 Sep (rd_yck5kdc2) at 0.91, while ruling 187's roomday_voice marked him ABSENT that day. Not a contradiction: roomday_voice looked only at that room-day's TEST windows (e.g. bw_amdxyq32, where he does not speak; my L4b max 0.21). The room-day-level "absent" label was too strong. It does not affect the classification (window-level).
- The anchored reading also explains the "staff candidates": timing names 4 doctors for a voice that IS Salanki on every day, so it is the PQM best-doctor assignment that is noisy, not the voice. This agrees with the placebo result.
- Recommendation (Fable):
  YES to an ANCHORED stratum, provided that
  (a) the card line states the match ("matches this doctor's stored voiceprint on N days, cos a-b"), is uniform in style, and excludes enrolment room-days from N and a-b;
  (b) enrolment room-days are never used as evidence or as minting audio;
  (c) minting from an anchored group requires V's agreement AND the ruling 182 controls on a held-out NON-enrolment day (>= 0.70 positive; < 0.40 vs other doctors). A centroid minted from voices chosen for matching the old print adds coverage (new rooms and days), not independent validation.
- Salanki's g071 (all days >= 0.89) is the strongest link found by any Phase L method.
- CORRECTION (surg-page #1226 is right): my '22:27' for the v3 batch 1 cards was a timestamp mis-conversion; the newest card write was 22:12:53 box clock. The batch 1 seed was regenerated at 22:17:59, so it was NOT stale when I flagged it. My later content check (61/61 identical, seed newer) confirms both seeds are current.

## vj-link #1227 (all 5 stored prints anchor groups): VERIFIED by my recompute
- g008 Banerjee (OPD 3, 8 days): 0.856-0.928. The 2 enrolment days (9 and 10 Sep, OPD 3) are 0.913/0.928; the 6 NON-enrolment days are 0.856-0.916. Best other print <= 0.26. Genuine.
- g034 Poornima (8 room-days: OPD 6 x6, OPD 5 21 and 23 Sep): 0.756-0.793, other prints <= 0.24. No enrolment overlap. Genuine; it matches production's "Poornima in OPD 5" on 20-22 Sep.
- g017 Dibyendu (Meet print; Cardiology, 5 days): 0.717-0.817, but the best other print reaches 0.49 (weaker separation). A Meet print DOES transfer to room audio at the cluster level. My L2 ("Meet/PWA prints must not score room audio") is QUALIFIED: it still holds for per-turn scoring and for the PWA print enrolled from a heuristic "Patient" speaker.
- Implication for VJ (next round, Fable): ruling 182 found the stored prints fail PER TURN, yet they match dense recurring CLUSTER centroids strongly for all 5 doctors. The ruling-186 per-turn margin under-uses them. A cluster-level presence test (room-day voice group vs stored print, >= 2 non-enrolment days, cos >= 0.70, best-other gap >= 0.3) could verify doctors for many more room-days (Poornima, Dibyendu, Banerjee's other days), so more CONFIDENT turns and a larger F4 base. It would be a definitional change (a new addendum), not for the current scored round.
- The timing labels are weak (vj-link: 47% right against the anchors), which is consistent with the placebo result.
- vj-link 46a29fd (enrolment excluded): Banerjee g008 = 6 non-enrolment days 0.86-0.92 and Salanki g071 = 4 days 0.89-0.93, both matching my recompute.
  - DISCREPANCY for Ankit: vj-link reports g013 0.63-0.72 and g077 0.72-0.76. Against the TONOR room-mic print ONLY I get g013 0.553-0.693 (6 of 9 >= 0.60, not 8) and g077 0.664/0.670.
  - Likely cause: a multi-centroid max that includes ankit-pwa, enrolled from a heuristic "Patient"-labelled speaker (my L2). The PWA print must not anchor room audio. Asked vj-link to confirm and to re-state Ankit's anchors with TONOR only.
- vj-link #1237 (before my PWA question #1240): enrolment exclusions confirmed (Poornima's enrolment is 17 Aug; Dibyendu's print is Meet, so neither is in range). Timing label == anchor doctor 16/34 = 47% vs ~12% chance; the anchor doctor is in timing's top 3 on 85%. Timing is a weak but real shortlist, consistent with ruling 187. The Ankit PWA question is still open.
- vj-link 081081e: Ankit anchors now use the TONOR print ONLY (PWA excluded): g013 = 6 matching of 9 non-enrolment days, 0.60-0.69; g077 = 2/2, 0.66-0.67. Both match my recompute exactly. RESOLVED. All 5 anchors are now verified with enrolment days excluded and room-mic/Meet prints only.
- Ruling 250 (23:10): Fable had published batch 1 at 22:25 from the 21:54 seed (pre-v3: false cross-day lines, staff voices shown as HIGH/MED), and has now withdrawn it. My #1217 'do not publish the 21:54 seed' was right in substance even though my card timestamp was wrong. Replacement = batch 1b + anchored known-voice cards (Salanki g071, Banerjee g008, Ankit g013), non-enrolment days only; I check before the 00:15 republish.

## Ruling 250 known-voice cards (vj-link a2c5c33; box batch1b-anchored + key): PASS
- 3 cards (Salanki g071 1cd1bf, Banerjee g008 64329a, Ankit g013 f05604), each labelled "KNOWN-VOICE CHECK" in the first evidence line. Fields are the same as the batch 1b cards. No tier words.
- Stated days and cos ranges equal my verified anchors: Banerjee 6 days 0.86-0.92, Salanki 4 days 0.89-0.93, Ankit 6 days 0.60-0.69.
- Enrolment exclusion (anchored_cards.py l.67): member room-days whose sessions intersect the doctor's enrolment sessions are dropped.
  - Salanki uses 11/19/23/24 Sep (drops 10 and 12 Sep). Banerjee uses 6 room-days, none on 9/10 Sep OPD 3.
  - Ankit's anchor_cos_by_day = [0.661, 0.693, 0.603, 0.600, 0.617, 0.611] is IDENTICAL to my TONOR-only recompute (the PWA print is not used).
- Clips: from members_used only, 3 different room-days per card, core single-speaker turns, per-turn cos >= 0.60, seeded. Contrast from another voice at cos < 0.30.
- The batch 1b LOW cards for the same two voices (g071, g008) are dropped, so V never sees one voice under two names.
- The evidence text states the stored-print match: by design this is a KNOWN-ANSWER control of V's hearing. Score it separately (my #1286).
- Next: check surg-page's merged seed (batch 1b minus 2 + these 3).

## Ruling 250 FINAL MERGED SEED (~/eta-data/doctor-voice-check/batch1b-anchors, 23:15): PASS
- 62 docs (61 link + 1 pair), 62 unique ids. The seed ids equal the folder ids exactly (batch1b 58+1 + batch1b-anchored 3); all 62 docs are identical to their cards.
- The dropped duplicates d652ed (g071) and 0e4968 (g008) are absent. The 3 KNOWN-VOICE CHECK cards are present.
- Only the allowed fields; all batch 1; 0 tier/gid/criteria/doctor_uid fields; 0 tier words (incl. "ANCHORED").
- FILES.txt: 246 audio entries (path, bytes, sha256, source). 12 random entries re-hashed against the source audio: 12/12 match.
- Verdict: publishable with blind-first ON (config/settings = {"evidence":"after"}). Score the 3 known-voice cards separately as known-answer controls.
- Per-clip key (vj-link 78dae9f, extension/clips-anchored-cards.json): 12 clips, 0 from enrolment sessions; doctor clips cos 0.654-0.864 (all >= 0.60); contrast 0.059-0.063 (< 0.30); all 12 byte-identical to the delivered mp3. My #1286 item 1 is satisfied.
  - Note: 2 doctor clips come from VJ test sessions (Salanki bs_gt2crzyp = V-pilot v3 windows 19 Sep; Ankit bs_m6nq7upz = a V5 session). Harmless for VJ: Phase L verdicts never enter VJ truth. Kept on record.
