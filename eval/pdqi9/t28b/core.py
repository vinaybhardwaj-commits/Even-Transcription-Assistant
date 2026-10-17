"""T28b / T28b-LOO / T28b-nd impostor false-accept harness. Offline only: files in, files out.

Arm (c) semantics (INFERRED, no record-only source in this repo):
  For label L and candidate centroid C in one consult,
    cos           = cosine(L, C)
    margin_next   = cos(L, C) - max over OTHER labels L' of cos(L', C)
    margin_runner = cos(L, C) - max over OTHER centroids C' (in the allowed set) of cos(L, C')
  A label passes arm (c) iff cos >= 0.65 AND margin_next >= 0.05 AND margin_runner >= 0.05.
  No other centroid: margin_runner is +inf (passes). No other label (one-label consult):
  the next-label margin passes only with one_label_pass, otherwise the arm abstains.
  Thresholds are compared with a 1e-6 tolerance so float32 centroids exactly on a threshold survive.

Truth is never derived from a voiceprint. It comes from a truth file (see load_truth).
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from dataclasses import dataclass

import numpy as np

COS_MIN = 0.65
MARGIN_NEXT_MIN = 0.05
MARGIN_RUNNER_MIN = 0.05
EPS = 1e-6
MIN_TRIALS_DEFAULT = 2736
TRUTH_SOURCES = ("role_votes_3of3", "manual")
GATE_POINT_MAX = 0.002
GATE_UPPER_MAX = 0.005

PKG_DIR = os.path.dirname(os.path.abspath(__file__))


class DisjointnessError(RuntimeError):
    pass


class InsufficientTrials(RuntimeError):
    pass


class InputError(RuntimeError):
    """Bad input. Messages carry counts and file roles only, never uids."""


def thresholds(one_label_pass: bool) -> dict:
    return {"cos_min": COS_MIN, "margin_next_min": MARGIN_NEXT_MIN, "margin_runner_min": MARGIN_RUNNER_MIN,
            "eps": EPS, "one_label_pass": bool(one_label_pass),
            "gate_point_max": GATE_POINT_MAX, "gate_upper_max": GATE_UPPER_MAX,
            "truth_sources": list(TRUTH_SOURCES)}


# ---------------------------------------------------------------- uids, files

def norm_uid(s) -> str:
    if not isinstance(s, str):
        raise InputError("non-string uid in input")
    return s.replace("﻿", "").strip().lower()


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_private(path: str, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    os.chmod(path, 0o600)


def prepare_out_dir(path: str, *, must_exist: bool = False) -> None:
    """Output dir is 0700. An existing dir with wider permissions is refused."""
    if os.path.exists(path):
        if os.stat(path).st_mode & 0o077:
            raise InputError("output dir exists with permissions wider than 0700")
    elif must_exist:
        raise InputError("output dir does not exist")
    else:
        os.makedirs(path, mode=0o700)
        os.chmod(path, 0o700)


def load_json_lines(path: str) -> list[dict]:
    with open(path, encoding="utf-8-sig") as fh:
        return [json.loads(line.lstrip("﻿")) for line in fh if line.strip()]


def load_manifest(path: str) -> list[dict]:
    rows = []
    seen = set()
    dups = 0
    for r in load_json_lines(path):
        row = dict(r)
        row["consult_uid"] = norm_uid(r["consult_uid"])
        row["doctor_uid"] = norm_uid(r["doctor_uid"])
        row["logged_in_doctor_uid"] = norm_uid(r.get("logged_in_doctor_uid", r["doctor_uid"]))
        if row["consult_uid"] in seen:
            dups += 1
        seen.add(row["consult_uid"])
        rows.append(row)
    if dups:
        raise InputError(f"{dups} duplicate manifest rows after uid normalisation")
    return rows


def load_exclude(path: str) -> set[str]:
    """Exclude list: one uid per line, or jsonl rows carrying consult_uid. Normalised."""
    out = set()
    with open(path, encoding="utf-8-sig") as fh:
        for line in fh:
            line = line.replace("﻿", "").strip()
            if not line:
                continue
            out.add(norm_uid(json.loads(line)["consult_uid"]) if line.startswith("{") else norm_uid(line))
    return out


def load_truth(path: str) -> dict[str, tuple[str, str]]:
    """Truth rows {consult_uid, label, source}; source must be in TRUTH_SOURCES."""
    out: dict[str, tuple[str, str]] = {}
    bad = dups = 0
    for r in load_json_lines(path):
        if r.get("source") not in TRUTH_SOURCES or not isinstance(r.get("label"), str):
            bad += 1
            continue
        u = norm_uid(r["consult_uid"])
        if u in out:
            dups += 1
        out[u] = (r["label"], r["source"])
    if bad:
        raise InputError(f"{bad} truth rows with a missing label or a source outside {list(TRUTH_SOURCES)}")
    if dups:
        raise InputError(f"{dups} duplicate truth rows after uid normalisation")
    return out


def _unit(v) -> np.ndarray:
    a = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(a)
    return a / n if n > 0 else a


def _vec_ok(a: np.ndarray) -> bool:
    return bool(np.all(np.isfinite(a)) and np.linalg.norm(a) > 0)


def decode_centroid(b64: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(b64), dtype="<f4").astype(np.float64)


def load_centroids(path: str) -> tuple[dict[str, np.ndarray], int]:
    """Returns (unit centroids by normalised uid, count of bad vectors)."""
    with open(path, encoding="utf-8-sig") as fh:
        rows = json.load(fh)
    out, bad, dups = {}, 0, 0
    for r in rows:
        u = norm_uid(r["pulse_doctor_uid"])
        v = decode_centroid(r["b64"])
        if u in out:
            dups += 1
        if not _vec_ok(v):
            bad += 1
            continue
        out[u] = _unit(v)
    if dups:
        raise InputError(f"{dups} duplicate centroid rows after uid normalisation")
    return out, bad


class VecsLoader:
    """Per-row vectors_path falls back to a default file; files are loaded once, consult keys normalised."""

    def __init__(self, default_path: str | None):
        self.default_path = default_path
        self._cache: dict[str, dict] = {}

    @staticmethod
    def path_for(row: dict, default: str | None) -> str | None:
        return row.get("vectors_path") or default

    def _load(self, path: str) -> dict:
        if path not in self._cache:
            with open(path, encoding="utf-8-sig") as fh:
                raw = json.load(fh)
            norm = {}
            for k, v in raw.items():
                nk = norm_uid(k)
                if nk in norm:
                    raise InputError("duplicate consult keys in a vectors file after uid normalisation")
                norm[nk] = v
            self._cache[path] = norm
        return self._cache[path]

    def get(self, row: dict) -> dict | None:
        path = self.path_for(row, self.default_path)
        return None if path is None else self._load(path).get(row["consult_uid"])

    def paths(self, manifest: list[dict]) -> list[str]:
        return sorted({p for p in (self.path_for(r, self.default_path) for r in manifest) if p})


def validate_vectors(manifest: list[dict], loader: VecsLoader, cents: dict[str, np.ndarray],
                     bad_centroids: int) -> None:
    """NaN, inf, zero-norm or wrong-dimension vectors abort the run with a count."""
    bad = bad_centroids
    dims = {len(v) for v in cents.values()}
    for row in manifest:
        v = loader.get(row)
        if not v:
            continue
        for vec in v.values():
            a = np.asarray(vec, dtype=np.float64)
            if a.ndim != 1 or not _vec_ok(a) or (dims and len(a) not in dims):
                bad += 1
    if len(dims) > 1:
        bad += 1
    if bad:
        raise InputError(f"{bad} non-finite, zero-norm or wrong-dimension vectors")


# ---------------------------------------------------------------- arm (c)

def arm_c_matrix(S: np.ndarray, centroid_mask: np.ndarray, one_label_pass: bool = False):
    """S is labels x centroids cosines. centroid_mask marks the runner-up set (bool, len = centroids).

    Returns (margin_next, margin_runner), both labels x centroids.
    """
    L, C = S.shape
    if L > 1:
        order = np.sort(S, axis=0)
        top, second = order[-1], order[-2]
        other_best = np.where(S >= top[None, :], second[None, :], top[None, :])
        margin_next = S - other_best
    else:
        margin_next = np.full_like(S, np.inf if one_label_pass else -np.inf)
    margin_runner = np.full_like(S, np.inf)
    for c in range(C):
        others = [j for j in range(C) if j != c and centroid_mask[j]]
        if others:
            margin_runner[:, c] = S[:, c] - S[:, others].max(axis=1)
    return margin_next, margin_runner


def passes(cos, mn, mr) -> np.ndarray:
    return (
        (np.asarray(cos) >= COS_MIN - EPS)
        & (np.asarray(mn) >= MARGIN_NEXT_MIN - EPS)
        & (np.asarray(mr) >= MARGIN_RUNNER_MIN - EPS)
    )


@dataclass
class Consult:
    uid: str
    doctor_uid: str
    logged_in_uid: str
    labels: list[str]
    L: np.ndarray  # labels x d, unit rows


def build_consult(row: dict, vecs_for_consult: dict) -> Consult:
    labels = sorted(vecs_for_consult)
    return Consult(row["consult_uid"], row["doctor_uid"], row["logged_in_doctor_uid"], labels,
                   np.array([_unit(vecs_for_consult[k]) for k in labels]))


# ---------------------------------------------------------------- trial set

def assert_disjoint(selected_consults, exclude: set[str]) -> None:
    clash = {norm_uid(s) for s in selected_consults} & {norm_uid(e) for e in exclude}
    if clash:
        raise DisjointnessError(f"{len(clash)} selected consults are in the exclude list")


def build_universe(manifest, exclude, truth, loader, cents, *, one_label_pass=False,
                   exclude_unmatched_ok=False):
    """Returns (T28b universe rows, nd trial rows, counts). Everything is uid-normalised already."""
    manifest_uids = {r["consult_uid"] for r in manifest}
    unmatched = len(exclude - manifest_uids)
    if unmatched and not exclude_unmatched_ok:
        raise InputError(f"{unmatched} exclusion uids matched no manifest consult "
                         "(pass --exclude-unmatched-ok to accept)")
    counts = {"manifest": len(manifest), "exclude_entries": len(exclude), "exclude_unmatched": unmatched,
              "dropped_excluded": 0, "no_truth": 0, "no_vectors": 0, "truth_label_not_in_vectors": 0,
              "one_label_consults": 0, "no_impostors": 0, "no_logged_in_centroid": 0,
              "consults_scored": 0, "truth_rows_not_in_manifest": len(set(truth) - manifest_uids),
              "truth_by_source": {s: 0 for s in TRUTH_SOURCES}}
    kept = []
    for row in manifest:
        if row["consult_uid"] in exclude:
            counts["dropped_excluded"] += 1
        else:
            kept.append(row)
    assert_disjoint([r["consult_uid"] for r in kept], exclude)
    cent_uids = sorted(cents)
    universe, nd = [], []
    for row in sorted(kept, key=lambda r: r["consult_uid"]):
        if row["consult_uid"] not in truth:
            counts["no_truth"] += 1
            continue
        v = loader.get(row)
        if not v:
            counts["no_vectors"] += 1
            continue
        label, source = truth[row["consult_uid"]]
        if label not in v:
            counts["truth_label_not_in_vectors"] += 1
            continue
        if len(v) == 1 and not one_label_pass:
            counts["one_label_consults"] += 1
            continue
        if len(v) == 1:
            counts["one_label_consults"] += 1  # counted either way; scored under --one-label-pass
        counts["consults_scored"] += 1
        counts["truth_by_source"][source] += 1
        true_uids = {row["doctor_uid"], row["logged_in_doctor_uid"]}
        imps = [u for u in cent_uids if u not in true_uids]
        if not imps:
            counts["no_impostors"] += 1
        else:
            universe.append({"consult_uid": row["consult_uid"], "doctor_uid": row["doctor_uid"],
                             "logged_in_doctor_uid": row["logged_in_doctor_uid"],
                             "label": label, "impostors": imps})
        if row["logged_in_doctor_uid"] in cents:
            for other in sorted(v):
                if other != label:
                    nd.append({"consult_uid": row["consult_uid"], "doctor_uid": row["doctor_uid"],
                               "logged_in_doctor_uid": row["logged_in_doctor_uid"], "label": other,
                               "centroid_uid": row["logged_in_doctor_uid"]})
        else:
            counts["no_logged_in_centroid"] += 1
    counts["universe_trials"] = sum(len(u["impostors"]) for u in universe)
    counts["nd_trials"] = len(nd)
    return universe, nd, counts


def sample_trials(universe: list[dict], target: int, seed: int) -> list[dict]:
    total = sum(len(u["impostors"]) for u in universe)
    k = min(target, total)
    rng = np.random.default_rng(seed)
    picks = np.sort(rng.choice(total, size=k, replace=False)) if k < total else np.arange(total)
    starts = np.cumsum([0] + [len(u["impostors"]) for u in universe])
    out, ci = [], 0
    for p in picks:
        while p >= starts[ci + 1]:
            ci += 1
        u = universe[ci]
        out.append({"consult_uid": u["consult_uid"], "doctor_uid": u["doctor_uid"],
                    "logged_in_doctor_uid": u["logged_in_doctor_uid"], "label": u["label"],
                    "centroid_uid": u["impostors"][int(p - starts[ci])]})
    return out


# ---------------------------------------------------------------- prereg identity

def git_head(start: str = PKG_DIR) -> str | None:
    """HEAD commit read straight from .git (no subprocess). None if not in a checkout."""
    d = os.path.abspath(start)
    while True:
        g = os.path.join(d, ".git")
        if os.path.isdir(g):
            break
        if os.path.dirname(d) == d:
            return None
        d = os.path.dirname(d)
    try:
        head = open(os.path.join(g, "HEAD")).read().strip()
        if not head.startswith("ref: "):
            return head
        ref = head[5:]
        p = os.path.join(g, ref)
        if os.path.exists(p):
            return open(p).read().strip()
        for line in open(os.path.join(g, "packed-refs")):
            if line.strip().endswith(" " + ref):
                return line.split()[0]
    except OSError:
        pass
    return None


def code_identity() -> dict:
    h = hashlib.sha256()
    for name in sorted(os.listdir(PKG_DIR)):
        if name.endswith(".py"):
            h.update(name.encode())
            h.update(open(os.path.join(PKG_DIR, name), "rb").read())
    return {"code_sha256": h.hexdigest(), "git_commit": git_head()}


def input_hashes(paths: dict, manifest: list[dict], loader: VecsLoader) -> dict:
    """sha256 of manifest, every vectors file, centroids (file includes enrolment metadata), truth, exclude."""
    out = {k: sha256_file(paths[k]) for k in ("manifest", "centroids", "truth", "exclude")}
    out["vectors"] = {p: sha256_file(p) for p in loader.paths(manifest)}
    return out


# ---------------------------------------------------------------- scoring

def _by_consult(trials):
    d: dict[str, list[dict]] = {}
    for t in trials:
        d.setdefault(t["consult_uid"], []).append(t)
    return d


def _f(x):
    x = float(x)
    return None if np.isinf(x) else x


def score_trials(trials: list[dict], nd_trials: list[dict], loader, manifest, cents, one_label_pass):
    """Return (T28b/LOO scored rows, nd scored rows)."""
    rows = {r["consult_uid"]: r for r in manifest}
    cent_uids = sorted(cents)
    cidx = {u: i for i, u in enumerate(cent_uids)}
    C = np.array([cents[u] for u in cent_uids])
    imp_by, nd_by = _by_consult(trials), _by_consult(nd_trials)
    out_imp, out_nd = [], []
    for cu in sorted(set(imp_by) | set(nd_by)):
        consult = build_consult(rows[cu], loader.get(rows[cu]))
        S = consult.L @ C.T
        all_mask = np.ones(len(cent_uids), dtype=bool)
        mn, mr_std = arm_c_matrix(S, all_mask, one_label_pass)
        loo_mask = all_mask.copy()
        for u in {consult.doctor_uid, consult.logged_in_uid}:
            if u in cidx:
                loo_mask[cidx[u]] = False  # true centroid(s) leave the runner-up set; candidates never masked
        _, mr_loo = arm_c_matrix(S, loo_mask, one_label_pass)
        for t in imp_by.get(cu, []):
            li, ci = consult.labels.index(t["label"]), cidx[t["centroid_uid"]]
            cos = float(S[li, ci])
            out_imp.append({**t, "cos": cos, "margin_next": _f(mn[li, ci]),
                            "margin_runner_std": _f(mr_std[li, ci]), "margin_runner_loo": _f(mr_loo[li, ci]),
                            "fa_std": bool(passes(cos, mn[li, ci], mr_std[li, ci])),
                            "fa_loo": bool(passes(cos, mn[li, ci], mr_loo[li, ci]))})
        for t in nd_by.get(cu, []):
            li, ci = consult.labels.index(t["label"]), cidx[t["centroid_uid"]]
            cos = float(S[li, ci])
            out_nd.append({**t, "cos": cos, "margin_next": _f(mn[li, ci]),
                           "margin_runner_std": _f(mr_std[li, ci]),
                           "fa": bool(passes(cos, mn[li, ci], mr_std[li, ci]))})
    return out_imp, out_nd
