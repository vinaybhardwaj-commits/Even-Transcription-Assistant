#!/usr/bin/env python3
# ORB2 case cutter, binding rule v2.2, tool v2.3 (ORDERS-O24 adds the clock block; the cut rule is unchanged) (ORDERS-O15, on v2.1 of ORDERS-O7 + lead ruling 23:05). Stdlib + /usr/bin/ffmpeg only. Self-contained.
# Usage: cutter_v2.py cut   --date YYYY-MM-DD --room OT-2 --bookings <csv> [--dry-run] [--idx <idx.jsonl>] [--workdir DIR]
#                          [--status-file F] [--cursor-file F] [--trash-dir DIR]   (the last three are for local tests; on orb2 leave them out)
#        cutter_v2.py check --date YYYY-MM-DD --room OT-2
# Bookings CSV needs the columns case_uid, ot_room, sched_start_ist, sched_end_ist ("YYYY-MM-DD HH:MM", IST). Other columns are ignored.
# Reads: `sudo -n cat tape.idx` (unless --idx), `sudo -n cat status.json` and `sudo -n cat cursor.json` (parsed as the operator account) and `sudo -n ionice/nice dd tape.pcm` piped into ffmpeg. No root python. Writes only under
# /var/lib/orbox-cases (packages, days/) and the work dir (idx snapshot). Never writes under /var/lib/room-recorder. Never deletes: old packages are mv'd.
#
# Pass order: (1) density and runs  (2) boundaries  (3) per-case onset and offset  (4) windows and the overlap assertion  (5) orphan check
# Definitions (all times epoch seconds, wall clock of tape.idx):
#  bins/runs: 30 s bins, active if >30% of records have rms>0.01; runs bridge quiet gaps <=10 min; runs <3 min dropped (as v1.1).
#    v2.1: a record goes in the bin of its chunk START = wall_ns - (samples - previous samples)/16000 s (rms covers the chunk before wall_ns, per R5);
#    the first record, and any record whose chunk length is not in (0, 5] s, use wall_ns.
#  density d(block): share of active 30 s bins in each 5-min block aligned to the wall clock; bins with no idx record inside the tape count as inactive.
#  boundary(A,B): search S=[A.booked_end, B.booked_start]; if shorter than 30 min, S=[B.bs-30m, A.be+30m] clipped to [A.bs, B.be]. Blocks fully inside S;
#    minimum d; longest contiguous stretch of minimum blocks (earliest on tie); boundary = middle of the stretch rounded down to 30 s.
#  segment: case i owns [boundary(i-1), boundary(i)]; first starts at booked_start-120 min (not before tape start); last ends at min(booked_end+180 min, tape end).
#  "block inside a run": the block overlaps the run (clipped to the segment) by at least 150 s.
#  onset (v2.1) = start of the first streak of >=3 consecutive 5-min blocks with d>=0.3, each inside the same run (clipped to the segment); not before segment start.
#    Offset (unchanged from v2) = end of the last block with d>=0.3 inside the chain (runs from the onset run, gaps <=20 min, clipped to the segment), not after segment end.
#    No qualifying onset: window = booked slot +-15 min clipped to the segment, t0 = booked_start, t0_method booked_start, binding_method booked_slot.
#  v2.2 onset fallback, only when no 3-block onset exists in the segment: candidates are runs (clipped to the segment) that overlap [booked_start-60 min, booked_end+60 min],
#    are >=15 min long (clipped) and hold a block with d>=0.5. Longest wins, then earliest. Onset = start of that run's first block with d>=0.3 (not before segment start);
#    offset = the usual chain rule from that run. Window = min(booked_start-15, onset-15) .. max(booked_end+15, offset+15) clipped to the segment, so the booked slot stays covered.
#    t0 = onset, t0_method activity_run, t0_flag weak_fallback. No candidate: the booked-slot rule above.
#  t0_flag: weak_fallback (above, wins over search_edge), search_edge when the onset block starts at or before the segment start, else null.
#  recorder_sessions (v2.2): [{id, start_utc, end_utc, source}] covering the window. Known spans: the current status.json session, starting at cursor.json
#    last_piece_ended_at_ms - next_index*300 s (source cursor_inferred, INFERRED: 5-min pieces counted from 0), and spans learned from earlier day files
#    (recorder_state_seen) and manifests (source previous_manifest). Uncovered parts are {id: null, source: unknown}. recorder_session_id = the id only when one known session
#    covers the whole window, else null. Each real run writes the status/cursor values it saw into the day file as recorder_state_seen.
#  out_of_case (day file): tape between the first segment start and the last segment end that lies in no window: start, end, duration_s, max_d.
#  The day file is mv'd to days/_superseded/<name>.<HHMMSS>.json before a new one is written. Idx snapshots: the newest 2 stay, older ones are mv'd to ~/orbox-lab/_to_delete/idx/.
#  room_uid in meta.json comes from the bookings column ot__ot_room_uid when the CSV has it, else null.
#  window = [onset-15 min, offset+15 min] clipped to the segment. Provisional: window_end+15 min after tape end, or last case with segment end = tape end
#    and chain end within the last 20 min of tape.
#  clock (v2.3, manifest): the ORB2 capture clock drifts against the NTP wall clock in tape.idx (about +6 ppm), so a flac holds a little more than window x 16000 frames.
#    samples_per_wall_s = least-squares slope of sample index on wall time over the anchors; ppm_vs_wall = (that/16000 - 1) x 1e6, 2 dp; anchors = [sample_index_in_flac, wall_ns]
#    from idx rows inside the window, one per 60 s (nearest row) plus the first and last row; sample_index = (byte_offset - byte_offset_start) / 2. method idx_least_squares
#    (idx_endpoints when only two rows exist). Map a sample to wall time through the anchors, never window_start + n/16000. `check` compares flac frames (read from the
#    FLAC STREAMINFO) with window x samples_per_wall_s and fails beyond 2 frames per started hour of window.
#  runs_considered: every run overlapping the segment; start/end original, clipped_start/clipped_end in the segment, length_min = original length,
#    in_chain true for every run that supplies the onset or belongs to the offset chain.
import sys, os, json, bisect, hashlib, subprocess, statistics, argparse, csv, shutil, math, collections, datetime as dt
VERSION = "o15-cutter-v2.3"; RULE = "v2.2"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30)); UTC = dt.timezone.utc
TAPE = "/var/lib/room-recorder/tape/tape.pcm"; IDX = "/var/lib/room-recorder/tape/tape.idx"; STATUS = "/var/lib/room-recorder/status.json"; CURSOR = "/var/lib/room-recorder/cursor.json"
OUT = "/var/lib/orbox-cases/cases"; DAYS = "/var/lib/orbox-cases/days"; BPS = 32000
ROOMS = {"OT-2": os.environ.get("ORBOX_ROOM_OT2", "<scribe_room_id>")}
BLK, BIN, DMIN = 300, 30, 0.3
PIECE_S = 300; TRASH_IDX = os.path.expanduser("~/orbox-lab/_to_delete/idx")
def ist(s): return dt.datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=IST)
def ep(d): return d.timestamp()
def iso(e, tz): return dt.datetime.fromtimestamp(e, tz).isoformat(timespec="seconds")
def iso_ms(e): return dt.datetime.fromtimestamp(e, UTC).strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % int(round(e % 1 * 1000) % 1000)
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()
def ffdur(p):
    h, m_, s_ = subprocess.run(["/usr/bin/ffmpeg", "-i", p, "-f", "null", "-"], capture_output=True, text=True).stderr.split("time=")[-1].split()[0].split(":")
    return int(h) * 3600 + int(m_) * 60 + float(s_)
