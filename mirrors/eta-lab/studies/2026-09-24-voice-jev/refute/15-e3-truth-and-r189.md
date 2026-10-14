# vj-refuter: ruling 185 E-3 truth installed; ruling 189 LQ hash verified

## Ruling 185: E-3 Cardiology labels -> /srv/vj-truth (DONE)
- Source: Mini /Volumes/Air Drive/eta-data/2026-09-23-e3kit-voice-id/out/recovery_labelled_turns.json, read via the ReadMini MCP (Mini ssh cap).
- Installed as vjscore: /srv/vj-truth/e3_recovery_labelled_turns.json (mode 600, 16473 bytes, sha256 66dc2c97d2f0...) plus e3_manifest.json.
- Integrity check: rebuilt with the source's json.dumps(indent=1) layout. Byte size equals the source (16473), and the base64 head, tail and a middle slice equal the source's base64. No staging copy is left outside /srv/vj-truth, except my rebuild script in my session scratchpad (not eta-lab).
- NOT copied:
  - labels_cardiology.csv: stale mapping. Its rows that agree with the recovered file add no new turns, and several disagree (e.g. a turn the recovered file labels patient is "doctor" in the csv).
  - labels_FAKE.csv and the WITHDRAWN report.
- Truth quality (for Fable):
  - 70 rows = 59 unique turns: 6 intentional repeats + 5 accidental duplicate pairs.
  - 1 turn has conflicting labels (two_voices vs dibyendu). Under the 165 B rule it is excluded.
  - two_voices (5 unique turns) is stored as is_doctor = false. It is mixed audio, so it should be EXCLUDED, not scored as not-doctor.
  - other_doctor (2) is stored as is_doctor = true. It is ambiguous for "the doctor (Dr X)". Fable to rule.
  - Clean: 36 Dibyendu + 15 patient/nurse = 51 usable turns (53 if other_doctor counts as doctor).
- Pool: NONE of the 6 E-3 windows (Cardiology, 9-22 Sep) is in the current VJ pool (V5, W58, SC30). vj-data must add these 6 windows (production turns, cards, clips).
  - Dibyendu's only centroid is Meet-sourced, so these turns will be margin MISSING = DOUBTFUL. They help the >= 60 labelled-doubtful target, not F4.
- Identities for vj-data (no labels, no clip ids): refute/e3_identities.json (59 turns).

## Ruling 189: LQ freeze hash VERIFIED
- studies/2026-09-24-voice-jev/link/LQ-FREEZE.md @ a9e5438, hashed with its own awk markers: 04545aae3478. It matches the approved sha12.
- The file is not yet present in the shared checkout's working tree. Before vj-link's first real run I will re-hash the copy it actually runs from (on voice-lab-1 / its worktree).
- Rule 7 makes LQ count only together with Q1 >= 0.70 and a "no" paired control, so my K2 (double counting) is resolved in the frozen text.

## Ruling 197(c) applied in /srv/vj-truth (run as vjscore; refute/e3_r197.py; prints counts only)
- /srv/vj-truth/e3_truth_r197.jsonl (sha12 149740e6ed58): 51 unique turns = 36 doctor + 15 not-doctor.
  - Excluded: 7 two_voices/other_doctor turns and 1 conflicting repeat.
  - This matches Fable's "36 clean doctor + 15 not-doctor".
- The scorer must read e3_truth_r197.jsonl, NOT the raw e3_recovery_labelled_turns.json. The raw file stays as the source of record.
- Of the 51, only turns in the 2 maaacrdh windows can map to production turns (at most 13 before these exclusions).

## Ruling 194 (Phase L criterion 1) and 197(a)/(b): noted for the pilot refute
- Criterion 1 = (a) full mutual exclusivity, (b) stable across >= 3 tolerances, (c) n >= 5 consults for HIGH, (d) never carries a tier alone. Zero HIGH is an acceptable result.
- 197(a): W58 confident turns may be page ITEMS. My N2 still holds for their CLASS: the W58 pyannote counts are pending, so an item selected as confident may become doubtful. The confident sample for F4 must use the final class.
- Scorable after 197(c): only 11 of the 51 clean E-3 turns map to a production turn (8 doctor / 3 not-doctor, both maaacrdh windows; counted inside /srv/vj-truth by e3_scorable.py). 197(c)'s 'the 6 windows join the pool' cannot hold for 4 of them: they have NO production turn rows, so there is no arm 1 answer. E-3 adds 11 labelled DOUBTFUL turns to the >= 60 target.
