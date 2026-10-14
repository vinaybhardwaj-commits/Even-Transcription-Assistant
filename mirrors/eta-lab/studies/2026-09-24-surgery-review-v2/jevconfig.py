"""jevconfig.py — W41 F4 (jev-audit finding #27): one reviewable module for this study's Jev
thresholds. Values only MOVED here from v3.py/v4.py/v5.py/build_consult.py/finalize.py, never
changed -- each module's own check_frozen()/selftest still verifies the exact same numbers, since
`global NAME` inside those modules rebinds the name in their own namespace regardless of whether
it started life as a literal or an import.

MODEL (the pinned Jev version, W41 F2) lives here since F4b; u9.py re-imports it, so u9.MODEL is unchanged for callers.
"""

# v3.py / v4.py / v5.py -- stage (a) recall gate on the "named"/"described" nouls. Tuned on V's
# 18-23 real labelled consults (jev-audit finding #25: this is the live threshold, not the
# "W2_inclusive P>=0.65" the order named, which no commit in this repo contains).
RECALL_CUT = 0.25

# v5.py only -- stage a0's present-patient gate (rulings 164/171/172/181).
GATE_CUT = 0.5

# build_consult.py -- Jev supports at most ~200 questions per call; probe questions (5/turn) are
# chunked at this size to stay under it.
CHUNK = 180

# build_consult.py's evidence_from(): a turn's per-kind probe must clear this probability to count
# as evidence, capped at this many turns per kind (highest-probability first, then time order).
EVIDENCE_MIN_P = 0.5
EVIDENCE_MAX = 6

# finalize.py -- Jev's too_poor probability at or above this marks a consult "poor" (transcript
# mostly unusable); the raw probability is still kept in the file's own meta block.
POOR_P = 0.75

# u9.py -- the Jev model version every request pins.
# W41 F2: every jev_decision row in production (5672/5672, 23-24 Sep) and the Arm D J4 bench
# (67/67 real rows, jev_window_signal, 22 Sep) came back model="jev-1.13.0" -- pin to what the
# wording (v2.1-v2.3) and the 18-real-label thresholds were actually tuned against, not the
# floating alias. response.model is still read back below and threaded through by callers, so a
# vendor-side change shows up in the data instead of being silently absorbed by the pin.
MODEL = "jev-1.13.0"
