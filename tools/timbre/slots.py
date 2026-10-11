"""Which Nemotron probability column is the doctor, and which is the patient.

Column ``i`` of the probability matrix is NeMo ``speaker_i`` — the tensor
``diarize_with_probs`` stores, packed by ``pack_nlp``. ETA's stored turn label
``spkN`` is not that index. ``tools/nemotron-worker/worker.py`` ``to_turns``
renames model labels to ``spk0``, ``spk1``, … in first-speech order, and
``lib/diarize-nemotron/identity.ts`` matches voiceprints on those labels.
``align_labels`` recovers the column by a majority vote of the dominant
probability column inside each turn. A bare ``spkN`` is never treated as a
column index.

The doctor is named the way the room path names one:

* an ETA identity row with a clinician id and a cosine at or above 0.65
  (``DIARIZE_BATCH_THRESHOLD`` in ``lib/stt/diarize-window.ts``), or
* the slot whose ECAPA embedding — the mean over that slot's dominant frames,
  or a vector the caller already pooled — has cosine at least 0.65 to the
  doctor centroid and leads the next slot by 0.05
  (``PULSE_ROOM_MIN_MARGIN`` in ``lib/diarize-nemotron/identity.ts``).

A failed ETA claim does not fall through to the centroid: the production
signal spoke. If the two name different slots, the decision is ``ambiguous``
and no patient windows are cut. The patient is the non-doctor slot with the
most exclusive talk. A runner-up with at least 75% of that talk (a translator
who spoke almost as long) is ``ambiguous`` too.

No audio and no model is loaded here. Embeddings are arrays the caller supplies.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# lib/stt/diarize-window.ts DIARIZE_BATCH_THRESHOLD
DOCTOR_COS_MIN = 0.65
# lib/diarize-nemotron/identity.ts PULSE_ROOM_MIN_MARGIN
DOCTOR_COS_MARGIN = 0.05
# Runner-up talk / patient talk at or above this is not "the" patient.
PATIENT_RIVAL_FRAC = 0.75
_MARGIN_EPS = 1e-6


class SlotError(ValueError):
    pass


@dataclass(frozen=True)
class SlotDecision:
    """``status`` is ``ok`` only when both slots are safe to cut audio from.

    ``doctor_slot`` / ``patient_slot`` are set when that role's own rule passed.
    A doctor can be known while the patient is still ambiguous (two non-doctor
    voices). ``candidate_*`` keeps the best guess either way. Windows code must
    read ``status``, not the candidate fields.
    """

    status: str
    reason: str
    confidence: float
    doctor_slot: int | None
    patient_slot: int | None
    doctor_source: str
    doctor_cosine: float | None
    runner_up_cosine: float | None
    centroid_slot: int | None
    centroid_cosine: float | None
    candidate_doctor_slot: int | None
    candidate_patient_slot: int | None
    patient_talk_s: float
    rival_talk_s: float
    talk_s: tuple[float, ...]
    label_to_slot: dict[str, int]

    @property
    def accepted(self) -> bool:
        return self.status == "ok" and self.doctor_slot is not None and self.patient_slot is not None


def cosine(a, b) -> float:
    """Dot / (|a| |b|). A zero vector is 0, matching ``lib/stt/losing-score.ts``."""
    av = np.asarray(a, dtype=np.float64).reshape(-1)
    bv = np.asarray(b, dtype=np.float64).reshape(-1)
    if av.shape != bv.shape or av.size == 0:
        raise SlotError("embedding and centroid must be the same non-empty length")
    if not np.isfinite(av).all() or not np.isfinite(bv).all():
        raise SlotError("embedding and centroid must be finite")
    na = float(np.linalg.norm(av))
    nb = float(np.linalg.norm(bv))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return float(np.dot(av, bv) / (na * nb))


def exclusive_talk_s(probs, frame_ms: float, thr: float = 0.5) -> np.ndarray:
    """Seconds per column where that column is the only one at or above ``thr``."""
    arr = _matrix(probs)
    if frame_ms <= 0:
        raise SlotError("frame_ms must be > 0")
    above = arr >= float(thr)
    single = above.sum(axis=1) == 1
    winner = np.argmax(arr, axis=1)
    counts = np.bincount(winner[single], minlength=arr.shape[1]).astype(np.float64)
    return counts * (float(frame_ms) / 1000.0)


def align_labels(probs, turns, frame_ms: float, thr: float = 0.5) -> dict[str, int]:
    """Map an ETA ``spkN`` (or any turn label) to a probability column.

    Each turn votes for the column that is the unique speaker at or above
    ``thr`` on its frames. The winner must be strictly ahead of the next
    column; a tie leaves the label unmapped. ``frame_ms`` is the resolved hop,
    and turn times are milliseconds from the same origin as the matrix.
    """
    arr = _matrix(probs)
    if frame_ms <= 0:
        raise SlotError("frame_ms must be > 0")
    votes: dict[str, np.ndarray] = {}
    n = arr.shape[0]
    for turn in turns:
        start_ms, end_ms, label = _parse_turn(turn)
        if end_ms <= start_ms:
            continue
        a = max(0, int(np.floor(start_ms / float(frame_ms))))
        b = min(n, int(np.ceil(end_ms / float(frame_ms))))
        if b <= a:
            continue
        sl = arr[a:b]
        single = (sl >= float(thr)).sum(axis=1) == 1
        winner = np.argmax(sl, axis=1)
        counts = votes.setdefault(label, np.zeros(arr.shape[1], dtype=np.int64))
        if np.any(single):
            counts += np.bincount(winner[single], minlength=arr.shape[1])
    out: dict[str, int] = {}
    for label, counts in votes.items():
        if int(counts.sum()) == 0:
            continue
        order = np.argsort(-counts, kind="stable")
        best = int(order[0])
        if counts.size > 1 and int(counts[int(order[1])]) == int(counts[best]):
            continue
        out[label] = best
    return out


def map_slots(
    probs,
    *,
    frame_ms: float,
    slot_embeddings=None,
    frame_embeddings=None,
    doctor_centroid=None,
    eta_doctor=None,
    turns=None,
    doctor_slot: int | None = None,
    patient_slot: int | None = None,
    cos_min: float = DOCTOR_COS_MIN,
    cos_margin: float = DOCTOR_COS_MARGIN,
    talk_thr: float = 0.5,
    rival_frac: float = PATIENT_RIVAL_FRAC,
    dominant_thr: float = 0.5,
) -> SlotDecision:
    """Name the doctor column and the patient column.

    Pass ``doctor_slot`` and ``patient_slot`` together to skip the match (an
    operator override). Otherwise pass an ETA identity (``eta_doctor``) and/or
    ECAPA vectors plus ``doctor_centroid``. ``frame_embeddings`` is
    ``(frames, dim)`` and is mean-pooled over each column's dominant frames.
    ``slot_embeddings`` is ``(speakers, dim)``, already pooled.
    """
    arr = _matrix(probs)
    if frame_ms <= 0:
        raise SlotError("frame_ms must be > 0")
    if not 0.0 <= float(cos_min) <= 1.0 or float(cos_margin) < 0:
        raise SlotError("cos_min must be in [0, 1] and cos_margin >= 0")
    if not 0.0 < float(rival_frac) <= 1.0:
        raise SlotError("rival_frac must be in (0, 1]")
    talk = exclusive_talk_s(arr, frame_ms, talk_thr)
    label_to_slot = align_labels(arr, turns, frame_ms, talk_thr) if turns is not None else {}
    if doctor_slot is not None or patient_slot is not None:
        return _given(arr.shape[1], doctor_slot, patient_slot, talk, label_to_slot)

    eta = _read_eta(eta_doctor, arr.shape[1], label_to_slot, float(cos_min))
    if eta.present and eta.reason:
        return _pack(
            status="ambiguous",
            reason=eta.reason,
            candidate_doctor_slot=eta.slot,
            doctor_cosine=eta.cosine,
            doctor_source="eta",
            talk_s=talk,
            label_to_slot=label_to_slot,
        )

    cent = _centroid_doctor(
        arr,
        talk,
        slot_embeddings=slot_embeddings,
        frame_embeddings=frame_embeddings,
        doctor_centroid=doctor_centroid,
        cos_min=float(cos_min),
        cos_margin=float(cos_margin),
        dominant_thr=float(dominant_thr),
    )
    if eta.present and eta.slot is not None:
        if cent.slot is not None and cent.slot != eta.slot:
            return _pack(
                status="ambiguous",
                reason="eta_centroid_disagree",
                doctor_cosine=eta.cosine,
                runner_up_cosine=cent.runner_up,
                centroid_slot=cent.slot,
                centroid_cosine=cent.cosine,
                candidate_doctor_slot=eta.slot,
                doctor_source="eta",
                talk_s=talk,
                label_to_slot=label_to_slot,
            )
        return _with_patient(
            doctor=eta.slot,
            source="eta",
            doctor_cosine=float(eta.cosine),
            runner_up=cent.runner_up,
            centroid_slot=cent.slot,
            centroid_cosine=cent.cosine,
            talk=talk,
            rival_frac=float(rival_frac),
            label_to_slot=label_to_slot,
        )
    if cent.slot is not None:
        return _with_patient(
            doctor=cent.slot,
            source="centroid",
            doctor_cosine=float(cent.cosine),
            runner_up=cent.runner_up,
            centroid_slot=cent.slot,
            centroid_cosine=cent.cosine,
            talk=talk,
            rival_frac=float(rival_frac),
            label_to_slot=label_to_slot,
        )
    if cent.reason:
        return _pack(
            status="ambiguous",
            reason=cent.reason,
            doctor_cosine=cent.cosine,
            runner_up_cosine=cent.runner_up,
            centroid_cosine=cent.cosine,
            candidate_doctor_slot=cent.candidate,
            doctor_source="centroid",
            talk_s=talk,
            label_to_slot=label_to_slot,
        )
    return _pack(
        status="ambiguous",
        reason="no_doctor_evidence",
        talk_s=talk,
        label_to_slot=label_to_slot,
    )


@dataclass(frozen=True)
class _Eta:
    present: bool
    slot: int | None
    cosine: float | None
    reason: str | None


@dataclass(frozen=True)
class _Cent:
    slot: int | None
    cosine: float | None
    runner_up: float | None
    candidate: int | None
    reason: str | None


def _given(n_speakers: int, doctor_slot, patient_slot, talk, label_to_slot) -> SlotDecision:
    if doctor_slot is None or patient_slot is None:
        raise SlotError("pass doctor_slot and patient_slot together")
    ds, ps = int(doctor_slot), int(patient_slot)
    if not (0 <= ds < n_speakers and 0 <= ps < n_speakers):
        raise SlotError("slot out of range")
    if ds == ps:
        raise SlotError("doctor_slot and patient_slot are the same")
    return _pack(
        status="ok",
        reason="ok",
        confidence=1.0,
        doctor_slot=ds,
        patient_slot=ps,
        doctor_source="given",
        candidate_doctor_slot=ds,
        candidate_patient_slot=ps,
        patient_talk_s=float(talk[ps]),
        talk_s=talk,
        label_to_slot=label_to_slot,
    )


def _with_patient(*, doctor, source, doctor_cosine, runner_up, centroid_slot, centroid_cosine, talk, rival_frac, label_to_slot):
    patient, rival, reason, candidate = _choose_patient(talk, doctor, rival_frac)
    if reason:
        return _pack(
            status="ambiguous",
            reason=reason,
            doctor_slot=doctor,
            doctor_source=source,
            doctor_cosine=doctor_cosine,
            runner_up_cosine=runner_up,
            centroid_slot=centroid_slot,
            centroid_cosine=centroid_cosine,
            candidate_doctor_slot=doctor,
            candidate_patient_slot=candidate,
            rival_talk_s=rival,
            talk_s=talk,
            label_to_slot=label_to_slot,
        )
    patient_talk = float(talk[patient])
    confidence = _confidence(doctor_cosine, patient_talk, rival)
    return _pack(
        status="ok",
        reason="ok",
        confidence=confidence,
        doctor_slot=doctor,
        patient_slot=patient,
        doctor_source=source,
        doctor_cosine=doctor_cosine,
        runner_up_cosine=runner_up,
        centroid_slot=centroid_slot,
        centroid_cosine=centroid_cosine,
        candidate_doctor_slot=doctor,
        candidate_patient_slot=patient,
        patient_talk_s=patient_talk,
        rival_talk_s=rival,
        talk_s=talk,
        label_to_slot=label_to_slot,
    )


def _choose_patient(talk: np.ndarray, doctor_slot: int, rival_frac: float):
    order = sorted((s for s in range(talk.size) if s != int(doctor_slot)), key=lambda s: (-float(talk[s]), s))
    if not order or float(talk[order[0]]) <= 0.0:
        return None, 0.0, "no_patient_speech", None
    best = order[0]
    rival = float(talk[order[1]]) if len(order) > 1 else 0.0
    if rival >= float(rival_frac) * float(talk[best]):
        return None, rival, "patient_rival", best
    return best, rival, None, best


def _confidence(doctor_cosine: float, patient_talk: float, rival_talk: float) -> float:
    if patient_talk <= 0.0:
        return 0.0
    patient_conf = max(0.0, min(1.0, 1.0 - (rival_talk / patient_talk)))
    doctor_conf = max(0.0, min(1.0, float(doctor_cosine)))
    return float(min(doctor_conf, patient_conf))


def _read_eta(eta, n_speakers: int, label_to_slot: dict[str, int], cos_min: float) -> _Eta:
    if eta is None:
        return _Eta(False, None, None, None)
    if isinstance(eta, dict):
        rows = [eta]
        claims = rows  # a single object is the doctor claim, id optional
    elif isinstance(eta, (list, tuple)):
        rows = list(eta)
        claims = [r for r in rows if _has_clinician(r)]
        if not claims:
            return _Eta(False, None, None, None)
    else:
        raise SlotError("eta_doctor must be a dict or a list of dicts")
    if len(claims) > 1:
        return _Eta(True, None, None, "eta_two_clinicians")
    row = claims[0]
    if not isinstance(row, dict):
        raise SlotError("eta_doctor rows must be dicts")
    slot, reason = _eta_slot(row, n_speakers, label_to_slot)
    cosine_v = row.get("cosine", row.get("match_confidence"))
    if reason:
        cos = None
        if cosine_v is not None:
            cos = _as_cos(cosine_v)
        return _Eta(True, slot, cos, reason)
    if cosine_v is None:
        return _Eta(True, slot, None, "eta_missing_cosine")
    cos = _as_cos(cosine_v)
    if cos < cos_min:
        return _Eta(True, slot, cos, "eta_below_threshold")
    return _Eta(True, slot, cos, None)


def _has_clinician(row) -> bool:
    if not isinstance(row, dict):
        raise SlotError("eta_doctor rows must be dicts")
    cid = row.get("clinician_id")
    return isinstance(cid, str) and cid.strip() != ""


def _as_cos(value) -> float:
    try:
        cos = float(value)
    except (TypeError, ValueError) as e:
        raise SlotError("eta cosine is not a number") from e
    if not np.isfinite(cos):
        raise SlotError("eta cosine must be finite")
    return cos


def _eta_slot(row: dict, n_speakers: int, label_to_slot: dict[str, int]) -> tuple[int | None, str | None]:
    column = None
    if "slot" in row and row["slot"] is not None:
        column = int(row["slot"])
    elif "speaker_idx" in row and row["speaker_idx"] is not None:
        column = int(row["speaker_idx"])
    label = row.get("speaker_label")
    mapped = None
    if isinstance(label, str) and label != "":
        if label not in label_to_slot:
            return column, "eta_label_unaligned"
        mapped = label_to_slot[label]
    if column is None and mapped is None:
        raise SlotError("eta doctor claim needs slot or speaker_label")
    if column is not None and mapped is not None and column != mapped:
        return column, "eta_slot_label_conflict"
    slot = column if column is not None else mapped
    if slot is None or not 0 <= int(slot) < n_speakers:
        raise SlotError("eta doctor slot out of range")
    return int(slot), None


def _centroid_doctor(
    probs,
    talk,
    *,
    slot_embeddings,
    frame_embeddings,
    doctor_centroid,
    cos_min: float,
    cos_margin: float,
    dominant_thr: float,
) -> _Cent:
    if slot_embeddings is None and frame_embeddings is None and doctor_centroid is None:
        return _Cent(None, None, None, None, None)
    if doctor_centroid is None:
        raise SlotError("doctor_centroid is required when embeddings are passed")
    if slot_embeddings is None and frame_embeddings is None:
        raise SlotError("slot_embeddings or frame_embeddings is required when a centroid is passed")
    if slot_embeddings is not None and frame_embeddings is not None:
        raise SlotError("pass slot_embeddings or frame_embeddings, not both")
    emb, present = _slot_matrix(probs, slot_embeddings, frame_embeddings, dominant_thr)
    centroid = np.asarray(doctor_centroid, dtype=np.float64).reshape(-1)
    scored: list[tuple[int, float]] = []
    for s in range(emb.shape[0]):
        if not present[s] or float(talk[s]) <= 0.0:
            continue
        scored.append((s, cosine(emb[s], centroid)))
    if not scored:
        return _Cent(None, None, None, None, None)
    scored.sort(key=lambda sc: (-sc[1], sc[0]))
    best_s, best_c = scored[0]
    runner = scored[1][1] if len(scored) > 1 else None
    if best_c < cos_min:
        return _Cent(None, best_c, runner, best_s, "centroid_below_threshold")
    if runner is not None and (best_c - runner) < (cos_margin - _MARGIN_EPS):
        return _Cent(None, best_c, runner, best_s, "centroid_margin")
    return _Cent(best_s, best_c, runner, best_s, None)


def _slot_matrix(probs, slot_embeddings, frame_embeddings, dominant_thr: float):
    n = probs.shape[1]
    if slot_embeddings is not None:
        emb = np.asarray(slot_embeddings, dtype=np.float64)
        if emb.ndim != 2 or emb.shape[0] != n or emb.shape[1] < 1:
            raise SlotError("slot_embeddings must be (speakers, dim)")
        if not np.isfinite(emb).all():
            raise SlotError("slot_embeddings must be finite")
        present = np.linalg.norm(emb, axis=1) > 0.0
        return emb, present
    fe = np.asarray(frame_embeddings, dtype=np.float64)
    if fe.ndim != 2 or fe.shape[0] != probs.shape[0] or fe.shape[1] < 1:
        raise SlotError("frame_embeddings must be (frames, dim)")
    if not np.isfinite(fe).all():
        raise SlotError("frame_embeddings must be finite")
    emb = np.zeros((n, fe.shape[1]), dtype=np.float64)
    present = np.zeros(n, dtype=bool)
    for s in range(n):
        mask = _dominant(probs, s, dominant_thr)
        if not np.any(mask):
            continue
        emb[s] = fe[mask].mean(axis=0)
        present[s] = True
    return emb, present


def _dominant(probs, slot: int, thr: float) -> np.ndarray:
    above = probs >= float(thr)
    single = above.sum(axis=1) == 1
    return single & (np.argmax(probs, axis=1) == int(slot))


def _pack(
    *,
    status: str,
    reason: str,
    confidence: float = 0.0,
    doctor_slot: int | None = None,
    patient_slot: int | None = None,
    doctor_source: str = "none",
    doctor_cosine: float | None = None,
    runner_up_cosine: float | None = None,
    centroid_slot: int | None = None,
    centroid_cosine: float | None = None,
    candidate_doctor_slot: int | None = None,
    candidate_patient_slot: int | None = None,
    patient_talk_s: float = 0.0,
    rival_talk_s: float = 0.0,
    talk_s=(),
    label_to_slot=None,
) -> SlotDecision:
    talk = tuple(float(x) for x in talk_s)
    return SlotDecision(
        status=status,
        reason=reason,
        confidence=float(confidence),
        doctor_slot=doctor_slot,
        patient_slot=patient_slot,
        doctor_source=doctor_source,
        doctor_cosine=None if doctor_cosine is None else float(doctor_cosine),
        runner_up_cosine=None if runner_up_cosine is None else float(runner_up_cosine),
        centroid_slot=centroid_slot,
        centroid_cosine=None if centroid_cosine is None else float(centroid_cosine),
        candidate_doctor_slot=candidate_doctor_slot,
        candidate_patient_slot=candidate_patient_slot,
        patient_talk_s=float(patient_talk_s),
        rival_talk_s=float(rival_talk_s),
        talk_s=talk,
        label_to_slot=dict(label_to_slot or {}),
    )


def _matrix(probs) -> np.ndarray:
    arr = np.asarray(probs, dtype=np.float64)
    if arr.ndim != 2 or arr.shape[0] < 1 or arr.shape[1] < 1:
        raise SlotError("probs must be (frames, speakers) with at least one frame")
    if not np.isfinite(arr).all():
        raise SlotError("probs must be finite")
    return arr


def _parse_turn(turn) -> tuple[int, int, str]:
    if isinstance(turn, dict):
        label = turn.get("speaker_label", turn.get("label"))
        try:
            return int(turn["start_ms"]), int(turn["end_ms"]), str(label)
        except (KeyError, TypeError, ValueError) as e:
            raise SlotError("turn must be {start_ms, end_ms, speaker_label}") from e
    if isinstance(turn, (list, tuple)) and len(turn) == 3:
        try:
            return int(turn[0]), int(turn[1]), str(turn[2])
        except (TypeError, ValueError) as e:
            raise SlotError("turn must be [start_ms, end_ms, label]") from e
    raise SlotError("turn must be [start_ms, end_ms, label]")
