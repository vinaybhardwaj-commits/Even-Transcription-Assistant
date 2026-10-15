"""audio-13 verification: per room-day hours of the voice-isolation signature, for EVERY room (not limited to ras.hosts),
so a control-room hit shows up. Read-only: uses the manifest and the vi cache; counts only.

    python tools/vi_report.py [first_day last_day]       (IST days, default 2026-10-01 2026-10-07)
Columns: VI = chunk-hours matching the voice_isolation_gated signature; zerofill = chunk-hours that are >= 95% gated
frames with (almost) no speech; chunks = chunks with counts that day. Blind room-days are skipped.
"""
import json, os, sys, collections
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ras import classify as cl
from ras.blind import blind_room_days
from ras.run import load_vi
from ras.scan import VI_CACHE, TAPES
from ras.scan import is_blind

ROOMS = {"room_yh3etjpf": "OPD 1", "room_87frpus9": "OPD 3", "room_ux92qpws": "OPD 4", "room_4ggnkg5x": "OPD 5",
         "room_pnyc9u49": "OPD 6", "room_qyzghzaf": "OPD 7", "room_d74hhmc4": "AUD", "room_bh6jtq4t": "ECHO",
         "room_ymch4bxu": "DIET", "room_jwyrr4dc": "jwyrr4dc", "room_mah3aspr": "mah3aspr"}


def main(first="2026-10-01", last="2026-10-07"):
    blind = blind_room_days()
    vi = load_vi(VI_CACHE)
    tab = collections.defaultdict(lambda: collections.Counter())
    when = collections.defaultdict(list)
    for l in open(os.path.join(TAPES, "manifest.jsonl")):
        r = json.loads(l)
        d = cl.ist_day(cl.parse_ts(r["started_at"]))
        if not (first <= d <= last) or is_blind(r, blind) or r["id"] not in vi:
            continue
        c = {"vi": vi[r["id"]]}
        k = (r["room_id"], d)
        t = cl.vi_totals(c)
        tab[k]["chunks"] += 1
        hrs = sum(vi[r["id"]]["n"]) / 50.0 / 3600
        if cl.vi_chunk(c):
            tab[k]["vi_h"] += hrs
            when[k].append(cl.parse_ts(r["started_at"]))
        elif t and t[1] < cl.VI_MIN_SPEECH_FRAMES and t[0] / max(1, t[2] - t[1]) >= 0.95:
            tab[k]["zerofill_h"] += hrs
    days = sorted({d for _, d in tab})
    print("| room | " + " | ".join(d[5:] for d in days) + " | total VI h |")
    print("|---|" + "---|" * (len(days) + 1))
    for room in sorted(ROOMS, key=lambda x: ROOMS[x]):
        cells, tot = [], 0.0
        for d in days:
            t = tab.get((room, d))
            if not t:
                cells.append("-")
                continue
            tot += t["vi_h"]
            cells.append(f"{t['vi_h']:.1f}" + (f" (zf {t['zerofill_h']:.1f})" if t["zerofill_h"] >= 0.05 else ""))
        print(f"| {ROOMS[room]} | " + " | ".join(cells) + f" | {tot:.1f} |")
    for room, label in (("room_ux92qpws", "OPD 4"), ("room_4ggnkg5x", "OPD 5")):
        ts = sorted(t for (r, d), v in when.items() if r == room and d == "2026-10-07" for t in v)
        print(f"{label} 7 Oct: first VI chunk {cl.iso(ts[0])[11:19] if ts else '-'}, last {cl.iso(ts[-1])[11:19] if ts else '-'}, n={len(ts)}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
