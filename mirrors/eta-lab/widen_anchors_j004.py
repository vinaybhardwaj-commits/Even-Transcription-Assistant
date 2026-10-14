#!/usr/bin/env python3
"""widen_anchors_j004.py — J-004 (ruling 416.4): widen the stage-1 anchor linkage to EVERY Aug-Sep consult with an
OT/surgery anchor (anchors_hist.json, 2026-08-01..09-19), as INPUT TO lx's E-6.2/E-7 re-run on the complete HIST.
Pool = hist-bulk's canonical tier A/B copy ~/eta-data/hist/runs/<run>/<room>/<date>/<win>.json (4,507 windows; window_id
NOT prefixed 'c-' = tier A/B; tier C c-* windows are 24 Sep 06:24Z->now and cannot overlap any anchor <=19 Sep, so they are
excluded by construction). Dedupe key (room_id, start) keeping the LATEST run dir (final-state rule of final_accounting:
retries resolve to the last terminal state). Window status: kind=correction annotations OVERRIDE the record
(undetermined / near_silence / transcribed_unconfirmed), kind=retranscription with better=false -> retranscribed_no_speech;
else no_signal/no_audio/failed from the record; done -> text | no_text | refused (by non-refused segment text).
IDS AND COUNTS ONLY — no transcript text (segments/text/text2 never copied; lx reads text in the vault by window id).
CANCELLED bookings included and flagged (Fable may veto). Rx-anchored consults = v3 UNION when mb-rx's J-001 lands.
Output: ~/eta-data/hist-mining/anchors_widened/anchors_ot_v2.json (0600, write-once). v1 (ad-hoc stage-1-era pool) superseded.
  widen_anchors_j004.py [--selftest]"""
import glob, hashlib, json, os, sys
from datetime import datetime, timedelta, timezone

H = os.path.expanduser("~/eta-data"); HM = f"{H}/hist-mining"; OUT = f"{HM}/anchors_widened"
ANN = f"{H}/lab-vault/staged/annotations"
P = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
PAD = timedelta(minutes=5)

def annotations():
    """window key (run/room/date/win) -> status override, from kind=correction + kind=retranscription (better=false only)."""
    ov = {}
    for kind, stat in (("correction", None), ("retranscription", "retranscribed_no_speech")):
        for f in glob.glob(f"{ANN}/{kind}/*/*/*.json"):
            try: a = json.load(open(f))
            except Exception: continue
            for it in a.get("items") or []:
                k = it.get("k")
                if not k: continue
                if kind == "correction": ov[k] = it.get("status") or "undetermined"
                elif it.get("better") is False: ov[k] = stat
    return ov

def run_of(p): return p.split("/runs/")[1].split("/")[0]

