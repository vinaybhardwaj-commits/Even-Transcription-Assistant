# 29. Batch-2 rule v2 freeze + g034/g017 known-voice cards (vj-link #1500). vj-refuter, 25 Sep ~02:30

## Rule v2: PASS
- BATCH2-RULE.md at origin f41c838 (01:27:07 IST) hashes to ea40f81c52e1 (full sha matches BATCH2-RULE.sha256).
- R1-R4 are folded in as written in refute/28:
  - R1 margin >= 0.15;
  - R2 doctor-count criterion dropped, with no demotion;
  - R3 check days are neither evidence nor minting;
  - R4 placebos on 9-24 Sep.
- g013 + g077 are one Ankit unit. H04 is an ordinary card only. H05 carries my amended test verbatim, run once.
- Freeze statement: no 16-17 Sep embedding exists (consistent with #1500: 11 of ~420 windows diarized).

## g034 (ae82a5) and g017 (9d2c75) cards: PASS, with one wording fix (W1)
Box ~/eta-data/voice-linkage/batch2-anchored{,-key}. Checked with my own commands:
- Audio: all 8 clips were re-cut independently from pilot/audio/{window}.wav with the stated ffmpeg settings. 8 of 8 are byte-identical to the delivered mp3, and the 8 sha256 values are distinct.
- Clip provenance, checked through the emb meta (window, off_s) -> turn -> link core_turn_idx:
  - Each doctor clip is a CORE turn of the group's member cluster: g034 on 3 room-days, cos 0.685-0.781; g017 on 3 room-days, cos 0.648-0.743. Every recomputed cos equals the key.
  - Each contrast clip comes from the same session and is NOT in the core (cos 0.068 and -0.169).
- Enrolment: the Poornima and Dibyendu print files (json, enroll-raw, match, payload) contain no bs_ room session, because both are Meet enrolments. So 0 of the 6 clip sessions are enrolment sessions.
- Card text: KNOWN-VOICE CHECK wording; Dibyendu's Meet-print disclosure is present; no tier words.
- W1 (fix before seeding): the card says "above 0.85 is a strong match; 0.60 to 0.70 is moderate". That leaves 0.70-0.85 unlabelled, and both new cards (0.76-0.79, 0.72-0.82) fall in the gap. The frozen rule says moderate = 0.60-0.85, so the batch-2 cards should read "0.60 to 0.85 is moderate".
  - The live batch-1b seed carries the same sentence, but its 3 known-voice cards (g008 0.86-0.92, g071 0.89-0.93, g013 0.60-0.69) are all inside labelled bands. The live seed is NOT to be changed (r260).

## vj-link's slip (#1500 item 3): repaired, verified
batch1b-anchored-key/clips.json again lists the 12 g071/g008/g013 clips. I re-cut all 12 from its offsets: 12 of 12 are byte-identical to batch1b-anchored/audio, and those 12 files are in the published seed's FILES.txt (12 of 12 sha). My refute/26 scoring split is unaffected.

## W1 re-check (vj-link #1506): CLOSED
- Both cards now read "0.60 to 0.85 is moderate".
- The 8 audio sha256 are unchanged (same 8 as above), and clip paths are unchanged.
- The key files are unchanged (mtime 01:28).
- The live batch-1b seed_docs.json still carries its original sentence 3 of 3 times, so it was not modified.
