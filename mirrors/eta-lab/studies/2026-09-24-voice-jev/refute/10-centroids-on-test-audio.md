# Refute: stored ECAPA centroids on the 18-24 Sep test audio (L3, L4) + ruling 168 vjscore verification

## Ruling 168 (vjscore): VERIFIED, with an audit caveat
- User vjscore (uid 997, nologin) owns /srv/vj-truth (mode 700). The directory is empty now.
- auth.log (UTC): vj-data created it at 12:33:04 UTC (18:03 IST) and ran one test as vjscore (`id; ls /srv/vj-truth | wc -l`) while it was empty. Baseline recorded.
- Caveat: every pane is the same unix user (vinay_bhardwaj, in google-sudoers), so any pane can read /srv/vj-truth as ROOT without ever becoming vjscore. My auth.log audit must therefore flag:
  (a) any sudo -u vjscore that is not mine;
  (b) any root sudo whose COMMAND mentions vj-truth or key.json;
  (c) any interactive root shell (sudo -i / sudo bash / su), which hides the command.
- I will run that audit before each scoring run and after it.

## L3 identity map: RESOLVED, but the room -> one-doctor assumption FAILS
Production clinician table (id, full_name only; pin columns never selected):
- doc_x3pwgdve = Dr Animesh Banerjee (OPD 3)
- doc_dcg2ay3s = Dr Prabhudev Salanki (OPD 5)
- doc_ppmku68m = Ankit Bhojani
- doc_7xyxkmkz = Poornima Parasuraman
Production 'clinician' turns 18-24 Sep:
- OPD 3: Banerjee 3470.
- OPD 5: Salanki 1622, but ALSO Poornima 222 (20-22 Sep).
- OPD 7: Poornima 58 + Ankit 20 (23 Sep).
classify.py maps each room to ONE stored centroid. On Poornima days, OPD 5 and OPD 7 turns are scored against Salanki's or Ankit's voice. Poornima's only centroid is Meet-sourced, which is excluded by L2.

## L4 centroid match on test audio (refute/l4_centroid_check.py + .json, my own ECAPA env)
- Method: 15 test windows in OPD 3/5/7 with audio. Each production cluster is embedded (turns >= 0.8 s, <= 60 s) and compared by cosine with the room's stored centroid.
- Top-cluster cosine: median 0.22, range 0.07-0.57. Only 1 of 15 windows is >= 0.5. The enrolment holdouts were 0.71-0.88.
- Where production has a clinician cluster (3 windows), it is the centroid's top cluster in only 1.
- 4 windows have top-second gap >= 0.10. In 3 of them the top cosine is < 0.3, so turns there would be CONFIDENT on a "match" that is not a voice match.
- Reading: on these days the stored centroids mostly do not find their doctor. Two causes seen so far: (i) another doctor was in the room (Poornima, per production); (ii) source or mic drift since 9-12 Sep. Either way the margin is scale-free and has no floor, so it turns noise into CONFIDENT.

## Proposed (Fable to rule; it changes the classification inputs, not the frozen text)
- R1: the reference doctor is chosen per ROOM-DAY, from production's attribution for that room-day, not per room.
  - Where that day's doctor has no room-mic centroid, use the ECAPA profile (165 C); otherwise the margin is missing (DOUBTFUL).
- R2: a margin is valid only if the top cosine to the reference is >= 0.5 (the lower end of the enrolment holdouts); otherwise the margin is missing (DOUBTFUL).
  - Without this, a meaningful share of "confident" turns rests on sub-0.3 matches.
