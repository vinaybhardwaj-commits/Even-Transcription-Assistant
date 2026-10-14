"""W50 terms bake-off: consult-length bands for the failure-count report Fable ruled on 18:45 (ADDENDUM-17, P1).

Failures are reported per engine AND per consult-length band, since a fragile candidate's failure mode (e.g.
parakeet-med OOMing on long audio) can correlate with length - a bare overall failure count would hide that
pattern. Bands chosen from the real retained (post-60min-span-cap) distribution: verified non-empty and reasonably
balanced (34/44/14 of the 92 retained consults), not arbitrary round numbers.
"""

BAND_EDGES = (
    (0.0, 600.0, "short <=10min"),
    (600.0, 1800.0, "medium 10-30min"),
    (1800.0, 3600.0 + 1e-9, "long 30-60min"),  # +epsilon: SPAN_CAP_S (3600.0) itself must land in "long", not overflow
)


def band_for(duration_s):
    for lo, hi, label in BAND_EDGES:
        if lo <= duration_s < hi:
            return label
    raise ValueError(f"duration_s={duration_s} is outside every band - should have been excluded by the span cap")
