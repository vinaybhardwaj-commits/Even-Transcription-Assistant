"""measure.py: the ruling-333 measurement (english_hallucination_guard over-refusal): draw 30 all-refused windows, then measure speech presence inside their refused spans.
Read refused_logic.py's docstring first: population, strata, controls, detectors and the decision rule are frozen THERE, before any window is measured.

  python3 measure.py draw    --out-dir D        writes D/draw.json (0600, never overwritten): population counts, allocation, the 30 window ids, the 15 control ids. NO audio is touched.
  python3 measure.py measure --draw D/draw.json --out D/results.json    decodes the cached audio (~/eta-data/hist-mining/audio, no service is called) and runs the detectors.

Run measure.py with /home/eta/vad/venv/bin/python (numpy, torch, silero-vad, webrtcvad; read-only use of that venv). Nothing here prints or stores transcript text: outputs are window ids, room ids,
language codes, seconds and fractions. Windows are handled at nice 15, 2 threads, CPU only; no GPU, no Mini service, no vendor call.
"""
import argparse, json, os, subprocess, sys

import refused_logic as R

FRAME_MS = 30
SR = 16000
FRAME = SR * FRAME_MS // 1000                       # 480 samples
ENERGY_MARGIN_DB = 12.0
SILERO_THRESHOLD = 0.5


def inside_git(path):
    """True if `path` (need not exist) is inside a git work tree; fails closed (git missing or any error other than 'not a git repository' = inside)."""
    probe = os.path.dirname(os.path.abspath(path))
    while not os.path.isdir(probe):
        parent = os.path.dirname(probe)
        if parent == probe:
            return True
        probe = parent
    d = probe
    while True:
        if os.path.lexists(os.path.join(d, ".git")):
            return True
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    try:
        r = subprocess.run(["git", "-C", probe, "rev-parse", "--is-inside-work-tree"], capture_output=True, text=True, env=dict(os.environ, LC_ALL="C", LANG="C"))
    except OSError:
        return True
    if r.returncode == 0:
        return r.stdout.strip() == "true"
    return "not a git repository" not in r.stderr


def write_private(path, text):
    if inside_git(path):
        raise SystemExit("refusing to write inside a git work tree: results and the draw stay on the box until reviewed")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


def cmd_draw(out_dir):
    pop = R.population()
    d = R.draw_main(pop)
    c = R.draw_controls()
    doc = dict(seed=R.SEED, logic_sha256=R.sha256_file(R.__file__), population=pop["counts"], room_counts=d["room_counts"], allocation=d["allocation"],
               chosen={r: [dict(window_id=w, path=pop["windows"][w]["path"], room=r, n_segments=pop["windows"][w]["n_segments"]) for w in ws] for r, ws in d["chosen"].items()},
               controls=dict(accepted=c["accepted"], silent=c["silent"], pool_accepted=c["pool_accepted"], pool_silent=c["pool_silent"]),
               language_note="every segment of every all-refused record is labelled en, so the language stratum is degenerate")
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    write_private(os.path.join(out_dir, "draw.json"), json.dumps(doc, indent=1) + "\n")
    print("population:", pop["counts"])
    print("allocation:", {k: v for k, v in d["allocation"].items()})
    print("drawn:", sum(len(v) for v in d["chosen"].values()), "| accepted controls", len(c["accepted"]), "| silent controls", len(c["silent"]))
    return doc


# ---------------------------------------------------------------- audio and detectors (numpy, torch: venv only)

def decode(path, offset_s, dur_s):
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-ss", f"{offset_s:.3f}", "-t", f"{dur_s:.3f}", "-i", path, "-f", "s16le", "-ac", "1", "-ar", str(SR), "pipe:1"],
                       capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg exit {r.returncode}")
    return r.stdout


def window_audio(rec, np):
    """The window's 900 s as int16 at 16 kHz, zeros where no chunk covers it; also the covered intervals."""
    buf = np.zeros(int(R.WINDOW_S * SR), dtype=np.int16)
    for name, cs, cl in R.chunk_plan(rec):
        a, b = max(cs, 0.0), min(cs + cl, R.WINDOW_S)
        if b <= a:
            continue
        raw = decode(os.path.join(R.AUDIO_DIR, name), a - cs, b - a)
        x = np.frombuffer(raw, dtype=np.int16)
        i0 = int(round(a * SR))
        n = min(len(x), len(buf) - i0)
        buf[i0:i0 + n] = x[:n]
    return buf, R.coverage(R.chunk_plan(rec))


def frames_to_intervals(flags, frame_s):
    out, start = [], None
    for i, f in enumerate(flags):
        if f and start is None:
            start = i * frame_s
        if not f and start is not None:
            out.append((start, i * frame_s))
            start = None
    if start is not None:
        out.append((start, len(flags) * frame_s))
    return out


