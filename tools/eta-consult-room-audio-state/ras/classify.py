"""Device/mute/off classifier (step 1). Pure functions over manifest rows + zero-run features.

States: recorder_off, muted, zero_all_day, audio_present, audio_gated, voice_isolation_gated, withheld (blind room-day, never decoded).
voice_isolation_gated: a chunk on a macOS 26 host whose gated frames (zero_ratio >= 0.95, peak < 0.002) are interleaved with
speech frames (peak >= 0.01) and are the majority of its non-speech frames (macOS Voice Isolation). Uncertain, like audio_gated.
audio_gated is a sub-state of audio_present, flagged by evidence.gated_reason (any of density | gate | zero_frac):
density = it contains zero stretches rejected as gate chatter; gate = the room-day's 7-day gate decision is gated
(rolling_7d only, not insufficient_history) or a stretch that day was gate_active; zero_frac = at least half of the
samples are digital zero (UNVALIDATED line). The mic may really have been muted. Consult minutes on it are
"uncertain", never "usable".
device_missing is NOT emitted from tape alone (rule retired in audio-02); it will come from kiosk-health audio.devices.
Every room-day in a room's span sums to exactly 1440 min (states + recorder_off).
All times are epoch seconds internally.
"""
from bisect import bisect_left, bisect_right
from datetime import datetime, timezone, timedelta

IST = timezone(timedelta(hours=5, minutes=30))
VERSION = "audio-state-7.0"

FULL_MS = 299000          # chunk shorter than this is truncated
GAP_S = 1.0               # inter-chunk gap above this is a real gap
MUTE_S = 10.0             # sustained digital zero => muted (design)
MUTE_S_GATED = 60.0       # rooms whose mic noise-gates to digital zero (see gated_rooms)
GATE_WINDOW_DAYS = 7      # gated-mic decision uses only chunks from the 7 days BEFORE the day classified
GATE_MIN_CHUNKS = 100     # less history than this -> decision "insufficient_history" (treated as gated)
POSSIBLE_DEAD_S = 1800.0  # mute reaching the end of the room-day for >= 30 min carries possible_dead
FLEET_STOP_S = 120.0      # several rooms stopping within +-2 min = fleet-wide stop
FLEET_MIN_OTHERS = 2
RESTART_S = 30.0          # same-session gap under this is a recorder restart, not a session end
SLIVER_S = 1.0            # intervals shorter than this are merged into a neighbour
GATE_ACTIVE_WINDOW_S = 600.0   # a mic that gated in the 10 min BEFORE a zero run is gating now (no 7-day lag)
GATE_ACTIVE_RUNS = 5          # >= this many zero runs (>=1 s) that END before the stretch starts, in that window
MUTE_S_GATE_ACTIVE = 300.0    # mute threshold while gate_active (whole blip-merged stretch)
CHATTER_BLIPS_PER_MIN = 2.0   # UNVALIDATED. gate chatter: > 2 blips/min (1 per 30 s) ...
ZERO_FRAC_GATED = 0.5        # UNVALIDATED: an audio_present interval at least this zero is audio_gated
CHATTER_MIN_BLIPS = 4         # ... with at least 4 blips. Refuter: real OPD 5 gate stretches >= 1 blip/16 s, real mutes ~1 per 5 min
BLIP_S = 1.0              # zero runs separated by a non-zero blip shorter than this are one zero stretch
DEAD_LO_FRAC = 0.999
DEAD_MIN_CHUNKS = 3
VI_MIN_SPEECH_FRAMES = 25     # UNVALIDATED. voice_isolation_gated chunk: >= 0.5 s of speech frames (peak >= 0.01) ...
VI_MIN_GATED_FRAMES = 250     # ... and >= 5 s of gated frames (zero_ratio >= 0.95, peak < 0.002) ...
VI_GATED_SHARE = 0.5          # ... and gated frames are more than this share of the non-speech frames
GATE_RUN_LO, GATE_RUN_HI, GATE_CHUNK_FRAC = 3.0, 10.0, 0.05


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def ist_day(ts):
    return datetime.fromtimestamp(ts, IST).strftime("%Y-%m-%d")


