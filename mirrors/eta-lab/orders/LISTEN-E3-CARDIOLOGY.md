# E-3 listening session for V, Cardiology: build order (Fable, 23 Sep)

Owner: yoga-drain (you built e3kit). Deliver a tailnet URL by **12:30 IST**. V sits at 13:00 for ~45 min.

## What V decided
- Choices = **named doctors + roles**.
- Scope = **Cardiology first** (room_bh6jtq4t, Dr. Dibyendu).
- Size = **~150 clips, ~45 min**.

## Settled design (no open questions; if something here is impossible, stop and report, don't improvise)

1. **Windows.** Pick 10 Cardiology 15-min windows spread over at least 4 different days and over
   morning and afternoon, preferring windows with the most speech. Include bs_gkzmch9p (12 Sep).
2. **Diarize.** The store has 0 speaker spans for these days, so diarize the chosen windows on the
   **Mini's eta-diarize AFTER night-drain has finished** (check the log has stopped growing; ETA ~07:30).
   ~57 s a window, ~10 min total. Do not run it while night-drain is live: swap is at 555 MB.
3. **Audio.** Do NOT go through scribe_extract_audio (the token is read-scope and we are not rotating
   it). Read the chunks directly on the Mini from the same storage the door presigns from. Audio stays
   on the Mini. Nothing is uploaded anywhere.
4. **Sampling, 150 clips.** Turns >= 1.5 s. Clip length 3-8 s (for a longer turn take the middle 8 s).
   Spread across every diarized cluster in every window, not just the loudest. Stratify by the
   current machine score against the room centroid: about 1/3 borderline (0.55-0.75), 1/3 high,
   1/3 low, so the threshold gets fitted where it matters. Add **10 hidden repeats** of clips already
   shown, to measure V's own consistency. Randomise the order.
5. **Candidates.** "Dr. Dibyendu" plus any other clinician the store has set on visits in this room
   (the warehouse has no room dimension, so use visit-clinician data, not the roster). Show only
   names you can source; list the source in your report.
6. **The page.** Stdlib Python server on the Mini, tailnet only, port 8798. Per clip:
   - plays automatically once; Replay button; "+3 s context" button (plays 3 s either side)
   - buttons, with number keys 1-7: **Dr. Dibyendu | Another doctor (pick or type the name) |
     Patient | Family/attendant | Nurse/staff | Two voices | Can't tell**
   - Skip, Back (change the last answer), a progress counter "37 / 160"
   - **Show no transcript text, no score, no cluster id, no window id** - anything visible biases the ear.
   - Every answer saved to disk the moment it's clicked, so a refresh or a break loses nothing and
     V can resume where he stopped.
7. **Output.** `~/dev/_fable/e3kit/out/labels_cardiology.csv` in score.py's format
   (window_id,time_ms,label,clinician_id) plus the raw answers JSON with timestamps.
8. **After V finishes** (not before): run score.py and report the leave-one-out doctor distribution,
   the non-doctor distribution, the Youden and EER thresholds, and V's agreement rate on the 10 repeats.

## Verify before you hand me the URL
- Open it yourself, answer 3 clips including a Back, refresh, confirm it resumes, then reset the answers file.
- Confirm each clip plays in a browser (codec) and the +3 s context works at a window edge.

## Do not
- write to the voiceprint store or the DB
- run anything heavy on the Mini while night-drain is live
- show V anything but the audio and the buttons

REPORT: at most 6 lines: URL, windows chosen (ids + IST), candidate names and their source, clip count, what you verified.
