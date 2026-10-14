"""Timbre on Nemotron speaker turns (how-to 14 Oct 2026, sections 2-4).

Separate from the nightly pipeline (pipeline.py and nightly_prepare.py are not touched).
The turn logic (offsets, merge, drop, split, overlap, roles, per-person aggregation,
reliability rule) is plain Python with no numpy, so it tests anywhere. The model run is
the ``score`` command and needs torch and the extractors.

Commands
  plan   (CPU, box)  frozen manifest + REB tracks + role layer -> plan JSONL. Times,
                     speakers and roles only. No audio, no text.
  score  (GPU, HF)   plan + audio -> one JSON line per turn with Odyssey, audEERING and
                     emotion2vec scores. Model revisions are pinned (MODEL_PINS).
Benchmarks B1-B4 live in turns_bench.py.

Rules kept here
  * segment t0_ms/t1_ms are tape_utc epoch ms; offset into consult.flac is t0_ms - manifest.t0_ms.
  * reliability is None until a benchmark measured it. Never 0, never "neutral".
  * role and role_source come only from the role layer (or the labelled silver map, marked as such).
    Voiceprints and timbre are never a role source.
  * no transcript text is read or written.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import math
import os
import sys
from pathlib import Path

MERGE_GAP_S = 0.5
MIN_TURN_S = 1.5
MAX_TURN_S = 30.0
# A turn counts as overlapped for aggregation when another speaker covers more than this
# fraction of it. Not set by the how-to ("overlapped turns excluded"); chosen here and recorded.
OVERLAP_EXCLUDE_FRAC = 0.2
SPLIT_HALF_MIN = 0.4
MIN_TURNS_PER_HALF = 2

# Pinned model commits (HF API, 14 Oct 2026; the box cache has the same shas for the first two).
MODEL_PINS = {
    "3loi/SER-Odyssey-Baseline-WavLM-Multi-Attributes": "00d0e12ba9bf957f5aeea36e8663c8c61cb50ac9",
    "microsoft/wavlm-large": "c1423ed94bb01d80a3f5ce5bc39f6026a0f4828c",
    "audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim": "6eba34a2485ea31cb03600241787c3a5edab8626",
    "emotion2vec/emotion2vec_plus_large": "6c303ba987b86b93193de93e34bb2b077a6bedc4",
}
MODEL_NAMES = {
    "odyssey": "odyssey_wavlm_dim.v1",
    "audeering": "audeering_msp_dim.v1",
    "e2v": "emotion2vec_plus_large.v1",
}
ROLES = ("doctor", "patient", "other")
ROLE_SOURCES = ("llm-roles", "text-judge", "caa-labels", "silver-labels")

# --------------------------------------------------------------------------- offsets / turns


def clip_offset_s(t_ms: int | float, manifest_t0_ms: int | float) -> float:
    """Seconds into consult.flac for an epoch-ms time (tape_utc)."""
    return (float(t_ms) - float(manifest_t0_ms)) / 1000.0


def segments_to_clip(segments, manifest_t0_ms, duration_s=None):
    """Diar segments (epoch ms) -> sorted [(start_s, end_s, speaker)] relative to the clip.

    Clipped to [0, duration_s] when the duration is known. Empty or inverted ones are dropped.
    """
    out = []
    for s in segments or []:
        a = clip_offset_s(s["t0_ms"], manifest_t0_ms)
        b = clip_offset_s(s["t1_ms"], manifest_t0_ms)
        a = max(0.0, a)
        if duration_s is not None:
            b = min(float(duration_s), b)
        if b > a:
            out.append((a, b, str(s["speaker"])))
    out.sort()
    return out


def merge_same_speaker(segs, max_gap_s=MERGE_GAP_S):
    """Join one speaker's segments when the gap between them is under max_gap_s.

    Done on each speaker's own timeline, so a short interjection by someone else between two
    pieces does not break the turn (it shows up in the overlap fraction instead).
    """
    by = {}
    for a, b, sp in segs:
        by.setdefault(sp, []).append((a, b))
    out = []
    for sp, lst in by.items():
        lst.sort()
        ca, cb = lst[0]
        for a, b in lst[1:]:
            if a - cb < max_gap_s:
                cb = max(cb, b)
            else:
                out.append((ca, cb, sp))
                ca, cb = a, b
        out.append((ca, cb, sp))
    out.sort()
    return out


def drop_short(turns, min_s=MIN_TURN_S):
    return [t for t in turns if (t[1] - t[0]) >= min_s]


def split_long(turns, max_s=MAX_TURN_S, min_s=MIN_TURN_S):
    """Cut turns over max_s into max_s chunks. A leftover tail under min_s is dropped."""
    out = []
    for a, b, sp in turns:
        if b - a <= max_s:
            out.append((a, b, sp))
            continue
        s = a
        while s < b:
            e = min(s + max_s, b)
            if e - s >= min_s:
                out.append((s, e, sp))
            s = e
    out.sort()
    return out


def _union(intervals):
    out = []
    for a, b in sorted(intervals):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def overlap_fraction(turn, raw_segs):
    """Fraction of the turn where a different speaker is also active (raw diar segments)."""
    a, b, sp = turn
    dur = b - a
    if dur <= 0:
        return 0.0
    cut = [(max(a, x), min(b, y)) for x, y, s in raw_segs if s != sp and min(b, y) > max(a, x)]
    covered = sum(y - x for x, y in _union(cut))
    return min(1.0, covered / dur)


def build_turns(segments, manifest_t0_ms, duration_s=None):
    """Full step 1 + 2 of the how-to. Returns turn dicts with clip-relative seconds."""
    raw = segments_to_clip(segments, manifest_t0_ms, duration_s)
    turns = split_long(drop_short(merge_same_speaker(raw)))
    return [
        {
            "turn": i,
            "speaker": sp,
            "t0_s": round(a, 3),
            "t1_s": round(b, 3),
            "dur_s": round(b - a, 3),
            "overlap_frac": round(overlap_fraction((a, b, sp), raw), 4),
        }
        for i, (a, b, sp) in enumerate(turns)
    ]


# --------------------------------------------------------------------------- roles


def norm_role(r):
    r = (r or "").lower()
    if r in ("doctor", "patient"):
        return r
    if r in ("attendant", "attender", "staff", "other", "family", "nurse"):
        return "other"
    return None


def role_segments_to_clip(role_track_segments, manifest_t0_ms):
    out = []
    for s in role_track_segments or []:
        r = norm_role(s.get("role"))
        if r is None:
            continue
        a = clip_offset_s(s["t0_ms"], manifest_t0_ms)
        b = clip_offset_s(s["t1_ms"], manifest_t0_ms)
        if b > a:
            out.append((a, b, r))
    return out


def assign_roles(raw_segs, role_segs):
    """Role per Nemotron speaker by most overlap with role-layer segments.

    raw_segs: [(a, b, speaker)], role_segs: [(a, b, role)]. Returns {speaker: role or "unknown"}.
    """
    out = {}
    for sp in {s for _, _, s in raw_segs}:
        mine = [(a, b) for a, b, s in raw_segs if s == sp]
        tot = {}
        for r in {r for _, _, r in role_segs}:
            theirs = [(a, b) for a, b, rr in role_segs if rr == r]
            ov = 0.0
            for x in _union(mine):
                for y in _union(theirs):
                    ov += max(0.0, min(x[1], y[1]) - max(x[0], y[0]))
            if ov > 0:
                tot[r] = ov
        out[sp] = max(tot, key=tot.get) if tot else "unknown"
    return out


# --------------------------------------------------------------------------- statistics


def median(xs):
    xs = sorted(xs)
    n = len(xs)
    if n == 0:
        return None
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2.0


def quantile(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    pos = (len(xs) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def iqr(xs):
    if not xs:
        return None
    return quantile(xs, 0.75) - quantile(xs, 0.25)


def _ranks(x):
    order = sorted(range(len(x)), key=lambda i: x[i])
    r = [0.0] * len(x)
    i = 0
    while i < len(x):
        j = i
        while j + 1 < len(x) and x[order[j + 1]] == x[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2.0
        i = j + 1
    return r


def spearman(a, b):
    """Spearman rho, None if fewer than 3 pairs or no variance."""
    pairs = [(x, y) for x, y in zip(a, b) if x is not None and y is not None and math.isfinite(x) and math.isfinite(y)]
    if len(pairs) < 3:
        return None
    ra, rb = _ranks([p[0] for p in pairs]), _ranks([p[1] for p in pairs])
    ma, mb = sum(ra) / len(ra), sum(rb) / len(rb)
    va = sum((x - ma) ** 2 for x in ra)
    vb = sum((y - mb) ** 2 for y in rb)
    if va == 0 or vb == 0:
        return None
    return sum((x - ma) * (y - mb) for x, y in zip(ra, rb)) / math.sqrt(va * vb)


# --------------------------------------------------------------------------- aggregation


def is_overlapped(turn_row, frac=OVERLAP_EXCLUDE_FRAC):
    return float(turn_row.get("overlap_frac") or 0.0) > frac


def _val(row, feature):
    v = (row.get("scores") or {}).get(feature)
    if v is None or not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    return float(v)


def aggregate_person(turn_rows, feature, overlap_frac=OVERLAP_EXCLUDE_FRAC):
    """Median, IQR, n_turns, seconds for one person and one feature; overlapped turns excluded.

    Returns None when no usable turn is left (an unscorable person has no row, never a zero).
    """
    used, excl_s = [], 0.0
    for r in turn_rows:
        if is_overlapped(r, overlap_frac):
            excl_s += float(r["dur_s"])
            continue
        v = _val(r, feature)
        if v is not None:
            used.append((v, float(r["dur_s"])))
    if not used:
        return None
    vals = [v for v, _ in used]
    return {
        "value": median(vals),
        "iqr": iqr(vals),
        "n_turns": len(used),
        "seconds": round(sum(d for _, d in used), 3),
        "overlap_excluded_s": round(excl_s, 3),
    }


def reliability_lookup(table, feature, role):
    """Benchmark reliability for (feature, role), or None when it has not been measured.

    ``table`` is {"feature|role": number}. A missing, null or non-finite entry gives None.
    Never returns 0 or a default.
    """
    if not table:
        return None
    v = table.get(f"{feature}|{role}")
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    return float(v)


def feature_rows(consult_uid, person, turn_rows, features, model_info, run_id, git_sha, reliability_table=None):
    """Section-4 rows for one person: one per feature with a median and an IQR field."""
    rows = []
    for feat in features:
        agg = aggregate_person(turn_rows, feat)
        if agg is None:
            continue
        model = model_info.get(feat.split(".")[0], {})
        rows.append(
            {
                "consult_uid": consult_uid,
                "speaker": person["speaker"],
                "role": person["role"],
                "role_source": person["role_source"],
                "feature": feat,
                "value": agg["value"],
                "stat": "median",
                "iqr": agg["iqr"],
                "model_id": model.get("model_id"),
                "model_rev": model.get("model_rev"),
                "n_turns": agg["n_turns"],
                "seconds": agg["seconds"],
                "overlap_excluded_s": agg["overlap_excluded_s"],
                "reliability": reliability_lookup(reliability_table, feat, person["role"]),
                "run_id": run_id,
                "git_sha": git_sha,
            }
        )
    return rows


def split_half_person(turn_rows, feature, overlap_frac=OVERLAP_EXCLUDE_FRAC):
    """(odd_median, even_median) of one person's usable turns in time order, or None.

    Odd/even = position among the person's own turns after overlap exclusion.
    Needs at least MIN_TURNS_PER_HALF turns in each half.
    """
    usable = [r for r in sorted(turn_rows, key=lambda r: r["t0_s"]) if not is_overlapped(r, overlap_frac)]
    vals = [_val(r, feature) for r in usable]
    odd = [v for i, v in enumerate(vals) if i % 2 == 0 and v is not None]
    even = [v for i, v in enumerate(vals) if i % 2 == 1 and v is not None]
    if len(odd) < MIN_TURNS_PER_HALF or len(even) < MIN_TURNS_PER_HALF:
        return None
    return median(odd), median(even)


# --------------------------------------------------------------------------- plan (box, CPU)


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _canonical(scope_dir, prefix):
    best = None
    for f in sorted(Path(scope_dir, "tracks").glob(f"{prefix}__*.json")):
        d = json.loads(f.read_text())
        if d.get("status") != "ok":
            continue
        key = ((d.get("extras") or {}).get("created_at") or "", f.stat().st_mtime)
        if best is None or key > best[0]:
            best = (key, d, f.name)
    return (best[1], best[2]) if best else (None, None)


def plan_clip(clip, reb_root, label=None):
    """Plan record for one frozen clip, or None when it has no usable Nemotron track."""
    scope = Path(reb_root) / clip["scope"]
    manifest = json.loads((scope / "manifest.json").read_text())
    t0 = manifest["t0_ms"]
    if t0 != clip["clip_t0_ms"]:
        raise ValueError(f"{clip['bench_id']}: manifest t0_ms differs from the frozen clip t0")
    dur = clip["audio_duration_ms"] / 1000.0
    nem_key = clip["tracks"]["diar_nemotron"]["key"]
    nem_path = Path(reb_root) / nem_key
    if _sha(nem_path) != clip["tracks"]["diar_nemotron"]["sha256"]:
        raise ValueError(f"{clip['bench_id']}: nemotron track sha differs from the freeze")
    nem = json.loads(nem_path.read_text())
    raw = segments_to_clip(nem.get("segments"), t0, dur)
    turns = build_turns(nem.get("segments"), t0, dur)

    role_segs, source = [], None
    for prefix, src in (("role.llm-roles", "llm-roles"), ("role.text-judge", "text-judge"), ("role.caa-labels", "caa-labels")):
        d, _ = _canonical(scope, prefix)
        if d:
            rs = role_segments_to_clip(d.get("segments"), t0)
            if rs:
                role_segs, source = rs, src
                break
    if source is None and label and label.get("speaker_roles"):
        sar = clip["tracks"].get("diar_sarvam")
        if sar:
            sd = json.loads((Path(reb_root) / sar["key"]).read_text())
            smap = {k: norm_role(v) for k, v in label["speaker_roles"].items() if norm_role(v)}
            for a, b, sp in segments_to_clip(sd.get("segments"), t0, dur):
                if smap.get(sp):
                    role_segs.append((a, b, smap[sp]))
            if role_segs:
                source = "silver-labels"
    roles = assign_roles(raw, role_segs) if source else {}
    persons = {}
    for sp in sorted({t["speaker"] for t in turns}):
        persons[sp] = {"role": roles.get(sp, "unknown"), "role_source": source if roles.get(sp, "unknown") != "unknown" else None}
    return {
        "bench_id": clip["bench_id"],
        "consult_uid": clip["consult_uid"],
        "audio_r2_key": clip["audio_r2_key"],
        "manifest_t0_ms": t0,
        "duration_s": dur,
        "nemotron_track": {"version": nem.get("version"), "cfg8": nem.get("config_hash"), "model": nem.get("model")},
        "persons": persons,
        "turns": turns,
    }


def cmd_plan(args):
    bb = Path(args.bench_dir).expanduser()
    reb = Path(args.reb_root).expanduser()
    man = json.loads((bb / "manifest.json").read_text())
    if _sha(bb / "manifest.json") != args.manifest_sha256:
        raise SystemExit("manifest sha256 differs from the freeze")
    labels = {}
    lp = bb / "labels.jsonl"
    if lp.exists():
        for line in lp.read_text().splitlines():
            if line.strip():
                d = json.loads(line)
                labels[d["bench_id"]] = d
    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with open(out, "w", opener=lambda p, f: os.open(p, f, 0o600)) as fh:
        for c in man["clips"]:
            rec = plan_clip(c, reb, labels.get(c["bench_id"]))
            fh.write(json.dumps(rec, separators=(",", ":")) + "\n")
            n += 1
    print(f"plan: {n} clips, {sum(len(json.loads(l)['turns']) for l in open(out))} turns -> {out}")


# --------------------------------------------------------------------------- score (GPU, HF)


def pin_models(pins=None):
    """Download the pinned commits and point refs/main at them, so the extractors (which
    resolve ``main`` from the local cache) load exactly these revisions."""
    from huggingface_hub import snapshot_download

    cache = Path(os.environ.get("HF_HUB_CACHE") or Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")) / "hub")
    for repo, sha in (pins or MODEL_PINS).items():
        allow = ["*.json", "*.txt"] if repo == "microsoft/wavlm-large" else None
        snapshot_download(repo, revision=sha, allow_patterns=allow)
        ref = cache / f"models--{repo.replace('/', '--')}" / "refs" / "main"
        ref.parent.mkdir(parents=True, exist_ok=True)
        ref.write_text(sha)
    os.environ["HF_HUB_OFFLINE"] = "1"


def _load_audio_16k(path):
    import numpy as np
    import soundfile as sf

    audio, sr = sf.read(str(path), dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if sr != 16000:
        from math import gcd

        from scipy.signal import resample_poly

        g = gcd(int(sr), 16000)
        audio = resample_poly(audio, 16000 // g, int(sr) // g).astype(np.float32)
    return audio


def _fetch_clip(key, dest_dir):
    from tools.timbre.r2audio import fetch_audio

    data = fetch_audio(key)
    p = Path(dest_dir) / (hashlib.sha1(key.encode()).hexdigest()[:16] + ".flac")
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return p


FEATURE_KEYS = {
    "odyssey": ("arousal", "valence", "dominance"),
    "audeering": ("arousal", "valence", "dominance"),
    "e2v": ("angry", "disgusted", "fearful", "happy", "neutral", "other", "sad", "surprised", "unknown"),
}


def score_turn(extractors, crop, sr=16000):
    scores, status = {}, {}
    for short, ex in extractors.items():
        row = ex.extract(crop, sr)
        status[short] = row["status"] if row["status"] == "ok" else f"{row['status']}:{row.get('reason')}"
        for k, v in row["features"].items():
            name = k[len("score_"):] if short == "e2v" and k.startswith("score_") else k
            if name in FEATURE_KEYS[short]:
                scores[f"{short}.{name}"] = None if (v is None or not math.isfinite(v)) else round(float(v), 6)
    return scores, status


def cmd_score(args):
    pin_models()
    from tools.timbre.extractors.base import build_extractor

    exs = {short: build_extractor(name, args.device) for short, name in MODEL_NAMES.items()}
    plan = [json.loads(l) for l in Path(args.plan).read_text().splitlines() if l.strip()]
    only = set(args.only.split(",")) if args.only else None
    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    git_sha = os.environ.get("TIMBRE_GIT_SHA", "unknown")
    import time

    t_start = time.time()
    n_turns = 0
    with open(out, "w", opener=lambda p, f: os.open(p, f, 0o600)) as fh:
        meta = {
            "kind": "meta",
            "models": {s: {"model_id": ex.spec.model_id, "model_rev": MODEL_PINS.get(ex.spec.model_id)} for s, ex in exs.items()},
            "pins": MODEL_PINS,
            "git_sha": git_sha,
            "overlap_exclude_frac": OVERLAP_EXCLUDE_FRAC,
        }
        fh.write(json.dumps(meta) + "\n")
        for rec in plan:
            if only and rec["bench_id"] not in only:
                continue
            if args.audio_dir:
                path = Path(args.audio_dir) / f"{rec['bench_id']}.flac"
            else:
                path = _fetch_clip(rec["audio_r2_key"], workdir)
            audio = _load_audio_16k(path)
            for t in rec["turns"]:
                a, b = int(round(t["t0_s"] * 16000)), int(round(t["t1_s"] * 16000))
                scores, status = score_turn(exs, audio[a:b])
                row = {
                    "kind": "turn",
                    "bench_id": rec["bench_id"],
                    "turn": t["turn"],
                    "speaker": t["speaker"],
                    "role": rec["persons"].get(t["speaker"], {}).get("role", "unknown"),
                    "t0_s": t["t0_s"],
                    "t1_s": t["t1_s"],
                    "dur_s": t["dur_s"],
                    "overlap_frac": t["overlap_frac"],
                    "scores": scores,
                    "status": status,
                }
                fh.write(json.dumps(row, separators=(",", ":")) + "\n")
                n_turns += 1
            fh.flush()
            print(f"scored {rec['bench_id']} turns={len(rec['turns'])} elapsed={time.time() - t_start:.0f}s", flush=True)
    print(f"done turns={n_turns} elapsed={time.time() - t_start:.0f}s", flush=True)


def emit_log_payload(path, chunk=4000):
    """Print a file as sha256-framed gzip+base64 lines, so a Job's logs carry the result."""
    raw = Path(path).read_bytes()
    z = base64.b64encode(gzip.compress(raw, 9)).decode()
    print(f"TIMBRE_TURNS_BEGIN sha256={hashlib.sha256(raw).hexdigest()} bytes={len(raw)} parts={math.ceil(len(z) / chunk)}", flush=True)
    for i in range(0, len(z), chunk):
        print(f"TIMBRE_TURNS_PART {i // chunk:05d} {z[i:i + chunk]}", flush=True)
    print("TIMBRE_TURNS_END", flush=True)


