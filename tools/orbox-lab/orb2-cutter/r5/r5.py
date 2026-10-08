# R5 refuter checks for the ORB2 case cutter. Stdlib + /usr/bin/ffmpeg only. Own code; the builder's cutter is not imported or run.
# Usage (cwd ~/orbox-lab/r5): python3 r5.py layout | rule | media | v0 | density
# Reads tape.pcm only via `sudo -n dd` (read-only). Writes only to cwd.
import sys, json, math, array, hashlib, statistics as st, subprocess, datetime as dt, os, bisect
IDX = "tape_idx_r5.jsonl"; PCM = "/var/lib/room-recorder/tape/tape.pcm"; CASES = "/var/lib/orbox-cases/cases/"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
def ist(s): return dt.datetime.fromtimestamp(s, IST).strftime("%H:%M:%S")
def ts(h, m, s=0): return dt.datetime(2026, 10, 8, h, m, s, tzinfo=IST).timestamp()
def iso(s): return dt.datetime.fromisoformat(s).timestamp()
def load_idx():
    R = []
    for line in open(IDX):
        try: R.append(json.loads(line))
        except json.JSONDecodeError: pass        # last line may be partial (file was growing)
    return R
def pcm(off, n):
    b = subprocess.run(["sudo", "-n", "dd", f"if={PCM}", "iflag=skip_bytes,count_bytes", f"skip={off}", f"count={n}", "status=none"],
                       capture_output=True, check=True).stdout
    assert len(b) == n, (off, n, len(b)); return b
def rms16(b):
    a = array.array("h"); a.frombytes(b); return math.sqrt(sum(x * x for x in a) / len(a)) / 32768 if len(a) else 0.0
def out(**k): print(json.dumps(k), flush=True)

CASE_IDS = ["case-1", "case-2", "case-3"]
BOOKED = [(ts(9, 0), ts(10, 30)), (ts(13, 30), ts(15, 30)), (ts(16, 0), ts(17, 30))]

