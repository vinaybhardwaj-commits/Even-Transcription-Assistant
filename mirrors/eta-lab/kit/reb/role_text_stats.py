"""role_text_stats.py: READ-ONLY measurement of the role.text-judge layer (6S9 step 2). Counts and rates only; no text, no names.

Per live text-judge track (consult clips 2026-10-02..2026-10-09): (a) judge A vs judge B on the doctor; (b) abstain reasons and rate per language heard (the dominant stt
language); (c) Jev requests / tokens / latency from the run's call log; (d) agreement with the VOICEPRINT label (role.sarvam-doctor-map v1) where the cutter had
doctor_identified: a NOISY reference only (VP recall 89.5%, false accept 3%), never truth and never an input to the judge.
"""
import argparse
import collections
import glob
import json
import os
import sys

from . import sarvam_lane as sl
from .role_text_judge import ENGINE as TJ_ENGINE, live_track
from . import writer

REB = os.path.expanduser("~/eta-data/reb")
OUT = "/home/eta/oc/palimpsest/out"


def pct(vals, p):
    if not vals:
        return None
    v = sorted(vals)
    k = (len(v) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return round(v[lo] + (v[hi] - v[lo]) * (k - lo), 4)


def latest_track(root, row, layer, engine):
    """The latest-finished live ok track of the consult for (layer, engine), or None."""
    wd = writer._window_dir(root, row["ist_date"], row["room_id"], "consult-" + row["consult_uid"])
    try:
        m = json.load(open(os.path.join(wd, "manifest.json")))
    except (OSError, ValueError):
        return None
    best = None
    for e in m.get("tracks", []):
        if e.get("layer") == layer and e.get("engine") == engine and e.get("status") in ("ok", "skipped"):
            p = os.path.join(root, e["path"])
            if os.path.exists(p) and (best is None or (e.get("finished_at") or "") >= (best[0] or "")):
                best = (e.get("finished_at"), p)
    return json.load(open(best[1])) if best else None


def doctor_of(track):
    ds = [sp for sp, v in (track["extras"].get("map") or {}).items() if v.get("role") == "doctor"]
    return ds[0] if len(ds) == 1 else None


def language_heard(stt):
    ex = stt.get("extras") or {}
    langs = collections.Counter()
    if ex.get("parts"):
        for p in ex["parts"]:
            langs[p.get("language_code")] += p.get("audio_s") or 0
    else:
        for sg in stt.get("segments", []):
            langs[sg.get("lang")] += (sg["t1_ms"] - sg["t0_ms"]) / 1000.0
    return langs.most_common(1)[0][0] if langs else None


def call_log_stats(path):
    rows = [json.loads(l) for l in open(path) if l.strip()]
    lat = [r["latency_s"] for r in rows if r.get("status") == 200]
    return {"requests": len(rows), "ok": sum(1 for r in rows if r.get("status") == 200), "retries": sum(1 for r in rows if (r.get("attempt") or 0) > 0),
            "input_tokens": sum(r.get("input_tokens") or 0 for r in rows), "output_tokens": sum(r.get("output_tokens") or 0 for r in rows),
            "latency_median_s": pct(lat, 0.5), "latency_p90_s": pct(lat, 0.9), "latency_max_s": max(lat) if lat else None}


def measure(root=REB, index_path=sl.CLIP_INDEX, since="2026-10-02", until="2026-10-09", call_log=None):
    rows = {u: r for u, r in sl.latest_rows(index_path).items() if r.get("status") == "cut" and since <= r["ist_date"] <= until}
    out = {"clips_in_scope": len(rows), "no_text_judge_track": 0}
    ab = collections.Counter()
    by_lang = collections.defaultdict(collections.Counter)
    reasons = collections.Counter()
    vp = collections.Counter()
    role_counts = collections.Counter()
    n = 0
    for uid, r in sorted(rows.items()):
        t = latest_track(root, r, "role", TJ_ENGINE)
        if not t:
            out["no_text_judge_track"] += 1
            continue
        n += 1
        mp = t["extras"]["map"]
        stt = live_track(root, r, "stt")
        lang = language_heard(stt[2]) if stt else None
        reason = t["extras"].get("abstain_reason")
        a_named = [sp for sp, v in mp.items() if v["judge_a"].get("named_doctor")]
        b_top = [sp for sp, v in mp.items() if v["judge_b"].get("is_top")]
        if not mp:
            kind = "no_speakers"
        elif a_named and b_top:
            kind = "A_and_B_name_same" if a_named[0] == b_top[0] else "A_and_B_name_different"
        elif a_named:
            kind = "A_names_B_no_call"
        elif b_top:
            kind = "A_abstains_B_names"
        else:
            kind = "neither_names"
        ab[kind] += 1
        by_lang[lang]["clips"] += 1
        if reason:
            reasons[reason] += 1
            by_lang[lang]["abstain_" + reason] += 1
        else:
            by_lang[lang]["doctor_assigned"] += 1
        for v in mp.values():
            role_counts[v["role"]] += 1
        if r.get("doctor_identified"):   # voiceprint reference: noisy, comparison only
            ref = latest_track(root, r, "role", "sarvam-doctor-map")
            if not ref or ref.get("status") != "ok":
                vp["no_voiceprint_track"] += 1
            else:
                vd, td = doctor_of(ref), doctor_of(t)
                vp["compared"] += 1
                if td is None:
                    vp["text_judge_abstains"] += 1
                elif vd is None:
                    vp["voiceprint_names_no_doctor"] += 1
                elif vd == td:
                    vp["same_speaker"] += 1
                else:
                    vp["different_speaker"] += 1
        else:
            vp["cutter_not_identified"] += 1
    out.update({"text_judge_tracks": n, "judge_a_vs_b_on_the_doctor": dict(ab), "abstain_reasons": dict(reasons),
                "doctor_assigned": n - sum(reasons.values()), "abstain_rate": round(sum(reasons.values()) / n, 4) if n else None,
                "roles_over_all_speakers": dict(role_counts), "by_language_heard": {str(k): dict(v) for k, v in sorted(by_lang.items(), key=lambda kv: str(kv[0]))},
                "voiceprint_reference_NOISY": dict(vp)})
    c = vp["compared"] - vp["text_judge_abstains"] - vp["voiceprint_names_no_doctor"]
    out["voiceprint_reference_NOISY"]["agreement_when_both_name_a_doctor"] = round(vp["same_speaker"] / c, 4) if c else None
    if call_log:
        out["jev_call_log"] = call_log_stats(call_log)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--call-log")
    ap.add_argument("--out", default=os.path.join(OUT, "ROLE-TEXT-JUDGE-STATS-09-OCT.json"))
    ap.add_argument("--root", default=REB)
    a = ap.parse_args(argv)
    res = measure(root=a.root, call_log=a.call_log)
    fd = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(res, indent=1, sort_keys=True))
    os.chmod(a.out, 0o600)
    print(json.dumps(res, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
