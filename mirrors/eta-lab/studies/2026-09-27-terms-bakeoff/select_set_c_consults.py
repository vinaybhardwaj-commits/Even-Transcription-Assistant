"""W50 set (c): the 92 span-cap-retained consults, with the real per-consult crop span already applied.

Reuses the exact join/filter already witnessed by both checkers (ADDENDUM-1 T1, ADDENDUM-2 G1, ADDENDUM-13,
test_span_cap.py's real-data check): `links.jsonl`'s `span` field for 22/23/24 Sep is ALREADY
`[called_at-30s, completed_at+30s]` (`cap_link.py`'s own PAD_S=30.0, ADDENDUM-2 G1) - no second pad is added here.
Filters to `status in {confirmed, probable}`, then `span_cap.filter_by_span_cap` (60-min cap, ADDENDUM-13).
"""
import json
import os
from datetime import datetime

from span_cap import filter_by_span_cap

CAP_DAYS_ROOT = os.path.expanduser("~/eta-data/cap")
DAYS = ("22", "23", "24")


def _parse_iso(s):
    return datetime.fromisoformat(s)


def list_set_c_consults(days_root=CAP_DAYS_ROOT, days=DAYS, year_month="2026-09"):
    """-> (kept, excluded): each a list of dicts {consult_id, day, room_id, span_start, span_end (datetime, tz-aware),
    duration_s}. `kept` is the 92 consults set (c) actually scores; `excluded` (7, per span_cap) is reported as a
    count only, per span_cap.py's own convention - never silently dropped from the record."""
    all_consults = []
    for day in days:
        links_path = os.path.join(days_root, f"{year_month}-{day}", "links.jsonl")
        with open(links_path) as f:
            for line in f:
                r = json.loads(line)
                if r.get("status") not in ("confirmed", "probable"):
                    continue
                a, b = r["span"]
                span_start, span_end = _parse_iso(a), _parse_iso(b)
                all_consults.append({
                    "consult_id": r["consult_id"], "day": day, "room_id": r["room"],
                    "span_start": span_start, "span_end": span_end,
                    "duration_s": (span_end - span_start).total_seconds(),
                })
    keyed = {(c["day"], c["consult_id"]): c for c in all_consults}
    kept_keys, excluded_keys = filter_by_span_cap(
        [((c["day"], c["consult_id"]), c["duration_s"]) for c in all_consults]
    )
    kept = [keyed[k] for k in kept_keys]
    excluded = [keyed[k] for k in excluded_keys]
    return kept, excluded


if __name__ == "__main__":
    import sys
    kept, excluded = list_set_c_consults()
    print(f"# {len(kept)} kept, {len(excluded)} excluded (span > 3600s)", file=sys.stderr)
    out = [{"consult_id": c["consult_id"], "day": c["day"], "room_id": c["room_id"],
            "span_start": c["span_start"].isoformat(), "span_end": c["span_end"].isoformat()}
           for c in kept]
    print(json.dumps(out, indent=1))
