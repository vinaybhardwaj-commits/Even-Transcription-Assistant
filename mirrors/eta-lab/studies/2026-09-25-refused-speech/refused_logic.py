"""refused_logic.py: the PURE logic of the ruling-333 measurement (english_hallucination_guard over-refusal): population, stratified draw, controls, chunk timeline,
span arithmetic and the pre-registered decision rule. No audio, no numpy, no text: everything here is ids, counts and seconds. Tests: test_refused_logic.py.

QUESTION (Fable ruling 333): of the windows whose EVERY segment the router's english_hallucination_guard refused (text not stored), how many hold speech?
This bounds how much refusal hit real speech. It does NOT say the refused text was correct.

POPULATION (frozen here, before any window is measured). A window is in the population if its raw run record on this box (hist/runs, hist/out, lab-vault/staged/runs,
under ~/eta-data) has >= 1 segment and EVERY segment has refused == true. One record per window_id: when a window has several such files the lexicographically LAST path
is used (14 windows had more than one). Windows in the exact-zero NO_SIGNAL lists (hist/exact_zero_windows_tierA/B.json) or with vault-index status no_signal are EXCLUDED
from the draw (dead-mic tape, ruling 255/280); at freeze time none of the all-refused windows was in those lists (0 of 603).

STRATA. Room only. The language stratum is degenerate: every segment of every all-refused record is labelled `en` (refuted-text is not stored, so no other language label
exists), so "room x language" collapses to room; that is itself reported.
ALLOCATION of the 30 draws: proportional to distinct windows per room, largest-remainder rounding (ties: the lexicographically smaller room id first), then every room with
>= MIN_ROOM_WINDOWS (15) windows is raised to at least 1 (taking from the room with the largest allocation, ties: larger room id last), rooms below the threshold get 0.
SELECTION inside a room: window ids sorted; partial Fisher-Yates driven by random.Random(SEED).random() (same on every Python 3 version); the chosen ids are then sorted.
No re-draws: the draw file is written once (O_EXCL) and never replaced.

CONTROLS run through the SAME measurement (ruling 333 / eta-refuter): N_ACCEPT windows the guard ACCEPTED with real text (vault index status `text`, n_words >= 100), drawn
with SEED+1 from the sorted ids, measured over their ACCEPTED segments' spans; N_SILENT windows with vault-index status no_signal (exact-zero tape), drawn with SEED+2,
measured over the whole 900 s window (they have no segments). Separation criterion (D1b speech fraction): accepted controls median >= 0.50 AND silent controls max <= 0.02. If it
fails, the 30-window counts must not be read.

MEASURED SPAN. Per window, the UNION of its refused segments' [start_s, end_s] (segments overlap by ~1 s; overlap is counted once), clipped to the window's 0..900 s and to
covered audio. Segment times are seconds from the window start (the cut starts at the window start). The controls verify that mapping: if it were wrong the accepted controls
would not separate.

DETECTORS (16 kHz mono; parameters frozen): D1a webrtcvad mode 2, D1b webrtcvad mode 3, both 30 ms frames; D2 silero-vad 6.2.3 get_speech_timestamps (threshold 0.5, its
defaults otherwise), the router's OWN detector, reported for comparison only (segments are VAD-sliced upstream, so D2 finding speech is close to circular); D3 energy: 30 ms frame RMS in
dBFS, floor = 20th percentile of frame RMS over the whole window, speech frame if RMS >= floor + 12 dB (a plain level test: steady hum reads as speech here, so D3 is a
baseline only). PRIMARY = D1b. DECISION per window (primary): SPEECH PRESENT if D1b speech seconds inside the measured span >= SPEECH_MIN_S (5.0) and the speech fraction >=
SPEECH_MIN_FRAC (0.10); else NO SPEECH DETECTED. The continuous numbers are reported for every detector so any other threshold can be read from them.
"""
import hashlib, json, os, random
from datetime import datetime, timezone

