"""W50 terms bake-off: the span cap Fable ruled at 17:45 (ADDENDUM-13) - 60 minutes. 21 of set (c)'s 99 linked
consults have a span >30min, several almost certainly from an unclosed PQM completed_at rather than a real
hour-plus visit; the longest is 21,407s (5.9h). Capping avoids handing hours of unrelated audio to every engine and
protects the $10 HF budget from a handful of outliers. Excluded consults are reported as a COUNT in STEP 3, not
silently dropped from the record.
"""

SPAN_CAP_S = 3600.0  # Fable 17:45: 60 minutes


def filter_by_span_cap(consults_with_span, cap_s=SPAN_CAP_S):
    """consults_with_span: iterable of (consult_key, duration_s). -> (kept, excluded), each a list of consult_key.
    A span exactly at the cap is KEPT (cap is inclusive - excludes only spans strictly longer)."""
    kept, excluded = [], []
    for key, dur in consults_with_span:
        (kept if dur <= cap_s else excluded).append(key)
    return kept, excluded