def iso(ts):
    return datetime.fromtimestamp(ts, IST).isoformat(timespec="milliseconds")


def build_chunks(manifest_rows, feats, vi=None):
    """Join manifest rows with features -> sorted list of chunk dicts for ONE room. vi: {chunk id: {"g", "s", "n"}}
    per-second voice-isolation frame counts (optional); a chunk without them has "vi": None."""
    out = []
    for r in manifest_rows:
        f = feats.get(r["id"])
        if f is None or "error" in f:
            continue
        s = parse_ts(r["started_at"])
        dur = f["decoded_ms"] / 1000.0
        out.append({"id": r["id"], "session": r["session_id"], "start": s, "end": s + dur, "dur": dur,
                    "manifest_ms": r["duration_ms"], "lo_frac": f["lo_frac"], "clip_frac": f.get("clip_frac"), "zero_frac": f["zero_frac"],
                    "runs": [(s + a, s + a + l) for a, l in f["runs"]], "vi": (vi or {}).get(r["id"])})
    out.sort(key=lambda c: c["start"])
    return out


def gated_decision(chunks, day_start):
    """Gated-mic decision for the day starting at day_start (epoch), from chunks of the prior 7 days only.

    A mic that gates to digital zero between sounds has many chunks with 3-10 s zero runs amid real audio.
    Never looks at day_start or later, so a day's labels do not change when later chunks arrive."""
    lo = day_start - GATE_WINDOW_DAYS * 86400
    prior = [c for c in chunks if lo <= c["start"] < day_start]
    n = len(prior)
    k = sum(1 for c in prior if c["lo_frac"] < DEAD_LO_FRAC and
            any(GATE_RUN_LO <= b - a < GATE_RUN_HI for a, b in c["runs"]))
    if n < GATE_MIN_CHUNKS:
        return {"gated": True, "decision": "insufficient_history", "window_days": GATE_WINDOW_DAYS,
                "prior_chunks": n, "gate_chunk_frac": round(k / n, 4) if n else None}
    frac = k / n
    return {"gated": frac >= GATE_CHUNK_FRAC, "decision": "rolling_7d", "window_days": GATE_WINDOW_DAYS,
            "prior_chunks": n, "gate_chunk_frac": round(frac, 4)}


def vi_totals(c):
    """(gated, speech, frames) frame counts of a chunk, or None when it has no voice-isolation counts."""
    v = c.get("vi")
    if not v:
        return None
    return sum(v["g"]), sum(v["s"]), sum(v["n"])


def vi_chunk(c):
    """The voice-isolation signature on one chunk: gated frames (zero_ratio >= 0.95, peak < 0.002) interleaved with
    speech frames (peak >= 0.01), gated frames the majority of the non-speech frames. Pure zero-fill (no speech), a normal
    room floor (no gated frames) and silence of any other kind do not match. -> evidence dict or None."""
    t = vi_totals(c)
    if t is None:
        return None
    g, sp, n = t
    nonspeech = n - sp
    if sp < VI_MIN_SPEECH_FRAMES or g < VI_MIN_GATED_FRAMES or nonspeech <= 0 or g / nonspeech <= VI_GATED_SHARE:
        return None
    return {"gated_s": round(g / 50.0, 1), "speech_s": round(sp / 50.0, 1), "gated_share_of_nonspeech": round(g / nonspeech, 3)}


def day_start_ts(d):
    return datetime.fromisoformat(d).replace(tzinfo=IST).timestamp()


