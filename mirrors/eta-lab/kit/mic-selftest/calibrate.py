"""calibrate.py: derive the 'no background noise' threshold from real tape and (only when asked) pre-register it (ruling 369 item 1). Stdlib only.

  python3 calibrate.py stretches.json [--out calibration.json] [--preregister]

stretches.json = {"source": "where the tape came from", "clinic_hours_ist": ["08:00", "20:00"] (optional), "manifest_jsonl": "lab-mover's manifest.jsonl" (for the chunk-rate gate),
                  "stretches": [ one of the two forms below, plus "label", "room", "note" ]}
  {"file": "/path/tape.pcm", "from_s": 0, "to_s": 2100}                  raw headerless 16 kHz mono int16 (tape.pcm), or
  {"stats_jsonl": "stats.jsonl", "room_id": "room_x", "from_iso": "2026-09-25T03:30:00Z", "to_iso": "2026-09-25T04:05:00Z"}   tape_stats.py output (numbers only)
Labels:
  empty        a stretch where the room was empty AND the mic healthy (e.g. OPD 4 09:00-09:35 IST on 25 Sep): what 'no background noise' looks like.
  quiet        people in the room but nobody speaking (occupied-quiet): must NOT read as dead.
  used         people in the room talking (a consult in progress): must NOT read as dead.
  unlabelled   occupancy not known: reported (how often the rule would fire there), never used to set or check the threshold.
Calibrate on TAPE (tape samples, or chunks decoded from them), never the level log: it is a duty-cycled 1.25 s RMS window and read 0 while a chime played.
The rule, fixed here before any live run. THREE gates must all pass before a sound may play in clinic hours (mic_selftest.run); calibrate.py sets the first two thresholds and the third's limit:
  1 LEVEL   1 s frame RMS -> sliding windows of dead_window_s (120 s, step 10 s) -> window level = its dead_quantile (0.90) of frame RMS;
            dead_rms_max = 1.10 x the MEDIAN window level over the 'empty' stretches (the room's typical level, not its noisiest window: eta-refuter #2227 item 4);
            speech_rms = 1.10 x the highest single-frame RMS in any 'empty' stretch (no speech-level second in the last 5 min).
  2 CHUNK   the recorded chunks' rate (bytes/s, full 5-min chunks only): chunk_rate_max_bps = 1.10 x the highest rate of any chunk starting inside an 'empty' stretch; the last two full
            chunks must both be at or under it. Reads the manifest, not the room Mac (eta-refuter #2227 item 3: today OPD 4 empty ran 892-1449 B/s, every occupied room >= 3500).
  Refuse to write unless neither gate passes more than 2% of the windows / steps in any 'quiet' or 'used' stretch (a gate that fires in occupied rooms is not a gate).
  Only a 'proposed' file can be written without an occupied ground-truth stretch (with a warning); --preregister needs at least one, and the manifest.
  Reported per stretch (stats stretches): dead_trigger_rate (level gate), chunk_gate_rate, combined_rate (level AND no speech in the last 5 min AND chunk gate: what actually permits a sound).
Reported per stretch: dead_trigger_rate = the share of windows that would read as dead: how often the rule fires there. An empty closed room and a dead mic look the same in level
terms, so the rule may fire on empty rooms; that is acceptable only because the chirp then decides.
Output status is 'proposed' unless --preregister is given: load_calibration() refuses a proposal. Committing a 'preregistered' file BEFORE any live run is the pre-registration.
"""
import argparse, datetime, json, math, os, statistics, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mic_selftest as M

DEAD_WINDOW_S = 120
DEAD_QUANTILE = 0.90
WINDOW_STEP_S = 10
DEAD_MARGIN = 1.10
SPEECH_MARGIN = 1.10
CHUNK_MARGIN = 1.10
MAX_OCCUPIED_TRIGGER = 0.02
LABELS = ("empty", "quiet", "used", "unlabelled")


def frame_rms(pcm):
    x = M.pcm_to_floats(pcm)
    return [M._rms(x[i:i + M.SR]) for i in range(0, len(x) - M.SR + 1, M.SR)]


