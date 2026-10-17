"""T28b / T28b-LOO impostor false-accept harness. Offline only: files in, files out.

Arm (c) semantics (INFERRED from the brief, no record-only source in this repo):
  For label L and candidate centroid C in one consult,
    cos           = cosine(L, C)
    margin_next   = cos(L, C) - max over OTHER labels L' of cos(L', C)
    margin_runner = cos(L, C) - max over OTHER centroids C' (in the allowed set) of cos(L, C')
  A label passes arm (c) iff cos >= 0.65 AND margin_next >= 0.05 AND margin_runner >= 0.05.
  With no other label (or no other centroid) the margin is +inf, i.e. it passes.
  Thresholds are compared with a 1e-6 tolerance so float32 centroids sitting exactly on a
  threshold are not lost to rounding.
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


class DisjointnessError(RuntimeError):
    pass


class InsufficientTrials(RuntimeError):
    pass


def _unit(v) -> np.ndarray:
    a = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(a)
    return a / n if n > 0 else a


def decode_centroid(b64: str) -> np.ndarray:
    return _unit(np.frombuffer(base64.b64decode(b64), dtype="<f4").astype(np.float64))


def load_centroids(path: str) -> dict[str, np.ndarray]:
    with open(path) as fh:
        rows = json.load(fh)
    return {r["pulse_doctor_uid"]: decode_centroid(r["b64"]) for r in rows}


def load_json_lines(path: str) -> list[dict]:
    with open(path) as fh:
        return [json.loads(line) for line in fh if line.strip()]


def load_uid_list(path: str) -> set[str]:
    """Exclude list: one uid per line, or jsonl rows carrying consult_uid."""
    out = set()
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            if line.startswith("{"):
                out.add(json.loads(line)["consult_uid"])
            else:
                out.add(line)
    return out


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


# ---------------------------------------------------------------- arm (c)

def arm_c_matrix(S: np.ndarray, centroid_mask: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """S is labels x centroids cosines. centroid_mask marks the runner-up set (bool, len = centroids).

    Returns (margin_next, margin_runner) matrices, both labels x centroids.
    """
    L, C = S.shape
    if L > 1:
        order = np.sort(S, axis=0)
        top, second = order[-1], order[-2]
        other_best = np.where(S >= top[None, :], second[None, :], top[None, :])
        # ties: if two labels share the max, the other best equals the max (handled by >= vs second)
        margin_next = S - other_best
    else:
        margin_next = np.full_like(S, np.inf)
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
    return Consult(
        uid=row["consult_uid"],
        doctor_uid=row["doctor_uid"],
        logged_in_uid=row.get("logged_in_doctor_uid", row["doctor_uid"]),
        labels=labels,
        L=np.array([_unit(vecs_for_consult[k]) for k in labels]),
    )


def cos_matrix(consult: Consult, cent_uids: list[str], cents: dict[str, np.ndarray]) -> np.ndarray:
    C = np.array([cents[u] for u in cent_uids])
    return consult.L @ C.T


def derive_truth(consult: Consult, cent_uids: list[str], cents: dict[str, np.ndarray]) -> str | None:
    """The label that passes arm (c) for the logged-in doctor with both margins."""
    if consult.logged_in_uid not in cents or consult.L.shape[0] == 0:
        return None
    S = cos_matrix(consult, cent_uids, cents)
    mn, mr = arm_c_matrix(S, np.ones(len(cent_uids), dtype=bool))
    j = cent_uids.index(consult.logged_in_uid)
    ok = passes(S[:, j], mn[:, j], mr[:, j])
    hits = np.flatnonzero(ok)
    return consult.labels[int(hits[0])] if len(hits) == 1 else None


# ---------------------------------------------------------------- trial set

def assert_disjoint(selected_consults, exclude: set[str]) -> None:
    clash = set(selected_consults) & exclude
    if clash:
        raise DisjointnessError(f"{len(clash)} selected consults are in the exclude list")


def build_universe(
    manifest: list[dict], exclude: set[str], vecs_loader, cents: dict[str, np.ndarray]
) -> tuple[list[dict], dict]:
    """Return (universe rows, counts). Each row: consult, truth label, impostor uid list."""
    counts = {
        "manifest": len(manifest),
        "dropped_excluded": 0,
        "no_vectors": 0,
        "no_truth": 0,
        "consults_with_truth": 0,
    }
    cent_uids = sorted(cents)
    kept = []
    for row in manifest:
        if row["consult_uid"] in exclude:
            counts["dropped_excluded"] += 1
        else:
            kept.append(row)
    assert_disjoint([r["consult_uid"] for r in kept], exclude)
    truth_file = vecs_loader.truth
    universe = []
    for row in sorted(kept, key=lambda r: r["consult_uid"]):
        v = vecs_loader.get(row)
        if not v:
            counts["no_vectors"] += 1
            continue
        consult = build_consult(row, v)
        if truth_file is not None:
            label = truth_file.get(consult.uid)
            if label not in consult.labels:
                label = None
        else:
            label = derive_truth(consult, cent_uids, cents)
        if label is None:
            counts["no_truth"] += 1
            continue
        true_uids = {consult.doctor_uid, consult.logged_in_uid}
        imps = [u for u in cent_uids if u not in true_uids]
        if not imps:
            counts["no_truth"] += 1
            continue
        counts["consults_with_truth"] += 1
        universe.append({"consult_uid": consult.uid, "doctor_uid": consult.doctor_uid,
                         "logged_in_doctor_uid": consult.logged_in_uid,
                         "label": label, "impostors": imps})
    counts["universe_trials"] = sum(len(u["impostors"]) for u in universe)
    return universe, counts


def sample_trials(universe: list[dict], target: int, seed: int) -> list[dict]:
    total = sum(len(u["impostors"]) for u in universe)
    k = min(target, total)
    rng = np.random.default_rng(seed)
    picks = np.sort(rng.choice(total, size=k, replace=False)) if k < total else np.arange(total)
    starts = np.cumsum([0] + [len(u["impostors"]) for u in universe])
    out = []
    ci = 0
    for p in picks:
        while p >= starts[ci + 1]:
            ci += 1
        u = universe[ci]
        out.append({"consult_uid": u["consult_uid"], "doctor_uid": u["doctor_uid"],
                    "logged_in_doctor_uid": u["logged_in_doctor_uid"], "label": u["label"],
                    "impostor_uid": u["impostors"][int(p - starts[ci])]})
    return out


def write_prereg(out_dir: str, trials: list[dict], *, seed: int, target: int, counts: dict,
                 exclude_path: str, manifest_path: str) -> tuple[str, str]:
    trials_path = os.path.join(out_dir, "prereg_trials.jsonl")
    write_private(trials_path, "".join(json.dumps(t, sort_keys=True) + "\n" for t in trials))
    sha = sha256_file(trials_path)
    meta = {
        "seed": seed,
        "target_trials": target,
        "achieved_trials": len(trials),
        "trial_list_sha256": sha,
        "exclude_sha256": sha256_file(exclude_path) if exclude_path else None,
        "manifest_sha256": sha256_file(manifest_path),
        "counts": counts,
    }
    write_private(os.path.join(out_dir, "prereg.json"), json.dumps(meta, indent=2, sort_keys=True) + "\n")
    write_private(os.path.join(out_dir, "prereg.sha256"), f"{sha}  prereg_trials.jsonl\n")
    return trials_path, sha


# ---------------------------------------------------------------- scoring

def score_trials(trials_path: str, expected_sha: str, vecs_loader, manifest: list[dict],
                 cents: dict[str, np.ndarray]) -> list[dict]:
    """Score the preregistered trial list. Refuses a list whose sha differs from the prereg."""
    if sha256_file(trials_path) != expected_sha:
        raise RuntimeError("trial list changed after preregistration")
    trials = load_json_lines(trials_path)
    rows = {r["consult_uid"]: r for r in manifest}
    cent_uids = sorted(cents)
    cidx = {u: i for i, u in enumerate(cent_uids)}
    by_consult: dict[str, list[dict]] = {}
    for t in trials:
        by_consult.setdefault(t["consult_uid"], []).append(t)
    out = []
    for cu in sorted(by_consult):
        consult = build_consult(rows[cu], vecs_loader.get(rows[cu]))
        S = cos_matrix(consult, cent_uids, cents)
        all_mask = np.ones(len(cent_uids), dtype=bool)
        mn, mr_std = arm_c_matrix(S, all_mask)
        loo_mask = all_mask.copy()
        for u in {consult.doctor_uid, consult.logged_in_uid}:
            if u in cidx:
                loo_mask[cidx[u]] = False
        # LOO: true centroid(s) leave the runner-up set. Candidate impostor columns are never masked.
        _, mr_loo = arm_c_matrix(S, loo_mask)
        for t in by_consult[cu]:
            li, ci = consult.labels.index(t["label"]), cidx[t["impostor_uid"]]
            cos = float(S[li, ci])
            fa_std = bool(passes(cos, mn[li, ci], mr_std[li, ci]))
            fa_loo = bool(passes(cos, mn[li, ci], mr_loo[li, ci]))
            out.append({**t, "cos": cos, "margin_next": _f(mn[li, ci]),
                        "margin_runner_std": _f(mr_std[li, ci]), "margin_runner_loo": _f(mr_loo[li, ci]),
                        "fa_std": fa_std, "fa_loo": fa_loo})
    return out


def _f(x) -> float | None:
    x = float(x)
    return None if np.isinf(x) else x


class VecsLoader:
    """Per-row vectors_path falls back to a default file; files are loaded once."""

    def __init__(self, default_path: str | None, truth: dict[str, str] | None = None):
        self.default_path = default_path
        self.truth = truth
        self._cache: dict[str, dict] = {}

    def get(self, row: dict) -> dict | None:
        path = row.get("vectors_path") or self.default_path
        if path is None:
            return None
        if path not in self._cache:
            with open(path) as fh:
                self._cache[path] = json.load(fh)
        return self._cache[path].get(row["consult_uid"])
