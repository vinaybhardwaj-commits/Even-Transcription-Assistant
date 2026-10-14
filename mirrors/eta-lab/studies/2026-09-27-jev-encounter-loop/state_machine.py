"""state_machine.py — README §C: a small two-state machine (IN_ENCOUNTER / BETWEEN) over each chunk's
Jev answer + regex candidate hits, then snap placed boundaries to the nearest acoustic activity edge
(segmenter.py's own edge detection — reuse, not reimplement). Pure functions, offline-testable.
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "2026-09-24-encounter-first"))
import segmenter as S  # noqa: E402
import jev_loop_constants as K  # noqa: E402


def _signals(answer, cand):
    """(open_signal, close_signal, patient_present) for one chunk. `answer` is None when the chunk had no
    Jev call (translation_missing) — falls back to the regex candidates only, and never forces a close just
    because translation was missing (unlike an explicit close signal, silence about the phase is not evidence)."""
    if answer is None:
        return cand["opening"], cand["closing"], True
    probs = answer["phase_probs"] or {}
    open_signal = (answer["nouls"]["opening"] >= K.OPEN_NOUL_T
                   or probs.get("greeting_or_opening", 0) >= K.OPEN_PHASE_T
                   or cand["opening"])
    close_signal = (answer["nouls"]["closing"] >= K.CLOSE_NOUL_T
                    or probs.get("closing_or_follow_up_instructions", 0) >= K.CLOSE_PHASE_T
                    or answer["phase"] in K.NON_ENCOUNTER_PHASES
                    or cand["closing"])
    present = answer["nouls"]["patient_present"] >= K.PATIENT_PRESENT_T
    return open_signal, close_signal, present


def run(chunks, answers, candidates):
    """chunks/answers/candidates are parallel lists (chunker.build_chunks output, jev_client.answer_chunk
    output or None, candidates.hits output). Returns (states, encounters:[{start_ms,end_ms,
    back_to_back_start,back_to_back_end}]) — encounters are NOT yet snapped (see snap_boundaries).

    back_to_back_start/end (eta-refuter-2 #4633, a declared bias not a bug): when a chunk both closes
    one encounter and opens the next (S1), the split falls at that whole chunk's boundary rather than
    at the true moment inside it — the new consult's start (and the old one's end) is then off by up
    to one chunk's length (<=CHUNK_TARGET_MS) unless snapping finds a real edge. These flags let the
    scorer report that error separately (PREREG §2), instead of averaging it invisibly into the rest."""
    state, cur_start, cur_is_reopen, states, encounters = "BETWEEN", None, False, [], []
    for ch, a, c in zip(chunks, answers, candidates):
        open_signal, close_signal, present = _signals(a, c)
        if state == "BETWEEN" and open_signal and present:
            state, cur_start, cur_is_reopen = "IN_ENCOUNTER", ch["start_ms"], False
        label = state  # the chunk that TRIGGERS a close is still part of the encounter it closes
        if state == "IN_ENCOUNTER" and (close_signal or not present):
            reopens = open_signal and present  # S1: does THIS SAME chunk immediately start the next one?
            encounters.append({"start_ms": cur_start, "end_ms": ch["end_ms"],
                                "back_to_back_start": cur_is_reopen, "back_to_back_end": reopens})
            state, cur_start = "BETWEEN", None
            # S1 (eta-refuter-2 #4612): a single 60s chunk can BOTH close one encounter and open the
            # next ("take care ... next, please sit") — the open check above only ran while state was
            # still BETWEEN-from-the-PREVIOUS-chunk, so it never saw this chunk's own opening signal.
            # Re-check now, in the same chunk, or the new consult silently loses its start.
            if reopens:
                state, cur_start, cur_is_reopen = "IN_ENCOUNTER", ch["start_ms"], True
        states.append(label)
    if state == "IN_ENCOUNTER" and cur_start is not None:
        # the room-day ends mid-encounter: close at the last chunk seen, never invent a later end
        encounters.append({"start_ms": cur_start, "end_ms": chunks[-1]["end_ms"],
                            "back_to_back_start": cur_is_reopen, "back_to_back_end": False})
    return states, encounters


def snap_boundaries(encounters, levels, labels, date, window_ms=None):
    """Snap each start/end to the nearest activity edge from segmenter.py's own S.edges()/S.nearest() (README
    §C — reuse, not reimplement). `levels`/`labels` are the room-day's raw inputs, same shape segmenter.py's
    other callers (arm_d.py, encounter_bounds.py) already pass.

    Minor (eta-refuter-2 #4612): a snap can invert a span (end pulled before start) or push one
    encounter into its neighbour. Both are guarded here rather than left for the scorer to choke on."""
    window_ms = window_ms or K.SNAP_WINDOW_MS
    carry = ("back_to_back_start", "back_to_back_end")  # pass these through snapping untouched
    if levels:
        on, off, _, _ = S.edges(levels, date)
        xs = sorted(on + off)
        out = []
        for e in encounters:
            s = S.nearest(xs, e["start_ms"], window_ms)
            s = e["start_ms"] if s is None else s
            e2 = S.nearest(xs, e["end_ms"], window_ms)
            e2 = e["end_ms"] if e2 is None else e2
            if e2 <= s:  # the snap inverted the span: distrust it entirely, keep the un-snapped edges
                s, e2 = e["start_ms"], e["end_ms"]
            out.append({"start_ms": s, "end_ms": e2, **{k: e[k] for k in carry if k in e}})
    else:
        out = [dict(e) for e in encounters]
    for i in range(1, len(out)):  # a snap must never push one encounter into its predecessor's span
        if out[i]["start_ms"] < out[i - 1]["end_ms"]:
            out[i]["start_ms"] = out[i - 1]["end_ms"]
    for i, e in enumerate(out):
        if e["end_ms"] <= e["start_ms"]:
            raise SystemExit(f"STAGE_FAIL snap_boundaries: inverted/empty span after clamping at index {i}: {e}")
        e["id"] = f"jevloop-{i}"
    return out