HOME = os.path.expanduser("~/eta-data")
ROOTS = ("hist/runs", "hist/out", "lab-vault/staged/runs")
AUDIO_DIR = os.path.join(HOME, "hist-mining", "audio")
VIEW_INDEX = os.path.join(HOME, "lab-vault", "staged", "index", "view-202609250657.jsonl")
EXACT_ZERO = ("hist/exact_zero_windows_tierA.json", "hist/exact_zero_windows_tierB.json")

SEED = 20260925
N_DRAW, N_ACCEPT, N_SILENT = 30, 10, 5
MIN_ROOM_WINDOWS = 15
ACCEPT_MIN_WORDS = 100
WINDOW_S = 900.0
SPEECH_MIN_S, SPEECH_MIN_FRAC = 5.0, 0.10
ACCEPT_SEP_MEDIAN, SILENT_SEP_MAX = 0.50, 0.02


def read_json(path):
    with open(path) as f:
        return json.load(f)


def read_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def all_refused(rec):
    segs = rec.get("segments")
    return bool(segs) and all(s.get("refused") is True for s in segs)


def scan_records(home=HOME, roots=ROOTS):
    """{window_id: [paths]} over every readable run record that has segments and a window_id (paths relative to home, sorted)."""
    out = {}
    for r in roots:
        for dp, _dn, fn in os.walk(os.path.join(home, r)):
            for f in fn:
                if not f.endswith(".json"):
                    continue
                p = os.path.join(dp, f)
                try:
                    d = read_json(p)
                except (OSError, ValueError):
                    continue
                if isinstance(d, dict) and "segments" in d and "window_id" in d:
                    out.setdefault(d["window_id"], []).append(os.path.relpath(p, home))
    return {k: sorted(v) for k, v in out.items()}


def population(home=HOME, view_index=None):
    """Returns dict(windows={window_id: {'path','room','n_segments','n_files'}}, counts=...). All-refused windows only; NO_SIGNAL excluded and counted."""
    recs = scan_records(home)
    nosignal = set()
    for f in EXACT_ZERO:
        nosignal |= set(read_json(os.path.join(home, f))["windows"])
    for r in read_jsonl(view_index or VIEW_INDEX):
        if r.get("status") == "no_signal":
            nosignal.add(r["window_id"])
    wins, n_multi, n_excl = {}, 0, 0
    for wid, paths in recs.items():
        ref = []
        for p in paths:
            d = read_json(os.path.join(home, p))
            if all_refused(d):
                ref.append((p, d))
        if not ref:
            continue
        if wid in nosignal:
            n_excl += 1
            continue
        p, d = ref[-1]
        n_multi += len(ref) > 1
        wins[wid] = dict(path=p, room=d.get("room_id"), n_segments=len(d["segments"]), n_files=len(ref))
    return dict(windows=wins, counts=dict(all_refused_windows=len(wins) + n_excl, excluded_no_signal=n_excl, in_population=len(wins), windows_with_several_files=n_multi))


def largest_remainder(counts, total):
    """Proportional allocation of `total` over {key: n}. Ties on the remainder: the lexicographically smaller key first."""
    n = sum(counts.values())
    quota = {k: total * v / n for k, v in counts.items()}
    alloc = {k: int(q) for k, q in quota.items()}
    left = total - sum(alloc.values())
    order = sorted(counts, key=lambda k: (-(quota[k] - alloc[k]), k))
    for k in order[:left]:
        alloc[k] += 1
    return alloc


def allocate(room_counts, total=N_DRAW, min_windows=MIN_ROOM_WINDOWS):
    """Proportional (largest remainder); every room with >= min_windows gets at least 1 (taken from the currently largest allocation); smaller rooms get 0."""
    eligible = {k: v for k, v in room_counts.items() if v >= min_windows}
    alloc = largest_remainder(eligible, total)
    for k in sorted(eligible):
        while alloc[k] < 1:
            donor = max(sorted(alloc), key=lambda x: (alloc[x], x))
            alloc[donor] -= 1
            alloc[k] += 1
    for k in room_counts:
        alloc.setdefault(k, 0)
    assert sum(alloc.values()) == total
    return dict(sorted(alloc.items()))


