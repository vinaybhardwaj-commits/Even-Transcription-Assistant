"""eta -> eta + eta_coincidence (15 Oct 2026, floor-strict kickoff). Synthetic only.
Property 4 (legacy equivalence) is checked against a private copy of the pre-change functions."""
from __future__ import annotations

import random

import pytest
from test_floor_scope import _consult
from test_pdqi9_attribution import CAT, _syn
from test_pdqi9_harness import floors_row

from tools.eta2freescript.eval.pdqi9 import floors
from tools.eta2freescript.eval.pdqi9.floors import _CUT, _DIGITS, _s


# ---- private copy of the pre-change logic (origin/main 3e10381c) ------------------------------------------------
def old_eta_has_run(m, run, art, prov, scope):
    if scope == "medicine":
        own = floors._medicine_output(m, art, prov)
        if own is not None:
            return run in _DIGITS.findall(own)
    return run in _DIGITS.findall(floors._eta_text(art, prov))


def old_run_source(m, field, run, art, prov, scope=None):
    if old_eta_has_run(m, run, art, prov, floors.floor_scope(scope)):
        return "eta"
    if field == "strength":
        return "pulse_catalogue" if floors._is_catalogue(m) else "eta"
    return "pulse_extraction"


def old_field_source(m, field, art, prov, scope=None):
    value = _s(m.get(field)).replace(_CUT, "")
    if not value:
        return "eta"
    own = floors._medicine_output(m, art, prov) if floors.floor_scope(scope) == "medicine" else None
    if floors._in_text(value, own if own is not None else floors._eta_text(art, prov)):
        return "eta"
    if field == "strength":
        return "pulse_catalogue" if floors._is_catalogue(m) else "eta"
    return "pulse_extraction"


def unit_norm(u):  # test-side restatement of the rule
    if u is None:
        return None
    u = u.lower().replace(".", "").replace(" ", "")
    return u[:-1] if u.endswith("s") else u


UNITS = [None, "mg", "mg.", "MG", "mgs", "m.g.", "Tablets", "tablet", "tab.", "days", "day", "milligram", "ml", "ml.", "weeks"]


def render(n, unit, sep):
    return n if unit is None else f"{n}{sep}{unit}"


