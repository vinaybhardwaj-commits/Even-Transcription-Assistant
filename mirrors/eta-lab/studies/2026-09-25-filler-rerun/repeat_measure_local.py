#!/usr/bin/env python3
"""Canonical repeat-ratio (v2, measures A+B) over production room transcripts. Counts and ratios only; text stays in memory."""
import json, os, re, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import repeat_ratio_v2 as R

ETA = "/home/eta/dev/Even-Transcription-Assistant"
SELECT = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")
SQL = """
select d.period, d.room_id, d.wid, d.t
from (select distinct on (tr.subject_id)
             case when tr.created_at >= timestamptz '2026-09-23T23:10:00Z' then 'today' else 'yday' end as period,
             s.room_id, tr.subject_id as wid, coalesce(tr.transcript_original,'') as t, tr.created_at
        from transcription_run tr
        join bench_window w on w.id = tr.subject_id
        join bench_session s on s.id = w.session_id
       where tr.subject_type = 'bench_window' and tr.error is null
         and tr.created_at >= timestamptz '2026-09-22T23:10:00Z'
         and not (tr.created_at >= now() - interval '24 hours' and tr.created_at < timestamptz '2026-09-23T23:10:00Z')
       order by tr.subject_id, tr.created_at desc) d
"""


def fetch():
    r = subprocess.run(["node", SELECT, SQL], cwd=ETA, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise RuntimeError(f"neon-select exit {r.returncode}")
    return json.loads(r.stdout)


# The filler-only set (whole transcript is filler), unchanged from the watch's earlier SQL; not a repeat measure.
_FILLER = re.compile(r"^((thank you( very much| so much)?|thanks( for watching)?|bye( bye)?|you|okay|ok|please subscribe|\u0927\u0928\u094d\u092f\u0935\u093e\u0926|\u0936\u0941\u0915\u094d\u0930\u093f\u092f\u093e) ?)+$")
_FOLD = re.compile(r"[^a-z\u0900-\u097f\u0c80-\u0cff]+")


def measure(rows):
    """Per period: window counts, share with an A loop / a B run, aggregate repeat_ratio, and per-room A-loop counts. No text out."""
    out = {}
    for x in rows:
        o = out.setdefault(x["period"], {"windows": 0, "empty": 0, "a_loop_windows": 0, "b_run_windows": 0, "either": 0,
                                         "ratio_ge_0.05": 0, "ratio_ge_0.10": 0, "ratio_ge_0.30": 0,
                                         "redundant_chars": 0, "total_chars": 0, "a_loops": 0, "filler_only": 0, "rooms": {}})
        t = x["t"]
        o["windows"] += 1
        o["total_chars"] += len(t)
        if not t.strip():
            o["empty"] += 1
            continue
        o["filler_only"] += bool(_FILLER.match(_FOLD.sub(" ", t.lower()).strip()))
        loops = R.phrase_loops(t)
        red = sum(l["redundant_chars"] for l in loops)
        ratio = red / len(t)
        b = R.repeated_sentences(t)["runs"]
        o["a_loops"] += len(loops)
        o["redundant_chars"] += red
        o["a_loop_windows"] += bool(loops)
        o["b_run_windows"] += bool(b)
        o["either"] += bool(loops or b)
        for th in ("0.05", "0.10", "0.30"):
            o["ratio_ge_" + th] += ratio >= float(th)
        if loops:
            o["rooms"][x["room_id"]] = o["rooms"].get(x["room_id"], 0) + 1
    for o in out.values():
        o["aggregate_repeat_ratio"] = round(o["redundant_chars"] / o["total_chars"], 4) if o["total_chars"] else 0.0
    return out


if __name__ == "__main__":
    res = measure(fetch())
    for o in res.values():
        o["rooms"] = dict(sorted(o["rooms"].items(), key=lambda kv: -kv[1])[:6])
    print(json.dumps(res, indent=1))
