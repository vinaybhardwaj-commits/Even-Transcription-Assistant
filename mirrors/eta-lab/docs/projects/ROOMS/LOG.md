# LOG — ROOMS (every clinic hour recorded)

Build and event log, newest first. Owner panes: fleet (fleet-watch), scribe, radar-kit.

## 26 Sep ~17:00 IST — OPD 4 down ~5.5 h; 8 rooms recording
Session: fleet (fleet-watch, 5-min polling).
OPD 4 DEVICE_MISSING (11:01) + NOT_RECORDING (11:31) still open; looks physical. 8 rooms recording. Restart = Fable's ruling. Dietary Mac silent since 24 Sep (hostname unknown).
Refs: #3676.

## 26 Sep 09:19 IST — no auto-start exists
Session: fleet/scribe (investigation).
Saturday recording delayed; V started rooms manually. Found: there has never been an auto-start mechanism — staff press Start each morning. Auto-start design = item 151 (V's decision).
Refs: #3366, #3373.

## 25 Sep — exact-zero root cause + C270 correction
Session: scribe + fleet + eta-refuter.
Bit-exact zero tape (137 h) root-caused to TONOR TM20 hardware mute (r255/280). V corrected OPD 4 uses a C270 webcam (no mute) — r336; acoustic test proved the C270 works in an empty room (r355/368).
Refs: r255, r267, r280, r336, r355, r368.

## 25 Sep 13:47 IST — fleet-watch live
Session: fleet.
24x7 room monitor deployed (r399), 5-min polling, $2/day cap; NOT_RECORDING/NOT_DELIVERING/DEVICE_MISSING alerts. Hardened local proxy (a47da00) keeps audio links off the LLM.
Refs: #2483, r399, r401, r404.