def _merge_runs(chunks):
    """Zero stretches for the mute rules.
    Pieces = zero runs joined across contiguous chunk boundaries. Pieces separated by a non-zero blip shorter than
    BLIP_S (in a chunk, or a 0.1-1 s chunk-boundary gap) are ONE stretch: [a, b, [chunk idx], last idx, n_pieces].
    Also returns the raw pieces (a, b) used to measure gating activity."""
    pieces = []
    for i, c in enumerate(chunks):
        for a, b in c["runs"]:
            if pieces and a - pieces[-1][1] <= 0.1 and pieces[-1][3] != i and \
                    c["start"] - chunks[pieces[-1][3]]["end"] <= GAP_S:
                pieces[-1][1] = b
                pieces[-1][2].append(i)
                pieces[-1][3] = i
            else:
                pieces.append([a, b, [i], i])
    stretches = []
    for p in pieces:
        if stretches and p[0] - stretches[-1][1] < BLIP_S:
            st = stretches[-1]
            st[1] = p[1]
            st[2] = sorted(set(st[2]) | set(p[2]))
            st[3] = p[3]
            st[4] += 1
            st[5] = max(st[5], p[1] - p[0])
        else:
            stretches.append([p[0], p[1], list(p[2]), p[3], 1, p[1] - p[0]])
    return stretches, [(p[0], p[1]) for p in pieces]


def classify_room(chunks, snapshot_end=None, first_day=None, last_day=None, blind_days=(), cutoff=None, vi_enabled=False):
    """chunks: build_chunks() output for one room (non-blind days only). Returns intervals (epoch) covering every
    IST day from first_day (default: first chunk day) to last_day (default: last chunk day), 1440 min each.
    cutoff: end of the room's last chunk; time after it is recorder_off with after_snapshot=true.
    blind_days: IST days emitted as a single `withheld` interval (no features).
    vi_enabled: the room's host runs macOS 26 (ras.hosts); only then can a chunk be voice_isolation_gated."""
    if not chunks and not blind_days:
        return []
    days = {}
    for c in chunks:
        days.setdefault(ist_day(c["start"]), []).append(c)
    gate = {}
    for d in days:
        gate[d] = gated_decision(chunks, day_start_ts(d))
    dead_days = {d for d, cs in days.items()
                 if len(cs) >= DEAD_MIN_CHUNKS and all(c["lo_frac"] >= DEAD_LO_FRAC for c in cs)}

    vi_flag = {i: vi_chunk(c) for i, c in enumerate(chunks)} if vi_enabled else {}
    segs = []  # (a, b, state, chunk idx list, extra evidence)

    def add(a, b, state, idxs, **ev):
        if b - a > 1e-6:
            segs.append((a, b, state, sorted(set(idxs)), ev))

    long_runs = []
    chatter = []   # (a, b, blips_per_min) stretches rejected as gate chatter
    active_days = set()   # IST days with a gate_active stretch
    stretches, pieces = _merge_runs(chunks)
    ends = [x[1] for x in pieces]   # pieces are disjoint and time-ordered
    for a, b, idxs, _, n_pieces, _longest in stretches:
        d = ist_day(a)
        if d in dead_days or b - a < MUTE_S:
            continue
        thr = MUTE_S_GATED if gate[d]["gated"] else MUTE_S
        # gate_active: only zero runs that END BEFORE this stretch starts (a stretch never flags itself)
        n_recent = bisect_left(ends, a) - bisect_left(ends, a - GATE_ACTIVE_WINDOW_S)
        active = n_recent >= GATE_ACTIVE_RUNS
        if active:
            active_days.add(d)
        if active:
            thr = max(thr, MUTE_S_GATE_ACTIVE)
        if b - a < thr:
            continue
        blips = n_pieces - 1
        if blips >= CHATTER_MIN_BLIPS and blips / ((b - a) / 60.0) > CHATTER_BLIPS_PER_MIN:
            chatter.append((a, b, blips / ((b - a) / 60.0)))
            continue      # gate chatter: many blips per minute, not a mute
        last_end = days[d][-1]["end"]
        pd = (b >= last_end - 0.5) and (b - a) >= POSSIBLE_DEAD_S
        long_runs.append((a, b, idxs, thr, pd, d, active))

    for i, c in enumerate(chunks):
        d = ist_day(c["start"])
        g = gate[d]
        if d in dead_days:
            add(c["start"], c["end"], "zero_all_day", [i], gate=g)
            continue
        pos = c["start"]
        present = "voice_isolation_gated" if vi_flag.get(i) else "audio_present"
        for a, b, idxs, thr, pd, rd, act in long_runs:
            if i not in idxs:
                continue
            a0, b0 = max(a, c["start"]), min(b, c["end"])
            if a0 > pos:
                add(pos, a0, present, [i], gate=g)
            add(a0, b0, "muted", [i], run_s=b - a, gate=gate[rd], mute_threshold_s=thr, possible_dead=pd, gate_active=act)
            pos = max(pos, b0)
        if pos < c["end"]:
            add(pos, c["end"], present, [i], gate=g)
    all_days = sorted(set(days) | set(blind_days))
    fd = first_day or all_days[0]
    ld = last_day or all_days[-1]
    lo = day_start_ts(fd)
    hi = day_start_ts(ld) + 86400
    # blind room-days: one withheld interval, nothing else may overlap it
    withheld = [(day_start_ts(d), day_start_ts(d) + 86400) for d in sorted(set(blind_days)) if fd <= d <= ld]
    segs = [x for x in _subtract(segs, withheld)]
    for a, b in withheld:
        segs.append((a, b, "withheld", [], {"reason": "blind_holdout"}))
    if cutoff is None:
        cutoff = chunks[-1]["end"] if chunks else lo
    segs = _cover(segs, chunks, lo, hi, cutoff)
    return _finalise(chunks, segs, chatter, active_days)


