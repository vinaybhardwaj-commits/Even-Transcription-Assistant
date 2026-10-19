#!/usr/bin/env python3
"""Append Nemotron-vs-Sarvam diarization agreement rows (one per consult) to a JSONL file.

A stratifier for the FreeScript scorer only. It is NOT part of the artifact or boundary.py.

Metric: bench-C "use 2" (e2e-lab ~/oc/nemotron-lead/bench-c/score.py:122-219), reproduced exactly:
  100 ms frames; speakers under 1 s of speech dropped; optimal 1-1 speaker mapping on overlap;
  dis = sum_f(max(|R|,|H|) - |R & map(H)|) / sum_f max(|R|,|H|), R = Sarvam, H = Nemotron.
  Higher dis = more disagreement (bench-C AUC 0.74 on PROBLEM, 0.89 on low confidence).
  diar_agreement = 1 - dis.  review_flag = dis >= 0.5 (bench-C rule, score.py:539), i.e.
  agreement <= 0.5.  The flag is decided on dis itself, so the boundary never depends on 1-dis rounding.

Inputs are read-only REB consult trees: <reb_root>/<ist_date>/<room_id>/_consults/<consult_uid>/
{manifest.json, tracks/diar.nemotron__*.json, tracks/diar.sarvam*__*.json}. Segment times are tape_utc
epoch ms; clip-relative seconds = (t0_ms - manifest.t0_ms) / 1000 (contract v0.2).

Output rows carry ids, numbers and timestamps only: no text, no names. The file is created 0600,
append-only; the latest row per consult_uid wins for readers (read_latest).

Default is --dry-run (print rows, write nothing). Pass --write to append. Standard library plus numpy;
scipy is used for the assignment when present (same optimum), else brute force like the bench.
"""
import argparse
import datetime as dt
import glob
import itertools
import json
import math
import os
import re
import stat
import sys

import numpy as np

FR = 0.1  # frame seconds (bench-C score.py:13)
REVIEW_DIS = 0.5  # bench-C rule dis >= 0.5 (score.py:539)
NEMOTRON_BASE = "nvidia/Nemotron-3-Diarization"
DEFAULT_OUT = "/home/eta/oc/nemotron/diar-agreement.jsonl"
DEFAULT_REB = os.path.join(os.path.expanduser("~"), "eta-data", "reb")
NEMOTRON_VERSION_PREFIX = "f667ed7"
NEMOTRON_PREFIX = "diar.nemotron"  # bench-C canonical(scope, 'diar.nemotron'): glob <prefix>__*.json
SARVAM_PREFIX = "diar.sarvam-saaras-v3"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FIELDS = ("consult_uid", "ist_date", "diar_agreement", "review_flag", "nemotron_model",
          "nemotron_track_id", "sarvam_track_id", "computed_at")


class InputError(ValueError):
    pass


class OutputError(RuntimeError):
    """The output file is unsafe to append to (symlink, loose mode, foreign owner, not a file)."""


# ---------------- metric (bench-C score.py:109-219) ----------------
def segs_of(track, t0, dur):
    """Clip-relative (a, b, speaker) tuples, clamped to [0, dur] (score.py:109-119)."""
    out = []
    for s in track.get("segments") or []:
        try:
            a = (s["t0_ms"] - t0) / 1000.0
            b = (s["t1_ms"] - t0) / 1000.0
            spk = str(s["speaker"])
        except (KeyError, TypeError) as e:
            raise InputError("segment missing t0_ms/t1_ms/speaker") from e
        if not (isinstance(a, float) and isinstance(b, float)) or math.isnan(a) or math.isnan(b):
            raise InputError("segment times not numeric")
        a = max(0.0, a)
        b = min(dur, b)
        if b > a:
            out.append((a, b, spk))
    out.sort()
    return out


def frames(sg, dur):
    n = int(math.ceil(dur / FR))
    A = {}
    for a, b, s in sg:
        i0 = int(round(a / FR))
        i1 = max(i0 + 1, int(round(b / FR)))
        A.setdefault(s, np.zeros(n, bool))[i0:min(n, i1)] = True
    return A, n