def overlap(a0, a1, b0, b1): return max(0.0, min(a1, b1) - max(a0, b0))
def fail(msg): sys.exit("FAIL: " + msg)
def flac_frames(p):   # exact sample count from the FLAC STREAMINFO block (36 bits after rate, channels, bit depth)
    with open(p, "rb") as f: h = f.read(26)
    if h[:4] != b"fLaC" or (h[4] & 0x7F) != 0: fail("not a FLAC with STREAMINFO first: " + p)
    n = int.from_bytes(h[18:26], "big") & ((1 << 36) - 1)
    if not n: fail("FLAC STREAMINFO holds no sample count: " + p)
    return n
# ---- inputs
def load_bookings(path, date, room):
    rows = []; uids = {}
    for r in csv.DictReader(open(path, newline="")):
        if r["ot_room"] == room and r["sched_start_ist"].startswith(date):
            rows.append((r["case_uid"], ep(ist(r["sched_start_ist"])), ep(ist(r["sched_end_ist"])))); uids[r["case_uid"]] = r.get("ot__ot_room_uid") or None
    if not rows: fail("no bookings for %s %s in %s" % (room, date, path))
    if len({c[0] for c in rows}) != len(rows): fail("duplicate case_uid in bookings")
    return sorted(rows, key=lambda c: (c[1], c[2])), uids
def prune_snapshots(workdir, trash, keep=2):   # keep the newest `keep` idx snapshots, mv (never rm) the rest
    snaps = sorted(f for f in os.listdir(workdir) if f.startswith("idx-snap-") and f.endswith(".jsonl")); moved = []
    for f in snaps[:-keep] if keep else snaps:
        os.makedirs(trash, exist_ok=True); dest = os.path.join(trash, f)
        if os.path.exists(dest): dest += "." + dt.datetime.now(IST).strftime("%H%M%S")
        shutil.move(os.path.join(workdir, f), dest); moved.append(f)
    return moved
def load_idx(path, workdir, trash=TRASH_IDX):
    if path:
        with open(path) as fh: txt = fh.read()
    else:
        txt = subprocess.run(["sudo", "-n", "cat", IDX], capture_output=True, check=True, text=True).stdout
        os.makedirs(workdir, exist_ok=True); path = os.path.join(workdir, "idx-snap-%s.jsonl" % dt.datetime.now(IST).strftime("%Y%m%d-%H%M%S")); open(path, "w").write(txt); prune_snapshots(workdir, trash)
    lines = [l for l in txt.split("\n") if l.strip()]; R = []
    for i, l in enumerate(lines):
        try: R.append(json.loads(l))
        except ValueError:
            if i == len(lines) - 1: break          # last line still being written
            raise
    return R, [r["wall_ns"] for r in R], path
