#!/usr/bin/env python3
# ORB2 case cutter, binding rule v1 (ORDERS-O6). Imports the helpers of cutter.py (v0, same directory). Stdlib only + /usr/bin/ffmpeg.
# Usage: cutter_v1.py plan <idx> <plan_v1.json> | cut <idx> <plan_v1.json> | check <plan_v1.json>
# cut: moves each v0 package into cases/<id>/_superseded_v0/ with mv (never rm), then writes v1 in place. Never writes under /var/lib/room-recorder.
import sys, os, json, bisect, subprocess, shutil, collections, datetime as dt
import cutter as v0
from cutter import IST, CASES, OUT, TAPE, STATUS, BPS, ist, ep, iso, load_idx, gaps_of, bins_of, byte_at, sha, ffdur, guard
VERSION = "o6-cutter-v1.1"; RULE = "v1.1"
# Pass order (lead ruling 8 Oct 18:55): 1) raw onsets for ALL cases; 2) offsets in booked order, capped by the next case's raw onset (or booked_start) - 1 min,
# with each onset clipped at the previous offset; 3) windows: pre-roll clipped at the previous window_end, post-roll at the next raw window_start; then assert no overlap.
BINDING_NOTES = {"case-2": "onset at search-window edge; true start likely about 13:00",
                 "case-1": "offset capped at booked_end+90",
                 "case-3": "provisional, activity continuing at cut time"}
def runs_of(B):
    """Active 30 s bins -> runs (start,end epoch s), bridging quiet gaps <= 10 min; drop runs shorter than 3 min."""
    ks = sorted(k for k, v in B.items() if v["active"]); runs = []
    for k in ks:
        if runs and (k - runs[-1][1]) * 30 <= 600: runs[-1][1] = k + 1   # runs[-1][1] = exclusive end bin; gap = (k - end)*30 s
        else: runs.append([k, k + 1])
    return [(a * 30, b * 30) for a, b in runs if (b - a) * 30 >= 180]
def raw_onset(runs, bs, be):
    for a, b in runs:
        if a <= be and b >= bs - 2700: return (max(a, bs - 2700), b)   # v1.1: onset = max(run start, booked_start - 45 min)
def chain_offset(runs, on_run, bs, be):
    end = on_run[1]; used = [on_run]
    for a, b in runs:
        if a <= on_run[0]: continue
        if a - end <= 1200: end = max(end, b); used.append((a, b))
        elif a > end: break
    return end, used