def best_map(O):
    """Optimal 1-1 mapping maximising summed overlap. Returns {row: col} (rows=R, cols=H)."""
    r, h = O.shape
    if r == 0 or h == 0:
        return {}
    try:
        from scipy.optimize import linear_sum_assignment
        ri, ci = linear_sum_assignment(O, maximize=True)
        return {int(i): int(j) for i, j in zip(ri, ci)}
    except ImportError:
        return best_map_brute(O)


def best_map_brute(O):
    """Verbatim bench-C algorithm (score.py:180-196)."""
    r, h = O.shape
    if r == 0 or h == 0:
        return {}
    if r <= h:
        best = (-1, None)
        for p in itertools.permutations(range(h), r):
            v = O[range(r), p].sum()
            if v > best[0]:
                best = (v, p)
        return {i: best[1][i] for i in range(r)}
    best = (-1, None)
    for p in itertools.permutations(range(r), h):
        v = O[p, range(h)].sum()
        if v > best[0]:
            best = (v, p)
    return {best[1][j]: j for j in range(h)}


def disagreement(Ar, Ah, minspk=1.0):
    """Bench-C use2 'dis' (score.py:199-210). Ar = reference (Sarvam), Ah = hypothesis (Nemotron).
    NaN when either side has no speaker with >= minspk seconds, or no speech."""
    R = [s for s in Ar if Ar[s].sum() * FR >= minspk]
    Hs = [s for s in Ah if Ah[s].sum() * FR >= minspk]
    if not R or not Hs:
        return float("nan")
    RM = np.stack([Ar[s] for s in R])
    HM = np.stack([Ah[s] for s in Hs])
    O = (RM[:, None, :] & HM[None, :, :]).sum(-1)
    mp = best_map(O)
    nr = RM.sum(0)
    nh = HM.sum(0)
    correct = sum(O[i, j] for i, j in mp.items())
    den = np.maximum(nr, nh).sum()
    return float((den - correct) / den) if den else float("nan")


def compute_dis(nemo_track, sarvam_track, t0_ms, dur_s):
    As, n = frames(segs_of(sarvam_track, t0_ms, dur_s), dur_s)
    An, _ = frames(segs_of(nemo_track, t0_ms, dur_s), dur_s)
    return disagreement(As, An)


# ---------------- row ----------------
def make_row(consult_uid, ist_date, dis, nemotron_model, nemotron_track_id, sarvam_track_id, now=None):
    if dis is None or not isinstance(dis, float) or math.isnan(dis) or not (0.0 <= dis <= 1.0):
        raise InputError("disagreement not in [0,1]")
    now = now or dt.datetime.now(dt.timezone.utc)
    return {
        "consult_uid": consult_uid,
        "ist_date": ist_date,
        "diar_agreement": round(1.0 - dis, 6),
        "review_flag": bool(dis >= REVIEW_DIS),
        "nemotron_model": nemotron_model,
        "nemotron_track_id": nemotron_track_id,
        "sarvam_track_id": sarvam_track_id,
        "computed_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


# ---------------- REB inputs ----------------
def _load_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError) as e:
        raise InputError(f"unreadable json: {os.path.basename(path)}") from e


def canonical_track(tracks_dir, prefix):
    """Latest status=ok track file for the exact prefix (glob <prefix>__*.json, as bench-C
    score.py:249-260): by extras.created_at,
    then mtime. Returns (track_dict, file_stem) or (None, None)."""
    cands = []
    for f in glob.glob(os.path.join(tracks_dir, prefix + "__*.json")):
        try:
            d = _load_json(f)
        except InputError:
            continue
        if not isinstance(d, dict) or d.get("status") != "ok":
            continue
        ca = (d.get("extras") or {}).get("created_at") or ""
        cands.append((str(ca), os.path.getmtime(f), f, d))
    if not cands:
        return None, None
    cands.sort(key=lambda x: (x[0], x[1]))
    f, d = cands[-1][2], cands[-1][3]
    return d, os.path.basename(f)[:-len(".json")]