def gaps_of(R):
    g = []
    for a, b in zip(R, R[1:]):
        dw = (b["wall_ns"] - a["wall_ns"]) / 1e9; db = b["byte_offset"] - a["byte_offset"]
        if dw > 2.0 or db != 2 * (b["samples"] - a["samples"]): g.append(dict(wall_start=a["wall_ns"] / 1e9, wall_end=b["wall_ns"] / 1e9, byte_offset=a["byte_offset"], duration_s=round(dw, 3)))
    return g
def clock_of(R, W, ws, we, b0):   # v2.3: sample-index <-> wall_ns anchors from the idx rows inside the window; None when fewer than 2 rows
    lo, hi = bisect.bisect_left(W, int(ws * 1e9)), bisect.bisect_right(W, int(we * 1e9)); rows = R[lo:hi]
    if len(rows) < 2: return None
    idxs = {0, len(rows) - 1}; t = rows[0]["wall_ns"] + 60 * 10 ** 9
    while t < rows[-1]["wall_ns"]:
        j = bisect.bisect_left(W, t, lo, hi) - lo; idxs.add(min(range(max(j - 1, 0), min(j + 1, len(rows) - 1) + 1), key=lambda k: abs(rows[k]["wall_ns"] - t))); t += 60 * 10 ** 9
    anchors = [[(rows[k]["byte_offset"] - b0) // 2, rows[k]["wall_ns"]] for k in sorted(idxs)]
    xs = [(w - anchors[0][1]) / 1e9 for _, w in anchors]; ys = [n - anchors[0][0] for n, _ in anchors]
    if len(anchors) > 2:
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys); sps = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs); method = "idx_least_squares"
    else: sps = ys[-1] / xs[-1]; method = "idx_endpoints"
    return dict(samples_per_wall_s=sps, ppm_vs_wall=round((sps / 16000 - 1) * 1e6, 2), anchors=anchors, method=method)