def _subtract(segs, cuts):
    for a, b, st, idxs, ev in segs:
        parts = [(a, b)]
        for x, y in cuts:
            nxt = []
            for p, q in parts:
                if q <= x or p >= y:
                    nxt.append((p, q))
                else:
                    if p < x:
                        nxt.append((p, x))
                    if q > y:
                        nxt.append((y, q))
            parts = nxt
        for p, q in parts:
            yield (p, q, st, idxs, ev)


def _cover(segs, chunks, lo, hi, cutoff):
    """Make segs tile [lo, hi) exactly: clip overlaps, absorb holes <= GAP_S, fill the rest with recorder_off."""
    segs = sorted(segs, key=lambda s: s[0])
    out = []
    pos = lo
    for a, b, st, idxs, ev in segs:
        if b <= pos:
            continue
        a = max(a, pos)
        if a - pos > GAP_S:
            _off(out, pos, a, chunks, cutoff)
        elif a > pos and out:
            p = out[-1]
            out[-1] = (p[0], a, p[2], p[3], p[4])
        elif a > pos:
            a = pos
        out.append((a, b, st, idxs, ev))
        pos = b
    if hi - pos > GAP_S:
        _off(out, pos, hi, chunks, cutoff)
    elif out and hi > pos:
        p = out[-1]
        out[-1] = (p[0], hi, p[2], p[3], p[4])
    return out


def _off(out, a, b, chunks, cutoff):
    """recorder_off for the hole [a, b). Only the part from `cutoff` (the data edge minus pull lag, or the room's
    last chunk end if later) is unobserved (after_snapshot). Dark time before it is plain recorder_off.
    A same-session gap under RESTART_S is tagged restart (never a session end)."""
    prev = next((c for c in chunks if abs(c["end"] - a) <= GAP_S), None)
    nxt = next((c for c in chunks if abs(c["start"] - b) <= GAP_S), None)
    idx = [chunks.index(c) for c in (prev, nxt) if c]
    edge = cutoff - GAP_S
    if a >= edge:
        pieces = [(a, b, True)]
    elif b > edge + GAP_S:
        pieces = [(a, cutoff, False), (cutoff, b, True)]
    else:
        pieces = [(a, b, False)]
    for x, y, after in pieces:
        ev = {"gap_ms": round((b - a) * 1000)}
        if after:
            ev["after_snapshot"] = True
            ev["room_last_chunk_end"] = iso(chunks[-1]["end"]) if chunks else None
        elif prev and nxt and prev["session"] == nxt["session"] and (b - a) < RESTART_S:
            ev["restart"] = True
        out.append((x, y, "recorder_off", idx, ev))


