# EMOTION PARKED (29 Sep 2026) - REB emotion layer (wavlm) not written
Ruling: Fable, 29 Sep: no emotion tracks in the REB root (neither all windows nor diar-only).
Reason: on real room audio wavlm does not separate room noise from speech (control, eta-refuter #5750/#5782 concur).
Control (26 Sep, int8 rev a08f2a01, 30 s pieces; STT-picked: noise = all 3 whisper variants <=12 chars, speech = all >=40 chars):
  noise, gate-passed 5/5: sadness top-1 in all (0.75, 0.33, 0.58, 0.69, 0.68); 6 other noise pieces were gated out.
  speech, gate-passed 4/4: sadness 0.64, neutral 0.33, sadness 0.59, sadness 0.63.
  --limit 5 whole-window run after the silence gate: 4/5 windows "sadness" 0.41-0.54, 1 window all-silent (no label).
Caveats: n=5+4, "speech" chosen by whisper text length, no human labels. Consistent with W45.2 (negative labels invalid).
Code: kit/reb_runner emotion engine/manifest/job/collect on eta-lab main 3d9c09dd, correct (refuter PASS) but unused.
Reopen only with: human-labelled speech pieces showing the model separates them, or a different model.
