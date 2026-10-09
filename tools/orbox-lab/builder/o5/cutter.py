#!/usr/bin/env python3
# ORB2 case cutter v0 (ORDERS-O5). Stdlib only + /usr/bin/ffmpeg. Never writes under /var/lib/room-recorder. Never deletes.
# Usage: cutter.py plan  <idx.jsonl> <plan.json>      idx only, no tape.pcm read
#        cutter.py layout <idx.jsonl>                  idx-only byte-layout checks
#        cutter.py cut   <idx.jsonl> <plan.json>      reads tape.pcm; refuses before 18:00 IST 8 Oct 2026
#        cutter.py verify <idx.jsonl> <plan.json>     reads tape.pcm; same guard; decode 10 s at a known record + flac duration checks
import sys, os, json, time, bisect, hashlib, subprocess, statistics, array, datetime as dt
VERSION = "o5-cutter-v0"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
TAPE = "/var/lib/room-recorder/tape/tape.pcm"; STATUS = "/var/lib/room-recorder/status.json"; OUT = "/var/lib/orbox-cases/cases"
GUARD_UTC = dt.datetime(2026, 10, 8, 18, 0, tzinfo=IST)           # no tape.pcm read before this
BPS = 32000                                                         # 16 kHz mono s16le, to be verified by `layout`
CASES = [("case-1", "2026-10-08 09:00", "2026-10-08 10:30"),
         ("case-2", "2026-10-08 13:30", "2026-10-08 15:30"),
         ("case-3", "2026-10-08 16:00", "2026-10-08 17:30")]
def ist(s): return dt.datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=IST)
def ep(d): return d.timestamp()
def iso(e, tz): return dt.datetime.fromtimestamp(e, tz).isoformat(timespec="seconds")
def load_idx(p):
    R = [json.loads(l) for l in open(p) if l.strip()]
    return R, [r["wall_ns"] for r in R]
def gaps_of(R):
    g = []
    for a, b in zip(R, R[1:]):
        dw = (b["wall_ns"] - a["wall_ns"]) / 1e9; db = b["byte_offset"] - a["byte_offset"]
        if dw > 2.0 or db != 2 * (b["samples"] - a["samples"]):
            g.append(dict(wall_start=a["wall_ns"] / 1e9, wall_end=b["wall_ns"] / 1e9, byte_offset=a["byte_offset"], gap_s=round(dw, 3), bytes_between=db))
    return g