def _split_days(segs):
    """Split tiled segs at IST midnight -> {day: [[a, b, state, idxs, ev], ...]}"""
    bydays = {}
    for a, b, st, idxs, ev in sorted(segs, key=lambda s: s[0]):
        cur = a
        while cur < b - 1e-9:
            d = ist_day(cur + 1e-6)
            e = min(b, day_start_ts(d) + 86400)
            bydays.setdefault(d, []).append([cur, e, st, list(idxs), dict(ev)])
            cur = e
    return bydays


def _absorb_slivers(L):
    """Merge every non-withheld interval shorter than SLIVER_S into its neighbour (previous, else next)."""
    while True:
        k = next((k for k, x in enumerate(L) if x[1] - x[0] < SLIVER_S and x[2] != "withheld" and len(L) > 1), None)
        if k is None:
            return L
        x = L.pop(k)
        if k > 0:
            p = L[k - 1]
            p[1] = x[1]
            p[3] = sorted(set(p[3]) | set(x[3]))
        else:
            n = L[0]
            n[0] = x[0]
            n[3] = sorted(set(n[3]) | set(x[3]))


def _merge_same(L):
    out = []
    for x in L:
        if out and out[-1][2] == x[2] and x[0] - out[-1][1] < 1e-3 and x[2] in ("audio_present", "zero_all_day", "muted", "voice_isolation_gated"):
            m = out[-1]
            m[1] = x[1]
            m[3] = sorted(set(m[3]) | set(x[3]))
            pdd = bool(m[4].get("possible_dead")) or bool(x[4].get("possible_dead"))
            rs = max(m[4].get("run_s", 0), x[4].get("run_s", 0))
            m[4] = {**m[4], **x[4]}
            if x[2] == "muted":
                m[4]["possible_dead"], m[4]["run_s"] = pdd, rs
        else:
            out.append(x)
    return out


def _finalise(chunks, segs, chatter=(), active_days=()):
    """Per IST day: absorb slivers, merge same-state neighbours, attach evidence."""
    out = []
    for d, L in sorted(_split_days(segs).items()):
        L = _merge_same(_absorb_slivers(L))
        L = _merge_same(_absorb_slivers(L))
        out += [_mk(chunks, a, b, st, idxs, ev, d, chatter, active_days) for a, b, st, idxs, ev in L]
    return out


def annotate_session_end(per_room):
    """per_room: {room: (chunks, intervals)}. Tag recorder_off intervals that start at a chunk end with
    evidence.session_end = how many OTHER rooms stopped within +-2 min (fleet-wide stop if >= 2)."""
    stops = {}
    for room, (chunks, ivs) in per_room.items():
        stops[room] = [c["end"] for c in chunks]
    for room, (chunks, ivs) in per_room.items():
        ends = stops[room]
        for iv in ivs:
            if iv["state"] != "recorder_off" or iv["evidence"].get("after_snapshot") or iv["evidence"].get("restart"):
                continue
            if not any(abs(e - iv["_a"]) <= 0.5 for e in ends):
                continue
            n = 0
            for other, (oc, oiv) in per_room.items():
                if other == room:
                    continue
                if any(o["state"] == "recorder_off" and not o["evidence"].get("after_snapshot") and
                       not o["evidence"].get("restart") and abs(o["_a"] - iv["_a"]) <= FLEET_STOP_S and
                       any(abs(e - o["_a"]) <= 0.5 for e in stops[other]) for o in oiv):
                    n += 1
            iv["evidence"]["session_end"] = {"stop_ts": iv["ts_start"], "other_rooms_stopping_within_2min": n,
                                             "fleet_wide": n >= FLEET_MIN_OTHERS}