def bins(R):
    b = {}
    for r in R:
        if "rms" not in r or r.get("samples", 0) == 0: continue
        k = int(r["wall_ns"] // 1_000_000_000 // 30 * 30); n, a = b.get(k, (0, 0)); b[k] = (n + 1, a + (r["rms"] > 0.01))
    return {k: (a / n > 0.30) for k, (n, a) in b.items()}, b
def runs(active):
    ks = sorted(k for k, v in active.items() if v); rs = []
    for k in ks:
        if rs and k - rs[-1][1] <= 600: rs[-1][1] = k + 30          # bridge quiet gap <= 10 min
        else: rs.append([k, k + 30])
    return [tuple(r) for r in rs if r[1] - r[0] >= 180]            # drop runs < 3 min

cmd = sys.argv[1]
if cmd == "layout":
    R = load_idx(); out(records=len(R), first_wall=ist(R[0]["wall_ns"] / 1e9), last_wall=ist(R[-1]["wall_ns"] / 1e9))
    bad_b = sum(r["byte_offset"] != 2 * r["samples"] for r in R); bad_f = sum(r.get("input_frames") is not None and r["input_frames"] != 3 * r["samples"] for r in R)
    no_isr = sum("input_sample_rate" not in r for r in R); isr = sorted({r.get("input_sample_rate") for r in R if "input_sample_rate" in r})
    mono = all(R[i]["byte_offset"] <= R[i + 1]["byte_offset"] for i in range(len(R) - 1))
    sp = [(R[i + 1]["wall_ns"] - R[i]["wall_ns"]) / 1e9 for i in range(len(R) - 1)]
    rate = [(R[i + 1]["samples"] - R[i]["samples"]) / ((R[i + 1]["wall_ns"] - R[i]["wall_ns"]) / 1e9) for i in range(1, len(R) - 1) if R[i + 1]["wall_ns"] > R[i]["wall_ns"]]
    span = (R[-1]["samples"] - R[1000]["samples"]) / ((R[-1]["wall_ns"] - R[1000]["wall_ns"]) / 1e9)
    gaps = [(ist(R[i]["wall_ns"] / 1e9), round(sp[i], 2)) for i in range(len(sp)) if sp[i] > 2.0]
    out(bad_byte_vs_2xsamples=bad_b, bad_input_frames_vs_3xsamples=bad_f, input_sample_rates=isr, records_without_isr=no_isr,
        byte_offset_monotonic=mono, spacing_median_s=round(st.median(sp), 3), rate_median=round(st.median(rate), 1), rate_overall=round(span, 2), gaps_over_2s=gaps)
    size = int(subprocess.run(["sudo", "-n", "stat", "-c", "%s", PCM], capture_output=True, text=True).stdout)
    out(pcm_size_now=size, last_idx_byte_offset=R[-1]["byte_offset"], pcm_ahead_bytes=size - R[-1]["byte_offset"])
    # decode 3 spots, 4 consecutive records each. chunk k = bytes [bo(k-1), bo(k)); compare with rms of record k and of record k-1.
    for T in (ts(9, 30), ts(14, 0), ts(17, 0)):
        k0 = bisect.bisect_left([r["wall_ns"] for r in R], T * 1e9)
        for k in range(k0, k0 + 4):
            a, b = R[k - 1]["byte_offset"], R[k]["byte_offset"]; x = rms16(pcm(a, b - a))
            out(spot=ist(T), rec=k, bytes=[a, b], dur_s=round((b - a) / 32000, 4), wall_dt_s=round((R[k]["wall_ns"] - R[k - 1]["wall_ns"]) / 1e9, 4),
                pcm_rms=round(x, 6), idx_rms_k=round(R[k]["rms"], 6), idx_rms_k_minus_1=round(R[k - 1]["rms"], 6))
elif cmd in ("rule", "density"):
    R = load_idx(); active, raw = bins(R); RS = runs(active); tape_end = R[-1]["wall_ns"] / 1e9
    if cmd == "density":
        for i, (bs, be) in enumerate(BOOKED):
            prof = []
            t = bs - 3600
            while t < be + 7200:
                ks = range(int(t), int(t) + 300, 30); prof.append((ist(t)[:5], round(sum(active.get(k, False) for k in ks) / 10, 1)))
                t += 300
            out(case=i + 1, booked=[ist(bs), ist(be)], profile=prof)
        sys.exit()
    out(tape_end=ist(tape_end), n_runs=len(RS), runs=[(ist(a), ist(b), round((b - a) / 60, 1)) for a, b in RS if a < ts(20, 0) and b > ts(7, 0)])
    # pass 1: raw onsets (rule 2 + alt A)
    on, onrun = [], []
    for bs, be in BOOKED:
        lo = bs - 45 * 60; cand = [r for r in RS if r[1] > lo and r[0] < be]
        if cand: on.append(max(cand[0][0], lo)); onrun.append(cand[0])
        else: on.append(None); onrun.append(None)
    # pass 2: offsets in booked order; onset clipped at previous offset
    off = []
    for i, (bs, be) in enumerate(BOOKED):
        if i and on[i] is not None and off[i - 1] is not None: on[i] = max(on[i], off[i - 1])
        if onrun[i] is None: off.append(None); continue
        j = RS.index(onrun[i]); end = RS[j][1]
        while j + 1 < len(RS) and RS[j + 1][0] - end <= 20 * 60: j += 1; end = RS[j][1]
        cap = be + 90 * 60
        if i + 1 < len(BOOKED): nxt = on[i + 1] if on[i + 1] is not None else BOOKED[i + 1][0]; cap = min(cap, nxt - 60)
        off.append(min(end, cap))
    # pass 3: windows, clip against neighbours, assert no overlap
    W = [[(on[i] if on[i] is not None else bs) - 900, (off[i] if off[i] is not None else be) + 900] for i, (bs, be) in enumerate(BOOKED)]
    for i in range(len(W)):
        if i: W[i][0] = max(W[i][0], W[i - 1][1])
        if i + 1 < len(W): W[i][1] = min(W[i][1], W[i + 1][0])
    overlap = any(W[i][1] > W[i + 1][0] for i in range(len(W) - 1))
    for i, cid in enumerate(CASE_IDS):
        M = json.load(open(CASES + cid + "/manifest.json"))
        mine = dict(onset=on[i], offset=off[i], t0=on[i] if on[i] is not None else BOOKED[i][0], ws=W[i][0], we=W[i][1])
        theirs = dict(onset=iso(M["activity"]["onset_ist"]), offset=iso(M["activity"]["offset_ist"]), t0=iso(M["t0_ist"]), ws=iso(M["window_start_ist"]), we=iso(M["window_end_ist"]))
        diff = {k: round(mine[k] - theirs[k]) for k in mine}
        prov_cut = W[i][1] + 900 > ts(18, 54, 5); prov_now = W[i][1] + 900 > tape_end
        out(case=i + 1, id=cid[:7], mine={k: ist(v) for k, v in mine.items()}, theirs={k: ist(v) for k, v in theirs.items()}, diff_s=diff,
            within_30s=all(abs(v) <= 30 for v in diff.values()), t0_method=("activity_onset" if on[i] is not None else "booked_start"), their_t0_method=M["t0_method"],
            provisional_at_cut_18_54_05=prov_cut, provisional_now=prov_now, their_provisional=M.get("provisional"),
            onset_run=[ist(onrun[i][0]), ist(onrun[i][1])] if onrun[i] else None,
            utc_ok=all(abs(iso(M[a + "_ist"]) - iso(M[a + "_utc"])) < 1e-6 for a in ("window_start", "window_end", "t0")))
    out(overlap=overlap, windows=[(ist(a), ist(b)) for a, b in W])
elif cmd in ("media", "v0"):
    R = load_idx(); W = [r["wall_ns"] / 1e9 for r in R]; B = [r["byte_offset"] for r in R]
    def wall_at(bo):                                   # wall time of byte offset bo (bo(k) is the end of chunk k, at wall(k))
        k = bisect.bisect_left(B, bo); k = min(max(k, 1), len(B) - 1)
        return W[k - 1] + (W[k] - W[k - 1]) * (bo - B[k - 1]) / max(B[k] - B[k - 1], 1)
    for cid in CASE_IDS:
        base = CASES + cid + ("/_superseded_v0/" if cmd == "v0" else "/")
        M = json.load(open(base + "manifest.json")); f = base + M["sources"][0]["path"]
        h = hashlib.sha256()
        with open(f, "rb") as fh:
            for blk in iter(lambda: fh.read(1 << 20), b""): h.update(blk)
        sha = h.hexdigest()
        if cmd == "v0": out(case=cid[:7], v0_sha_file=sha, v0_sha_manifest=M["media_sha256"], match=sha == M["media_sha256"]); continue
        probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels,sample_fmt,bits_per_raw_sample", "-of", "json", f], capture_output=True, text=True).stdout
        p = subprocess.Popen(["nice", "-n", "10", "ffmpeg", "-v", "error", "-i", f, "-f", "s16le", "-acodec", "pcm_s16le", "-"], stdout=subprocess.PIPE)
        N = 320000; head = b""; tail = b""; total = 0
        while True:
            blk = p.stdout.read(1 << 20)
            if not blk: break
            total += len(blk)
            if len(head) < N: head += blk[:N - len(head)]
            tail = (tail + blk)[-N:]
        p.wait()
        s, e = M["sources"][0]["byte_offset_start"], M["sources"][0]["byte_offset_end"]
        ws, we = iso(M["window_start_ist"]), iso(M["window_end_ist"]); gap_s = sum(g.get("duration_s", 0) for g in M["gaps"])
        th, tt = pcm(s, N), pcm(e - N, N)
        out(case=cid[:7], sha_file=sha, sha_manifest=M["media_sha256"], sha_match=sha == M["media_sha256"], probe=json.loads(probe)["streams"],
            decoded_bytes=total, decoded_s=round(total / 32000, 3), manifest_bytes=e - s, window_minus_gaps_s=round(we - ws - gap_s, 3),
            dur_diff_s=round(total / 32000 - (we - ws - gap_s), 3), first10_exact=head == th, last10_exact=tail == tt,
            rms_first=[round(rms16(head), 6), round(rms16(th), 6)], rms_last=[round(rms16(tail), 6), round(rms16(tt), 6)],
            wall_at_byte_start=ist(wall_at(s)), wall_at_byte_end=ist(wall_at(e)), start_err_s=round(wall_at(s) - ws, 2), end_err_s=round(wall_at(e) - we, 2), ffmpeg_rc=p.returncode)
