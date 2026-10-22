"""FRX-V10 span registry and order_capable (spec "Inputs: bundle, spans and speakers"; D7, rule 15).

Every STT segment (a Turn) is one span: `span_id` is "s<turn index>", so a span id and a turn index name the same thing and the mapper's
turn-based code keeps working. A span carries who spoke (diarisation label and role-track role), verbatim `quote_native` and `quote_en`, the
clip-boundary quarantine and `order_capable`.

D7 (until EB-0a is signed): `order_capable` is the ROLE TRACK's doctor label and nothing else. A consult with no role track, or whose role
track names no doctor, has no order-capable span, so it posts no orders (every order becomes a prompt). The text-judge or caa label counts when
it is the canonical role track (rule 15). With two doctor labels both are order-capable and the roster flags `second_doctor` (V, 17 Oct).
EB-0a (3/3 votes, voiceprint arm) is NOT wired: `span_source` is "none", `three_of_three` false, the voiceprint arm "off".
"""
from __future__ import annotations

import datetime as dt
import re
from collections import defaultdict

from ..ingest import Consult, Turn

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
_SPAN = re.compile(r"^\s*[sS](\d+)\s*$")
_ROLE_OUT = {"doctor": "treating_doctor", "patient": "patient", "attendant": "attender", "attender": "attender",
             "staff": "staff", "other": "unknown", "unknown": "unknown"}
# The stored-model citation keys that name a turn. Stage A v3 writes "s12" in them; the mapper wants the integer.
CITE_LIST_KEYS = ("source_turns", "foreign_turns")
CITE_ONE_KEYS = ("decision_turn", "strength_turn", "source_quote_turn", "quote_turn")


def span_id(idx: int) -> str:
    return f"s{idx}"


def span_index(ref) -> int | None:
    """The turn index a citation names: an int, "12", "s12" or "S12". None for anything else (a bool is not an index)."""
    if isinstance(ref, bool):
        return None
    if isinstance(ref, int):
        return ref
    if isinstance(ref, str):
        m = _SPAN.match(ref)
        if m:
            return int(m.group(1))
        if ref.strip().isdigit():
            return int(ref.strip())
    return None


def cite_to_turns(node):
    """Stage A v3 cites span ids ("s12"). Rewrite every citation field of an encounter to the integer turn index the mapper reads. An int
    passes through unchanged (v2 output stays valid); a value that is no index stays as it is, so the guard sees and drops it as before."""
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k in CITE_LIST_KEYS and isinstance(v, list):
                out[k] = [span_index(x) if span_index(x) is not None else x for x in v]
            elif k in CITE_ONE_KEYS and span_index(v) is not None:
                out[k] = span_index(v)
            else:
                out[k] = cite_to_turns(v)
        return out
    if isinstance(node, list):
        return [cite_to_turns(v) for v in node]
    return node


def label_of(t: Turn) -> str:
    digits = re.findall(r"\d+", str(t.speaker))
    return f"speaker_{digits[-1]}" if digits else "speaker_0"


def _iso(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, IST).isoformat(timespec="seconds")


def turn_order_capable(c: Consult, t: Turn) -> bool:
    """D7: the role track's doctor label for this turn. A role inferred by Stage A (`model_inferred`) never counts."""
    return bool(c.role_track and t.role == "doctor" and t.role_source == "role_track")


def build_spans(c: Consult, quarantined: set[int] | frozenset[int] = frozenset()) -> list[dict]:
    out = []
    for t in c.turns:
        out.append({
            "span_id": span_id(t.idx), "segment_refs": [f"{c.uid}:{t.idx}"], "t0": _iso(t.t0_ms), "t1": _iso(t.t1_ms),
            "label": label_of(t), "lang": t.lang or "und",
            "quote_native": t.native_text or t.text or "", "quote_en": t.text or "",
            "span_source": "none", "order_capable": turn_order_capable(c, t),
            "boundary_quarantined": t.idx in quarantined, "relay_of": None,
            # not in the contract's Span: the role-track role, so a reader need not join the roster
            "role": t.role if t.role_source == "role_track" else "unknown",
        })
    return out


def build_roster(c: Consult) -> list[dict]:
    talk: dict[str, float] = defaultdict(float)
    votes: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for t in c.turns:
        lab, secs = label_of(t), max(0, t.t1_ms - t.t0_ms) / 1000
        talk[lab] += secs
        if t.role_source == "role_track":
            votes[lab][_ROLE_OUT.get(t.role, "unknown")] += secs or 1e-9
    roster = []
    for lab in sorted(talk, key=lambda s: int(s.split("_")[1])):
        v = votes.get(lab)
        role = max(v, key=lambda r: (v[r], r != "unknown")) if v else "unknown"
        roster.append({
            "label": lab, "talk_s": round(talk[lab], 1), "role": role,
            "role_votes": {"role_track": role if v else None, "clef": None, "jev": None},
            "three_of_three": False,
            "armc": {"state": "off", "cos": None, "margin_next_label": None, "margin_runner_up_centroid": None, "gate_flag": "off"},
            "voiceprint_match": False, "translator_of": None,
            "order_capable": bool(c.role_track and role == "treating_doctor"),
        })
    docs = [r for r in roster if r["order_capable"]]
    for r in roster:
        r["second_doctor"] = bool(r["order_capable"] and len(docs) > 1)
    return roster


def registry(c: Consult, quarantined=frozenset()) -> dict:
    return {"roster": build_roster(c), "spans": build_spans(c, quarantined)}


def order_capable_turns(c: Consult) -> set[int]:
    return {t.idx for t in c.turns if turn_order_capable(c, t)}


def any_order_capable(c: Consult) -> bool:
    return any(turn_order_capable(c, t) for t in c.turns)


def neighbours(c: Consult, idx: int, gap_s: float = 2.0) -> list[int]:
    """Turn indices adjacent to `idx` by the SAME speaker with a gap of at most `gap_s` (rule 1: the token window crosses into them)."""
    t = c.turns[idx]
    out = []
    if idx > 0:
        p = c.turns[idx - 1]
        if p.speaker == t.speaker and (t.t0_ms - p.t1_ms) / 1000 <= gap_s:
            out.append(idx - 1)
    if idx + 1 < len(c.turns):
        n = c.turns[idx + 1]
        if n.speaker == t.speaker and (n.t0_ms - t.t1_ms) / 1000 <= gap_s:
            out.append(idx + 1)
    return out