def nemotron_model_id(track):
    """'nvidia/Nemotron-3-Diarization@f667ed7' from the track's model and version (7-char prefix)."""
    model = track.get("model")
    ver = track.get("version")
    if not isinstance(model, str) or not isinstance(ver, str) or not model or not ver:
        raise InputError("nemotron track lacks model/version")
    return f"{model}@{ver[:7]}"


def check_nemotron(track, allow_model=False):
    nemotron_model_id(track)
    if allow_model:
        return
    if track.get("model") != NEMOTRON_BASE or not str(track.get("version")).startswith(NEMOTRON_VERSION_PREFIX):
        raise InputError(f"nemotron model/version differs from {NEMOTRON_BASE}@{NEMOTRON_VERSION_PREFIX} "
                         f"(got {track.get('model')!r}@{str(track.get('version'))[:12]!r}); use --allow-model")


def _pos_finite(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and x > 0


def find_consult_dirs(reb_root, date=None, uids=None):
    pat = os.path.join(reb_root, date or "*", "*", "_consults", "*")
    out = []
    for d in sorted(glob.glob(pat)):
        if os.path.isfile(os.path.join(d, "manifest.json")):
            if uids is None or os.path.basename(d) in uids:
                out.append(d)
    return out


def row_from_consult_dir(cdir, now=None, allow_model=False):
    """Build the row for one consult dir, or return None when a track is missing. Bad input raises
    InputError (the caller logs and skips; it never aborts the run)."""
    uid = os.path.basename(cdir)
    man = _load_json(os.path.join(cdir, "manifest.json"))
    try:
        t0 = man["t0_ms"]
        dur_ms = man["audio"]["duration_ms"]
        ist_date = man["ist_date"]
    except (KeyError, TypeError) as e:
        raise InputError("manifest lacks t0_ms/audio.duration_ms/ist_date") from e
    if not _pos_finite(t0):
        raise InputError("manifest t0_ms not finite and positive")
    if not _pos_finite(dur_ms):
        raise InputError("manifest audio.duration_ms not finite and positive")
    if not isinstance(ist_date, str) or not DATE_RE.match(ist_date):
        raise InputError("manifest ist_date not YYYY-MM-DD")
    want = dt.datetime.fromtimestamp(t0 / 1000.0, IST).date().isoformat()
    if ist_date != want:
        raise InputError("manifest ist_date does not match the IST date of t0_ms")
    dur = dur_ms / 1000.0
    tdir = os.path.join(cdir, "tracks")
    nemo, nemo_id = canonical_track(tdir, NEMOTRON_PREFIX)
    sar, sar_id = canonical_track(tdir, SARVAM_PREFIX)
    if nemo is None or sar is None:
        return None
    check_nemotron(nemo, allow_model)
    dis = compute_dis(nemo, sar, t0, dur)
    if math.isnan(dis):
        raise InputError("no comparable speech (nan disagreement)")
    return make_row(uid, ist_date, dis, nemotron_model_id(nemo), nemo_id, sar_id, now)


# ---------------- JSONL store ----------------
def read_latest(path):
    """{consult_uid: row}; later lines win; malformed lines are ignored. Refuses a symlink."""
    latest = {}
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return latest
    except OSError as e:
        raise OutputError(f"cannot open output safely: {e.strerror}") from e
    with os.fdopen(fd) as fh:
        for line in fh:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if isinstance(r, dict) and isinstance(r.get("consult_uid"), str):
                latest[r["consult_uid"]] = r
    return latest


def should_skip(row, latest, force=False):
    if force:
        return False
    prev = latest.get(row["consult_uid"])
    return bool(prev and all(prev.get(k) == row[k]
                             for k in ("nemotron_model", "nemotron_track_id", "sarvam_track_id")))


def _check_fd(fd):
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        raise OutputError("output is not a regular file")
    if stat.S_IMODE(st.st_mode) != 0o600:
        raise OutputError(f"output mode is {stat.S_IMODE(st.st_mode):04o}, must be 0600")
    if st.st_uid != os.getuid():
        raise OutputError("output is not owned by the current user")
    return st


def preflight_out(path):
    """Refuse (OutputError) before any work when an existing output is unsafe. Writes nothing."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return
    except OSError as e:
        raise OutputError(f"cannot open output safely: {e.strerror}") from e
    try:
        _check_fd(fd)
    finally:
        os.close(fd)


def _write_all(fd, data):
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        view = view[n:]


def append_rows(path, rows):
    """Append-only, never truncates. Creates 0600 (umask 077, O_EXCL|O_NOFOLLOW). An existing file must
    be a regular 0600 file owned by us, else OutputError and nothing is written. Under flock, a torn
    last line (no trailing newline) is terminated first; short writes are looped."""
    if not rows:
        return 0
    preflight_out(path)
    parent = os.path.dirname(path)
    old = os.umask(0o077)
    try:
        if parent:
            os.makedirs(parent, mode=0o700, exist_ok=True)
        flags = os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW
        try:
            fd = os.open(path, flags)
        except FileNotFoundError:
            try:
                fd = os.open(path, flags | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                fd = os.open(path, flags)
    except OSError as e:
        raise OutputError(f"cannot open output safely: {e.strerror}") from e
    finally:
        os.umask(old)
    try:
        st = _check_fd(fd)
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_EX)
        size = os.fstat(fd).st_size
        buf = b""
        if size > 0 and os.pread(fd, 1, size - 1) != b"\n":
            buf = b"\n"
        buf += b"".join((json.dumps(r, separators=(",", ":")) + "\n").encode() for r in rows)
        _write_all(fd, buf)
        os.fsync(fd)
    finally:
        os.close(fd)
    return len(rows)


# ---------------- CLI ----------------
def run(reb_root, out, date=None, uids=None, force=False, write=False, now=None, log=sys.stderr,
        allow_model=False):
    if write:
        preflight_out(out)
    latest = read_latest(out)
    rows, stats = [], {"consults": 0, "rows": 0, "skipped_same": 0, "missing_track": 0, "bad_input": 0}
    for cdir in find_consult_dirs(reb_root, date, uids):
        stats["consults"] += 1
        try:
            row = row_from_consult_dir(cdir, now, allow_model)
        except InputError as e:
            stats["bad_input"] += 1
            print(f"skip {os.path.basename(cdir)}: {e}", file=log)
            continue
        if row is None:
            stats["missing_track"] += 1
            continue
        if should_skip(row, latest, force):
            stats["skipped_same"] += 1
            continue
        rows.append(row)
    stats["rows"] = len(rows)
    if write:
        append_rows(out, rows)
    return rows, stats


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--reb-root", default=DEFAULT_REB)
    ap.add_argument("--out", default=DEFAULT_OUT, metavar="PATH")
    ap.add_argument("--date", help="ist_date filter, YYYY-MM-DD")
    ap.add_argument("--consult-uid", action="append", help="repeatable")
    ap.add_argument("--allow-model", action="store_true", help="accept a Nemotron model/version other than the pinned one")
    ap.add_argument("--force", action="store_true", help="append even if the latest row has the same model and sarvam track")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dry-run", action="store_true", default=True, help="print rows, write nothing (default)")
    g.add_argument("--write", action="store_true", help="append rows to --out")
    a = ap.parse_args(argv)
    try:
        rows, stats = run(a.reb_root, a.out, a.date, set(a.consult_uid) if a.consult_uid else None,
                          a.force, write=a.write, allow_model=a.allow_model)
    except OutputError as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2
    for r in rows:
        print(json.dumps(r, separators=(",", ":")))
    print(json.dumps({"mode": "write" if a.write else "dry-run", "out": a.out, **stats}), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