def byte_at(R, W, t):   # (wall, byte) pairs from idx, linear interpolation, even-aligned
    i = bisect.bisect_right(W, int(t * 1e9)) - 1; i = max(0, min(i, len(R) - 2)); a, b = R[i], R[i + 1]
    f = (t * 1e9 - a["wall_ns"]) / max(b["wall_ns"] - a["wall_ns"], 1); f = min(max(f, 0.0), 1.0)
    return int((a["byte_offset"] + f * (b["byte_offset"] - a["byte_offset"])) // 2 * 2)
# ---- pass 1: density and runs
def bins_of(R):
    B = {}; prev = None
    for r in R:
        w = r["wall_ns"] / 1e9
        if prev is not None and 0 < (r["samples"] - prev["samples"]) / 16000 <= 5: w -= (r["samples"] - prev["samples"]) / 16000
        B.setdefault(int(w // BIN), []).append(r.get("rms", 0.0)); prev = r
    return {k: dict(active=(sum(x > 0.01 for x in v) / len(v) > 0.30), rms_median=statistics.median(v), n=len(v)) for k, v in B.items()}
def runs_of(B):
    ks = sorted(k for k, v in B.items() if v["active"]); runs = []
    for k in ks:
        if runs and (k - runs[-1][1]) * BIN <= 600: runs[-1][1] = k + 1
        else: runs.append([k, k + 1])
    return [(a * BIN, b * BIN) for a, b in runs if (b - a) * BIN >= 180]
def density(B):
    kmin, kmax = min(B), max(B); D = {}
    for b in range(kmin // 10, kmax // 10 + 1):
        ks = [k for k in range(b * 10, b * 10 + 10) if kmin <= k <= kmax]
        D[b * BLK] = sum(1 for k in ks if B.get(k, {}).get("active")) / len(ks)
    return D
# ---- pass 2: boundaries
def boundary(D, A, C):
    lo, hi = A[2], C[1]
    if hi - lo < 1800: lo, hi = max(C[1] - 1800, A[1]), min(A[2] + 1800, C[2])
    blocks = sorted(t for t in D if t >= lo and t + BLK <= hi)
    if not blocks: blocks = sorted(t for t in D if t + BLK > lo and t < hi)
    if not blocks: fail("no density blocks in search window for %s/%s" % (A[0], C[0]))
    m = min(D[t] for t in blocks); st = []
    for t in blocks:
        if D[t] != m: continue
        if st and t == st[-1][1]: st[-1][1] = t + BLK
        else: st.append([t, t + BLK])
    best = max(st, key=lambda s: (s[1] - s[0], -s[0])); mid = (best[0] + best[1]) / 2
    return dict(t=math.floor(mid / BIN) * BIN, min_density=round(m, 3), stretch=(best[0], best[1]), search=(lo, hi))
# ---- pass 3: onset and offset
def find_onset(D, cr):   # first streak of >=3 consecutive qualifying blocks inside one clipped run; returns (run index, streak start)
    for i, (ca, cb, a, b) in enumerate(cr):
        t = math.floor(ca / BLK) * BLK; n = 0
        while t < cb:
            if D.get(t, 0) >= DMIN and overlap(t, t + BLK, ca, cb) >= 150:
                n += 1
                if n == 3: return i, t - 2 * BLK
            else: n = 0
            t += BLK
def fallback_run(D, cr, bs, be):   # v2.2: (run index, onset block start) of the weak-fallback run, or None
    best = None
    for i, (ca, cb, a, b) in enumerate(cr):
        if cb - ca < 900 or overlap(ca, cb, bs - 3600, be + 3600) <= 0: continue
        bl = [t for t in range(int(math.floor(ca / BLK) * BLK), int(cb), BLK) if overlap(t, t + BLK, ca, cb) >= 150]
        if not any(D.get(t, 0) >= 0.5 for t in bl): continue
        key = (cb - ca, -ca)
        if best is None or key > best[0]: best = (key, i, next(t for t in bl if D.get(t, 0) >= DMIN))
    return (best[1], best[2]) if best else None
def chain_of(cr, i):
    end = cr[i][1]; used = [i]
    for j in range(i + 1, len(cr)):
        if cr[j][0] - end <= 1200: used.append(j); end = max(end, cr[j][1])
        else: break
    return used, end
def plan(cases, R, W):
    B = bins_of(R); runs = runs_of(B); D = density(B); G = gaps_of(R); tape_lo, tape_hi = R[0]["wall_ns"] / 1e9, R[-1]["wall_ns"] / 1e9; n = len(cases)
    bnd = [boundary(D, cases[i], cases[i + 1]) for i in range(n - 1)]
    for a, b in zip(bnd, bnd[1:]):
        if not a["t"] < b["t"]: fail("boundaries not increasing")
    seg = []
    for i, (cid, bs, be) in enumerate(cases):
        lo = max(bs - 7200, tape_lo) if i == 0 else bnd[i - 1]["t"]; hi = min(be + 10800, tape_hi) if i == n - 1 else bnd[i]["t"]
        if not lo < hi: fail("empty segment %s" % cid)
        seg.append((lo, hi))
    P = []
    for i, (cid, bs, be) in enumerate(cases):
        lo, hi = seg[i]; notes = []
        cr = [(max(a, lo), min(b, hi), a, b) for a, b in runs if a < hi and b > lo]
        o = find_onset(D, cr); chain_end = None; t0f = None; fb = None if o else fallback_run(D, cr, bs, be)
        if o or fb:
            ri, t = o or fb; used, chain_end = chain_of(cr, ri); on = max(t, lo)
            if on > t or t < lo: notes.append("onset clipped to segment start")
            ends = [bt + BLK for j in used for bt in range(int(math.floor(cr[j][0] / BLK) * BLK), int(cr[j][1]), BLK) if D.get(bt, 0) >= DMIN and overlap(bt, bt + BLK, cr[j][0], cr[j][1]) >= 150]
            off = min(max(ends), hi)
            if o: t0, t0m, bind = on, "activity_onset", "booked_slot+activity"; t0f = "search_edge" if t <= lo else None
            else: t0, t0m, bind, t0f = on, "activity_run", "booked_slot+activity_run", "weak_fallback"; notes.append("no 3-block onset: weak fallback on the longest run near the slot")
        else:
            used = []; on = off = None; t0, t0m, bind = bs, "booked_start", "booked_slot"; notes.append("no qualifying onset: window from booked slot")
        rs = min(bs, on) if fb else (on if on is not None else bs); re_ = max(be, off) if fb else (off if off is not None else be)
        ws = max(rs - 900, lo); we = min(re_ + 900, hi)
        if ws > rs - 900: notes.append("pre-roll clipped at segment start")
        if we < re_ + 900: notes.append("post-roll clipped at segment end")
        prov = None
        if we + 900 > tape_hi: prov = "window_end + 15 min is after the tape end at cut time (%s)" % iso(tape_hi, IST)
        elif i == n - 1 and hi == tape_hi and chain_end is not None and chain_end >= tape_hi - 1200: prov = "segment ends at the tape end and the activity chain is still active in the last 20 min (%s)" % iso(tape_hi, IST)
        P.append(dict(case_id=cid, booked_start=bs, booked_end=be, segment=seg[i], boundary_prev=bnd[i - 1] if i > 0 else None, boundary_next=bnd[i] if i < n - 1 else None,
                      onset=on, offset=off, t0=t0, t0_method=t0m, t0_flag=t0f, binding_method=bind, window_start=ws, window_end=we, pre_roll_s=int(round(t0 - ws)), post_roll_s=int(round(we - (off if off is not None else be))),
                      provisional=bool(prov), provisional_reason=prov, notes=notes, gaps=[g for g in G if g["wall_end"] > ws and g["wall_start"] < we],
                      bin_rows=[dict(bin_start=k * BIN, active=int(v["active"]), rms_median=round(v["rms_median"], 5), n=v["n"]) for k, v in sorted(B.items()) if ws <= k * BIN < we],
                      runs_considered=[dict(start=iso(a, IST), end=iso(b, IST), clipped_start=iso(ca, IST), clipped_end=iso(cb, IST), length_min=round((b - a) / 60, 1), in_chain=(j in used)) for j, (ca, cb, a, b) in enumerate(cr)]))
    # pass 4: overlap assertion
    for a, b in zip(sorted(P, key=lambda p: p["window_start"]), sorted(P, key=lambda p: p["window_start"])[1:]):
        if a["window_end"] > b["window_start"]: fail("windows overlap: %s ends %s, %s starts %s" % (a["case_id"], iso(a["window_end"], IST), b["case_id"], iso(b["window_start"], IST)))
    for p in P:
        if not p["window_end"] > p["window_start"]: fail("empty window " + p["case_id"])
    # pass 5: orphan check
    orphans = [dict(block_ist=iso(t, IST), density=round(D[t], 2)) for t in sorted(D) if t >= seg[0][0] and t + BLK <= seg[-1][1] and D[t] >= DMIN
               and not any(overlap(t, t + BLK, p["window_start"], p["window_end"]) > 0 for p in P)]
    ooc = []; cur = seg[0][0]
    for w0, w1 in sorted((p["window_start"], p["window_end"]) for p in P) + [(seg[-1][1], seg[-1][1])]:
        if w0 > cur: ooc.append(dict(start=iso(cur, IST), end=iso(w0, IST), duration_s=int(round(w0 - cur)), max_d=round(max([D[t] for t in D if overlap(t, t + BLK, cur, w0) > 0] or [0.0]), 2)))
        cur = max(cur, w1)
    return dict(P=P, out_of_case=ooc, orphans=orphans, tape_lo=tape_lo, tape_hi=tape_hi, idx_records=len(R))
def plan_key(p): return hashlib.sha256(json.dumps([p["case_id"], p["booked_start"], p["booked_end"], p["window_start"], p["window_end"], p["t0"], p["t0_method"], p["t0_flag"], p["binding_method"], p["onset"], p["offset"], p["provisional"]]).encode()).hexdigest()
def show(pl, date, room):
    print("rule", RULE, "| %s %s | idx records %d | tape %s -> %s IST" % (room, date, pl["idx_records"], iso(pl["tape_lo"], IST), iso(pl["tape_hi"], IST)))
    f = lambda e: iso(e, IST)[11:19]
    for p in pl["P"]:
        bp, bn = p["boundary_prev"], p["boundary_next"]
        print("case %s booked %s-%s" % (p["case_id"], f(p["booked_start"]), f(p["booked_end"])))
        print("  boundary_prev", (f(bp["t"]) + " dmin %.2f stretch %s-%s search %s-%s" % (bp["min_density"], f(bp["stretch"][0]), f(bp["stretch"][1]), f(bp["search"][0]), f(bp["search"][1]))) if bp else "none (booked_start-120min)",
              "| boundary_next", (f(bn["t"]) + " dmin %.2f stretch %s-%s search %s-%s" % (bn["min_density"], f(bn["stretch"][0]), f(bn["stretch"][1]), f(bn["search"][0]), f(bn["search"][1]))) if bn else "none (min(booked_end+180min, tape end))")
        print("  segment %s-%s | onset %s offset %s | window %s-%s | t0 %s %s flag %s | provisional %s | duration_s %.1f | gaps %d | notes %s" % (f(p["segment"][0]), f(p["segment"][1]), p["onset"] and f(p["onset"]), p["offset"] and f(p["offset"]),
              f(p["window_start"]), f(p["window_end"]), f(p["t0"]), p["t0_method"], p["t0_flag"], p["provisional"], p["window_end"] - p["window_start"], len(p["gaps"]), p["notes"]))
        for r in p["runs_considered"]: print("    run %s-%s clipped %s-%s %.1f min in_chain %s" % (r["start"][11:19], r["end"][11:19], r["clipped_start"][11:19], r["clipped_end"][11:19], r["length_min"], r["in_chain"]))
    for p in pl["P"]:
        if "sessions" in p: print("  sessions", p["case_id"], [(x["id"], x["start_utc"][11:19], x["end_utc"][11:19], x["source"]) for x in p["sessions"]])
    print("out_of_case spans:", len(pl["out_of_case"]), [(o["start"][11:16], o["end"][11:16], o["duration_s"], o["max_d"]) for o in pl["out_of_case"]])
    print("overlap assertion: PASS | orphans (d>=0.3, in no window):", len(pl["orphans"]), [(o["block_ist"][11:16], o["density"]) for o in pl["orphans"]])
# ---- recorder sessions (v2.2)
def read_json_sudo(path, fp=None):
    if fp: return json.load(open(fp))
    return json.loads(subprocess.run(["sudo", "-n", "cat", path], capture_output=True, check=True, text=True).stdout)
def read_state(a, strict):   # (status_sid, cursor dict or None); a read error is fatal only when strict
    sid = cur = None
    try: sid = read_json_sudo(STATUS, a.status_file).get("session_id")
    except (subprocess.CalledProcessError, OSError, ValueError):
        if strict: raise
    try: cur = read_json_sudo(CURSOR, a.cursor_file)
    except (subprocess.CalledProcessError, OSError, ValueError): cur = None
    return sid, cur
def state_seen(sid, cur, now):
    c = {k: cur.get(k) for k in ("next_index", "last_piece_ended_at_ms")} if cur else None; start = None
    if sid and c and isinstance(c["next_index"], (int, float)) and isinstance(c["last_piece_ended_at_ms"], (int, float)):
        start = c["last_piece_ended_at_ms"] / 1000 - c["next_index"] * PIECE_S
    return dict(seen_at_utc=iso(now, UTC), status_session_id=sid, cursor=c, piece_s=PIECE_S, inferred_start_utc=iso(start, UTC) if start is not None else None,
                last_piece_ended_utc=iso(c["last_piece_ended_at_ms"] / 1000, UTC) if c and isinstance(c["last_piece_ended_at_ms"], (int, float)) else None)
def utc_ep(x): return dt.datetime.fromisoformat(x).timestamp()
def known_spans(seen, days_dir=DAYS, out_dir=OUT):   # -> (current span or None, [earlier spans]); span = [id, start, end, source]
    cur = None
    if seen["status_session_id"] and seen["inferred_start_utc"]: cur = [seen["status_session_id"], utc_ep(seen["inferred_start_utc"]), math.inf, "cursor_inferred"]
    old = {}
    def add(i, s0, s1):
        if not i or (cur and i == cur[0]): return
        o = old.setdefault(i, [i, s0, s1, "previous_manifest"]); o[1] = min(o[1], s0); o[2] = max(o[2], s1)
    for d in (days_dir, days_dir + "/_superseded"):
        for f in (sorted(os.listdir(d)) if os.path.isdir(d) else []):
            if not f.endswith(".json"): continue
            try: st = json.load(open(d + "/" + f)).get("recorder_state_seen")
            except (ValueError, OSError): continue
            if st and st.get("status_session_id") and st.get("inferred_start_utc") and st.get("last_piece_ended_utc"): add(st["status_session_id"], utc_ep(st["inferred_start_utc"]), utc_ep(st["last_piece_ended_utc"]))
    for c in (sorted(os.listdir(out_dir)) if os.path.isdir(out_dir) else []):
        try: m = json.load(open("%s/%s/manifest.json" % (out_dir, c)))
        except (ValueError, OSError): continue
        for x in m.get("recorder_sessions") or []:
            if x.get("id") and x.get("source") in ("cursor_inferred", "previous_manifest"): add(x["id"], utc_ep(x["start_utc"]), utc_ep(x["end_utc"]))
    return cur, list(old.values())
def sessions_for(ws, we, cur, old):   # pieces covering [ws, we]; the current session wins, then the latest-starting earlier span
    pts = {ws, we} | {t for sp in ([cur] if cur else []) + old for t in sp[1:3] if ws < t < we}; pts = sorted(pts); out = []
    for x, y in zip(pts, pts[1:]):
        m = (x + y) / 2; hit = cur if cur and cur[1] <= m < cur[2] else next(iter(sorted([sp for sp in old if sp[1] <= m < sp[2]], key=lambda sp: -sp[1])), None)
        e = dict(id=hit[0], start=x, end=y, source=hit[3]) if hit else dict(id=None, start=x, end=y, source="unknown")
        if out and (out[-1]["id"], out[-1]["source"]) == (e["id"], e["source"]): out[-1]["end"] = y
        else: out.append(e)
    return [dict(id=e["id"], start_utc=iso(e["start"], UTC), end_utc=iso(e["end"], UTC), source=e["source"]) for e in out]
def session_id_of(pieces):
    return (pieces[0]["id"], pieces[0]["source"]) if len(pieces) == 1 and pieces[0]["id"] else (None, None)
# ---- cut
def supersede_name(d, rule):
    base = "_superseded_" + rule.replace(".", "_")
    if rule.startswith("v2") or os.path.exists(d + "/" + base): base += "_" + dt.datetime.now(IST).strftime("%H%M")
    if os.path.exists(d + "/" + base): fail("superseded dir exists: " + d + "/" + base)
    return base
def write_package(p, R, W, room, source_name, room_uid, self_sha):
    cid = p["case_id"]; d = f"{OUT}/{cid}"; flac = d + "/media/room_orb2.flac"
    os.makedirs(d + "/media", exist_ok=True); os.makedirs(d + "/tracks", exist_ok=True)
    b0, b1 = byte_at(R, W, p["window_start"]), byte_at(R, W, p["window_end"])
    dd = subprocess.Popen(["sudo", "-n", "ionice", "-c3", "nice", "-n", "10", "dd", f"if={TAPE}", "bs=1M", "iflag=skip_bytes,count_bytes", f"skip={b0}", f"count={b1 - b0}", "status=none"], stdout=subprocess.PIPE)
    ff = subprocess.run(["/usr/bin/ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "-", "-c:a", "flac", flac], stdin=dd.stdout, capture_output=True)
    dd.stdout.close()
    if dd.wait() != 0 or ff.returncode != 0: fail("dd/ffmpeg failed for %s: %s" % (cid, ff.stderr))
    with open(d + "/tracks/activity.jsonl", "w") as f:
        for r in p["bin_rows"]: f.write(json.dumps(dict(t_rel_ms=int(round((r["bin_start"] - p["t0"]) * 1000)), t_abs=iso_ms(r["bin_start"]), rms_median=r["rms_median"], active=bool(r["active"]))) + "\n")
    open(d + "/tracks/transcript.jsonl", "w").close()
    rates = collections.Counter(r.get("input_sample_rate") for r in R[bisect.bisect_left(W, int(p["window_start"] * 1e9)):bisect.bisect_right(W, int(p["window_end"] * 1e9))] if r.get("input_sample_rate")).most_common(1)
    clock = clock_of(R, W, p["window_start"], p["window_end"], b0)
    tz2 = lambda e: dict(ist=iso(e, IST), utc=iso(e, UTC))
    gaps = [dict(start_utc=iso(g["wall_start"], UTC), end_utc=iso(g["wall_end"], UTC), start_ist=iso(g["wall_start"], IST), end_ist=iso(g["wall_end"], IST), duration_s=g["duration_s"], byte_offset=g["byte_offset"]) for g in p["gaps"]]
    bd = lambda b: dict(tz2(b["t"]), min_density=b["min_density"], stretch_ist=[iso(b["stretch"][0], IST), iso(b["stretch"][1], IST)]) if b else None
    m = dict(case_id=cid, ot_room=room, source_room_id=ROOMS[room], recorder_session_id=session_id_of(p["sessions"])[0], recorder_session_id_source=session_id_of(p["sessions"])[1], recorder_sessions=p["sessions"], rule_version=RULE,
             booked_start_ist=iso(p["booked_start"], IST), booked_end_ist=iso(p["booked_end"], IST),
             window_start_ist=iso(p["window_start"], IST), window_end_ist=iso(p["window_end"], IST), window_start_utc=iso(p["window_start"], UTC), window_end_utc=iso(p["window_end"], UTC),
             segment=dict(start_ist=iso(p["segment"][0], IST), end_ist=iso(p["segment"][1], IST), start_utc=iso(p["segment"][0], UTC), end_utc=iso(p["segment"][1], UTC)),
             boundary_prev=bd(p["boundary_prev"]), boundary_next=bd(p["boundary_next"]),
             binding_method=p["binding_method"], t0_ist=iso(p["t0"], IST), t0_utc=iso(p["t0"], UTC), t0_method=p["t0_method"], t0_flag=p["t0_flag"], pre_roll_s=p["pre_roll_s"], post_roll_s=p["post_roll_s"],
             provisional=p["provisional"], provisional_reason=p["provisional_reason"],
             activity=dict(onset_ist=p["onset"] and iso(p["onset"], IST), offset_ist=p["offset"] and iso(p["offset"], IST),
                           rule="v2.2: 30 s bins >30% rms>0.01; runs bridge <=10 min, drop <3 min; 5-min density; onset = first streak of 3 blocks d>=0.3 inside a run, else weak fallback on the longest run >=15 min near the slot with a block d>=0.5; offset = last block d>=0.3 in the chain (gap <=20 min); within the segment", runs_considered=p["runs_considered"]),
             sources=[dict(id="orb2_room", path="media/room_orb2.flac", sample_rate=16000, channels=1, capture_input_sample_rate=rates[0][0] if rates else None, byte_offset_start=b0, byte_offset_end=b1, clock="wall_ns from tape.idx, NTP-synced", clock_offset_ms=0)], clock=clock,
             gaps=gaps, notes=p["notes"], media_sha256=sha(flac), plan_key=plan_key(p), cutter=dict(version=VERSION, sha256=self_sha))
    meta = dict(case_id=cid, ot_room=room, room_uid=room_uid, booked_start=tz2(p["booked_start"]), booked_end=tz2(p["booked_end"]), team_roles=[], asa=None,
                times=dict(wheel_in=None, incision=None, closure=None, wheel_out=None), simulated=False, source="metasurfer bookings CSV " + source_name)
    json.dump(meta, open(d + "/meta.json", "w"), indent=1); json.dump(m, open(d + "/manifest.json", "w"), indent=1)
    print(cid, "bytes", b1 - b0, "s %.2f" % ((b1 - b0) / BPS), "sha12", m["media_sha256"][:12], "prov", m["provisional"], "gaps", len(gaps))
def cmd_cut(a):
    if a.room not in ROOMS: fail("room not mapped: " + a.room)
    if not a.dry_run and not os.environ.get("ORBOX_ROOM_OT2"): fail("ORBOX_ROOM_OT2 is unset: set the scribe room id before a real cut")
    cases, uids = load_bookings(a.bookings, a.date, a.room); R, W, ipath = load_idx(a.idx, a.workdir, a.trash_dir); pl = plan(cases, R, W)
    now = dt.datetime.now(UTC).timestamp(); sid, cur = read_state(a, strict=not a.dry_run); seen = state_seen(sid, cur, now); cs, old = known_spans(seen)
    for p in pl["P"]: p["sessions"] = sessions_for(p["window_start"], p["window_end"], cs, old)
    show(pl, a.date, a.room); print("idx file:", ipath)
    if a.dry_run: print("dry run: nothing written"); return
    self_sha = sha(os.path.abspath(__file__))
    for p in pl["P"]:
        d = f"{OUT}/{p['case_id']}"; mp = d + "/manifest.json"
        if os.path.exists(mp):
            old_m = json.load(open(mp))
            if old_m.get("rule_version") == RULE and old_m.get("plan_key") == plan_key(p): print(p["case_id"], "unchanged: v2 package with the same plan exists, nothing done"); continue
            sup = d + "/" + supersede_name(d, old_m.get("rule_version", "v0")); os.makedirs(sup)
            for nme in ("manifest.json", "meta.json", "media", "tracks"):
                if os.path.exists(f"{d}/{nme}"): shutil.move(f"{d}/{nme}", f"{sup}/{nme}")
            print(p["case_id"], "old package ->", os.path.basename(sup))
        write_package(p, R, W, a.room, os.path.basename(a.bookings), uids.get(p["case_id"]), self_sha)
    dayf = f"{DAYS}/{a.date}-{a.room}.json"; os.makedirs(DAYS, exist_ok=True)
    if os.path.exists(dayf):
        os.makedirs(DAYS + "/_superseded", exist_ok=True); sp = "%s/_superseded/%s.%s.json" % (DAYS, os.path.basename(dayf)[:-5], dt.datetime.now(IST).strftime("%H%M%S"))
        if os.path.exists(sp): fail("superseded day file exists: " + sp)
        shutil.move(dayf, sp); print("old day file ->", sp)
    json.dump(dict(date=a.date, room=a.room, rule_version=RULE, cut_at_ist=dt.datetime.now(IST).isoformat(timespec="seconds"), tape_end_ist=iso(pl["tape_hi"], IST), cases=[p["case_id"] for p in pl["P"]],
                   recorder_state_seen=seen, out_of_case_note="tape between the first segment start and the last segment end that lies in no window", out_of_case=pl["out_of_case"],
                   orphans_note="5-min blocks with density >= 0.3 between the first segment start and the last segment end that are in no window", orphans=pl["orphans"]), open(dayf, "w"), indent=1)
    print("day file:", dayf)
def cmd_check(a):
    bad = 0; found = 0
    for cid in sorted(os.listdir(OUT)):
        mp = f"{OUT}/{cid}/manifest.json"
        if not os.path.exists(mp): continue
        m = json.load(open(mp))
        if m.get("rule_version") != RULE or m.get("ot_room") != a.room or not m["booked_start_ist"].startswith(a.date): continue
        found += 1; d = f"{OUT}/{cid}"; s = m["sources"][0]; exp = (s["byte_offset_end"] - s["byte_offset_start"]) / BPS
        shaok = sha(d + "/media/room_orb2.flac") == m["media_sha256"]; dur = ffdur(d + "/media/room_orb2.flac")
        rows = [json.loads(l) for l in open(d + "/tracks/activity.jsonl")]; tabs = all("t_abs" in r and "t_rel_ms" in r for r in rows); meta = os.path.exists(d + "/meta.json")
        ck = m.get("clock"); frames = flac_frames(d + "/media/room_orb2.flac"); win = utc_ep(m["window_end_utc"]) - utc_ep(m["window_start_utc"])
        if ck: want = win * ck["samples_per_wall_s"]; tol = 2 * math.ceil(win / 3600); ckok = abs(frames - want) <= tol; cks = "clock_frames %d window*sps %.1f diff %.1f tol %d %s" % (frames, want, frames - want, tol, "ok" if ckok else "BAD")
        else: ckok = True; cks = "clock_frames %d clock block absent (pre-v2.3 package, not checked)" % frames
        ok = shaok and abs(dur - exp) <= 0.1 and tabs and meta and ckok
        bad += not ok
        print(cid, "PASS" if ok else "FAIL", "sha256_match", shaok, "flac_s %.2f" % dur, "bytes/32000 %.2f" % exp, "activity_rows", len(rows), "t_abs_all", tabs, "meta.json", meta, cks, "gaps", len(m["gaps"]), "provisional", m["provisional"])
    if not found: fail("no v2 packages for %s %s" % (a.room, a.date))
    sys.exit(1 if bad else 0)
if __name__ == "__main__":
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest="cmd", required=True)
    c = sp.add_parser("cut"); c.add_argument("--date", required=True); c.add_argument("--room", required=True); c.add_argument("--bookings", required=True)
    c.add_argument("--dry-run", action="store_true"); c.add_argument("--idx"); c.add_argument("--workdir", default=os.path.expanduser("~/orbox-lab/o7"))
    c.add_argument("--status-file"); c.add_argument("--cursor-file"); c.add_argument("--trash-dir", default=TRASH_IDX)
    k = sp.add_parser("check"); k.add_argument("--date", required=True); k.add_argument("--room", required=True)
    a = ap.parse_args(); {"cut": cmd_cut, "check": cmd_check}[a.cmd](a)
