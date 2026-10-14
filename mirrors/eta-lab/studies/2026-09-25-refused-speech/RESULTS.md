# Ruling 333 measurement: RESULTS (split-speaker, 25 Sep 2026, ~07:45 IST). Ids, counts and seconds only; no text, no labels.
Frozen before measuring: `PREREG.md` (9894479), `PREREG-addendum-1.md` (87ed79b, post-hoc control). Data: `results_r1.json`, `noisy_results_r1.json`. Code: `refused_logic.py` (frozen, sha256 466f56b3...), `measure.py` (sha256 7dd322c226e4c890...), `noisy_control.py`.

## Headline (primary = webrtcvad mode 3; rule: >= 5 s and >= 10 % of the refused span)
- **1 of 30** all-refused windows has speech present by the frozen rule; **29 of 30 do not**. Other detectors on the same spans: webrtcvad mode 2 **5 of 30**; Silero (the router's own detector) **0 of 30**; energy **1 of 30**. All three of (webrtc 3, Silero, energy) agree on speech in **0 of 30**.
- Refused span in the 30 windows: 5908 s in total (median 74.5 s per window). Primary speech seconds: 386.6 s, of which 342.1 s are in the single flagged window (2026-09-10_room_ymch4bxu_1015, span 900 s, primary 0.38, Silero 0.00, energy 0.00).
  Without that window: 44.4 s of 5008 s = 0.9 %.
- POST-HOC diagnostic on that one window (`hum_diagnostic.py`, written after the results were open): a steady tone at 218.8 Hz, peak 309x the median bin, strongest bin in 83 % of frames, only 9.5 % of energy in 300-3400 Hz. The same room's guard-ACCEPTED control from earlier that day has the same 218.8 Hz tone (156x) but 35 % speech-band energy. Reading: the flag in that window is most likely hum triggering webrtcvad, not speech. That is an inference from a spectrum, not proof.
- By room (primary present / drawn): only room_ymch4bxu 1 of 2; every other room 0.

## Controls (same code)
- Guard-ACCEPTED, 10 windows, over accepted segments: primary median fraction 0.533 (min 0.074); webrtc 2 median 0.716; Silero median 0.623 (min 0.000). Two of the 10 have Silero 0.0 and a primary fraction <= 0.25 although the router transcribed them: **the detectors under-report real speech in some rooms**, so "no speech detected" in a refused window is not proof of no speech.
- Exact-zero NO_SIGNAL, 4 measured of 5 (one has a chunk file missing locally): all detectors 0.0.
- Frozen separation criterion (primary: accepted median >= 0.50 AND silent max <= 0.02): **met** (0.533, 0.0), narrowly on the median.
- Noisy-silence N1 (8 night no-text windows, 14-20 Sep): median primary fraction 0.0, 0 of 8 at >= 0.10: **PASS**. N2 (6 windows >= 22 Sep, C270 period, no pass/fail): primary fractions 0.0, 0.0, 0.0, 0.0, 0.001, 0.0.

## What it shows and what it cannot
- Shows: in this sample the guard's all-refused windows hold very little detectable speech: at most 1 of 30 by the primary rule (probably hum), 5 of 30 by the most permissive detector, 0 of 30 by Silero. It does not show that the guard is discarding large amounts of clean speech.
- Cannot show: that the refused text was correct or wrong; that low-SNR speech is absent (the controls show the detectors miss speech in some accepted windows, so 'no speech detected' is a floor, not a ceiling); anything about the C270 period beyond 3 drawn windows (27 of the 30 are earlier); language (all `en`).
- The 30 windows are 5 % of 603; a rate would need a larger draw. Fable decides whether the guard over-refuses.

## Addendum 2 (post-hoc, ~07:46 IST): what the refused segments are (eta-refuter #1876 point 3; router_server.py read)
- `PREREG.md` said the refused spans were "Silero-sliced". **That premise was wrong for these windows.** In the router (`router_server.py`, `vad_segments`), when Silero VAD finds NO speech spans the router falls back to FIXED windows
  (30 s spans, hop 29 s, restarted per 180 s sub-window, method `fixed-window-vad-empty`) and lets the engines decide. `segmentation_check.py` on the 30 drawn windows: **all 213 of the 213 refused segments match that fixed plan; 30 of 30 windows are all-fixed.**
  (Guard-accepted controls: 2 of 10 all-fixed, 4 mixed, 4 none.) So every drawn all-refused window is one where the router's Silero found nothing, and Silero reading 0.0 in them (D2) is **by construction, not an independent check** (same detector, same 0.5 threshold that triggered the fallback).
  Independent evidence is webrtcvad and the energy test only.
- **Why this does not settle "no over-refusal":** the router's own comment records that on low-SNR far-field room audio "no speech" from Silero is a VAD failure far more often than a quiet room (19 Sep: the VAD kept 50 % of the speech the diarizer found, 5 of 30 windows returned zero spans on audio holding 179-671 s of diarized speech). So these are exactly the windows where real low-SNR speech can hide, my detectors miss speech there too (the accepted controls), and the guard's refusal in them can be a correct rejection of hallucination over near-silence OR a refusal of real faint speech. The measurement cannot tell these apart. An independent speech measure (the diarizer) on the same 30 windows would; not run, and not proposed to run during the Mini's protected window.