def pct(v, q):
    s = sorted(v)
    if not s:
        return None
    k = min(len(s) - 1, max(0, int(math.ceil(q / 100.0 * len(s))) - 1))
    return s[k]


def read_stretch(st):
    with open(st["file"], "rb") as f:
        data = f.read()
    a = int(st.get("from_s", 0) * M.SR) * 2
    b = int(st["to_s"] * M.SR) * 2 if "to_s" in st else len(data)
    return data[a:b]


def _epoch(iso):
    return datetime.datetime.strptime(iso.replace("Z", "+0000"), "%Y-%m-%dT%H:%M:%S%z").timestamp()


def read_stats_series(st):
    """1 s RMS series from tape_stats.py output for one room and time range (UTC ISO). Numbers only."""
    lo, hi = _epoch(st["from_iso"]), _epoch(st["to_iso"])
    pts = []
    with open(st["stats_jsonl"]) as f:
        for line in f:
            r = json.loads(line)
            if r.get("room_id") != st["room_id"] or "rms" not in r:
                continue
            t0 = _epoch(r["started_at"].split(".")[0].rstrip("Z") + "Z")
            for i, v in enumerate(r["rms"]):
                if lo <= t0 + i < hi:
                    pts.append((t0 + i, v))
    pts.sort()
    return [v for _, v in pts]


def read_stats_points(st):
    """[(epoch, rms)] for the same selection (needed for the combined gate, which is a function of time)."""
    lo, hi = _epoch(st["from_iso"]), _epoch(st["to_iso"])
    pts = []
    with open(st["stats_jsonl"]) as f:
        for line in f:
            r = json.loads(line)
            if r.get("room_id") != st["room_id"] or "rms" not in r:
                continue
            t0 = _epoch(r["started_at"].split(".")[0].rstrip("Z") + "Z")
            for i, v in enumerate(r["rms"]):
                if lo <= t0 + i < hi:
                    pts.append((t0 + i, v))
    pts.sort()
    return pts


def stretch_rms(st, reader=read_stretch):
    return read_stats_series(st) if "stats_jsonl" in st else frame_rms(reader(st))


def load_chunks(manifest_path, room_id):
    """Full chunks of one room from lab-mover's manifest, in time order: [{start, end, size_bytes, duration_ms, rate}]."""
    out = []
    with open(manifest_path) as f:
        for line in f:
            if not line.strip():
                continue
            r = json.loads(line)
            if r.get("room_id") != room_id or r.get("duration_ms", 0) < M.CHUNK_FULL_MS:
                continue
            t0 = _epoch(r["started_at"].split(".")[0].rstrip("Z") + "Z")
            out.append(dict(start=t0, end=t0 + r["duration_ms"] / 1000.0, ended_at=t0 + r["duration_ms"] / 1000.0, size_bytes=r["size_bytes"], duration_ms=r["duration_ms"],
                            rate=r["size_bytes"] * 1000.0 / r["duration_ms"], idx=r.get("idx"), session_id=r.get("session_id")))
    out.sort(key=lambda c: c["start"])
    return out


def chunk_gate_at(chunks, t, limit):
    """The chunk gate as it would read at time t (the whole gate: current session, consecutive idx, fresh): the room-state list would hold the chunks of the newest session
    that had ENDED at or before t, so that is what it is fed."""
    done = [c for c in chunks if c["end"] <= t]
    if not done:
        return False
    session = done[-1]["session_id"]
    recent = [c for c in done if c["session_id"] == session][-6:]
    return M.chunk_gate(recent, limit, session, t)[0]


