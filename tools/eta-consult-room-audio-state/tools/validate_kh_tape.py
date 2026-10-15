"""Read-only: label the REAL 6-7 Oct shadow intervals with causes derived from live kiosk_health_events, and print the
7 Oct off/gap intervals per room next to the FLEET session start. Nothing is written anywhere."""
import glob, json, os, sys
from datetime import datetime
import psycopg

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ras import causes as ca, kiosk_health as kh
from ras.classify import build_chunks

OUT = os.path.expanduser("~/eta-data/consult/audio-state")
FX = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "fleet_session_starts_07oct.json")
T = lambda s: datetime.fromisoformat(s).timestamp()


def main():
    with psycopg.connect(open(os.path.expanduser("~/.config/eta-audio/db.url")).read().strip(), connect_timeout=20) as c:
        c.read_only = True
        cur = c.cursor()
        cur.execute("""SELECT id, room_id, ts, boot_id, kind, payload FROM kiosk_health_events
                       WHERE kind IN ('heartbeat','recorder.status','audio.error','audio.devices') ORDER BY ts, id""")
        rows = [dict(id=r[0], room_id=r[1], ts=r[2], boot_id=r[3], kind=r[4], payload=r[5]) for r in cur.fetchall()]
    ev = kh.normalise_rows(rows)
    fleet = json.load(open(FX))
    feats = {json.loads(l)["id"]: json.loads(l) for l in open(os.path.join(OUT, "cache", "feat.jsonl"))}
    man = {}
    for l in open(os.path.expanduser("~/eta-data/tapes/manifest.jsonl")):
        r = json.loads(l)
        man.setdefault(r["room_id"], []).append(r)
    by = {}
    for f in sorted(glob.glob(os.path.join(OUT, "room_*_2026-10-0[67].jsonl"))):
        room = os.path.basename(f)[:-17]
        by.setdefault(room, []).extend({**json.loads(l), "_a": T(json.loads(l)["ts_start"]), "_b": T(json.loads(l)["ts_end"])}
                                       for l in open(f))
    for room in by:
        by[room].sort(key=lambda i: i["_a"])
        if room in ev:
            full = kh.full_chunk_starts(build_chunks(man.get(room, []), feats))
            by[room] = kh.apply_device_missing(by[room], kh.device_missing_spans(ev[room], "C270 HD WEBCAM", full))
    out = ca.label_causes(by, ev)
    day0 = T("2026-10-07T00:00:00+05:30")
    for room, name in fleet["names"].items():
        print(f"{name} (FLEET start {fleet['starts_ist'][room]}){'' if room in ev else '  [no kiosk-health rows]'}")
        for i in out.get(room, []):
            if i["_b"] > day0 and i["state"] in ("recorder_off", "device_missing", "audio_present", "zero_all_day"):
                tag = i["evidence"].get("cause") or ("after_snapshot" if i["evidence"].get("after_snapshot") else "")
                print(f"   {i['state']:<14} {i['ts_start'][11:19]}-{i['ts_end'][11:19]} {tag}")


if __name__ == "__main__":
    main()
