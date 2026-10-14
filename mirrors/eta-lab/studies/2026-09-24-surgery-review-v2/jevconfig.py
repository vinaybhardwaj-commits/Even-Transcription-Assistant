"""jevconfig.py — W41 F4 (jev-audit finding #27): one reviewable module for this study's Jev
thresholds. Values only MOVED here from v3.py/v4.py/v5.py/build_consult.py/finalize.py, never
changed -- each module's own check_frozen()/selftest still verifies the exact same numbers, since
`global NAME` inside those modules rebinds the name in their own namespace regardless of whether
it started life as a literal or an import.

u9.MODEL (the pinned Jev version, W41 F2) is NOT here yet: F2 and F4 were built on separate
branches off the same base, so u9.py still defines it locally. Folding it into this module is a
natural follow-up once F2 merges -- flagged, not silently skipped.
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