def plan(idx, out):
    R, W = load_idx(idx); G = gaps_of(R); B = bins_of(R); runs = runs_of(B); tape_hi = R[0]["wall_ns"] / 1e9; tape_hi = R[-1]["wall_ns"] / 1e9; tape_lo = R[0]["wall_ns"] / 1e9
    cs = sorted(((cid, ep(ist(s)), ep(ist(e))) for cid, s, e in CASES), key=lambda c: c[1]); n = len(cs)
    raw = [raw_onset(runs, bs, be) for _, bs, be in cs]                                   # pass 1: onsets without the previous-case constraint
    nxt_on = lambda i: (raw[i + 1][0] if raw[i + 1] else cs[i + 1][1]) if i + 1 < n else None
    P = []; prev_off = None
    for i, (cid, bs, be) in enumerate(cs):                                                # pass 2/3: offsets, then final onsets in booked order
        on_run = raw[i]; notes = []
        if on_run and prev_off is not None and on_run[0] < prev_off:
            notes.append("onset clipped to previous case offset"); on_run = (prev_off, max(on_run[1], prev_off))
        if on_run:
            on = on_run[0]; off, used = chain_offset(runs, on_run, bs, be); cap = be + 5400
            if off > cap: off = cap; notes.append("offset capped at booked_end+90min")
            if nxt_on(i) is not None and off > nxt_on(i) - 60: off = nxt_on(i) - 60; notes.append("offset capped at next case onset - 1 min")
            t0, t0m, bind = on, "activity_onset", "booked_slot+activity"
        else:
            on = off = None; used = []; t0, t0m, bind = bs, "booked_start", "booked_slot"
            off = be; notes.append("no qualifying run: window from booked slot")
        P.append(dict(case_id=cid, booked_start=bs, booked_end=be, onset=on, offset=off, t0=t0, t0_method=t0m, binding_method=bind,
                      raw_ws=(on if on is not None else bs) - 900, raw_we=(off if off is not None else be) + 900, notes=notes, used_runs=used))
        prev_off = off
    for i, p in enumerate(P):                                                              # window: clip pre-roll / post-roll against neighbours, then tape bounds
        ws, we = p["raw_ws"], p["raw_we"]
        if i > 0: ws = max(ws, P[i - 1]["window_end"])
        if i + 1 < n: we = min(we, P[i + 1]["raw_ws"])
        if we < p["raw_we"] and i + 1 < n: p["notes"].append("post-roll clipped at next case window start")
        if ws > p["raw_ws"]: p["notes"].append("pre-roll clipped at previous case window end")
        prov = None
        if we + 900 > tape_hi: prov = "window_end + 15 min is after the tape end at cut time (%s)" % iso(tape_hi, IST)
        if we > tape_hi: we = tape_hi; p["notes"].append("window_end clamped to tape end")
        if ws < tape_lo: ws = tape_lo
        p.update(window_start=ws, window_end=we, provisional=bool(prov), provisional_reason=prov, pre_roll_s=round(p["t0"] - ws, 1), post_roll_s=round(we - (p["offset"] or p["booked_end"]), 1),
                 gaps=[g for g in G if g["wall_end"] > ws and g["wall_start"] < we],
                 bin_rows=[dict(bin_start=k * 30, active=int(v["active"]), rms_median=round(v["rms_median"], 5), n=v["n"]) for k, v in sorted(B.items()) if ws <= k * 30 < we],
                 runs_considered=[dict(start=iso(a, IST), end=iso(b, IST), length_min=round((b - a) / 60, 1), in_chain=(a, b) in p["used_runs"]) for a, b in runs if a <= p["booked_end"] + 5400 and b >= p["booked_start"] - 2700])
    ws_sorted = sorted(P, key=lambda p: p["window_start"])
    for a, b in zip(ws_sorted, ws_sorted[1:]):
        if a["window_end"] > b["window_start"]: sys.exit("FAIL: windows overlap: %s ends %s, %s starts %s" % (a["case_id"], iso(a["window_end"], IST), b["case_id"], iso(b["window_start"], IST)))
    for p in P: assert p["window_end"] > p["window_start"], p["case_id"]
    json.dump(dict(version=VERSION, rule=RULE, idx=idx, tape_last_wall=tape_hi, idx_records=len(R), overlap_assertion="PASS", plans=P), open(out, "w"), indent=1)
    for p in P: print(p["case_id"], "onset", p["onset"] and iso(p["onset"], IST), "offset", p["offset"] and iso(p["offset"], IST), "window", iso(p["window_start"], IST), iso(p["window_end"], IST), p["t0_method"], "prov", p["provisional"], "gaps", len(p["gaps"]), p["notes"])
    print("overlap assertion: PASS")
