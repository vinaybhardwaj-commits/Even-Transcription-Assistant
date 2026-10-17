"""Strict day-summary check on synthetic intervals: no dependence on the written output files or their counts."""
import json
from ras import report

D = 86400.0


def iv(day, state, a, b):
    return {"ist_day": day, "state": state, "_a": a, "_b": b}


def test_day_summary_is_exactly_1440_per_room_day_and_one_row_per_room_day(tmp_path):
    allint = {
        "r1": [iv("2026-10-06", "audio_present", 0, 3600), iv("2026-10-06", "audio_gated", 3600, 5400),
               iv("2026-10-06", "recorder_off", 5400, D), iv("2026-10-07", "muted", D, 2 * D)],
        "r2": [iv("2026-10-06", "withheld", 0, D)],
    }
    out = tmp_path / "day-summary.jsonl"
    report.write_day_summary(allint, {}, str(out))
    rows = [json.loads(l) for l in out.read_text().splitlines()]
    assert [(r["room_id"], r["ist_day"]) for r in rows] == [("r1", "2026-10-06"), ("r1", "2026-10-07"), ("r2", "2026-10-06")]
    for r in rows:
        assert abs(sum(r[c] for c in report.SUMMARY_COLS) - 1440) < 0.01, r
    r = rows[0]
    assert (r["usable_min"], r["uncertain_min"], r["off_min"]) == (60, 30, 1350)


def test_day_summary_a_short_day_is_not_hidden(tmp_path):
    out = tmp_path / "s.jsonl"
    report.write_day_summary({"r": [iv("d", "audio_present", 0, 3600)]}, {}, str(out))
    r = json.loads(out.read_text())
    assert abs(sum(r[c] for c in report.SUMMARY_COLS) - 1440) > 1          # the strict check would flag it
