"""Patient-purity score for a Timbre window (T-1 / T-2 follow-up to the 2026-10-11 baseline).

Batch-1 labelling showed that "patient" windows often contain the doctor, a translator or an
attender. The diarizer's own segment labels do not catch this: the contaminating voice is
usually inside a segment already assigned to the patient cluster. So purity is scored per
short frame from speaker evidence, not from segment labels.

Two evidence sources, same output:

* ``embedding_purity``: per-frame speaker-embedding cosines (e.g. ECAPA on 1.5 s frames, 0.5 s
  hop). ``cos_patient`` is the frame's cosine to the clip's patient reference;
  ``cos_other`` is its best cosine to any other reference (doctor voiceprint / centroid,
  attenders, other diarized speakers). A frame is *pure patient* when
  ``cos_patient - cos_other >= margin`` and ``cos_patient >= min_cos``.
* ``probs_purity``: Nemotron per-frame speaker probabilities ``(frames, speakers)``.
  ``frame_patient_scores`` is the per-frame view: patient probability, patient dominance
  (patient minus the best other slot), and the second-highest speaker probability.
  A frame is pure patient when the patient slot is ``>= p_min``, beats every other slot
  by ``dominance``, every other slot is ``< other_max``, and the doctor voiceprint cosine
  (optional, per frame) is below ``doctor_cos_max``. The aggregate adds pure-patient
  seconds and a purity score (pure frames / active frames).

``purity`` is pure-patient frames / active frames. ``PurityRule`` is the one keep/drop
rule. ``PurityRule.judge`` runs it on ``fuse_purity``, which keeps a window only when
every supplied source still clears the rule: purity and pure-patient seconds are the
worse of the two, and the patient-cosine gate still reads the embedding score.
Defaults come from the batch-1 validation (see ``baselines/README.md``): keep a window
when purity >= 0.6, pure-patient speech >= 3 s and mean patient cosine >= 0.30.

No audio and no model is loaded here, so the fast test suite covers it.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np


class PurityError(ValueError):
    pass


@dataclass(frozen=True)
class PurityRule:
    min_purity: float = 0.6
    min_pure_s: float = 3.0
    min_cos_patient_mean: float | None = 0.30

    def passes(self, score: dict) -> bool:
        purity = score.get("purity")
        pure_s = score.get("pure_patient_s")
        if purity is None or pure_s is None or not np.isfinite(purity):
            return False
        if purity < self.min_purity or pure_s < self.min_pure_s:
            return False
        if self.min_cos_patient_mean is not None:
            cp = score.get("cos_patient_mean")
            if cp is not None and np.isfinite(cp) and cp < self.min_cos_patient_mean:
                return False
        return True

    def to_dict(self) -> dict:
        return asdict(self)

    def judge(self, embedding: dict | None = None, probs: dict | None = None) -> dict:
        """Fuse embedding and Nemotron scores, then apply this rule. See ``fuse_purity``."""
        fused = fuse_purity(embedding=embedding, probs=probs)
        fused["keep"] = self.passes(fused)
        fused["rule"] = self.to_dict()
        return fused


def embedding_purity(
    cos_patient,
    cos_other,
    *,
    hop_s: float = 0.5,
    active=None,
    margin: float = 0.10,
    min_cos: float = 0.25,
) -> dict:
    """Score one window from per-frame cosines. ``active`` masks silent frames (default: all)."""
    cp = _vec(cos_patient, "cos_patient")
    co = _vec(cos_other, "cos_other") if cos_other is not None else np.full(cp.shape, -1.0)
    if co.shape != cp.shape:
        raise PurityError("cos_patient and cos_other must have the same length")
    if hop_s <= 0:
        raise PurityError("hop_s must be > 0")
    act = np.ones(cp.shape, dtype=bool) if active is None else np.asarray(active, dtype=bool).reshape(-1)
    if act.shape != cp.shape:
        raise PurityError("active must match the frame count")
    n = int(act.sum())
    if n == 0:
        return _empty("embedding")
    dom = cp - co
    pure = act & (dom >= margin) & (cp >= min_cos)
    other = act & (co > cp)
    return {
        "source": "embedding",
        "n_frames": n,
        "purity": float(pure.sum() / n),
        "pure_patient_s": float(pure.sum() * hop_s),
        "other_frac": float(other.sum() / n),
        "dominance_mean": float(dom[act].mean()),
        "dominance_p10": float(np.percentile(dom[act], 10)),
        "cos_patient_mean": float(cp[act].mean()),
        "cos_other_max": float(co[act].max()),
    }


def frame_patient_scores(
    probs,
    patient_slot: int,
    *,
    doctor_slot: int | None = None,
    p_min: float = 0.5,
    dominance: float = 0.3,
    other_max: float = 0.3,
    active_thr: float = 0.3,
    doctor_cos=None,
    doctor_cos_max: float = 0.5,
) -> dict:
    """Per-frame patient evidence from Nemotron probabilities ``(frames, speakers)``.

    ``patient_dominance`` is the patient slot minus the best other slot.
    ``second_speaker_p`` is the second-highest probability in the frame, whoever
    it belongs to. ``pure`` is the keep mask ``probs_purity`` aggregates.
    ``doctor_slot`` is checked for range; the mask already drops a frame whose
    other slots (the doctor included) reach ``other_max``.
    """
    arr = np.asarray(probs, dtype=np.float64)
    if arr.ndim != 2 or arr.shape[1] < 1:
        raise PurityError("probs must be (frames, speakers)")
    if not np.isfinite(arr).all():
        raise PurityError("probs must be finite")
    ps = int(patient_slot)
    if not 0 <= ps < arr.shape[1]:
        raise PurityError("patient_slot out of range")
    if doctor_slot is not None and not 0 <= int(doctor_slot) < arr.shape[1]:
        raise PurityError("doctor_slot out of range")
    pp = arr[:, ps]
    others = np.delete(arr, ps, axis=1)
    max_other = others.max(axis=1) if others.shape[1] else np.zeros(arr.shape[0])
    if arr.shape[1] == 1:
        second_p = np.zeros(arr.shape[0])
    else:
        second_p = np.partition(arr, -2, axis=1)[:, -2]
    active = arr.max(axis=1) >= float(active_thr)
    pure = active & (pp >= p_min) & (pp - max_other >= dominance) & (max_other < other_max)
    if doctor_cos is not None:
        dc = _vec(doctor_cos, "doctor_cos")
        if dc.shape[0] != arr.shape[0]:
            raise PurityError("doctor_cos must match the frame count")
        pure = pure & ~(dc >= doctor_cos_max)
    return {
        "patient_p": pp,
        "max_other": max_other,
        "patient_dominance": pp - max_other,
        "second_speaker_p": second_p,
        "active": active,
        "pure": pure,
    }


def probs_purity(
    probs,
    patient_slot: int,
    *,
    frame_s: float = 0.010,
    doctor_slot: int | None = None,
    p_min: float = 0.5,
    dominance: float = 0.3,
    other_max: float = 0.3,
    active_thr: float = 0.3,
    doctor_cos=None,
    doctor_cos_max: float = 0.5,
) -> dict:
    """Score one window from Nemotron probabilities ``(frames, speakers)`` already cut to the window.

    The default ``frame_s`` is 10 ms, the production hop (the NLP1 header often
    still says 80 ms; use ``NlpLoad.frame_ms`` from ``load_nlp``).
    """
    if frame_s <= 0:
        raise PurityError("frame_s must be > 0")
    frames = frame_patient_scores(
        probs,
        patient_slot,
        doctor_slot=doctor_slot,
        p_min=p_min,
        dominance=dominance,
        other_max=other_max,
        active_thr=active_thr,
        doctor_cos=doctor_cos,
        doctor_cos_max=doctor_cos_max,
    )
    active = frames["active"]
    pure = frames["pure"]
    n = int(active.sum())
    if n == 0:
        return _empty("probs")
    arr = np.asarray(probs, dtype=np.float64)
    pp = frames["patient_p"]
    max_other = frames["max_other"]
    second = active & ((arr >= active_thr).sum(axis=1) >= 2)
    out = {
        "source": "probs",
        "n_frames": n,
        "purity": float(pure.sum() / n),
        "pure_patient_s": float(pure.sum() * frame_s),
        "other_frac": float((active & (max_other > pp)).sum() / n),
        "overlap_s": float(second.sum() * frame_s),
        "dominance_mean": float(frames["patient_dominance"][active].mean()),
        "second_speaker_p_mean": float(frames["second_speaker_p"][active].mean()),
        "second_speaker_p_max": float(frames["second_speaker_p"][active].max()),
        "cos_patient_mean": None,
    }
    if doctor_slot is not None:
        out["doctor_s"] = float((active & (arr[:, int(doctor_slot)] >= active_thr)).sum() * frame_s)
    return out


def fuse_purity(embedding: dict | None = None, probs: dict | None = None) -> dict:
    """One score from ``embedding_purity`` and ``probs_purity``.

    Pass either or both. Purity and pure-patient seconds are the minimum of the
    supplied sources, and ``other_frac`` is the maximum: a window is only as
    pure as the worse evidence. The patient-cosine mean comes from the embedding
    score. Second-speaker probability, overlap and doctor seconds come from the
    Nemotron score. Dominance is not merged — a cosine margin and a probability
    margin are different units — so a fused score leaves ``dominance_mean`` unset
    and keeps ``dominance_embedding`` / ``dominance_probs``.
    """
    if embedding is None and probs is None:
        raise PurityError("fuse_purity needs an embedding score, a probs score, or both")
    parts = [s for s in (embedding, probs) if s is not None]
    for s in parts:
        if "purity" not in s or "pure_patient_s" not in s:
            raise PurityError("score is missing purity or pure_patient_s")
    purities = [s.get("purity") for s in parts]
    if any(p is None or not np.isfinite(p) for p in purities):
        purity = None
        pure_s = float(min(float(s.get("pure_patient_s") or 0.0) for s in parts))
    else:
        purity = float(min(float(p) for p in purities))
        pure_s = float(min(float(s["pure_patient_s"]) for s in parts))
    out = {
        "source": "fused" if embedding is not None and probs is not None else parts[0].get("source"),
        "n_frames": int(min(int(s.get("n_frames") or 0) for s in parts)),
        "purity": purity,
        "pure_patient_s": pure_s,
        "other_frac": _finite_agg([s.get("other_frac") for s in parts], max),
        "cos_patient_mean": None,
        "dominance_mean": None,
    }
    if embedding is not None:
        out["cos_patient_mean"] = embedding.get("cos_patient_mean")
        out["dominance_embedding"] = embedding.get("dominance_mean")
    if probs is not None:
        out["dominance_probs"] = probs.get("dominance_mean")
        for key in ("second_speaker_p_mean", "second_speaker_p_max", "overlap_s", "doctor_s"):
            if key in probs:
                out[key] = probs[key]
        if embedding is None:
            out["cos_patient_mean"] = probs.get("cos_patient_mean")
    if len(parts) == 1:
        out["dominance_mean"] = parts[0].get("dominance_mean")
    return out


def auroc_low_is_positive(score, positive) -> float | None:
    """AUROC for "low purity flags a contaminated window". Ties count half. None if one class is empty."""
    s = _vec(score, "score")
    y = np.asarray(positive, dtype=bool).reshape(-1)
    if y.shape != s.shape:
        raise PurityError("score and positive must have the same length")
    m = np.isfinite(s)
    s, y = s[m], y[m]
    n1, n0 = int(y.sum()), int((~y).sum())
    if n1 == 0 or n0 == 0:
        return None
    neg = -s  # higher = more contaminated
    greater = (neg[y][:, None] > neg[~y][None, :]).sum()
    ties = (neg[y][:, None] == neg[~y][None, :]).sum()
    return float((greater + 0.5 * ties) / (n1 * n0))


def threshold_table(score, positive, thresholds) -> list[dict]:
    """Keep/drop counts per threshold (keep = score >= threshold). Aggregates only."""
    s = _vec(score, "score")
    y = np.asarray(positive, dtype=bool).reshape(-1)
    rows = []
    for t in thresholds:
        keep = np.isfinite(s) & (s >= float(t))
        rows.append(
            {
                "threshold": float(t),
                "kept": int(keep.sum()),
                "kept_frac": float(keep.mean()) if keep.size else None,
                "positives_dropped": int((~keep & y).sum()),
                "positives": int(y.sum()),
                "negatives_dropped": int((~keep & ~y).sum()),
                "negatives": int((~y).sum()),
            }
        )
    return rows


def _finite_agg(values, fn):
    xs = [float(v) for v in values if v is not None and np.isfinite(v)]
    if not xs:
        return None
    return float(fn(xs))


def _vec(v, name: str) -> np.ndarray:
    arr = np.asarray(v, dtype=np.float64).reshape(-1)
    if arr.size == 0:
        raise PurityError(f"{name} is empty")
    return arr


def _empty(source: str) -> dict:
    return {
        "source": source,
        "n_frames": 0,
        "purity": None,
        "pure_patient_s": 0.0,
        "other_frac": None,
        "cos_patient_mean": None,
    }