def bins_of(R):
    B = {}
    for r in R:
        B.setdefault(int(r["wall_ns"] // 30_000_000_000), []).append(r.get("rms", 0.0))
    return {k: dict(active=(sum(x > 0.01 for x in v) / len(v) > 0.30), rms_median=statistics.median(v), n=len(v)) for k, v in B.items()}
def act(B, k): return 1 if B.get(k, {}).get("active") else 0
def onset(B, lo, hi):   # first active bin in [lo,hi] with >=3 of next 5 active
    for k in range(lo, hi + 1):
        if act(B, k) and sum(act(B, k + j) for j in range(1, 6)) >= 3: return k
def offset(B, lo, hi):  # last active bin <= hi with >=3 of previous 5 active
    for k in range(hi, lo - 1, -1):
        if act(B, k) and sum(act(B, k - j) for j in range(1, 6)) >= 3: return k
def plan_case(cid, bs_s, be_s, R, B, G):
    bs, be = ep(ist(bs_s)), ep(ist(be_s)); tape_lo, tape_hi = R[0]["wall_ns"] / 1e9, R[-1]["wall_ns"] / 1e9
    kon = onset(B, int((bs - 1800) // 30), int(be // 30)); kof = offset(B, int(bs // 30), int((be + 5400) // 30))
    on = kon * 30 if kon is not None else None; off = (kof + 1) * 30 if kof is not None else None
    ws = min(bs, on if on is not None else bs) - 900; we = max(be, off if off is not None else be) + 900
    ws, we = max(ws, bs - 7200), min(we, be + 7200); notes = []
    if we > tape_hi: notes.append("window_end_after_tape_end: clamped"); we = tape_hi
    if ws < tape_lo: notes.append("window_start_before_tape_start: clamped"); ws = tape_lo
    t0_method = "activity_onset" if on is not None and bs - 900 <= on <= be + 900 else "booked_start"   # no mark exists in the data
    t0 = on if t0_method == "activity_onset" else bs
    binding = "booked_slot+activity" if (on is not None or off is not None) else "booked_slot"
    t_end = max(be, off if off is not None else be)
    gw = [g for g in G if g["wall_end"] > ws and g["wall_start"] < we]
    return dict(case_id=cid, booked_start=bs, booked_end=be, onset_bin=kon, offset_bin=kof, onset=on, offset=off, window_start=ws, window_end=we,
                binding_method=binding, t0=t0, t0_method=t0_method, pre_roll_s=round(t0 - ws, 1), post_roll_s=round(we - t_end, 1), gaps=gw, notes=notes)
def byte_at(R, W, t):   # exact (wall, byte) pairs from idx; linear interpolation between records, even-aligned
    i = bisect.bisect_right(W, int(t * 1e9)) - 1; i = max(0, min(i, len(R) - 2)); a, b = R[i], R[i + 1]
    f = (t * 1e9 - a["wall_ns"]) / max(b["wall_ns"] - a["wall_ns"], 1); f = min(max(f, 0.0), 1.0)
    return int((a["byte_offset"] + f * (b["byte_offset"] - a["byte_offset"])) // 2 * 2)
def run_plan(idx, out):
    R, W = load_idx(idx); G = gaps_of(R); B = bins_of(R); plans = []
    for cid, s, e in CASES:
        if ep(ist(e)) + 900 > R[-1]["wall_ns"] / 1e9 and ep(ist(s)) > R[-1]["wall_ns"] / 1e9: plans.append(dict(case_id=cid, skipped="booked slot is after the end of this idx copy")); continue
        p = plan_case(cid, s, e, R, B, G); p["bin_rows"] = [dict(bin_start=k * 30, active=int(v["active"]), rms_median=round(v["rms_median"], 5), n=v["n"])
            for k, v in sorted(B.items()) if p["window_start"] - 1800 <= k * 30 <= p["window_end"] + 1800]; plans.append(p)
    json.dump(dict(version=VERSION, idx=idx, idx_records=len(R), idx_first_wall=R[0]["wall_ns"] / 1e9, idx_last_wall=R[-1]["wall_ns"] / 1e9, idx_gaps_total=len(G), plans=plans), open(out, "w"), indent=1)
    for p in plans:
        if "skipped" in p: print(p["case_id"], p["skipped"]); continue
        print(p["case_id"], "onset", p["onset"] and iso(p["onset"], IST), "offset", p["offset"] and iso(p["offset"], IST), "window", iso(p["window_start"], IST), iso(p["window_end"], IST),
              p["binding_method"], p["t0_method"], "gaps", len(p["gaps"]), p["notes"])
def run_layout(idx):
    R, W = load_idx(idx); bad = sum(r["byte_offset"] != 2 * r["samples"] for r in R); ratio = {round(r["input_frames"] / r["samples"], 3) for r in R if r["samples"] and "input_frames" in r}
    d = [(b["samples"] - a["samples"]) / ((b["wall_ns"] - a["wall_ns"]) / 1e9) for a, b in zip(R, R[1:]) if 0 < b["wall_ns"] - a["wall_ns"] < 2e9]
    print("records", len(R), "byte_offset != 2*samples:", bad, "| input_frames/samples ratios:", sorted(ratio)[:5], "| rates:", {r.get("input_sample_rate") for r in R}, "| records without input_frames:", sum("input_frames" not in r for r in R))
    print("samples per wall second: median %.1f min %.1f max %.1f (16000 expected)" % (statistics.median(d), min(d), max(d)))
    print("record spacing s: median %.3f; discontinuities >2 s: %d" % (statistics.median((b["wall_ns"] - a["wall_ns"]) / 1e9 for a, b in zip(R, R[1:])), len(gaps_of(R))))
def guard():
    if dt.datetime.now(IST) < GUARD_UTC: sys.exit("REFUSED: no tape.pcm read before 18:00 IST 8 Oct 2026 (now %s)" % dt.datetime.now(IST).isoformat(timespec="seconds"))
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()
def read_pcm(start, n):   # root read via sudo, gentle IO
    return subprocess.run(["sudo", "-n", "ionice", "-c3", "nice", "-n", "10", "dd", f"if={TAPE}", "bs=1M", "iflag=skip_bytes,count_bytes", f"skip={start}", f"count={n}", "status=none"], capture_output=True, check=True).stdout
def run_cut(idx, planp):
    guard(); P = json.load(open(planp)); R, W = load_idx(idx); self_sha = sha(os.path.abspath(__file__))
    sid = json.loads(subprocess.run(["sudo", "-n", "cat", STATUS], capture_output=True, check=True, text=True).stdout)["session_id"]
    for p in P["plans"]:
        if "skipped" in p: continue
        cid = p["case_id"]; d = f"{OUT}/{cid}"; os.makedirs(d + "/media", exist_ok=True); os.makedirs(d + "/tracks", exist_ok=True)
        b0, b1 = byte_at(R, W, p["window_start"]), byte_at(R, W, p["window_end"]); flac = d + "/media/room_orb2.flac"
        dd = subprocess.Popen(["sudo", "-n", "ionice", "-c3", "nice", "-n", "10", "dd", f"if={TAPE}", "bs=1M", "iflag=skip_bytes,count_bytes", f"skip={b0}", f"count={b1 - b0}", "status=none"], stdout=subprocess.PIPE)
        ff = subprocess.run(["/usr/bin/ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "-", "-c:a", "flac", flac], stdin=dd.stdout, capture_output=True)
        dd.stdout.close(); assert dd.wait() == 0 and ff.returncode == 0, ff.stderr
        with open(d + "/tracks/activity.jsonl", "w") as f:
            for r in p["bin_rows"]:
                if p["window_start"] <= r["bin_start"] < p["window_end"]: f.write(json.dumps(dict(t_rel_ms=int(round((r["bin_start"] - p["t0"]) * 1000)), rms_median=r["rms_median"], active=bool(r["active"]))) + "\n")
        open(d + "/tracks/transcript.jsonl", "w").close()   # empty placeholder; schema t_rel_ms,t_end_ms,role,text; role default "unknown"
        gaps = [dict(wall_start_utc=iso(g["wall_start"], dt.timezone.utc), wall_end_utc=iso(g["wall_end"], dt.timezone.utc), byte_offset=g["byte_offset"], gap_s=g["gap_s"]) for g in p["gaps"]]
        m = dict(case_id=cid, ot_room="OT-2", source_room_id="<scribe_room_id>", recorder_session_id=sid,
                 booked_start_ist=iso(p["booked_start"], IST), booked_end_ist=iso(p["booked_end"], IST),
                 window_start_ist=iso(p["window_start"], IST), window_end_ist=iso(p["window_end"], IST), window_start_utc=iso(p["window_start"], dt.timezone.utc), window_end_utc=iso(p["window_end"], dt.timezone.utc),
                 binding_method=p["binding_method"], t0_ist=iso(p["t0"], IST), t0_method=p["t0_method"], pre_roll_s=p["pre_roll_s"], post_roll_s=p["post_roll_s"],
                 activity=dict(onset_ist=p["onset"] and iso(p["onset"], IST), offset_ist=p["offset"] and iso(p["offset"], IST), rule="30 s bins, >30% records rms>0.01; onset/offset need >=3 active of 5"),
                 sources=[dict(id="orb2_room", path="media/room_orb2.flac", sample_rate=16000, channels=1, byte_offset_start=b0, byte_offset_end=b1, clock="wall_ns from tape.idx, NTP-synced", clock_offset_ms=0)],
                 gaps=gaps, notes=p["notes"], media_sha256=sha(flac), cutter=dict(version=VERSION, sha256=self_sha))
        json.dump(m, open(d + "/manifest.json", "w"), indent=1); print(cid, "bytes", b1 - b0, "s", (b1 - b0) / BPS, "sha256", m["media_sha256"][:12], "gaps", len(gaps))
def ffdur(p):   # full decode to null; duration from the last time= stamp
    h, m_, s_ = subprocess.run(["/usr/bin/ffmpeg", "-i", p, "-f", "null", "-"], capture_output=True, text=True).stderr.split("time=")[-1].split()[0].split(":")
    return int(h) * 3600 + int(m_) * 60 + float(s_)
def run_verify(idx, planp):
    guard(); P = json.load(open(planp)); R, W = load_idx(idx); p = next(x for x in P["plans"] if "skipped" not in x)
    i = bisect.bisect_right(W, int((p["t0"] + 600) * 1e9)); i = max(1, i)   # a record ten minutes after t0
    a = R[i]; pcm = read_pcm(a["byte_offset"], 320000); s = array.array("h"); s.frombytes(pcm[:len(pcm) // 2 * 2])
    print("decoded 10 s at idx record", i, "byte_offset", a["byte_offset"], "bytes", len(pcm), "samples", len(s), "duration_s", len(s) / 16000)
    for j in range(5):   # per-record rms from pcm vs rms stored in the NEXT record (chunk i covers [offset_i, offset_i+1))
        n = (R[i + j + 1]["byte_offset"] - R[i + j]["byte_offset"]) // 2; ch = s[sum((R[i + k + 1]["byte_offset"] - R[i + k]["byte_offset"]) // 2 for k in range(j)):][:n]
        rms = (sum(x * x for x in ch) / len(ch)) ** 0.5 / 32768 if ch else 0
        print("  chunk", j, "samples", n, "pcm rms %.5f" % rms, "idx rms (this rec) %.5f (next rec) %.5f" % (R[i + j]["rms"], R[i + j + 1]["rms"]))
    for q in P["plans"]:
        if "skipped" in q: continue
        m = json.load(open(f"{OUT}/{q['case_id']}/manifest.json")); fl = f"{OUT}/{q['case_id']}/media/room_orb2.flac"
        exp = (m["sources"][0]["byte_offset_end"] - m["sources"][0]["byte_offset_start"]) / BPS
        print(q["case_id"], "flac duration_s", ffdur(fl), "expected (bytes/32000)", exp, "window_s", q["window_end"] - q["window_start"], "gaps", len(m["gaps"]))
if __name__ == "__main__":
    {"plan": lambda: run_plan(sys.argv[2], sys.argv[3]), "layout": lambda: run_layout(sys.argv[2]), "cut": lambda: run_cut(sys.argv[2], sys.argv[3]), "verify": lambda: run_verify(sys.argv[2], sys.argv[3])}[sys.argv[1]]()
