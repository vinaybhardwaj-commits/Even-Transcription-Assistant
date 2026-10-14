# 33. GCP exit (r386 S1 / r393 owners): vj-refuter's data on voice-lab-1, and the truth store sealed. vj-refuter, 25 Sep ~12:25 box clock

## Ownership (r393)
- ~/vj/refute on voice-lab-1 is vj-refuter's (5.6 GB, almost all .venv plus an HF model cache).
  - Non-venv files: scripts, centroid and pitch checks, re-query arm outputs and clips, requery_ids.txt (ids only), turn_vecs_rooms_box.json.
  - It holds NO label values, so lab-mover's plain copy under gcp-archive/voice-lab-1/home/vj/refute is fine.
- /srv/vj-truth (user vjscore, mode 700, 26 MB, 49 files: truth files plus score/ with code, inputs, the re-query and outputs) is vj-refuter's (r168).

## Sealed archive (done by me; plaintext never written to the box)
- Stream: `sudo -u vjscore tar /srv/vj-truth` over ssh, piped into `gpg --symmetric AES256` on the box.
- Out: ~/eta-data/vj-truth-sealed/vj-truth-20260925.tar.gpg (5.85 MB, mode 600; directory 700).
- Key: ~/.claude/secrets-archive/voice-lab-1/vj-truth-seal.key (mode 600, random 48 bytes; never printed or on argv).
- MANIFEST.sha256: 49 lines, paths and hashes only.
- Plaintext tar sha256 starts f937b25e1cdfb778. A decrypt round-trip (in a pipe, no extraction) gives the same sha and 49 files.
- Rule: only vj-refuter decrypts, and every decrypt is logged in the refute notes. Builders never read the key or the archive. This is a procedural seal, since all box panes run as user eta. It holds as long as no other pane touches ~/eta-data/vj-truth-sealed or the key.
- lab-mover must NOT copy /srv/vj-truth in plain into gcp-archive. For GATE 1, list it as "owner-archived, sealed", with the 49-line manifest for count comparison.

## Scoring venue after voice-lab-1 stops (safer option now; decision parked for Fable)
- No scoring is possible or due until V's page labels exist.
- Proposal A, recommended: recreate a separate scoring user on the box (useradd vjscore; /srv/vj-truth mode 700; sudo -u vjscore; auth.log audit), then decrypt the seal into it. This is a box system change, so it needs Fable's go.
- Proposal B: score as eta from a decrypted temp dir removed after each run. It is weaker, since there is no OS boundary.

## vj-arms #2352 dependency (1): arm 4 needs Vertex
- The box has no Google credentials, so an F5 re-query of arm 4 cannot run after the stop.
- Interim: arm 4 is 37/88 and fails F2/F3.
- Safer option: F5 for arm 4 = not_run. The status is then NOT_ADOPTED or CONTINUE_ONLY regardless, and no verdict changes.
- Only if arm 4 passes F1-F3 at the final score does Fable name a Vertex path (e.g. V's credential) for its F5 re-query.
- Arms 2/3 re-query through the Jev HTTP API from the box (key copy on the box), so they are unaffected.

## Auth audit additions (see refute/22)
- The 13:07:33 UTC `sudo ls /srv/vj-truth` is CLOSED. vj-data's "second disclosure" in data/VJSCORE-SETUP.md (19:0x IST, empty result, no file read) covers it. I had missed that entry.
- New, vj-data's third disclosure: `sudo du -sh /srv/vj-truth` (root, sizes only) at ~06:50 UTC on 25 Sep.
- Mine: the sealing commands at ~06:54 UTC (sudo -u vjscore tar; sudo -u vjscore find/sha256sum), plus the earlier ls/du inventory at ~06:5x UTC.

## refuter-2 #2419 condition 1: MET (~13:40 box clock)
- MANIFEST.sha256 file sha = 561c83506ce5bf6f (49 lines).
- Sorted-by-path lists: seal manifest = plain copy = fresh-decrypt per-file hashes, all with sha ae66506e443cce4c (49/49).
- Condition 2 is agreed: the source /srv/vj-truth stays untouched until S7.
- The plain copy may be removed by lab-mover. GATE 1 records it as sealed (manifest sha 561c83506ce5bf6f).

## GATE 1 voice-lab-1: PASS (refuter-2 #2455)
- /srv/vj-truth is recorded as owner-archived and sealed: the source count of 49 equals the manifest (561c83506ce5bf6f); 0 plain vj-truth paths remain in gcp-archive.
- ~/vj/refute is in the archive, hash-matched (0 sha differences).
- From vj-refuter's side, voice-lab-1 may stop (S6).
- Open for Fable: the scoring venue and the arm-4 F5 path (see above).

## Fable ruling 413.4(a): item 67 decided
- The sealed archive goes into the Air Drive mirror as the encrypted tar plus its manifests only. The key never leaves the box. vj-refuter checks the Mini-side hashes.
- Box-side hashes already verified (#2576):
  - tar.gpg b4c44bbf75fce3a0...
  - MANIFEST.sha256 561c83506ce5bf6f...
  - plain_tar.sha256 01b3250aa576f222...
- Pending: lab-mover's Mini-side hashes after the copy. The Mini lost power at ~16:13, so the copy may need re-running.
- Residual risk, accepted by the ruling: the key is single-copy on the box. Once voice-lab-1's disk is deleted (S7), losing the box means losing the VJ truth store; the off-box ciphertext cannot be decrypted without the key.
- The truth store holds the E-3 and V-pilot truth plus the scorer and interim outputs. The page labels are not in it yet: they will come from the page export.
- Mini-side check DONE (lab-mover #2778, copied 20:33 box to /Volumes/Air Drive/gcp-archive/_vj-truth-sealed/): all 3 full sha256 values match my box files exactly (tar.gpg b4c44bbf..., MANIFEST 561c8350..., plain_tar 01b3250a...). The key did not travel. Off-box encrypted copy CONFIRMED.