def _mk(chunks, a, b, st, idxs, ev, day, chatter=(), active_days=()):
    cs = [chunks[i] for i in idxs if chunks[i]["end"] > a and chunks[i]["start"] < b] or [chunks[i] for i in idxs]
    if st in ("muted", "zero_all_day"):
        zf = 1.0 if st == "muted" else sum(c["lo_frac"] * c["dur"] for c in cs) / max(1e-9, sum(c["dur"] for c in cs))
    elif st == "recorder_off":
        zf = None
    else:
        tot = sum(c["dur"] for c in cs)
        zf = sum(c["lo_frac"] * c["dur"] for c in cs) / tot if tot else None
    runs = [min(y, b) - max(x, a) for c in cs for x, y in c["runs"] if y > a and x < b]
    mz = max(runs, default=0.0)
    if st == "muted":
        mz = ev.get("run_s", mz)
    evidence = {"zero_frac": None if zf is None else round(zf, 4), "max_zero_run_s": round(mz, 2),
                "gap_ms": ev.get("gap_ms"), "segment": sorted({c["session"] for c in cs}),
                "chunk_ids": [c["id"] for c in cs]}
    if st == "withheld":
        return {"ist_day": day, "state": st, "ts_start": iso(a), "ts_end": iso(b), "_a": a, "_b": b,
                "evidence": {"reason": ev.get("reason", "blind_holdout")}}
    for k in ("mute_threshold_s", "after_snapshot", "restart", "room_last_chunk_end"):
        if k in ev:
            evidence[k] = ev[k]
    if "gate" in ev:
        evidence["gated"] = ev["gate"]["gated"]
        evidence["gate_decision"] = ev["gate"]
    if st == "muted":
        evidence["possible_dead"] = bool(ev.get("possible_dead"))
        evidence["gate_active"] = bool(ev.get("gate_active"))
    if st in ("audio_present", "voice_isolation_gated"):
        tot = sum(c["dur"] for c in cs if c.get("clip_frac") is not None)
        evidence["clipping_frac"] = None if not tot else round(
            sum(c["clip_frac"] * c["dur"] for c in cs if c.get("clip_frac") is not None) / tot, 5)
    if st == "voice_isolation_gated":
        t = [vi_totals(c) or (0, 0, 0) for c in cs]
        g, sp, n = (sum(x[k] for x in t) for k in range(3))
        evidence.update({"gated_reason": ["voice_isolation"], "vi_gated_s": round(g / 50.0, 1), "vi_speech_s": round(sp / 50.0, 1),
                         "vi_gated_share_of_nonspeech": round(g / (n - sp), 3) if n > sp else None, "vi_chunks": len(cs)})
    if st == "audio_present":
        hit = [(max(x, a), min(y, b), r) for x, y, r in chatter if y > a and x < b]
        gd = evidence.get("gate_decision") or {}
        reasons = []
        if hit:
            reasons.append("density")
        if (gd.get("decision") == "rolling_7d" and gd.get("gated")) or day in active_days:
            reasons.append("gate")
        if evidence["zero_frac"] is not None and evidence["zero_frac"] >= ZERO_FRAC_GATED:
            reasons.append("zero_frac")
        if reasons:
            st = "audio_gated"
            evidence["gated_reason"] = reasons
            evidence["chatter_seconds"] = round(sum(y - x for x, y, _ in hit), 1)
            evidence["n_stretches"] = len(hit)
            evidence["peak_blips_per_min"] = round(max((r for _, _, r in hit), default=0.0), 2)
            evidence["zero_fraction"] = evidence["zero_frac"]
    return {"ist_day": day, "state": st, "ts_start": iso(a), "ts_end": iso(b), "_a": a, "_b": b, "evidence": evidence}