def records(overrides):
    """Canonical tier A/B records. Tier A/B runs live in hist/runs/<run>/<room>/<date>/<win>.json; the tier A
    old-layout ('no-run-field', 104 done windows) lives in hist/out/<room-day>/<win>.json. Dedupe (room_id, start):
    a state=done record beats failed/no_audio probes (final_accounting resolves retries to the last terminal state),
    latest run name among equals; hist/out records are admitted ONLY where no hist/runs record exists for the window
    (old-layout gap-filler; hist/runs is canonical where both exist). NO text fields are kept."""
    seen = {}
    for f in glob.glob(f"{H}/hist/runs/*/*/*/*.json"):
        win = os.path.basename(f)[:-5]
        if win.startswith("c-"): continue
        try: r = json.load(open(f))
        except Exception: continue
        if not (isinstance(r, dict) and r.get("start") and r.get("end") and r.get("room_id")): continue
        run = run_of(f)
        key = (r["room_id"], r["start"])
        cur = seen.get(key)
        done_new, done_cur = r.get("state") == "done", cur is not None and cur[1].get("state") == "done"
        if cur is None or (done_new and not done_cur) or (done_new == done_cur and run > cur[0]):
            seen[key] = (run, r, f)
    for f in glob.glob(f"{H}/hist/out/*/*.json"):
        win = os.path.basename(f)[:-5]
        try: r = json.load(open(f))
        except Exception: continue
        if not (isinstance(r, dict) and r.get("start") and r.get("end") and r.get("room_id")): continue
        key = (r["room_id"], r["start"])
        if key in seen: continue
        seen[key] = ("hist-out(old-layout)", r, f)
    # annotation-known windows with NO run record (skipped by the run: exact-zero by size / near-silence): synthesize a
    # no-text coverage record so the linkage sees the tape slot. Grid start is encoded in the id: <date>_room_<room>_<HHMM> IST.
    have = set(seen.keys())
    for k, status in overrides.items():
        try: run, room, date, win = k.split("/")[0], k.split("/")[1], k.split("/")[2], k.split("/")[3]
        except ValueError: continue
        if win.startswith("c-"): continue
        hh, mm = int(win.split("_")[-1][:2]), int(win.split("_")[-1][2:4])
        start = datetime.fromisoformat(f"{date}T{hh:02d}:{mm:02d}:00+05:30").astimezone(timezone.utc)
        key = (room, start.isoformat())
        if key in have: continue
        seen[key] = (run, {"state": "skipped_no_record", "_status": status, "start": start.isoformat(),
                           "end": (start + timedelta(minutes=15)).isoformat(), "room_id": room, "window_id": win}, None)
    out = {}
    for (room, start), (run, r, f) in seen.items():
        win = r.get("window_id") or (os.path.basename(f)[:-5] if f else None)
        date = r["start"][:10]
        k = f"{run}/{room}/{date}/{win}"
        if "_status" in r: status = r["_status"]
        elif k in overrides: status = overrides[k]
        elif r.get("state") != "done": status = r.get("state") or "failed"
        else:
            segs = [s for s in (r.get("segments") or []) if not s.get("refused") and (s.get("text") or "").strip()]
            status = "text" if segs else ("refused" if (r.get("segments") or []) and all(s.get("refused") for s in r["segments"]) else "no_text")
        out[k] = {"window_id": win, "room_id": room, "start": r["start"], "end": r["end"], "run": run,
                  "status": status, "n_segments": len(r.get("segments") or []),
                  "stack_id": (r.get("provenance") or {}).get("stack_id")}
    return list(out.values())

def build():
    anchors = json.load(open(f"{HM}/anchors_hist.json"))
    recs = records(annotations())
    byroom = {}
    for r in recs: byroom.setdefault(r["room_id"], []).append(r)
    out = []
    for a in anchors:
        lo, hi = P(a["called"]), P(a["done"]); lo5, hi5 = lo - PAD, hi + PAD
        rooms = {}
        for room, rs in byroom.items():
            hits = []
            for r in rs:
                if P(r["end"]) > lo5 and P(r["start"]) < hi5:
                    hits.append({"window_id": r["window_id"], "start": r["start"], "end": r["end"], "run": r["run"],
                                 "status": r["status"], "n_segments": r["n_segments"],
                                 "exact": P(r["end"]) > lo and P(r["start"]) < hi})
            if hits: rooms[room] = sorted(hits, key=lambda h: h["start"])
        out.append({"token_uid": a["token_uid"], "individual_uid": a["individual_uid"], "day": a.get("day") or a["called"][:10],
                    "called": a["called"], "done": a["done"], "days_after": a.get("days_after"), "doctor_uid": a.get("doctor_uid"),
                    "booked_procedure": a["booked_procedure"], "booked_source": a.get("booked_source"),
                    "booking_status": a.get("booking_status"), "cancelled": a.get("booking_status") == "CANCELLED",
                    "rooms_with_windows": rooms,
                    "n_rooms_exact": sum(1 for h in rooms.values() if any(x["exact"] for x in h)),
                    "n_windows": sum(len(h) for h in rooms.values()),
                    "n_windows_text": sum(1 for h in rooms.values() for x in h if x["status"] == "text")})
    return out, len(recs)

def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 16), b""): h.update(b)
    return h.hexdigest()

