#!/usr/bin/env python3
"""Build SUBMIT-LIST-3.csv (the feeder's input) and HELD-SWITCH-OFF-3.csv from read-only production snapshots.
Inputs (JSON arrays from kit/neon-select.mjs; opaque ids and states only, no text):
  allwin.json  bench_window x bench_session x room, closed_at 20 Sep 00:00 IST .. 23 Sep 00:00 IST
  jobs.json    room_window jobs grouped by args->>'window_id' (n_jobs, live, last_status, last_error)
  subj.json    stt_subject_job (asr) rows for those windows
  orig128.json the 128 ids of the 22 Sep recovery set (from FINDINGS-2 / SUBMIT-LIST-2.csv column window_id)
Usage: build_set3.py <dir with the four json files> <out dir>
Audio class is INFERRED (no level log before 22 Sep 19:53 IST, peak_level NULL): same-room neighbours within
30 min that the drain already judged, else the IST-hour speech share among windows processed that day."""
import csv, collections as C, datetime as dt, json, os, sys

src, out = sys.argv[1], sys.argv[2]
L = lambda n: json.load(open(os.path.join(src, n)))
W = {w["window_id"]: w for w in L("allwin.json")}
J = {j["window_id"]: j for j in L("jobs.json")}
S = {s["window_id"]: s for s in L("subj.json")}
ORIG = set(L("orig128.json"))
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
ist = lambda ms: dt.datetime.fromtimestamp(int(ms) / 1000, IST)

byroom = C.defaultdict(list)
for w in W.values():
    byroom[w["room_id"]].append((int(w["start_ms"]), w["state"]))
proc = C.defaultdict(lambda: [0, 0])
for w in W.values():
    if w["state"] in ("transcribed", "silent"):
        d = ist(w["start_ms"])
        proc[(d.date(), d.hour)][0 if w["state"] == "transcribed" else 1] += 1


def classify(w):
    ms = int(w["start_ms"])
    d = ist(ms)
    if d.hour < 7 or d.hour >= 21:
        return "after_hours", 0.05
    near = [st for (s, st) in byroom[w["room_id"]] if s != ms and abs(s - ms) <= 30 * 60_000]
    if "transcribed" in near:
        return "likely_speech", 0.90
    if "silent" in near:
        return "likely_silence", 0.10
    sp, si = proc.get((d.date(), d.hour), (0, 0))
    if sp + si >= 4:
        p = sp / (sp + si)
        return ("hour_speech" if p >= 0.5 else "unknown" if p >= 0.25 else "likely_silence"), round(p, 2)
    return "unknown", 0.40


rows, held = [], []
for wid, w in W.items():
    if w["state"] != "closed":
        continue
    d = ist(w["start_ms"]).date()
    j, s = J.get(wid), S.get(wid)
    live = bool(j and j["live"])
    if wid in ORIG:
        set_, cause = ("G22", "inflight_now_from_bulk_submit") if live else ("F22", "recovery_job_failed")
        if not live and not (j and j["last_status"] == "failed"):
            set_, cause = "F22", "closed_no_failed_job"
    elif d in (dt.date(2026, 9, 20), dt.date(2026, 9, 21)):
        set_, cause = ("C20" if d.day == 20 else "D21"), "never_transcribed_outside_auto_drain_horizon"
    else:
        continue
    cls, p = classify(w)
    err = (s or {}).get("last_error") or ""
    r = dict(set=set_, window_id=wid, room_id=w["room_id"], window_start_ist=ist(w["start_ms"]).strftime("%Y-%m-%d %H:%M"),
             cause=cause, audio_class=cls, p_speech=p, has_clip=int(bool(w["has_clip"])),
             subject_attempts=(s or {}).get("attempts", ""), false_busy_failure=int(err.startswith("join_failed: join_already_running")),
             n_prior_jobs=(j or {}).get("n_jobs", 0), live_now=int(live))
    (rows if w["switch_on"] else held).append(r)

SET_ORDER = {"F22": 0, "G22": 1, "D21": 2, "C20": 3}
rows.sort(key=lambda r: (-r["p_speech"], SET_ORDER[r["set"]], r["window_start_ist"]))
for i, r in enumerate(rows, 1):
    r["rank"] = i
held.sort(key=lambda r: (-r["p_speech"], r["window_start_ist"]))
cols = ["rank", "set", "window_id", "room_id", "window_start_ist", "cause", "audio_class", "p_speech", "has_clip",
        "subject_attempts", "false_busy_failure", "n_prior_jobs", "live_now"]
for name, data in (("SUBMIT-LIST-3.csv", rows), ("HELD-SWITCH-OFF-3.csv", held)):
    with open(os.path.join(out, name), "w", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        wr.writeheader()
        wr.writerows(data)

print("feeder list", len(rows), "held(switch off)", len(held))
for label, data in (("feeder", rows), ("held", held)):
    c = C.Counter((r["set"], r["audio_class"]) for r in data)
    for k in sorted(c):
        print(f"  {label} {k[0]} {k[1]:15s} {c[k]}")
print("expected speech windows (sum p) feeder:", round(sum(r["p_speech"] for r in rows), 1))