def combined_rates(points, chunks, dead, speech, limit, step=WINDOW_STEP_S):
    """Shares of time steps (every step s) at which: the level gate passes (last 120 s p90 <= dead), the chunk gate passes, and ALL of level + no speech-level second in the last
    5 min + chunk gate pass. Only steps with a full 120 s of level history count. None if there are none."""
    if len(points) < DEAD_WINDOW_S:
        return None
    n = lvl = chk = allg = 0
    for i in range(DEAD_WINDOW_S - 1, len(points), step):
        t = points[i][0]
        win = [v for _, v in points[i - DEAD_WINDOW_S + 1:i + 1]]
        look = [v for tt, v in points[max(0, i - 299):i + 1]]
        a = M.window_level(win, DEAD_QUANTILE) <= dead
        c = chunk_gate_at(chunks, t, limit) if limit is not None else False
        b = max(look) < speech
        n += 1
        lvl += a
        chk += c
        allg += (a and b and c)
    return dict(level_gate_rate=round(lvl / n, 4), chunk_gate_rate=round(chk / n, 4), combined_rate=round(allg / n, 4), steps=n)


def stats(rms):
    return dict(seconds=len(rms), min=min(rms), p01=pct(rms, 1), p05=pct(rms, 5), p50=pct(rms, 50), p95=pct(rms, 95), p999=pct(rms, 99.9), max=max(rms))


def window_levels(rms, window_s=DEAD_WINDOW_S, quantile=DEAD_QUANTILE, step=WINDOW_STEP_S):
    """The quantile level of every sliding window (empty list if the stretch is shorter than a window)."""
    return [M.window_level(rms[a:a + window_s], quantile) for a in range(0, len(rms) - window_s + 1, step)]


def trigger_rate(rms, dead_rms_max, window_s=DEAD_WINDOW_S, quantile=DEAD_QUANTILE, step=WINDOW_STEP_S):
    """Share of sliding windows whose quantile level is <= dead_rms_max, i.e. how often the dead rule would fire. None if the stretch is shorter than a window."""
    lv = window_levels(rms, window_s, quantile, step)
    if not lv:
        return None
    return round(sum(1 for v in lv if v <= dead_rms_max) / len(lv), 4)