def main():
    out, n_recs = build()
    os.makedirs(OUT, mode=0o700, exist_ok=True)
    p = f"{OUT}/anchors_ot_v2.json"
    if os.path.exists(p): raise SystemExit(f"refusing to overwrite {p} (write-once)")
    json.dump({"job": "J-004", "ruling": "416.4", "built": datetime.now().astimezone().isoformat(timespec="seconds"),
               "pool": "hist/runs tier A/B (4,507 universe), (room,start) latest-run dedupe, correction+retranscription overrides",
               "note": "OT/surgery-anchored Aug-Sep consults (anchors <=2026-09-19; tier C out of scope); Rx union = v3 when J-001 lands; ids+counts only, no text",
               "anchors": out}, open(p, "w"), indent=1)
    os.chmod(p, 0o600)
    print(f"tier A/B records in pool: {n_recs}")
    print(f"anchors: {len(out)} | exact-span coverage any-status: {sum(1 for o in out if o['n_rooms_exact'])} | with any +-5min window: {sum(1 for o in out if o['rooms_with_windows'])} | with >=1 status=text window: {sum(1 for o in out if o['n_windows_text'])} | cancelled: {sum(o['cancelled'] for o in out)}")
    print(f"wrote {p} sha256 {sha256_file(p)}")

def selftest():
    global H, HM, OUT, ANN
    import tempfile, shutil
    old = (H, HM, OUT, ANN)
    t = tempfile.mkdtemp(prefix="j004-")
    H, HM, ANN = t, f"{t}/hist-mining", f"{t}/ann"; OUT = f"{HM}/anchors_widened"; os.makedirs(HM)
    os.makedirs(f"{ANN}/correction/r/d"); os.makedirs(f"{ANN}/retranscription/r/d"); os.makedirs(f"{H}/hist/runs/runB/r/d"); os.makedirs(f"{H}/hist/runs/runA/r/d")
    json.dump([{"token_uid": "t1", "individual_uid": "i1", "day": None, "called": "2026-09-10T05:00:00+00:00",
                "done": "2026-09-10T05:02:00+00:00", "days_after": 1, "doctor_uid": "d1", "booked_procedure": "hernia repair",
                "booked_source": "surgery_case", "booking_status": "DONE"}], open(f"{HM}/anchors_hist.json", "w"))
    seg = {"start_s": 0, "end_s": 30, "text": "x", "refused": False}
    mk = lambda run, st: json.dump({"ok": True, "state": "done", "start": "2026-09-10T05:00:00+00:00", "end": "2026-09-10T05:15:00+00:00",
                                    "room_id": "r", "window_id": "2026-09-10_r_1030", "segments": [dict(seg)] if st == "done" else [],
                                    "provenance": {"stack_id": "s1"}}, open(f"{H}/hist/runs/{run}/r/d/2026-09-10_r_1030.json", "w"))
    mk("runA", "done"); mk("runB", "done")            # same (room,start) twice: runB (latest) wins
    json.dump({"items": [{"k": "runB/r/2026-09-10/2026-09-10_r_1030", "status": "near_silence"}], "kind": "correction"},
              open(f"{ANN}/correction/r/d/a.json", "w"))
    ov = annotations()
    assert ov == {"runB/r/2026-09-10/2026-09-10_r_1030": "near_silence"}
    out, n = build()
    assert n == 1 and out[0]["rooms_with_windows"]["r"][0]["status"] == "near_silence" and out[0]["rooms_with_windows"]["r"][0]["run"] == "runB"
    assert out[0]["day"] == "2026-09-10" and out[0]["n_windows_text"] == 0
    os.remove(f"{ANN}/correction/r/d/a.json")
    out, n = build()
    assert out[0]["rooms_with_windows"]["r"][0]["status"] == "text" and out[0]["n_windows_text"] == 1
    json.dump({"items": [{"k": "runB/r/2026-09-10/2026-09-10_r_1030", "better": False, "text2": "SHOULD-NOT-LEAK"}], "kind": "retranscription"},              open(f"{ANN}/retranscription/r/d/a.json", "w"))
    out, n = build()
    assert out[0]["rooms_with_windows"]["r"][0]["status"] == "retranscribed_no_speech"
    assert "SHOULD-NOT-LEAK" not in json.dumps(out)
    shutil.rmtree(t); H, HM, OUT, ANN = old
    print("selftest ok")

if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest()
    else: main()
