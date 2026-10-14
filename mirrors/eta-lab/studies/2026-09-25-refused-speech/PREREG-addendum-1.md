# Ruling 333 measurement: pre-registration ADDENDUM 1 (split-speaker, 25 Sep 2026, ~07:25 IST): noisy-silence control, and what was visible when it was written

Origin: eta-refuter #1831. The exact-zero controls are digital silence, so they cannot show whether a detector fires on steady room noise or hum. `PREREG.md` (9894479) is unchanged; this only adds a control.

## POST-HOC DISCLOSURE (read this first)
The main measurement was already running when this addendum was written. I had seen its progress lines for the first ~14 refused windows (primary speech fraction 0.004 to 0.033 each) and had NOT opened `results.json`
(it did not exist). The noisy-silence control below was designed, drawn and frozen before any result file was opened, but NOT before any number was visible. It is labelled post-hoc.
The main run was also restarted once (07:24) to add progressive saving and per-window error handling and to read chunk timing from `hist/manifest.json`; the frozen `refused_logic.py` (sha256 466f56b3...) is unchanged.

## The control (frozen in `noisy_draw_frozen.json`, code `noisy_control.py`)
Real-microphone windows in which the router found NO text (vault status `no_text`), in the rooms of the 30 drawn windows, measured over the whole 900 s with the SAME detectors and decision rule.
- **N1 (night, IST 01:00-05:00): 8 windows** (seed 20260928) from a pool of 33. No such window exists since 22 Sep (the C270 webcam-mic period): all 33 are 14-20 Sep, the recorder period of 27 of the 30 drawn windows.
- **N2 (dated >= 22 Sep, any hour, C270 mics): 6 windows** (seed 20260929) from a pool of 19. Caveat: daytime windows in which the router found no text, and the router's VAD is known to miss low-SNR speech, so a window may hold real speech: **N2 is reported, no pass/fail**.
- **Criterion (N1 only, primary = webrtcvad mode 3):** median speech fraction <= 0.05 AND at most 1 of the 8 at >= 0.10. If N1 fails, the primary detector fires on room noise, the 30-window counts overstate speech, and that is the finding.
- Only 3 of the 30 drawn windows are dated >= 22 Sep, so the hum question for the C270 period is only weakly testable (N2); stated, not hidden.

## Integrity (eta-refuter #1831 point 2), counts only
Local chunk file size vs `hist/manifest.json` size_bytes: the 30 drawn windows use 112 chunks: 112 match, 0 mismatch, 0 missing, 0 not in the manifest. The noisy control's 48 chunks: 48 of 48 match. The other controls: 4 chunk files are missing locally (those control windows will be reported as not measurable if their chunks are among them).