def cut(idx, planp):
    guard(); P = json.load(open(planp)); R, W = load_idx(idx); self_sha = sha(os.path.abspath(__file__)); v0_sha = sha(os.path.join(os.path.dirname(os.path.abspath(__file__)), "cutter.py"))
    sid = json.loads(subprocess.run(["sudo", "-n", "cat", STATUS], capture_output=True, check=True, text=True).stdout)["session_id"]
    for p in P["plans"]:
        cid = p["case_id"]; d = f"{OUT}/{cid}"; sup = d + "/_superseded_v0"
        if os.path.exists(d + "/manifest.json"):
            assert not os.path.exists(sup), "superseded dir already exists: " + sup
            os.makedirs(sup)
            for nme in ("manifest.json", "media", "tracks"): shutil.move(f"{d}/{nme}", f"{sup}/{nme}")
        os.makedirs(d + "/media"); os.makedirs(d + "/tracks")
        b0, b1 = byte_at(R, W, p["window_start"]), byte_at(R, W, p["window_end"]); flac = d + "/media/room_orb2.flac"
        dd = subprocess.Popen(["sudo", "-n", "ionice", "-c3", "nice", "-n", "10", "dd", f"if={TAPE}", "bs=1M", "iflag=skip_bytes,count_bytes", f"skip={b0}", f"count={b1 - b0}", "status=none"], stdout=subprocess.PIPE)
        ff = subprocess.run(["/usr/bin/ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "-", "-c:a", "flac", flac], stdin=dd.stdout, capture_output=True)
        dd.stdout.close(); assert dd.wait() == 0 and ff.returncode == 0, ff.stderr
        with open(d + "/tracks/activity.jsonl", "w") as f:
            for r in p["bin_rows"]: f.write(json.dumps(dict(t_rel_ms=int(round((r["bin_start"] - p["t0"]) * 1000)), rms_median=r["rms_median"], active=bool(r["active"]))) + "\n")
        open(d + "/tracks/transcript.jsonl", "w").close()
        rates = collections.Counter(r.get("input_sample_rate") for r in R[bisect.bisect_left(W, int(p["window_start"] * 1e9)):bisect.bisect_right(W, int(p["window_end"] * 1e9))] if r.get("input_sample_rate")).most_common(1)
        gaps = [dict(wall_start_utc=iso(g["wall_start"], dt.timezone.utc), wall_end_utc=iso(g["wall_end"], dt.timezone.utc), byte_offset=g["byte_offset"], gap_s=g["gap_s"]) for g in p["gaps"]]
        m = dict(case_id=cid, ot_room="OT-2", source_room_id="<scribe_room_id>", recorder_session_id=sid, rule_version=RULE,
                 booked_start_ist=iso(p["booked_start"], IST), booked_end_ist=iso(p["booked_end"], IST),
                 window_start_ist=iso(p["window_start"], IST), window_end_ist=iso(p["window_end"], IST), window_start_utc=iso(p["window_start"], dt.timezone.utc), window_end_utc=iso(p["window_end"], dt.timezone.utc),
                 binding_method=p["binding_method"], t0_ist=iso(p["t0"], IST), t0_utc=iso(p["t0"], dt.timezone.utc), t0_method=p["t0_method"], pre_roll_s=p["pre_roll_s"], post_roll_s=p["post_roll_s"],
                 provisional=p["provisional"], provisional_reason=p["provisional_reason"], binding_note=(BINDING_NOTES.get(cid) if (p["provisional"] or cid != "case-3") else None),   # case 3 wording only if it is provisional
                 activity=dict(onset_ist=p["onset"] and iso(p["onset"], IST), offset_ist=p["offset"] and iso(p["offset"], IST), rule="v1.1 (onset clipped at booked_start-45min): 30 s bins >30% records rms>0.01; runs bridge <=10 min, drop <3 min; chain gap <=20 min", runs_considered=p["runs_considered"]),
                 sources=[dict(id="orb2_room", path="media/room_orb2.flac", sample_rate=16000, channels=1, capture_input_sample_rate=rates[0][0] if rates else None, byte_offset_start=b0, byte_offset_end=b1,
                               clock="wall_ns from tape.idx, NTP-synced", clock_offset_ms=0)],
                 gaps=gaps, notes=p["notes"], media_sha256=sha(flac), cutter=dict(version=VERSION, sha256=self_sha, helpers_cutter_py_sha256=v0_sha))
        json.dump(m, open(d + "/manifest.json", "w"), indent=1); print(cid, "bytes", b1 - b0, "s", (b1 - b0) / BPS, "sha12", m["media_sha256"][:12], "prov", m["provisional"], "gaps", len(gaps))
def check(planp):
    for p in json.load(open(planp))["plans"]:
        d = f"{OUT}/{p['case_id']}"; m = json.load(open(d + "/manifest.json")); s = m["sources"][0]; exp = (s["byte_offset_end"] - s["byte_offset_start"]) / BPS
        print(p["case_id"], "flac s %.2f" % ffdur(d + "/media/room_orb2.flac"), "bytes/32000 %.2f" % exp, "window s %.1f" % (p["window_end"] - p["window_start"]), "gaps", len(m["gaps"]), "superseded_v0 present", os.path.isdir(d + "/_superseded_v0"))
if __name__ == "__main__":
    {"plan": lambda: plan(sys.argv[2], sys.argv[3]), "cut": lambda: cut(sys.argv[2], sys.argv[3]), "check": lambda: check(sys.argv[2])}[sys.argv[1]]()