def pick(sorted_pool, n, seed):
    """Partial Fisher-Yates over random.Random(seed).random(); the chosen items in sorted order. `sorted_pool` must already be sorted."""
    rng = random.Random(seed)
    pool = list(sorted_pool)
    n = min(n, len(pool))
    for j in range(n):
        k = j + int(rng.random() * (len(pool) - j))
        pool[j], pool[k] = pool[k], pool[j]
    return sorted(pool[:n])


def draw_main(pop, seed=SEED):
    by_room = {}
    for wid, w in pop["windows"].items():
        by_room.setdefault(w["room"], []).append(wid)
    room_counts = {r: len(v) for r, v in by_room.items()}
    alloc = allocate(room_counts)
    chosen = {}
    for r in sorted(by_room):
        if alloc[r]:
            chosen[r] = pick(sorted(by_room[r]), alloc[r], seed)
    return dict(room_counts=dict(sorted(room_counts.items())), allocation=alloc, chosen=chosen)


def draw_controls(seed=SEED, view_index=None):
    rows = read_jsonl(view_index or VIEW_INDEX)
    acc = sorted(r["window_id"] for r in rows if r["status"] == "text" and r["n_words"] >= ACCEPT_MIN_WORDS)
    sil = sorted(r["window_id"] for r in rows if r["status"] == "no_signal")
    return dict(accepted=pick(acc, N_ACCEPT, seed + 1), silent=pick(sil, N_SILENT, seed + 2), pool_accepted=len(acc), pool_silent=len(sil))


def iso(s):
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def chunk_plan(rec):
    """[(local_file_name, chunk_start_s_from_window_start, chunk_len_s)] for every chunk used, in time order. Times are seconds from the window start."""
    w0 = iso(rec["start"])
    out = []
    for c in rec["provenance"]["source_chunks"] if rec.get("provenance", {}).get("source_chunks") else rec["cut"]["chunks_used"]:
        cs = (iso(c["started_at"]) - w0).total_seconds()
        out.append((c["r2_key"].replace("/", "__"), cs, c["duration_ms"] / 1000.0))
    return sorted(out, key=lambda x: x[1])


def coverage(plan, window_s=WINDOW_S):
    """Union of the chunk intervals clipped to [0, window_s], as sorted [(a, b)]."""
    iv = sorted((max(0.0, s), min(window_s, s + l)) for _f, s, l in plan if s + l > 0 and s < window_s)
    merged = []
    for a, b in iv:
        if merged and a <= merged[-1][1] + 1e-9:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


def union(intervals):
    out = []
    for a, b in sorted(intervals):
        if b <= a:
            continue
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def intersect(x, y):
    """Intersection of two lists of disjoint sorted intervals."""
    out, i, j = [], 0, 0
    while i < len(x) and j < len(y):
        a, b = max(x[i][0], y[j][0]), min(x[i][1], y[j][1])
        if b > a:
            out.append((a, b))
        if x[i][1] < y[j][1]:
            i += 1
        else:
            j += 1
    return out


def total(iv):
    return sum(b - a for a, b in iv)


def measured_span(rec, kind, window_s=WINDOW_S):
    """The span a window is measured over: 'refused' = union of refused segments; 'accepted' = union of non-refused segments that carry text; 'whole' = the window.
    Clipped to the window and to covered audio."""
    if kind == "whole":
        span = [(0.0, window_s)]
    else:
        want = (lambda s: s.get("refused") is True) if kind == "refused" else (lambda s: s.get("refused") is not True and (s.get("text") or "").strip())
        span = union([(max(0.0, s["start_s"]), min(window_s, s["end_s"])) for s in rec["segments"] if want(s)])
    return intersect(span, coverage(chunk_plan(rec), window_s))


def present(speech_s, span_s):
    """The pre-registered primary decision."""
    return span_s > 0 and speech_s >= SPEECH_MIN_S and speech_s / span_s >= SPEECH_MIN_FRAC


def sha256_file(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()