def detect_all(buf, np, torch, silero_model, get_ts, webrtcvad, covered):
    """Returns {detector: [(a, b) speech intervals in seconds from the window start]}."""
    fs = FRAME_MS / 1000.0
    n = len(buf) // FRAME
    raw = buf[:n * FRAME].tobytes()
    res = {}
    for name, mode in (("D1a_webrtc2", 2), ("D1b_webrtc3", 3)):
        v = webrtcvad.Vad(mode)
        flags = [v.is_speech(raw[i * FRAME * 2:(i + 1) * FRAME * 2], SR) for i in range(n)]
        res[name] = frames_to_intervals(flags, fs)
    audio = torch.from_numpy(buf.astype("float32") / 32768.0)
    ts = get_ts(audio, silero_model, sampling_rate=SR, threshold=SILERO_THRESHOLD, return_seconds=True)
    res["D2_silero"] = [(t["start"], t["end"]) for t in ts]
    fr = buf[:n * FRAME].astype("float64").reshape(n, FRAME)
    rms = np.sqrt((fr ** 2).mean(axis=1))
    db = 20 * np.log10(rms / 32768.0 + 1e-12)
    cov_flags = np.zeros(n, dtype=bool)
    for a, b in covered:
        cov_flags[int(a / fs):min(n, int(b / fs))] = True
    floor = float(np.percentile(db[cov_flags], 20)) if cov_flags.any() else 0.0
    res["D3_energy"] = frames_to_intervals(list(db >= floor + ENERGY_MARGIN_DB), fs)
    return res, floor


def chunk_time_map():
    """r2_key -> (started_at, duration_ms) from every run record that carries chunk timing AND from hist/manifest.json (which lists every chunk with its times). Some records
    (link3 coverage windows, NO_SIGNAL skips) hold only chunk KEYS; the time is recovered from these sources, never guessed."""
    out = {}
    try:
        for j in R.read_json(os.path.join(R.HOME, "hist", "manifest.json"))["jobs"]:
            for c in j["chunks"]:
                out[c["r2_key"]] = (c["started_at"], c["duration_ms"])
    except (OSError, ValueError, KeyError):
        pass
    for root in R.ROOTS:
        for dp, _dn, fn in os.walk(os.path.join(R.HOME, root)):
            for f in fn:
                if not f.endswith(".json"):
                    continue
                try:
                    d = R.read_json(os.path.join(dp, f))
                except (OSError, ValueError):
                    continue
                if not isinstance(d, dict):
                    continue
                for c in (d.get("provenance", {}) or {}).get("source_chunks") or (d.get("cut", {}) or {}).get("chunks_used") or []:
                    out[c["r2_key"]] = (c["started_at"], c["duration_ms"])
    return out


class NoTiming(Exception):
    pass


def ensure_timing(rec, keymap):
    if (rec.get("provenance", {}) or {}).get("source_chunks") or (rec.get("cut", {}) or {}).get("chunks_used"):
        return rec
    keys = (rec.get("cut", {}) or {}).get("chunk_keys") or (rec.get("provenance", {}) or {}).get("source_audio_keys") or []
    missing = [k for k in keys if k not in keymap]
    if not keys or missing:
        raise NoTiming(f"{len(missing)} of {len(keys)} chunk keys have no timing anywhere")
    rec = dict(rec)
    rec["cut"] = dict(rec.get("cut", {}), chunks_used=[dict(r2_key=k, started_at=keymap[k][0], duration_ms=keymap[k][1]) for k in keys])
    return rec


def measure_window(wid, path, kind, np, torch, silero_model, get_ts, webrtcvad, keymap):
    rec = R.read_json(os.path.join(R.HOME, path))
    try:
        rec = ensure_timing(rec, keymap)
        span = R.measured_span(rec, kind)
        span_s = R.total(span)
        buf, covered = window_audio(rec, np)
    except NoTiming as e:
        return dict(window_id=wid, room_id=rec.get("room_id"), language="en", kind=kind, error=f"no chunk timing: {e}", span_s=0.0, primary_present=False)
    except (RuntimeError, OSError) as e:
        return dict(window_id=wid, room_id=rec.get("room_id"), language="en", kind=kind, error=f"audio not readable: {type(e).__name__}", span_s=0.0, primary_present=False)
    det, floor = detect_all(buf, np, torch, silero_model, get_ts, webrtcvad, covered)
    row = dict(window_id=wid, room_id=rec.get("room_id"), language="en", kind=kind, n_segments=len(rec.get("segments", [])), span_s=round(span_s, 2),
               covered_s=round(R.total(covered), 1), energy_floor_dbfs=round(floor, 1))
    for name, iv in det.items():
        s = R.total(R.intersect(R.union(iv), span))
        row[name + "_s"] = round(s, 2)
        row[name + "_frac"] = round(s / span_s, 3) if span_s > 0 else None
        row[name + "_present"] = R.present(s, span_s)
    row["primary_present"] = row["D1b_webrtc3_present"]
    return row


