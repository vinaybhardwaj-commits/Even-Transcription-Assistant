"""Clip-boundary guard: find turns that belong to the previous or next patient, and quarantine them.

A consult clip is cut from continuous room audio, so its edges can carry the end of the previous consult or the start of
the next one. Orders taken from those turns would go into the wrong patient's prescription. Signals, all deterministic:

  role_track_two_consults  the role track's extras.two_consults flag. With gap_at_s, the clip is split there and the
                           side with less speech is quarantined; without it the artifact is only flagged.
  second_patient_voice     two or more speaker labels the role track calls "patient". A secondary patient voice whose
                           turns all sit in the first or last EDGE_FRAC of the clip and never interleave with the main
                           patient's turns quarantines the edge span up to (or from) that voice. Interleaved: flag only.
  long_gap                 a silence of at least GAP_S. The other consult is NOT "whichever side is shorter".
                           With Stage A's foreign_turns, only those turns are quarantined (never a turn Stage A left
                           as the current patient), including when the previous patient fills the long side.
                           Without labels, only an early short side that has a speaker the rest of the clip does not
                           is quarantined; a late short side is flagged, not quarantined. Greetings are ignored.
  stage_a_topic            Stage A's consult_boundary.foreign_turns (a topic discontinuity: another complaint, another
                           name, a goodbye then a new greeting). Applied after Stage A.

Quarantined turns stay in provenance as evidence, but the mapper never builds a gp_extraction item from them.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .ingest import Consult, Turn

GAP_S = 45.0
EDGE_FRAC = 0.30
# A greeting or admin remark at a clip edge is not another consult. Matching is the whole turn, not a substring,
# so "thank you, I will come next month" still counts.
_ADMIN = re.compile(
    r"(?:(?:good\s+)?(?:morning|afternoon|evening|night)|hello|hi|hey|namaste|namaskar|"
    r"please\s+(?:sit(?:\s+down)?|come\s+in|wait|have\s+a\s+seat)|come\s+in|have\s+a\s+seat|"
    r"thank(?:s|\s+you)(?:\s+so\s+much)?|ok(?:ay)?|yes|no|ji|hmm+|one\s+moment|just\s+a\s+moment|"
    r"take\s+care|bye|goodbye|see\s+you|welcome)[.!?, ]*",
    re.I,
)


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


def _admin(text: str) -> bool:
    t = " ".join((text or "").strip().split())
    return bool(t) and len(t) <= 40 and bool(_ADMIN.fullmatch(t))


def _all_admin(turns: list[Turn]) -> bool:
    return bool(turns) and all(_admin(t.text) for t in turns)


def _at_edge(c: Consult, t: Turn) -> bool:
    span = max(1, c.clip_t1_ms - c.clip_t0_ms)
    return (t.t0_ms - c.clip_t0_ms) <= EDGE_FRAC * span or (c.clip_t1_ms - t.t1_ms) <= EDGE_FRAC * span


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


def _second_patient(c: Consult, b: Boundary, foreign: set[int], labelled: bool) -> None:
    if not c.role_track:
        return
    by = {}
    for t in c.turns:
        if t.role == "patient":
            by.setdefault(t.speaker, []).append(t)
    if len(by) < 2:
        return
    # With Stage A's labels, the current patient is the one Stage A did not mark foreign. Most-speech alone
    # picks the previous patient when that consult is the long side, and then quarantines the current one.
    def _kept(sp):
        return _speech([t for t in by[sp] if t.idx not in foreign]) if labelled else _speech(by[sp])

    main = max(by, key=_kept)
    if labelled and _kept(main) == 0:
        main = max(by, key=lambda s: _speech(by[s]))
    span = max(1, c.clip_t1_ms - c.clip_t0_ms)
    m0, m1 = by[main][0].idx, by[main][-1].idx
    for sp, ts in by.items():
        if sp == main:
            continue
        if _all_admin(ts):
            continue
        first, last = ts[0], ts[-1]
        if last.idx < m0 and (last.t1_ms - c.clip_t0_ms) <= EDGE_FRAC * span:
            b.add("second_patient_voice", range(0, last.idx + 1))
        elif first.idx > m1 and (c.clip_t1_ms - first.t0_ms) <= EDGE_FRAC * span:
            # A patient who only appears at the end, with no Stage A label, may be the current consult
            # after a long previous one. Flag it. Quarantine only the turns Stage A called foreign.
            if labelled:
                q = [i for i in range(first.idx, len(c.turns)) if i in foreign]
                if q:
                    b.add("second_patient_voice", q)
                else:
                    b.add("second_patient_voice:unconfirmed")
            else:
                b.add("second_patient_voice:unconfirmed")
        else:
            b.add("second_patient_voice:interleaved")


def _gap_geometry(c: Consult, before: list[Turn], after: list[Turn]):
    """(short, long, early_short, at_edge) for one silence. early_short: the short side is the clip's start."""
    total = max(1, _speech(c.turns))
    span = max(1, c.clip_t1_ms - c.clip_t0_ms)
    short, long_ = (before, after) if _speech(before) < _speech(after) else (after, before)
    early_short = short is before
    at_edge = (short is before and (before[-1].t1_ms - c.clip_t0_ms) <= EDGE_FRAC * span) or \
              (short is after and (c.clip_t1_ms - after[0].t0_ms) <= EDGE_FRAC * span)
    small = _speech(short) < EDGE_FRAC * total
    return short, long_, early_short, at_edge and small


