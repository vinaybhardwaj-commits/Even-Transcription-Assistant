#!/usr/bin/env python3
"""choose_bounds.py <bounds_raw.json> <selected.json> <out_bounds.json> — lx's bounds, kept only when SANE; otherwise the PQM window with 5 min context each side.
SANE = basis arm_d|arm_d_audio, check False (no two clips >=30% each), encounter <=45 min and <=4x max(PQM span, 5 min). Anything with check True (>=2 encounters) stays check True and is never selectable.
Measured on 21-22 Sep: audio-derived cuts can be wild (a 3-min PQM step -> 63 min; 7-min -> 360 min), hence the rule."""
import json, sys
CTX = 5 * 60 * 1000
HARD = {"two_clips", "long_encounter"}


def choose(b):
    enc = (b["encounter"]["end_ms"] - b["encounter"]["start_ms"]) / 60000
    pqm = (b["pqm"]["end_ms"] - b["pqm"]["start_ms"]) / 60000
    reasons = b.get("check_reasons")
    hard = bool(set(reasons) & HARD) if reasons is not None else bool(b["check"])  # lx's newer bounds name the reasons: only two_clips / long_encounter mean >=2 encounters; the rest are advisory
    if b["basis"] in ("arm_d", "arm_d_audio") and not hard and enc <= 45 and enc <= 4 * max(pqm, 5):
        return b, "lx"
    s, e = b["pqm"]["start_ms"], b["pqm"]["end_ms"]
    return {**b, "basis": "pqm_fallback", "encounter": {"start_ms": s, "end_ms": e},
            "greyed": [{"start_ms": s - CTX, "end_ms": s, "why": "before (context)"}, {"start_ms": e, "end_ms": e + CTX, "why": "after (context)"}]}, "pqm"


def selftest():
    base = {"item_id": "x", "room_day_id": "r", "pqm": {"start_ms": 0, "end_ms": 10 * 60000}, "greyed": [], "check": False, "basis": "arm_d_audio"}
    ok = {**base, "encounter": {"start_ms": 0, "end_ms": 20 * 60000}}
    assert choose(ok)[1] == "lx"
    big = {**ok, "pqm": {"start_ms": 0, "end_ms": 30 * 60000}}  # 4x the PQM span is 120 min: only the 45-min cap can reject
    assert choose({**big, "encounter": {"start_ms": 0, "end_ms": 46 * 60000}})[1] == "pqm", "over 45 min"
    assert choose({**big, "encounter": {"start_ms": 0, "end_ms": 45 * 60000}})[1] == "lx", "exactly 45 min is sane"
    assert choose({**ok, "pqm": {"start_ms": 0, "end_ms": 3 * 60000}, "encounter": {"start_ms": 0, "end_ms": 21 * 60000}})[1] == "pqm", "over 4x the 5-min floor"
    assert choose({**ok, "pqm": {"start_ms": 0, "end_ms": 3 * 60000}, "encounter": {"start_ms": 0, "end_ms": 20 * 60000}})[1] == "lx", "exactly 4x the floor is sane"
    r, how = choose({**ok, "check": True}); assert how == "pqm" and r["check"] is True and r["basis"] == "pqm_fallback", ">=2 clips: PQM window, still flagged"
    assert choose({**ok, "basis": "pqm_fallback"})[1] == "pqm" and choose({**ok, "basis": "arm_d"})[1] == "lx"
    soft = {**ok, "check": True, "check_reasons": ["clamped_mid_speech", "long_pqm"]}
    assert choose(soft)[1] == "lx", "advisory reasons (clamped_mid_speech, long_pqm, no_speaker_data) do not exclude"
    assert choose({**ok, "check": False, "check_reasons": ["two_clips"]})[1] == "pqm" and choose({**ok, "check": False, "check_reasons": ["long_encounter"]})[1] == "pqm", "two_clips / long_encounter are hard"
    assert choose({**ok, "check": False, "check_reasons": []})[1] == "lx" and choose({**ok, "check": True, "check_reasons": []})[1] == "lx", "with reasons present, an empty list means none"
    print("choose_bounds selftest OK")


if __name__ == "__main__":
    if sys.argv[1] == "--selftest":
        selftest(); raise SystemExit
    raw = {x["item_id"]: x for x in json.load(open(sys.argv[1]))}; sel = json.load(open(sys.argv[2]))
    out = [choose(raw[q])[0] for q in sel if q in raw]
    json.dump(out, open(sys.argv[3], "w"), indent=1)
    print("chosen:", len(out), "| lx bounds:", sum(1 for q in sel if q in raw and choose(raw[q])[1] == "lx"), "| PQM window:", sum(1 for q in sel if q in raw and choose(raw[q])[1] == "pqm"))
