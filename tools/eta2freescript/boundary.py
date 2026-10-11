"""Clip-boundary guard: find turns that belong to the previous or next patient, and quarantine them.

A consult clip is cut from continuous room audio, so its edges can carry the end of the previous consult or the start of
the next one. Orders taken from those turns would go into the wrong patient's prescription. Signals, all deterministic:

  role_track_two_consults  the role track's extras.two_consults flag. With gap_at_s, the clip is split there and the
                           side with less speech is quarantined; without it the artifact is only flagged.
  second_patient_voice     two or more speaker labels the role track calls "patient". A secondary patient voice whose
                           turns all sit in the first or last EDGE_FRAC of the clip and never interleave with the main
                           patient's turns quarantines the edge span up to (or from) that voice. Interleaved: flag only.
  long_gap                 a silence of at least GAP_S between turns, with the shorter side inside an edge and holding
                           under EDGE_FRAC of the speech. Quarantined only when the short side also has a speaker who is
                           not heard on the long side, or Stage A marked a turn there as foreign; else flag only.
  stage_a_topic            Stage A's consult_boundary.foreign_turns (a topic discontinuity: another complaint, another
                           name, a goodbye then a new greeting). Applied after Stage A.

Quarantined turns stay in provenance as evidence, but the mapper never builds a gp_extraction item from them.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .ingest import Consult, Turn

GAP_S = 45.0
EDGE_FRAC = 0.30


@dataclass
class Boundary:
    suspected: bool = False
    quarantined: set[int] = field(default_factory=set)
    reasons: list[str] = field(default_factory=list)

    def add(self, reason: str, turns=()) -> None:
        self.suspected = True
        if reason not in self.reasons:
            self.reasons.append(reason)
        self.quarantined.update(turns)

    def as_json(self) -> dict:
        return {"suspected": self.suspected, "quarantined_turns": sorted(self.quarantined), "reasons": list(self.reasons)}


def _speech(turns: list[Turn]) -> int:
    return sum(max(0, t.t1_ms - t.t0_ms) for t in turns)


def _two_consults(c: Consult, b: Boundary) -> None:
    f = c.role_flags
    if not f or f.two_consults is not True:
        return
    if f.gap_at_s is None:
        b.add("role_track_two_consults:no_gap")
        return
    cut = c.clip_t0_ms + int(f.gap_at_s * 1000)
    before = [t for t in c.turns if t.t0_ms < cut]
    after = [t for t in c.turns if t.t0_ms >= cut]
    if not before or not after:
        b.add("role_track_two_consults:gap_outside_clip")
        return
    minor = before if _speech(before) < _speech(after) else after
    b.add("role_track_two_consults", (t.idx for t in minor))


def _second_patient(c: Consult, b: Boundary) -> None:
    if not c.role_track:
        return
    by = {}
    for t in c.turns:
        if t.role == "patient":
            by.setdefault(t.speaker, []).append(t)
    if len(by) < 2:
        return
    main = max(by, key=lambda s: _speech(by[s]))
    span = max(1, c.clip_t1_ms - c.clip_t0_ms)
    m0, m1 = by[main][0].idx, by[main][-1].idx
    for sp, ts in by.items():
        if sp == main:
            continue
        first, last = ts[0], ts[-1]
        if last.idx < m0 and (last.t1_ms - c.clip_t0_ms) <= EDGE_FRAC * span:
            b.add("second_patient_voice", range(0, last.idx + 1))
        elif first.idx > m1 and (c.clip_t1_ms - first.t0_ms) <= EDGE_FRAC * span:
            b.add("second_patient_voice", range(first.idx, len(c.turns)))
        else:
            b.add("second_patient_voice:interleaved")


def _long_gap(c: Consult, b: Boundary, foreign: set[int]) -> None:
    total = max(1, _speech(c.turns))
    span = max(1, c.clip_t1_ms - c.clip_t0_ms)
    for i in range(1, len(c.turns)):
        gap = (c.turns[i].t0_ms - c.turns[i - 1].t1_ms) / 1000
        if gap < GAP_S:
            continue
        before, after = c.turns[:i], c.turns[i:]
        short, long_ = (before, after) if _speech(before) < _speech(after) else (after, before)
        at_edge = (short is before and (before[-1].t1_ms - c.clip_t0_ms) <= EDGE_FRAC * span) or \
                  (short is after and (c.clip_t1_ms - after[0].t0_ms) <= EDGE_FRAC * span)
        if not at_edge or _speech(short) >= EDGE_FRAC * total:
            continue
        stranger = {t.speaker for t in short} - {t.speaker for t in long_}
        if stranger or foreign & {t.idx for t in short}:
            b.add("long_gap", (t.idx for t in short))
        else:
            b.add("long_gap:unconfirmed")


def detect(c: Consult, stage_a_boundary: dict | None = None) -> Boundary:
    """Pre-Stage-A call: stage_a_boundary None. Post-Stage-A call: pass encounter['consult_boundary']."""
    b = Boundary()
    foreign = set()
    if stage_a_boundary:
        foreign = {t for t in (stage_a_boundary.get("foreign_turns") or []) if isinstance(t, int) and 0 <= t < len(c.turns)}
    _two_consults(c, b)
    _second_patient(c, b)
    _long_gap(c, b, foreign)
    if foreign:
        b.add("stage_a_topic", foreign)
    elif stage_a_boundary and stage_a_boundary.get("suspected"):
        b.add("stage_a_topic:unlocalised")
    return b
