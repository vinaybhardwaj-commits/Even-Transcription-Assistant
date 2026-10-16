"""tools/timbre/role_clef.py — Clef-omni role labels pick the Nemotron slots of a no-voiceprint consult part (CLEF-D2-R4).

Dark and suggest-only. For ONE consult PART (the prepared 16 kHz audio plus its Nemotron probabilities, as
``nightly_prepare`` writes them) every Nemotron slot with at least ``MIN_SLOT_SPEECH_S`` of dominant speech is cut into up to
``MAX_SNIPPETS`` snippets of ``SNIPPET_MIN_S``..``SNIPPET_MAX_S`` (dominant frames only, time order, spread over the part) and
sent in ONE Clef-omni call (``role``, a score question over doctor / patient / attender or family / other staff). The slots
are then chosen by named thresholds; otherwise there is NO decision and the part keeps its ``no_voiceprint`` row. Never guess.

Clef-omni is reached only through the existing Clef lane (``ClefClient``: transport, retries, cost log, ``TIMBRE_CLEF`` gate).
What leaves the host is the model name, the fixed state sentence, the question and the audio snippets. No transcript text, no
ids, no names. Output per part: ``{clip_id, doctor_slot, patient_slot, decided, reason_code, n_calls, input_tokens}`` and
nothing else (no per-slot probabilities). Logs carry codes and counts only.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
from pathlib import Path

import numpy as np

from tools.timbre.audio import TARGET_SR
from tools.timbre.extractors import clef_omni as clef
from tools.timbre.slots import _dominant

log = logging.getLogger("tools.timbre.role_clef")

ROLE_QUESTION_SET = "timbre-role-v1"
ROLE_STATE = "Clinic consultation audio. All clips are the same speaker. Decide who this speaker is."
ROLE_CRITERIA = ("doctor", "patient", "attender or family", "other staff")
ROLE_SOURCE = "clef_omni"

MIN_SLOT_SPEECH_S = 6.0  # a slot needs this much dominant speech to be asked about
MAX_SNIPPETS = 3
SNIPPET_MIN_S = 4.0
SNIPPET_MAX_S = 10.0
MIN_RUN_S = 0.3  # a dominant run shorter than this is not used (it is a splice artefact, not speech)
P_DOCTOR_MIN = 0.6
DOCTOR_MARGIN_MIN = 0.2  # over the next slot's p(doctor)
P_PATIENT_MIN = 0.6
DOMINANT_THR = 0.5

# reason codes
DECIDED = "decided"
SLOTS_LT2 = "slots_lt2"  # fewer than two slots have enough speech: no call is made
DOCTOR_P_LOW = "doctor_p_low"
DOCTOR_MARGIN = "doctor_margin"
PATIENT_P_LOW = "patient_p_low"
CALL_FAILED = "call_failed"
BUDGET = "budget"
NO_INPUT = "no_input"


def dominant_audio(probs: np.ndarray, frame_ms: float, wav: np.ndarray, slot: int) -> np.ndarray:
    """The slot's dominant-frame audio, runs of at least MIN_RUN_S joined in time order."""
    p = np.asarray(probs, dtype=np.float64)
    mask = _dominant(p, int(slot), DOMINANT_THR)
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    starts, ends = np.where(d == 1)[0], np.where(d == -1)[0]
    hop = float(frame_ms) / 1000.0
    pieces = []
    for a, b in zip(starts, ends):
        if (b - a) * hop < MIN_RUN_S:
            continue
        x = wav[int(round(a * hop * TARGET_SR)): int(round(b * hop * TARGET_SR))]
        if len(x):
            pieces.append(np.asarray(x, dtype=np.float32))
    return np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)