def decode_log_payload(text):
    """Inverse of emit_log_payload on a log string. Verifies the sha256."""
    head, parts = None, {}
    for line in text.splitlines():
        line = line.strip()
        if "TIMBRE_TURNS_BEGIN" in line:
            head = dict(kv.split("=") for kv in line.split("TIMBRE_TURNS_BEGIN", 1)[1].split())
        elif "TIMBRE_TURNS_PART" in line:
            idx, data = line.split("TIMBRE_TURNS_PART", 1)[1].split()[:2]
            parts[int(idx)] = data
    if head is None or len(parts) != int(head["parts"]):
        raise ValueError("log payload incomplete")
    raw = gzip.decompress(base64.b64decode("".join(parts[i] for i in range(len(parts)))))
    if hashlib.sha256(raw).hexdigest() != head["sha256"]:
        raise ValueError("log payload sha256 mismatch")
    return raw


def cmd_emit(args):
    emit_log_payload(args.file)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m tools.timbre.turns")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan")
    p.add_argument("--bench-dir", default="~/oc/nemotron-lead/bench-b")
    p.add_argument("--reb-root", default="~/eta-data")
    p.add_argument("--manifest-sha256", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_plan)
    s = sub.add_parser("score")
    s.add_argument("--plan", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--workdir", default="/tmp/timbre-turns")
    s.add_argument("--audio-dir", default=None, help="local <bench_id>.flac files instead of R2")
    s.add_argument("--device", default="cuda")
    s.add_argument("--only", default=None)
    s.set_defaults(fn=cmd_score)
    e = sub.add_parser("emit")
    e.add_argument("--file", required=True)
    e.set_defaults(fn=cmd_emit)
    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