def gen_case(rng):
    run = "".join(rng.choice("123456789") if i == 0 else rng.choice("0123456789") for i in range(rng.randint(1, 6)))
    fu, eu = rng.choice(UNITS), rng.choice(UNITS)
    in_eta = rng.random() < 0.75
    distract = [f"{rng.randint(1, 9)}{rng.choice('0123456789')}{rng.choice('0123456789')}{rng.choice('0123456789')}7 mg" for _ in range(rng.randint(0, 2))]
    parts = distract + ([render(run, eu, rng.choice(["", " "]))] if in_eta else [])
    rng.shuffle(parts)
    # a separator keeps a bare number from taking the next part's word as its unit
    note = "Medication:\nParacetamol " + " ; ".join(parts)
    field = rng.choice(["strength", "frequency", "duration"])
    m = {"name": "Paracetamol", field: render(run, fu, rng.choice(["", " "]))}
    if rng.random() < 0.5:
        m.update(CAT if rng.random() < 0.8 else {"uid": "u", "other": True, "name": "Paracetamol"})
    art = _syn(note, [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
    expect_strict = len(run) >= 3 or (unit_norm(fu) is not None and unit_norm(fu) == unit_norm(eu))
    return m, field, run, art, in_eta, expect_strict


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_run_source_legacy_equivalence_and_strict_property(scope):
    rng = random.Random(15102026)
    seen = set()
    for _ in range(3000):
        m, field, run, art, in_eta, strict = gen_case(rng)
        prov = floors._prov_for(m, art)
        new, old = floors._run_source(m, field, run, art, prov, scope), old_run_source(m, field, run, art, prov, scope)
        assert (old == "eta") == (new in ("eta", "eta_coincidence")), (m, art["note_text"], old, new)
        if old != "eta":
            assert new == old
        if old == "eta" and in_eta:
            assert new == ("eta" if strict else "eta_coincidence"), (m, art["note_text"], new)
        seen.add(new)
    assert {"eta", "eta_coincidence", "pulse_extraction"} <= seen


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_field_source_legacy_equivalence(scope):
    rng = random.Random(7)
    seen = set()
    for _ in range(3000):
        m, field, run, art, in_eta, strict = gen_case(rng)
        if rng.random() < 0.15:
            m[field] = rng.choice(["", "after food", "twice daily", "5 mg and 500 mg", "12", f"{run} mg, {run} days"])
        prov = floors._prov_for(m, art)
        new, old = floors._field_source(m, field, art, prov, scope), old_field_source(m, field, art, prov, scope)
        assert (old == "eta") == (new in ("eta", "eta_coincidence")), (m, art["note_text"], old, new)
        if old != "eta":
            assert new == old
        if not _s(m.get(field)) or not _DIGITS.findall(_s(m[field])):
            assert new == old
        seen.add(new)
    assert {"eta", "eta_coincidence"} <= seen


def test_worst_priority():
    assert floors.SOURCES == ("eta", "eta_coincidence", "pulse_catalogue", "pulse_extraction", "check")
    assert floors._worst(["pulse_extraction", "eta_coincidence", "pulse_catalogue"]) == "eta_coincidence"
    assert floors._worst(["eta_coincidence", "eta"]) == "eta"
    assert floors._worst(["check", "pulse_catalogue"]) == "pulse_catalogue"


def _src(strength=None, duration=None, frequency=None, note="Medication:\nParacetamol 5 mg", scope="global", med=None):
    m = {"name": "Paracetamol", **(med or {}), **{k: v for k, v in (("strength", strength), ("duration", duration), ("frequency", frequency)) if v}}
    art = _syn(note, [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
    return floors._invented_core({"medicines": [m]}, art, _consult("hello"), scope)["sources"]


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fixed_cases(scope):
    assert _src(duration="5 days", scope=scope) == ["eta_coincidence"]
    assert _src(strength="500 mg", note="Medication:\nParacetamol 500 mg", scope=scope) == ["eta"]
    assert _src(strength="10 mg", note="Medication:\nParacetamol 10 mg", scope=scope) == ["eta"]
    assert _src(frequency="12", note="Medication:\nParacetamol 12 mg", scope=scope) == ["eta_coincidence"]
    assert _src(strength="0.5 mg", note="Medication:\nParacetamol 0.5 mg", scope=scope) == ["eta", "eta"]  # runs 0 and 5, both same-unit
    assert _src(strength="40", note="Medication:\nParacetamol 40 mg", scope=scope) == ["eta_coincidence"]
    assert _src(strength="7 mg", scope=scope) == ["eta"]  # non-catalogue strength, no run in ETA's text: default unchanged
    assert _src(strength="7 mg", scope=scope, med=CAT) == ["pulse_catalogue"]
    assert _src(strength="5 Mgs.", scope=scope) == ["eta"]  # mgs. = mg
    assert _src(strength="5 milligram", scope=scope) == ["eta_coincidence"]  # mg != milligram
    # several runs: eta if ANY run is strict


def test_any_run_strict_makes_a_hit_eta():
    art = _syn("Medication:\nParacetamol 5 mg 650 ml", [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
    m = {"name": "Paracetamol", "strength": "5 days 650 weeks"}
    runs = [("strength", "5"), ("strength", "650")]
    assert floors._worst(floors._run_source(m, k, r, art, None, "global") for k, r in runs) == "eta"
    m = {"name": "Paracetamol", "strength": "5 days"}
    assert floors._run_source(m, "strength", "5", art, None, "global") == "eta_coincidence"


def test_empty_replayed_field_is_eta():
    art = _syn("Medication:\nParacetamol 5 mg", [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
    assert floors._field_source({"name": "Paracetamol"}, "duration", art, None) == "eta"


def test_judge_field_value_match():
    art = _syn("Medication:\nParacetamol 5 mg twice a day", [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
    fs = lambda v, f="frequency": floors._field_source({"name": "Paracetamol", f: v}, f, art, None, "global")
    assert fs("5 mg", "strength") == "eta"
    assert fs("2 days") == "eta_coincidence"
    assert fs("5 days and 500 mg") == "pulse_extraction"  # 500 not in ETA's text: not a value match, unchanged
    assert fs("twice a day") == "eta"  # both read "2 daily": same unit
    art2 = _syn("Medication:\nParacetamol 500 mg 5 days", [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
    assert floors._field_source({"name": "Paracetamol", "strength": "500 mg 5 days"}, "strength", art2, None, "global") == "eta"  # one strict run
    assert floors._field_source({"name": "Paracetamol", "strength": "5 days"}, "strength", art2, None, "global") == "eta"  # same unit
    art3 = _syn("Medication:\nParacetamol after food", [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
    assert floors._field_source({"name": "Paracetamol", "instructions": "after food"}, "instructions", art3, None, "global") == "eta"


def test_header_and_basis():
    def row(name, key, **at):
        return {"uid": "u", "arm": "Bn", **{k: 0 for k in ("unsupported_drugs", "leak_items", "invented_fields", "dose_precedence_errors", "hallucinations",
                "invented_numbers", "dose_precedence_det", "printable_errors", "unknown_key_errors", "validator_failures", "unclear_items")},
                "artifact_missing": False, "completion": {"missing": 2, "covered": 2, "parse_failure": False},
                key: sum(at.values()), "attribution": {key: {**floors._zero_attr(), **at}}}
    bn = [row("n", "invented_numbers", eta_coincidence=3)]
    eta = floors.aggregate(bn, basis="eta", scope="medicine")
    allb = floors.aggregate(bn, basis="all", scope="medicine")
    r_eta = next(r for r in eta["rows"] if r["floor"].startswith("invented numbers"))
    r_all = next(r for r in allb["rows"] if r["floor"].startswith("invented numbers"))
    assert r_eta["eta"] == 0 and r_eta["eta_coincidence"] == 3 and r_eta["bn"] == 3
    assert r_eta["pass"] is True and r_all["pass"] is False
    assert eta["header"]["eta_coincidence"] == 3 and eta["header"]["eta"] == 0