def snippets_for(dom: np.ndarray) -> list[np.ndarray]:
    """Up to MAX_SNIPPETS snippets (SNIPPET_MIN_S..SNIPPET_MAX_S) taken at even offsets across the slot's dominant audio."""
    total_s = len(dom) / TARGET_SR
    if total_s < MIN_SLOT_SPEECH_S:
        return []
    n = int(min(MAX_SNIPPETS, total_s // SNIPPET_MIN_S))
    n = max(n, 1)
    length_s = min(SNIPPET_MAX_S, total_s / n)
    out = []
    for i in range(n):
        a = int(round(i * (total_s / n) * TARGET_SR))
        out.append(dom[a: a + int(round(length_s * TARGET_SR))])
    return out


def qualifying_slots(probs: np.ndarray, frame_ms: float, wav: np.ndarray) -> dict[int, list[np.ndarray]]:
    """slot -> snippets, for every slot with at least MIN_SLOT_SPEECH_S of dominant speech."""
    p = np.asarray(probs, dtype=np.float64)
    out = {}
    for s in range(p.shape[1]):
        snips = snippets_for(dominant_audio(p, frame_ms, wav, s))
        if snips:
            out[s] = snips
    return out


def choose_slots(p_doctor: dict[int, float], p_patient: dict[int, float]) -> tuple[int | None, int | None, str]:
    """(doctor_slot, patient_slot, reason_code) from per-slot p(doctor) and p(patient). Ties break to the lower slot."""
    ranked = sorted(p_doctor, key=lambda s: (-p_doctor[s], s))
    best = ranked[0]
    second = p_doctor[ranked[1]] if len(ranked) > 1 else 0.0
    if p_doctor[best] < P_DOCTOR_MIN:
        return None, None, DOCTOR_P_LOW
    if p_doctor[best] - second < DOCTOR_MARGIN_MIN:
        return None, None, DOCTOR_MARGIN
    others = sorted((s for s in p_patient if s != best), key=lambda s: (-p_patient[s], s))
    if not others or p_patient[others[0]] < P_PATIENT_MIN:
        return None, None, PATIENT_P_LOW
    return best, others[0], DECIDED


class RoleClient(clef.ClefClient):
    """The Clef lane's client (transport, retries, cost log, TIMBRE_CLEF gate) asking the ``role`` question.

    ``ClefClient._post`` sends ``self.prepare([wav])``; this subclass swaps in the role body for one call at a time.
    """

    def __init__(self, **kw):
        kw.setdefault("question_set", ROLE_QUESTION_SET)
        super().__init__(**kw)
        self._role_lock = threading.Lock()
        self._role_wavs: list[bytes] = []

    def prepare(self, wavs):
        account, token = clef.resolve_account_id(), clef.resolve_token()
        wavs = self._role_wavs or wavs
        return clef.Prepared(
            url=clef.run_url(account),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            body=role_body(wavs),
        )

    def ask_role(self, snippets: list[np.ndarray]) -> tuple[list[float], int]:
        """ONE call for one slot: (probabilities over ROLE_CRITERIA, input tokens)."""
        clef.require_enabled()
        wavs = [clef.encode_wav(s, TARGET_SR) for s in snippets]
        sha = hashlib.sha256(b"".join(wavs)).hexdigest()
        with self._role_lock:
            self._role_wavs = wavs
            try:
                if clef.mock_enabled():
                    payload = mock_role_payload(sha)
                else:
                    payload, _status, _attempts = self._post(b"")
            finally:
                self._role_wavs = []
        inner = clef.unwrap_result(payload)
        answers = inner.get("answers")
        probs = clef.ordered_score_probs(answers.get("role") if isinstance(answers, dict) else None, ROLE_CRITERIA)
        in_tok, out_tok = clef.usage_tokens(inner)
        mock = clef.mock_enabled()
        self._record(sha, input_tokens=in_tok, output_tokens=out_tok, cost_usd=0.0 if mock else clef.input_cost_usd(in_tok),
                     billed=not mock, cached=False, mock=mock, parsed=True, http_status=200, latency_s=0.0, attempts=1)
        return probs, int(in_tok)


def role_questions() -> dict:
    return {"role": {"type": "score", "instructions": "Who is this speaker?", "criteria": list(ROLE_CRITERIA)}}


def role_body(wavs: list[bytes]) -> dict:
    if not 1 <= len(wavs) <= clef.MAX_CLIPS:
        raise clef.ClefLimitError(f"clef accepts 1 to {clef.MAX_CLIPS} audio clips per call")
    return {"model": clef.MODEL_NAME, "state": ROLE_STATE, "audio": [clef.wav_data_uri(w) for w in wavs], "questions": role_questions()}


def mock_role_payload(sha: str) -> dict:
    """Deterministic offline mock (TIMBRE_CLEF_MOCK=1): a valid distribution from the clip hash."""
    raw = [1.0 + int(sha[i * 2: i * 2 + 2], 16) for i in range(len(ROLE_CRITERIA))]
    tot = sum(raw)
    return {"success": True, "result": {"answers": {"role": {"probabilities": {str(i): v / tot for i, v in enumerate(raw)}}}, "usage": {"input_tokens": 0, "output_tokens": 0}}}


def decide_part(clip_id: str, wav: np.ndarray, probs: np.ndarray, frame_ms: float, client, *, budget_left_usd: float | None = None) -> dict:
    """Role decision for one part. ``client.ask_role(snippets) -> (probabilities, input_tokens)``; one call per qualifying slot."""
    result = {"clip_id": clip_id, "doctor_slot": None, "patient_slot": None, "decided": False, "reason_code": NO_INPUT, "n_calls": 0, "input_tokens": 0}
    slots = qualifying_slots(probs, frame_ms, wav)
    if len(slots) < 2:
        result["reason_code"] = SLOTS_LT2
        return result
    p_doctor, p_patient = {}, {}
    spent = 0.0
    for s in sorted(slots):
        if budget_left_usd is not None and spent >= budget_left_usd:
            result["reason_code"] = BUDGET
            return result
        result["n_calls"] += 1
        try:
            p, tokens = client.ask_role(slots[s])
        except (clef.ClefError, ValueError):
            result["reason_code"] = CALL_FAILED
            log.info("role_clef call_failed slot_calls=%d", result["n_calls"])
            return result
        result["input_tokens"] += int(tokens)
        spent += clef.input_cost_usd(int(tokens))
        p_doctor[s], p_patient[s] = float(p[0]), float(p[1])
    ds, ps, code = choose_slots(p_doctor, p_patient)
    result.update({"doctor_slot": ds, "patient_slot": ps, "decided": code == DECIDED, "reason_code": code})
    return result


def decide_parts(prepared_clips: list[dict], prep_dir: Path, client, *, budget_usd: float | None = None) -> dict[str, dict]:
    """Role decisions for every prepared part (audio in prep_dir/audio, probabilities in prep_dir/nlp). Keyed by clip_id."""
    import soundfile as sf

    from tools.timbre.nemotron_probs import NlpError, load_nlp

    out: dict[str, dict] = {}
    spent = 0.0
    for c in prepared_clips:
        cid = c["clip_id"]
        dur = float(c.get("duration_s") or 0.0)
        try:
            wav, sr = sf.read(str(Path(prep_dir) / "audio" / f"{cid}.wav"), dtype="float32")
            loaded = load_nlp(Path(prep_dir) / "nlp" / f"{cid}.nlp", expected_duration_s=dur, tol_s=max(5.0, 0.05 * dur))
            if sr != TARGET_SR or wav.ndim != 1:
                raise ValueError("audio is not 16 kHz mono")
        except (OSError, ValueError, NlpError):
            out[cid] = {"clip_id": cid, "doctor_slot": None, "patient_slot": None, "decided": False, "reason_code": NO_INPUT, "n_calls": 0, "input_tokens": 0}
            continue
        left = None if budget_usd is None else max(0.0, budget_usd - spent)
        rec = decide_part(cid, wav, loaded.probs, float(loaded.frame_ms), client, budget_left_usd=left)
        spent += clef.input_cost_usd(rec["input_tokens"])
        out[cid] = rec
    return out


def summarize(roles: dict[str, dict]) -> dict:
    """Counts only: parts, decided, calls, tokens, usd (at the Clef input rate) and a count per reason code."""
    codes: dict[str, int] = {}
    for r in roles.values():
        codes[r["reason_code"]] = codes.get(r["reason_code"], 0) + 1
    tokens = sum(int(r["input_tokens"]) for r in roles.values())
    return {"role_parts": len(roles), "role_decided": sum(1 for r in roles.values() if r["decided"]), "role_calls": sum(int(r["n_calls"]) for r in roles.values()),
            "role_input_tokens": tokens, "role_cost_usd": round(clef.input_cost_usd(tokens), 6), "role_reasons": dict(sorted(codes.items()))}


def write_roles(roles: dict[str, dict], path: Path) -> Path:
    path.write_text(json.dumps(roles, sort_keys=True), encoding="utf-8")
    return path


def load_roles(path: str) -> dict[str, dict]:
    """The ``--clef-roles`` file: ``{clip_id: {doctor_slot, patient_slot, decided, ...}}``. Only decided entries are kept."""
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("clef roles file must be a JSON object keyed by clip_id")
    out = {}
    for cid, r in raw.items():
        if isinstance(r, dict) and r.get("decided") is True and isinstance(r.get("doctor_slot"), int) and isinstance(r.get("patient_slot"), int):
            out[str(cid)] = {"doctor_slot": int(r["doctor_slot"]), "patient_slot": int(r["patient_slot"])}
    return out