def summarise(rows):
    def med(xs):
        xs = sorted(x for x in xs if x is not None)
        return None if not xs else (xs[len(xs) // 2] if len(xs) % 2 else (xs[len(xs) // 2 - 1] + xs[len(xs) // 2]) / 2)
    errs = [r for r in rows if "error" in r]
    rows = [r for r in rows if "error" not in r]
    main = [r for r in rows if r["kind"] == "refused"]
    acc = [r for r in rows if r["kind"] == "accepted"]
    sil = [r for r in rows if r["kind"] == "whole"]
    out = dict(n_refused_windows=len(main), n_accepted_controls=len(acc), n_silent_controls=len(sil),
               windows_without_chunk_timing=dict(refused=sum(r["kind"] == "refused" for r in errs), accepted=sum(r["kind"] == "accepted" for r in errs), silent=sum(r["kind"] == "whole" for r in errs)))
    for name in ("D1a_webrtc2", "D1b_webrtc3", "D2_silero", "D3_energy"):
        out[name] = dict(refused_present=sum(r[name + "_present"] for r in main), refused_median_frac=med([r[name + "_frac"] for r in main]),
                         accepted_median_frac=med([r[name + "_frac"] for r in acc]), accepted_min_frac=min([r[name + "_frac"] for r in acc if r[name + "_frac"] is not None], default=None),
                         silent_max_frac=max([r[name + "_frac"] for r in sil if r[name + "_frac"] is not None], default=None))
    p = out["D1b_webrtc3"]
    out["controls_separate_D1b"] = bool(acc and sil and p["accepted_median_frac"] is not None and p["accepted_median_frac"] >= R.ACCEPT_SEP_MEDIAN
                                        and p["silent_max_frac"] is not None and p["silent_max_frac"] <= R.SILENT_SEP_MAX)
    out["primary_present_of_refused"] = f"{sum(r['primary_present'] for r in main)} of {len(main)}"
    out["not_measurable_refused_windows"] = sum(1 for r in main if r["span_s"] <= 0)
    out["all_three_detectors_present"] = sum(all(r[n + "_present"] for n in ("D1b_webrtc3", "D2_silero", "D3_energy")) for r in main)
    out["by_room_primary_present"] = {}
    for r in main:
        k = out["by_room_primary_present"].setdefault(r["room_id"], [0, 0])
        k[0] += bool(r["primary_present"])
        k[1] += 1
    return out


def cmd_measure(draw_path, out_path):
    os.nice(15)
    import numpy as np, torch, webrtcvad
    from silero_vad import load_silero_vad, get_speech_timestamps
    torch.set_num_threads(2)
    model = load_silero_vad()
    doc = R.read_json(draw_path)
    if doc["logic_sha256"] != R.sha256_file(R.__file__):
        raise SystemExit("refused_logic.py changed since the draw was frozen: measurement refused")
    jobs = [(c["window_id"], c["path"], "refused") for r in sorted(doc["chosen"]) for c in doc["chosen"][r]]
    def rec_path(wid):
        """The record file for a CONTROL window: any run file named <window_id>.json under the roots (NO_SIGNAL skip records have no `segments` key, so scan_records does not list them)."""
        found = []
        for root in R.ROOTS:
            for dp, _dn, fn in os.walk(os.path.join(R.HOME, root)):
                if wid + ".json" in fn:
                    found.append(os.path.relpath(os.path.join(dp, wid + ".json"), R.HOME))
        if not found:
            raise SystemExit(f"no record file for control window {wid}")
        return sorted(found)[-1]
    jobs += [(w, rec_path(w), "accepted") for w in doc["controls"]["accepted"]]
    jobs += [(w, rec_path(w), "whole") for w in doc["controls"]["silent"]]
    rows = []
    keymap = chunk_time_map()
    progress = out_path + ".progress.jsonl"
    for i, (wid, path, kind) in enumerate(jobs, 1):
        rows.append(measure_window(wid, path, kind, np, torch, model, get_speech_timestamps, webrtcvad, keymap))
        fd = os.open(progress, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)      # a crash must not lose finished windows
        with os.fdopen(fd, "a") as pf:
            pf.write(json.dumps(rows[-1]) + "\n")
        print(f"{i}/{len(jobs)} {kind} {wid} span {rows[-1]['span_s']} s primary {rows[-1].get('D1b_webrtc3_frac', rows[-1].get('error'))}", flush=True)
    out = dict(seed=doc["seed"], logic_sha256=doc["logic_sha256"], summary=summarise(rows), windows=rows)
    out["measure_py_sha256"] = R.sha256_file(__file__)
    write_private(out_path, json.dumps(out, indent=1) + "\n")
    print(json.dumps(out["summary"], indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("draw"); d.add_argument("--out-dir", required=True)
    m = sub.add_parser("measure"); m.add_argument("--draw", required=True); m.add_argument("--out", required=True)
    a = ap.parse_args()
    if a.cmd == "draw":
        cmd_draw(a.out_dir)
    else:
        cmd_measure(a.draw, a.out)