def calibrate(spec, now=None, reader=read_stretch, status="proposed"):
    groups = {k: [] for k in LABELS}
    rows, series, sts = [], [], []
    for st in spec["stretches"]:
        if st.get("label") not in LABELS:
            raise ValueError(f"stretch label must be one of {LABELS}: {st.get('label')!r}")
        rms = stretch_rms(st, reader)
        if not rms:
            raise ValueError(f"stretch has no full second of tape: {st.get('file') or st.get('room_id')}")
        groups[st["label"]].append(rms)
        src = os.path.basename(st["file"]) if "file" in st else f"{st['room_id']} {st['from_iso']}..{st['to_iso']}"
        rows.append(dict(source=src, label=st["label"], room=st.get("room"), note=st.get("note"), **{k: round(v, 6) for k, v in stats(rms).items() if k != "seconds"}, seconds=len(rms)))
        series.append(rms)
        sts.append(st)
    if not groups["empty"]:
        raise ValueError("need at least one 'empty' stretch")
    occupied = bool(groups["used"] or groups["quiet"])
    manifest = spec.get("manifest_jsonl")
    if status == "preregistered" and not occupied:
        raise ValueError("cannot pre-register without an occupied ('quiet' or 'used') ground-truth stretch: the separation is unchecked")
    if status == "preregistered" and not manifest:
        raise ValueError("cannot pre-register without manifest_jsonl: the chunk-rate gate has no calibration")
    empty_levels = [v for r in groups["empty"] for v in window_levels(r)]
    if not empty_levels:
        raise ValueError(f"every 'empty' stretch is shorter than the {DEAD_WINDOW_S} s window")
    dead = DEAD_MARGIN * statistics.median(empty_levels)
    chunk_limit, chunks_by_room = None, {}
    if manifest:
        empty_rates = []
        for st, row in zip(sts, rows):
            if row["label"] == "empty" and "stats_jsonl" in st:
                chunks_by_room.setdefault(st["room_id"], load_chunks(manifest, st["room_id"]))
                lo, hi = _epoch(st["from_iso"]), _epoch(st["to_iso"])
                empty_rates += [c["rate"] for c in chunks_by_room[st["room_id"]] if lo <= c["start"] < hi]
        if not empty_rates:
            raise ValueError("no full chunk starts inside an 'empty' stretch: the chunk-rate limit has no basis")
        chunk_limit = CHUNK_MARGIN * max(empty_rates)
    speech = SPEECH_MARGIN * max(max(r) for r in groups["empty"])
    for label in ("quiet", "used"):
        for r in groups[label]:
            rate = trigger_rate(r, dead)
            if rate is not None and rate > MAX_OCCUPIED_TRIGGER:
                raise ValueError(f"no separation: the dead threshold {dead:.5f} would fire in {rate:.1%} of the windows of an occupied ('{label}') stretch (limit {MAX_OCCUPIED_TRIGGER:.0%})")
    for st, row, rms in zip(sts, rows, series):
        row["dead_trigger_rate"] = trigger_rate(rms, dead)
        if manifest and "stats_jsonl" in st:
            chunks_by_room.setdefault(st["room_id"], load_chunks(manifest, st["room_id"]))
            comb = combined_rates(read_stats_points(st), chunks_by_room[st["room_id"]], dead, speech, chunk_limit)
            if comb:
                row.update(chunk_gate_rate=comb["chunk_gate_rate"], combined_rate=comb["combined_rate"], combined_steps=comb["steps"])
            if row["label"] in ("quiet", "used") and comb and (comb["chunk_gate_rate"] > MAX_OCCUPIED_TRIGGER):
                raise ValueError(f"no separation: the chunk-rate limit {chunk_limit:.0f} B/s would pass in {comb['chunk_gate_rate']:.1%} of the steps of an occupied ('{row['label']}') stretch "
                                 f"(limit {MAX_OCCUPIED_TRIGGER:.0%})")
    if speech <= dead:
        speech = dead * 1.01
    warnings = [] if occupied else ["no occupied ('quiet' or 'used') ground-truth stretch: the thresholds are unchecked against people in the room"]
    if not manifest:
        warnings.append("no manifest_jsonl: chunk_rate_max_bps is None and load_calibration refuses this file")
    cal = dict(status=status, preregistered_at=(now or datetime.datetime.now(datetime.timezone.utc)).isoformat(timespec="seconds"),
               dead_rms_max=round(dead, 6), dead_window_s=DEAD_WINDOW_S, dead_quantile=DEAD_QUANTILE, speech_rms=round(speech, 6),
               chunk_rate_max_bps=(round(chunk_limit, 1) if chunk_limit is not None else None), chunk_gate_n=M.CHUNK_GATE_N,
               dead_margin=DEAD_MARGIN, speech_margin=SPEECH_MARGIN, chunk_margin=CHUNK_MARGIN, source=spec.get("source", ""), stretches=rows,
               rule="dead_rms_max = 1.10 x MEDIAN window p90 (120 s) over 'empty'; speech_rms = 1.10 x max frame over 'empty'; chunk_rate_max_bps = 1.10 x max rate of empty chunks; "
                    "each passes in <= 2% of 'quiet'/'used' windows/steps; gates ANDed at run time")
    if warnings:
        cal["warnings"] = warnings
    if spec.get("clinic_hours_ist"):
        cal["clinic_hours_ist"] = spec["clinic_hours_ist"]
    return cal


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("spec")
    ap.add_argument("--out", default=M.DEFAULT_CAL)
    ap.add_argument("--preregister", action="store_true", help="write status 'preregistered' (a plain run writes 'proposed', which load_calibration refuses)")
    a = ap.parse_args(argv)
    with open(a.spec) as f:
        spec = json.load(f)
    try:
        cal = calibrate(spec, status="preregistered" if a.preregister else "proposed")
    except ValueError as e:
        print("not written:", e, file=sys.stderr)
        return 1
    with open(a.out, "w") as f:
        json.dump(cal, f, indent=1)
    print(json.dumps({k: cal[k] for k in ("status", "dead_rms_max", "dead_window_s", "dead_quantile", "speech_rms", "chunk_rate_max_bps", "preregistered_at")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