def _long_gap(c: Consult, b: Boundary, foreign: set[int], labelled: bool) -> None:
    """Which side of a long silence is the other consult.

    Gap length alone picked the short side, so a long previous consult quarantined the current patient and the
    previous patient's orders were emitted. With Stage A's per-turn labels, only turns Stage A called foreign are
    quarantined, on whichever side they sit, and a turn Stage A left as the current patient never is. Without
    labels, an early short side with a speaker the rest of the clip does not have is the previous patient; a late
    short side is unsure (it may be the current patient after a long previous consult) and is flagged only.
    Greetings and admin talk do not count.
    """
    for i in range(1, len(c.turns)):
        gap = (c.turns[i].t0_ms - c.turns[i - 1].t1_ms) / 1000
        if gap < GAP_S:
            continue
        before, after = c.turns[:i], c.turns[i:]
        short, _, early_short, geometric = _gap_geometry(c, before, after)
        if labelled:
            on_before = {t.idx for t in before if t.idx in foreign}
            on_after = {t.idx for t in after if t.idx in foreign}
            if on_before and not on_after:
                b.add("long_gap", on_before)
            elif on_after and not on_before:
                b.add("long_gap", on_after)
            elif on_before and on_after:
                b.add("long_gap", on_before | on_after)
            elif geometric and not _all_admin(short):
                b.add("long_gap:unconfirmed")
            continue
        if not geometric or _all_admin(short):
            continue
        if not early_short:
            # The short side is at the end. It may be the next patient or the current one. Don't quarantine.
            b.add("long_gap:unconfirmed")
            continue
        stranger = {t.speaker for t in short} - {t.speaker for t in after}
        if stranger:
            b.add("long_gap", (t.idx for t in short))
        else:
            b.add("long_gap:unconfirmed")


# Addendum A F4 (cases 6fqhvv8f, 7s815msg): a goodbye, a silence of 20 s or more, then a greeting, a name call or "come, sit" means everything
# before the silence was the previous patient.
LEAD_GAP_S = 20.0
_GOODBYE = re.compile(r"\b(?:good\s?bye|bye|take care|see you|thank(?:s| you)|dhanyavad\w*|dhanyawad\w*|shukriya|namaste|namaskara|dhanyavadagalu|barthini|bartini)\b", re.I)
_OPENING = re.compile(
    r"\b(?:hello|hi|namaste|namaskara|good\s+(?:morning|afternoon|evening)|come\s+(?:in|here|inside)|come,?\s+sit|please\s+sit|sit\s+down|have\s+a\s+seat|"
    r"baithiye|baitho|next|(?:mr|mrs|ms|shri|smt|sri)\.?\s+[A-Za-z]+)\b", re.I)
_NAME_CALL = re.compile(r"^\s*[A-Z][a-z]{2,}(?:\s+(?:ji|garu|avare|madam|sir|amma|bhai))?\s*[.?!,]*\s*$")


def _leading_goodbye(c: Consult, b: Boundary) -> None:
    n = len(c.turns)
    for i in range(0, n - 1):
        if i + 1 > 0.6 * n:
            break
        t, nxt = c.turns[i], c.turns[i + 1]
        if (nxt.t0_ms - t.t1_ms) / 1000 < LEAD_GAP_S:
            continue
        if not _GOODBYE.search(t.text or ""):
            continue
        opening = _OPENING.search(nxt.text or "") or _NAME_CALL.match((nxt.text or "").strip())
        if not opening or _speech(c.turns[i + 1:]) <= 0:
            continue
        b.add("leading_goodbye_gap", range(0, i + 1))
        return


def detect(c: Consult, stage_a_boundary: dict | None = None) -> Boundary:
    """Pre-Stage-A call: stage_a_boundary None. Post-Stage-A call: pass encounter['consult_boundary']."""
    b = Boundary()
    raw_foreign: set[int] = set()
    if stage_a_boundary:
        raw_foreign = {t for t in (stage_a_boundary.get("foreign_turns") or []) if isinstance(t, int) and 0 <= t < len(c.turns)}
    # Greetings at the clip edge are not another consult, even if Stage A listed them.
    foreign = {i for i in raw_foreign if not (_admin(c.turns[i].text) and _at_edge(c, c.turns[i]))}
    _two_consults(c, b)
    _leading_goodbye(c, b)
    _second_patient(c, b, foreign, stage_a_boundary is not None)
    _long_gap(c, b, foreign, stage_a_boundary is not None)
    if foreign:
        b.add("stage_a_topic", foreign)
    elif stage_a_boundary and stage_a_boundary.get("suspected") and not raw_foreign:
        b.add("stage_a_topic:unlocalised")
    return b
