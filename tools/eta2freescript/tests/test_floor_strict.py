"""eta -> eta + eta_coincidence (15 Oct 2026, floor-strict kickoff). Synthetic only.
Property 4 (legacy equivalence) is checked against a private copy of the pre-change functions."""
from __future__ import annotations

import random
import subprocess
import types
from pathlib import Path

import pytest
from test_floor_scope import _consult
from test_pdqi9_attribution import CAT, _syn, item
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


NB = "\u00a0"
# canonical unit -> surface spellings that must all read as that unit
SURFACE = {
    None: [],
    "mg": ["mg", "MG", "mgs", "mg.", "m.g.", "Mg"],
    "ml": ["ml", "ml.", "mL"],
    "day": ["days", "Days"],  # not "day": "5/day" is "5 daily" since FIX4
    "week": ["weeks", "week"],
    "tablet": ["tablet", "Tablets"],
    "%": ["%"],
    "daily": ["daily"],
}
CANON = list(SURFACE)
WORD = {i: w for i, w in enumerate("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
                                   "seventeen eighteen nineteen twenty".split(), 1)}


def render(run, canon, rng):
    """One surface rendering of `run` followed by the unit `canon` (None: nothing). The run is always a standalone digit run in the
    result (as itself, as a number word, or as one end of a range)."""
    num = run
    if run.isdigit() and not run.startswith("0") and int(run) in WORD and rng.random() < 0.2:
        num = WORD[int(run)]
    if canon is None:
        return rng.choice([num, f"({num})", f"{num}-{rng.randint(1, 99)}", f"{num} to {rng.randint(1, 99)}"])
    u = rng.choice(SURFACE[canon])
    sep = rng.choice(["", " ", " ", NB, "\t", "\n", "  ", f" {NB}"])
    if num != run and not sep:
        sep = " "  # a number word needs a boundary before the unit
    if canon == "%":
        return rng.choice([f"{num}%", f"{num} %", f"{num}% cream", f"{num}{NB}%", f"{rng.randint(1, 9)}-{num}%"])
    if canon == "daily":
        day = rng.choice([" ", NB, "\n"])
        opts = [f"{num} a{day}day", f"{num} daily", f"{num}{sep}daily"]
        if run == "1":
            opts.append("once a day")
        if run == "2":
            opts.append("twice a day")
        return rng.choice(opts)
    lo, hi = rng.randint(1, 99), rng.randint(1, 99)
    return rng.choice([
        f"{num}{sep}{u}", f"({num}){sep}{u}", f"({num}) {u}", f"{num}-{u}", f"{num} _{u}", f"{num}/{u}", f"{num} - {u}",
        f"{lo}-{num}{sep}{u}", f"{lo} \u2013 {num} {u}", f"{lo} to {num} {u}", f"{num}-{hi}{sep}{u}", f"{num} \u2013 {hi}{sep}{u}",
        f"{num} to {hi} {u}", f"{num} to{NB}{hi} {u}",
    ])


def gen_case(rng):
    run = "".join(rng.choice("123456789") if i == 0 else rng.choice("0123456789") for i in range(rng.randint(1, 6)))
    fu = rng.choice(CANON)
    eu = fu if rng.random() < 0.5 else rng.choice(CANON)
    in_eta = rng.random() < 0.75
    distract = [f"{rng.randint(1, 9)}{rng.choice('0123456789')}{rng.choice('0123456789')}{rng.choice('0123456789')}7 mg" for _ in range(rng.randint(0, 2))]
    eta_part = render(run, eu, rng)
    parts = distract + ([eta_part] if in_eta else [])
    rng.shuffle(parts)
    # a separator keeps a bare number from taking the next part's word as its unit
    note = "Medication:\nParacetamol " + " ; ".join(parts) + " ;"
    field = rng.choice(["strength", "frequency", "duration"])
    m = {"name": "Paracetamol", field: render(run, fu, rng)}
    if rng.random() < 0.5:
        m.update(CAT if rng.random() < 0.8 else {"uid": "u", "other": True, "name": "Paracetamol"})
    art = _syn(note, [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
    # same canonical unit; none on both sides is the identical text; a newline in ETA's text may be a piece boundary, which ends the unit
    # search (FIX3), so a field with no unit matches it (the ambiguity is settled toward eta)
    expect_strict = len(run) >= 3 or fu == eu or (fu is None and "\n" in floors._same_norm(eta_part))
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
    """Property (FIX3): old eta <=> new eta, or new eta_coincidence, or the hit carries the wrote_nothing flag; every flagged hit has an
    empty field and source pulse_catalogue or check; every non-empty-field path is unflagged and keeps the old eta/not-eta split."""
    rng = random.Random(7)
    seen = set()
    for _ in range(3000):
        m, field, run, art, in_eta, strict = gen_case(rng)
        if rng.random() < 0.15:
            m[field] = rng.choice(["", "after food", "twice daily", "5 mg and 500 mg", "12", f"{run} mg, {run} days"])
        prov = floors._prov_for(m, art)
        new, moved = floors._field_hit1(m, field, art, prov, scope)
        old = old_field_source(m, field, art, prov, scope)
        assert (old == "eta") == (new in ("eta", "eta_coincidence") or moved), (m, art["note_text"], old, new, moved)
        if moved:
            assert new in ("pulse_catalogue", "check") and not _s(m.get(field)), (m, new)
        if _s(m.get(field)):
            assert not moved
            if old != "eta":
                assert new == old
        if not _s(m.get(field)) or not _DIGITS.findall(floors._numnorm(_s(m[field]))):
            assert new == old or moved
        seen.add(new)
    assert {"eta", "eta_coincidence", "pulse_catalogue", "check"} <= seen


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
    assert _src(strength="5 milligram", scope=scope) == ["eta"]  # FIX6: mg = milligram (the synonym reading)
    assert _src(strength="5 mcg", scope=scope) == ["eta_coincidence"]  # a different unit is still a coincidence
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


# ---- FIX2: one normaliser, the unit token ------------------------------------------------------------------------
@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_identity_same_rendering_both_sides_is_eta(scope):
    """(i) The same rendered string as field and as ETA text is eta, for every canonical unit including none."""
    rng = random.Random(2)
    for _ in range(3000):
        run = str(rng.randint(1, 99))
        x = render(run, rng.choice(CANON), rng)
        m = {"name": "Paracetamol", "duration": x}
        art = _syn("Medication:\nParacetamol " + x + " ;", [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
        prov = floors._prov_for(m, art)
        for r in floors._DIGITS.findall(floors._numnorm(x)):
            assert floors._run_source(m, "duration", r, art, prov, scope) == "eta", (x, r)
        assert floors._field_source(m, "duration", art, prov, scope) == "eta", x


def test_identity_strict_run_any_string():
    rng = random.Random(3)
    alphabet = list("0123456789 \t\n" + NB + "-–()_/.,%;:abcdmgl") + ["once", "a day", "to", "twice"]
    for _ in range(5000):
        x = "".join(rng.choice(alphabet) for _ in range(rng.randint(1, 14)))
        n = floors._same_norm(x)
        for r in floors._DIGITS.findall(n):
            assert floors._strict_run(r, n, n), x


def test_same_unit_under_any_rendering_and_different_unit_is_coincidence():
    """(ii) and (iii) on the _strict_run level, over every pair of surface renderings."""
    rng = random.Random(4)
    for _ in range(4000):
        run = str(rng.randint(1, 99))
        fu, eu = rng.choice(CANON), rng.choice(CANON)
        e_raw = render(run, eu, rng)
        f, e = floors._same_norm(render(run, fu, rng) + " ;"), floors._same_norm(e_raw + " ;")
        assert floors._strict_run(run, f, e) == (fu == eu or (fu is None and "\n" in e)), (f, e, fu, eu)


def test_normaliser_is_symmetric():
    for x in ["2 a day", "once  a day", "5 mg", "TWICE\ta day", "five\nmg"]:
        assert floors._same_norm(x) == floors._same_norm(floors._same_norm(x))


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix2_verdict_cases(scope):
    para = lambda t: f"Medication:\nParacetamol {t}"
    assert _src(frequency="2 a day", note=para("2 a day"), scope=scope) == ["eta"]
    assert _src(frequency="1 a day", note=para("once a day"), scope=scope) == ["eta"]
    assert _src(strength="5 mg", note=para("5 mg"), scope=scope) == ["eta"]  # NBSP in ETA's text
    assert _src(strength="5 mg", note=para("5 mg"), scope=scope) == ["eta"]  # NBSP in the field
    assert _src(duration="5 mg", note=para("5-10 mg"), scope=scope) == ["eta"]  # a range takes the unit after the last number
    assert _src(duration="5-10 mg", note=para("5 mg"), scope=scope) == ["eta", "pulse_extraction"]  # 5 is ETA's, 10 is not
    assert _src(duration="5-10 mg", note=para("5 to 10 mg"), scope=scope) == ["eta", "eta"]
    assert _src(duration="5 days", note=para("5-10 mg"), scope=scope) == ["eta_coincidence"]
    assert _src(strength="2% cream", note=para("2% cream"), scope=scope) == ["eta"]
    assert _src(duration="5%", note=para("5% ;"), scope=scope) == ["eta"]
    assert _src(duration="5%", note=para("5 mg"), scope=scope) == ["eta_coincidence"]
    assert _src(strength="(5) mg", note=para("5 mg"), scope=scope) == ["eta"]
    assert _src(strength="5-mg", note=para("5 mg"), scope=scope) == ["eta"]
    assert _src(strength="5 _mg", note=para("5 mg"), scope=scope) == ["eta"]
    assert _src(strength="5 mg", note=para("(5) mg"), scope=scope) == ["eta"]
    assert _src(duration="5 mg", note=para("5 ml"), scope=scope) == ["eta_coincidence"]
    assert _src(duration="5", note=para("5 mg"), scope=scope) == ["eta_coincidence"]  # a missing unit on one side only


# ---- FIX3: a unit never crosses a piece boundary; eta_wrote_nothing -------------------------------------------------
@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_bare_number_at_end_of_a_piece_is_eta_under_any_following_piece(scope):
    rng = random.Random(5)
    words = ["Paracetamol", "mg", "daily", "after", "food", "Metformin", "tablet", "ml", "x", "review", "%"]
    for _ in range(3000):
        n = str(rng.randint(1, 99))
        after = " ".join(rng.choice(words) for _ in range(rng.randint(1, 3)))
        mid = rng.choice(["\n", "\n\n", " \n ", "\n" + NB])
        # the piece ends in the bare number; what follows is a note line or a provenance text
        if rng.random() < 0.5:
            note, prov_text = f"Medication:\nParacetamol {n}{mid}{after}", "Paracetamol"
        else:
            note, prov_text = f"Medication:\nParacetamol {n}", "Paracetamol" + mid.strip() + after
        art = _syn(note, [{"kind": "medicine", "name": "Paracetamol", "text": prov_text}])
        m = {"name": "Paracetamol", "duration": n}
        assert floors._run_source(m, "duration", n, art, floors._prov_for(m, art), scope) == "eta", (note, prov_text)
        assert floors._field_source(m, "duration", art, floors._prov_for(m, art), scope) == "eta", (note, prov_text)


def _wn(strength=None, note="Medication:\nParacetamol", scope="global", med=None, field="strength"):
    """(source, wrote_nothing flag) of a judged hit on an empty `field` of Paracetamol; `med` can make it a catalogue row."""
    m = {"name": "Paracetamol", **(med or {})}
    if strength:
        m[field] = strength
    art = _syn(note, [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
    return floors._field_hit(m, [field], art, floors._prov_for(m, art), scope)


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix3_fixed_cases(scope):
    cat200 = {**CAT, "name": "Paracetamol 200 mg tab", "brand_name": "", "generic": ""}
    cat_plain = {**CAT, "name": "Paracetamol", "brand_name": "Dolo", "generic": ""}
    assert _wn(note="Medication:\nParacetamol", scope=scope, med=cat200) == ("pulse_catalogue", True)  # ETA wrote no strength, name shows one
    assert _wn(note="Medication:\nParacetamol", scope=scope, med=cat_plain) == ("check", True)  # no digits shown
    assert _wn(note="Medication:\nParacetamol", scope=scope) == ("check", True)  # not a catalogue row: nothing to read a strength from
    assert _wn(note="Medication:\nParacetamol 5 mg", scope=scope, med=cat200) == ("eta", False)  # ETA wrote a strength
    assert _wn(note="Medication:\nParacetamol x 7 days", scope=scope, med=cat200) == ("pulse_catalogue", True)  # days is not a strength
    assert _wn(note="Medication:\nParacetamol x 7 days", scope=scope, med=cat_plain) == ("check", True)
    assert _wn(note="Medication:\nParacetamol twice a day", scope=scope, med=cat_plain) == ("check", True)  # frequency
    # FIX4 (b): a number directly after the medicine's name is a strength unless a time or frequency word follows; a form word does not cancel
    assert _wn(note="Medication:\nParacetamol 2 tablets", scope=scope, med=cat_plain) == ("eta", False)
    assert _wn(note="Medication:\nParacetamol 2 days", scope=scope, med=cat_plain) == ("check", True)
    assert _wn(note="Medication:\nParacetamol 5%", scope=scope) == ("eta", False)  # % is a strength unit
    assert _wn(note="Medication:\nParacetamol 5 puffs", scope=scope, med=cat200) == ("eta", False)  # FIX4 (b), as above
    assert _wn(note="Medication:\nParacetamol x 5 puffs", scope=scope, med=cat200) == ("eta", False)  # FIX5 structural rule: 5 is not followed by a time word
    assert _wn(note="Medication:\nParacetamol 5 zorgs", scope=scope) == ("eta", False)  # an unknown unit counts as a strength
    assert _wn(note="Medication:\nParacetamol 5\nmg", scope=scope) == ("eta", False)  # FIX4 (e): a number wrapped onto the next line
    assert _wn(note="Medication:\nParacetamol\nMetformin 500 mg", scope=scope) == ("check", True)  # another drug's line is not ETA's strength
    # a hit that also names a non-empty field: the old rule's eta stays eta where another field is eta
    m = {"name": "Paracetamol", "frequency": "5 mg"}
    art = _syn("Medication:\nParacetamol 5 mg", [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
    assert floors._field_hit(m, ["strength", "frequency"], art, floors._prov_for(m, art), scope) == ("eta", False)


def test_a_hit_with_an_empty_field_and_a_pulse_extraction_field():
    # old rule: worst(eta, pulse_extraction) = eta (the empty field was ETA's). Now the empty field is no ETA invention, so the hit is
    # pulse_extraction, and it is flagged because the old rule counted it as eta.
    m = {"name": "Paracetamol", "frequency": "9 days"}
    art = _syn("Medication:\nParacetamol", [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
    assert floors._field_hit(m, ["strength", "frequency"], art, floors._prov_for(m, art), "global") == ("pulse_extraction", True)


def test_flag_is_counted_alongside_the_source_and_rolls_up():
    rx = {"medicines": [{**CAT, "name": "Dolo", "strength": ""}]}
    out = floors._judge_attribution([item(1, invented=["strength"])], floors.numbered_items(rx), _syn("Medication: Dolo"))
    assert out["invented_fields"]["check"] == 1 and out["invented_fields"]["eta_wrote_nothing"] == 1 and out["invented_fields"]["eta"] == 0
    assert floors._tally(["eta", "check"]) ["eta_wrote_nothing"] == 0
    assert "eta_wrote_nothing" not in floors.SOURCES and floors._worst(["check", "pulse_catalogue"]) == "pulse_catalogue"


# ---- FIX4 (15 Oct 2026): in doubt, ETA's -------------------------------------------------------------------------------
PREV = "387abea4"  # FIX3: the second oracle. FIX4 may only move a hit toward eta compared with it.


def _oracle_prev():
    src = subprocess.run(["git", "show", f"{PREV}:tools/eta2freescript/eval/pdqi9/floors.py"], cwd=Path(__file__).resolve().parent,
                         capture_output=True, text=True, check=True).stdout
    mod = types.ModuleType("tools.eta2freescript.eval.pdqi9.floors_prev")
    mod.__package__ = "tools.eta2freescript.eval.pdqi9"
    exec(compile(src, f"floors@{PREV}", "exec"), mod.__dict__)
    return mod


@pytest.fixture(scope="module")
def prev():
    return _oracle_prev()


def _para(t):
    return f"Medication:\nParacetamol {t}"


def _eta_both_paths(value, eta_text, scope, field="duration"):
    """Sources of a replayed `value` against ETA's `eta_text` on the digit-run path and on the judged whole-field path."""
    m = {"name": "Paracetamol", field: value}
    art = _syn(_para(eta_text), [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
    prov = floors._prov_for(m, art)
    runs = [floors._run_source(m, field, r, art, prov, scope) for r in floors._DIGITS.findall(value)]
    return runs, floors._field_source(m, field, art, prov, scope)


# the verdict's finding B probes: same unit, so eta (each pair both ways)
SAME_UNIT = [
    ("2 times a day", "twice a day"), ("2 times daily", "twice a day"), ("twice daily", "2 times a day"), ("twice a day", "twice daily"),
    ("2 times a day", "2 times daily"), ("2 times per day", "twice a day"), ("2 times/day", "twice daily"), ("2 time a day", "twice a day"),
    ("3 times a day", "thrice daily"), ("1 times daily", "once a day"), ("1 time a day", "once daily"), ("1 times a day", "once a day"),
    ("5 mg", "5/10 mg"), ("5 mg", "5 or 10 mg"), ("5 mg", "5, 10 mg"), ("5 mg", "5 and 10 mg"), ("5 mg", "5\u201410 mg"),
    ("5 mg", "5 ~ 10 mg"), ("5 mg", "5\u201310 mg"), ("5 mg", "5 - 10 mg"), ("5 mg", "5 to 10 mg"), ("10 mg", "5/10 mg"),
    ("5 mg", "5 / 10 mg"), ("5 mg", "5 , 10 mg"), ("5 mg", "5 OR 10 mg"),
    ("5 \u00b5g", "5 \u03bcg"), ("5 \u03bcg", "5 \u00b5g"), ("5 \u338e", "5 mg"), ("5 mg", "5 \u338e"), ("5 m\u200bg", "5 mg"),
    ("5 mg", "5 m\u200bg"), ("5 mg", "5 \u200bmg"), ("5 mg", "5 [mg]"), ("5 [mg]", "5 mg"), ("5 mg", '5 "mg"'), ('5 "mg"', "5 mg"),
    ("5 mg", "5: mg"), ("5: mg", "5 mg"), ("5 mg", "5 (mg)"), ("5 mg", "5 \u201cmg\u201d"), ("5 mg", "5 'mg'"), ("5 mg", "5 {mg}"),
    ("5 %", "5 percent"), ("5 percent", "5%"), ("5 percent", "5 %"), ("5 %", "5 per cent"), ("5%", "5 percent"),
    ("2\uff05", "2 percent"), ("5 \uff4d\uff47", "5 mg"),
]


@pytest.mark.parametrize("scope", ["global", "medicine"])
@pytest.mark.parametrize("value,eta_text", SAME_UNIT)
def test_fix4_finding_b_same_unit_is_eta(scope, value, eta_text):
    runs, whole = _eta_both_paths(value, eta_text, scope)
    assert set(runs) <= {"eta"}, (value, eta_text, runs)
    assert whole == "eta", (value, eta_text, whole)


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix4_different_units_stay_coincidence(scope):
    for value, eta_text in [("5 days", "5 mg"), ("5 mg", "5 ml"), ("5 mg", "5 percent"), ("5 %", "5 mg"), ("2 times a day", "2 mg"),
                            ("5 mg", "5/10 ml"), ("5 mg", "5 or 10 days"), ("5 \u00b5g", "5 mg"), ("5 [mg]", "5 ml")]:
        runs, whole = _eta_both_paths(value, eta_text, scope)
        assert runs == ["eta_coincidence"] and whole == "eta_coincidence", (value, eta_text, runs, whole)


def _wrote(name, note, prov_items, scope="global", med=None, field="strength"):
    m = {"name": name, **(med or {})}
    art = _syn(note, prov_items)
    return floors._field_hit(m, [field], art, floors._prov_for(m, art), scope)


def _dolo(note, scope="global", prov=None, med=None):
    return _wrote("Dolo", note, prov if prov is not None else [{"kind": "medicine", "name": "Dolo", "text": "Dolo", "names": ["Dolo"]}], scope, med)


# the verdict's finding A and A2 probes: ETA wrote a strength, so the empty judged field stays eta
WROTE = [
    # (a) a number and a unit outside the time / form / frequency set
    "Medication:\nDolo 650 mg", "Medication:\nDolo 5 ml", "Medication:\nDolo 5% cream", "Medication:\nDolo 500 mcg", "Medication:\nDolo 1 g",
    "Medication:\nDolo 5 [mg]", 'Medication:\nDolo 5 "mg"', "Medication:\nDolo 5: mg", "Medication:\nDolo 5 \u338e", "Medication:\nDolo 5 percent",
    # (b) a number after, or glued to, the name; a form word does not cancel it
    "Medication:\nDolo 650", "Medication:\nDolo650", "Medication:\nDolo-650 tab", "Medication:\nDolo 650 tab", "Medication:\nDolo 650 Tablet",
    "Medication:\nDolo 650 BD", "Medication:\nDolo 650 1-0-1", "Medication:\nDolo-650", "Medication:\nTab Dolo 650", "Medication:\nTab. Dolo650 BD",
    "Medication:\nDOLO 650", "Medication:\nDolo (650)", "Medication:\nDolo: 650", "Medication:\nDolo\u2013650", "Medication:\nDolo 2 tablets",
    "Medication:\nDolo 650.5", "Medication:\nDolo 1,000",
    # (c) number words of any size
    "Medication:\nDolo forty mg", "Medication:\nDolo forty", "Medication:\nDolo two hundred fifty mg", "Medication:\nDolo two hundred and fifty",
    "Medication:\nDolo six hundred fifty tab", "Medication:\nDolo twenty-five mg", "Medication:\nDolo five hundred mg", "Medication:\nDolo ten mg",
    "Medication:\nDolo nine hundred ninety nine mg", "Medication:\nDolo Forty Mg", "Medication:\nDolo one thousand mg",
    # (e) a number wrapped onto the next line
    "Medication:\nDolo 650\nmg", "Medication:\nDolo 650\n mg", "Medication:\nDolo forty\nmg", "Medication:\nDolo 650\n\nmg",
    # (f) continuation lines
    "Medication:\nTab Dolo\n650 mg 1-0-1", "Medication:\nTab Dolo\n650 mg", "Medication:\nTab Dolo\n1-0-1\n650 mg", "Medication:\nTab Dolo\n650 mg\n1-0-1",
    "Medication:\nTab Dolo\n1-0-1\n1-0-1\n500 mg", "Medication:\nTab Dolo\n(650 mg)", "Medication:\nTab Dolo\nforty mg", "Medication:\nTab Dolo\n650\nmg",
]


@pytest.mark.parametrize("scope", ["global", "medicine"])
@pytest.mark.parametrize("note", WROTE)
def test_fix4_finding_a_eta_wrote_a_strength(scope, note):
    assert _dolo(note, scope) == ("eta", False), note
    m = {"name": "Dolo"}
    art = _syn(note, [{"kind": "medicine", "name": "Dolo", "text": "Dolo", "names": ["Dolo"]}])
    assert floors._eta_wrote_strength(m, art, floors._prov_for(m, art)) is True


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix4_provenance_value_and_unit_without_text(scope):
    for strength in ({"value": "650", "unit": "mg"}, {"value": 650, "unit": "mg"}, {"value": 650.0, "unit": "mg"}, {"value": 0.5, "unit": "g"},
                     {"value": "forty", "unit": "mg"}, {"value": "650", "unit": "tablet"}):
        p = {"kind": "medicine", "name": "Dolo", "text": "Dolo", "names": ["Dolo"], "medicine": {"strength": strength}}
        m = {"name": "Dolo"}
        art = _syn("Medication:\nDolo", [p])
        # FIX5: any digit in the strength value counts, a form unit included
        assert _dolo("Medication:\nDolo", scope, [p]) == ("eta", False), strength
    # the pair is joined by a space, never a newline: the unit is read next to the value even though the value is a bare number
    pieces: list[str] = []
    floors._prov_strength_pieces({"medicine": {"strength": {"value": 650, "unit": "mg"}}}, pieces)
    assert "650 mg" in pieces and not any("\n" in x for x in pieces)
    # a transcript quote is still not ETA's output
    p = {"kind": "medicine", "name": "Dolo", "text": "Dolo", "names": ["Dolo"], "evidence": [{"quote": "650 mg"}]}
    assert _dolo("Medication:\nDolo", scope, [p]) == ("check", True)


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix4_still_wrote_nothing(scope):
    """The cases FIX4 must NOT move: no number, a time or frequency word after the name's number, another medicine's number."""
    cases = [
        "Medication:\nDolo", "Medication:\nDolo twice a day", "Medication:\nDolo 2 days", "Medication:\nDolo 3 weeks",
        "Medication:\nDolo-2 months", "Medication:\nDolo 1 year", "Medication:\nDolo 4 hours", "Medication:\nDolo 30 minutes",
        "Medication:\nDolo x 7 days", "Medication:\nDolo\nMetformin 500 mg", "Medication:\nDolo twice", "Medication:\nDolo after food",
        "Medication:\nDolo\nafter food", "Medication:\nDolo\nMetformin\n650 mg",
    ]
    for note in cases:
        assert _dolo(note, scope, med=CAT) == ("check", True), note
    # a continuation line that names another ETA medicine is that medicine's strength
    other = [{"kind": "medicine", "name": "Dolo", "text": "Dolo", "names": ["Dolo"]},
             {"kind": "medicine", "name": "Metformin", "text": "Metformin", "names": ["Metformin"]}]
    assert _dolo("Medication:\nTab Dolo\n650 mg Metformin", scope, other, med=CAT) == ("check", True)
    assert _dolo("Medication:\nTab Dolo\n650 mg Metformin", scope, other, med=CAT) != ("eta", False)
    # a line that is not a continuation: it has to follow directly
    assert _dolo("Medication:\nTab Dolo\nafter food\n650 mg", scope, med=CAT) == ("check", True)


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix4_catalogue_name_shows_a_strength(scope):
    def cat(**kw):
        return {**CAT, "brand_name": "", "generic": "", **kw}
    for nm in ("Dolo 650 Tablet", "Paracetamol 650", "Dolo650", "Dolo-650 tab", "Paracetamol forty", "Paracetamol two hundred fifty", "Paracetamol 650\nmg",
               "Pan 40 BD", "Paracetamol 650 mg"):
        assert floors._catalogue_name_has_strength(cat(name=nm)), nm
        m = cat(name=nm)
        art = _syn("Medication:\nParacetamol", [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
        assert floors._field_hit(m, ["strength"], art, floors._prov_for(m, art), scope) == ("pulse_catalogue", True), nm
    for nm in ("Dolo", "Paracetamol tablets", "Dolo 3 days", "Paracetamol twice a day"):
        assert not floors._catalogue_name_has_strength(cat(name=nm)), nm
    assert not floors._catalogue_name_has_strength({"name": "Dolo 650", "uid": "u", "other": True})  # not a catalogue row


def test_fix4_number_word_normaliser_is_local():
    assert floors._wrote_norm("Forty mg") == "9 mg"
    assert floors._wrote_norm("two hundred and fifty mg") == "9 mg"
    assert floors._wrote_norm("twenty-five mg") == "9 mg"
    assert floors._wrote_norm("twice a day").split() == ["twice", "daily"]  # a frequency word, not a number
    assert floors._numnorm("forty mg") == "forty mg"  # the shared normaliser (FIX3) is untouched
    assert "forty" not in floors._NUMWORDS


# ---- generators and properties ---------------------------------------------------------------------------------------
# A rendering is (text, v3 unit, v4 unit): the unit each reading (FIX3's, FIX4's) takes from it. Two texts are the same unit when their
# FIX3 units are equal or their FIX4 units are equal (the check is the OR of the two readings, so a hit only moves toward eta).
# ETA's side can also be read at a line wrap, where a number has no unit (None) under both readings.
def render4(run, rng):
    n = int(run)
    t = rng.choice(["mg", "mg", "ml", "%", "days", "daily", "times", None])
    if t == "mg":
        u, v3u = rng.choice([("mg", "mg"), ("MG", "mg"), ("mgs", "mg"), ("m.g.", "mg"), ("\u338e", None), ("m\u200bg", "m"), ("\uff4d\uff47", "\uff4d\uff47")])
        fmt, wrapped = rng.choice([("{n} {u}", 0), ("{n}{u}", 0), ("{n}\u00a0{u}", 0), ("{n}\n{u}", 1), ("{n} [{u}]", 2), ('{n} "{u}"', 2), ("{n}: {u}", 2),
                                   ("{n} ({u})", 0), ("{n} \u201c{u}\u201d", 2)])
        # an unsplit mg keeps v3's reading; a unit behind [ " : or a curly quote is invisible to FIX3 (None)
        return fmt.format(n=run, u=u), (None if wrapped == 2 else v3u), "mg"
    if t == "ml":
        fmt, v3u = rng.choice([("{n} ml", "ml"), ("{n} mL", "ml"), ("{n} [ml]", None), ("{n}: ml", None)])
        return fmt.format(n=run), v3u, "ml"
    if t == "%":
        fmt, v3u = rng.choice([("{n}%", "%"), ("{n} %", "%"), ("{n} percent", "percent"), ("{n} per cent", "per"), ("{n} Percent", "percent"),
                               ("{n}\uff05", None), ("{n} [%]", None)])
        return fmt.format(n=run), v3u, "%"
    if t == "days":
        fmt, v3u = rng.choice([("{n} days", "day"), ("{n} Days", "day"), ("{n}-days", "day"), ("{n} [days]", None)])
        return fmt.format(n=run), v3u, "day" if v3u else "day"
    if t == "daily":
        if n in (1, 2, 3) and rng.random() < 0.5:
            w = {1: "once", 2: "twice", 3: "thrice"}[n]
            return rng.choice([(f"{w} a day", "daily"), (f"{w} daily", "daily"), (f"{w} per day", "per")]) + ("time",)
        fmt, v3u = rng.choice([("{n} a day", "daily"), ("{n} daily", "daily"), ("{n} per day", "per"), ("{n}/day", "day"), ("{n}\u00a0a\u00a0day", "daily")])
        return fmt.format(n=run), v3u, "daily"
    if t == "times":
        if n in (1, 2, 3) and rng.random() < 0.3:
            w = {1: "once", 2: "twice", 3: "thrice"}[n]
            return rng.choice([(f"{w} a day", "daily"), (f"{w} daily", "daily")]) + ("time",)
        return rng.choice(["{n} times a day", "{n} times daily", "{n} times per day", "{n} times/day", "{n} time a day", "{n} times"]).format(n=run), "time", "time"
    return run, None, None


def gen_case4(rng):
    run = str(rng.randint(1, 30))
    ft, f3, f4 = render4(run, rng)
    et, e3, e4 = render4(run, rng)
    if rng.random() < 0.3:
        et, e3, e4 = ft, f3, f4
    return run, ft, (f3, f4), et, (e3, e4)


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix4_same_unit_is_eta_generated(scope):
    """Same unit under either reading: eta, on the digit-run path and on the whole-field path. Different: eta_coincidence."""
    rng = random.Random(15102615)
    n_eta = n_coin = 0
    for _ in range(4000):
        run, ft, (f3, f4), et, (e3, e4) = gen_case4(rng)
        wrap = "\n" in et
        same = f3 == e3 or f4 == e4 or (wrap and (f3 is None or f4 is None))
        m = {"name": "Paracetamol", "duration": ft}
        art = _syn(_para(et + " ;"), [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
        prov = floors._prov_for(m, art)
        got = floors._run_source(m, "duration", run, art, prov, scope)
        assert got == ("eta" if same else "eta_coincidence"), (ft, et, (f3, f4), (e3, e4), got)
        n_eta += same
        n_coin += not same
    assert n_eta > 1000 and n_coin > 500


def gen_range4(rng):
    """The field gives `run UNIT`; ETA gives `run SEP hi UNIT`: every member takes the unit after the last number."""
    run, hi = str(rng.randint(1, 30)), str(rng.randint(31, 99))
    u = rng.choice(["mg", "ml", "days", "%", "mcg"])
    fu = u if rng.random() < 0.6 else rng.choice(["mg", "ml", "days", "%", "mcg"])
    sep = rng.choice(["-", "\u2013", "\u2014", "~", "/", ",", " to ", " or ", " and ", " - ", " / ", ", ", "\u00a0to\u00a0", " OR ", " And "])
    glue = "" if u == "%" else " "
    return run, f"{run}{glue}{fu}", f"{run}{sep}{hi}{glue}{u}", fu == u


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix4_range_and_list_separators_generated(scope):
    rng = random.Random(15102617)
    for _ in range(3000):
        run, ft, et, same = gen_range4(rng)
        m = {"name": "Paracetamol", "duration": ft}
        art = _syn(_para(et + " ;"), [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
        got = floors._run_source(m, "duration", run, art, floors._prov_for(m, art), scope)
        assert got == ("eta" if same else "eta_coincidence"), (ft, et, got)


def gen_wrote(rng):
    """(note, expected) over the A forms: expected True when ETA wrote a strength by rule (a)-(f); False for the controls."""
    brand = rng.choice(["Dolo", "Pan", "Telma", "Augmentin"])
    sep = rng.choice(["", " ", "-", " ", ": ", "\u00a0"])
    n = rng.choice(["650", "40", "5", "500", "forty", "two hundred fifty", "six hundred and fifty", "twenty five", "seventy-five", "one thousand"])
    tail = rng.choice(["", " mg", " tab", " BD", " 1-0-1", " Tablet", " ml", " mcg", " %"])
    kind = rng.choice(["name", "name", "unit", "wrap", "cont", "cont_wrap", "ctl_time", "ctl_none", "ctl_other", "freq"])
    pre = rng.choice(["", "Tab ", "Tab. ", "Cap "])
    if kind == "name":
        if sep == "" and not n.replace(" ", "").isdigit():
            sep = " "
        return f"Medication:\n{pre}{brand}{sep}{n}{tail}", True
    if kind == "unit":
        return f"Medication:\n{pre}{brand} {n} {rng.choice(['mg', 'ml', 'mcg', 'g', 'IU', '%', 'percent'])}", True
    if kind == "wrap":
        return f"Medication:\n{pre}{brand} {n}\n{rng.choice(['mg', 'ml', 'mcg'])}", True
    if kind == "cont":
        mid = rng.choice(["", "1-0-1\n", "OD\n1-0-1\n"][:2])
        return f"Medication:\n{pre}{brand}\n{mid}{n} mg{rng.choice(['', ' 1-0-1', ' after food'])}", True
    if kind == "cont_wrap":
        return f"Medication:\n{pre}{brand}\n{n}\nmg", True
    if kind == "ctl_time":
        return f"Medication:\n{pre}{brand}{sep or ' '}{rng.choice(['2', '3', 'two', 'ten'])} {rng.choice(['days', 'weeks', 'months', 'years', 'hours', 'minutes'])}", False
    if kind == "freq":  # FIX6: a frequency word never cancels a number
        return f"Medication:\n{pre}{brand}{sep or ' '}{rng.choice(['2', '3', 'two', 'ten', '40'])} {rng.choice(['times', 'daily', 'times a day', 'a day', 'OD', 'time daily'])}", True
    if kind == "ctl_none":
        return f"Medication:\n{pre}{brand} {rng.choice(['twice a day', 'after food', 'BD', 'once daily', 'at night', 'SOS'])}", False
    return f"Medication:\n{pre}{brand}\nMetformin {n} mg", False


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix4_wrote_strength_generated(scope):
    rng = random.Random(15102620)
    t = f = 0
    for _ in range(4000):
        note, expect = gen_wrote(rng)
        brand = next(b for b in ("Augmentin", "Dolo", "Pan", "Telma") if b in note)
        prov = [{"kind": "medicine", "name": brand, "text": brand, "names": [brand]}]
        got = _wrote(brand, note, prov, scope)
        assert got == (("eta", False) if expect else ("check", True)), (note, got)
        t += expect
        f += not expect
    assert t > 1500 and f > 800


def gen_any(rng):
    """A mix of every form, with the FIX3 forms, for the properties against the two oracles."""
    kind = rng.random()
    if kind < 0.4:
        run, ft, _, et, _ = gen_case4(rng)
        return {"name": "Paracetamol", rng.choice(["strength", "frequency", "duration"]): ft, **(CAT if rng.random() < 0.4 else {})}, _para(et + " ;"), None
    if kind < 0.8:
        note, _ = gen_wrote(rng)
        brand = next(b for b in ("Augmentin", "Dolo", "Pan", "Telma") if b in note)
        field = rng.choice(["strength", "frequency", "duration"])
        m = {"name": brand, **(CAT if rng.random() < 0.5 else {}), "name_": brand}
        m["name"] = brand
        if rng.random() < 0.25:
            m[field] = rng.choice(["", "5 mg", "2 times a day", "twice a day", "650", "5 percent", "after food"])
        return m, note, brand
    m, field, run, art, in_eta, _ = gen_case(rng)
    return m, art["note_text"], "Paracetamol"


def _rank(src, moved):
    """eta 0, eta_coincidence 1, a hit the old rule counted as eta but FIX3 flagged wrote_nothing 2, anything else 3."""
    if src == "eta":
        return 0
    if src == "eta_coincidence":
        return 1
    return 2 if moved else 3


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix4_moves_no_hit_away_from_eta(scope, prev):
    """Property: over the generators, no FIX4 change moves any hit away from eta compared with 387abea4, on the digit-run path
    and on the judged-field path, with and without the wrote_nothing flag. Improvements are counted, so the property is not vacuous."""
    rng = random.Random(15102630)
    better = worse = same = 0
    for _ in range(6000):
        m, note, brand = gen_any(rng)
        brand = brand or "Paracetamol"
        art = _syn(note, [{"kind": "medicine", "name": brand, "text": brand, "names": [brand]}])
        field = next((k for k in ("strength", "frequency", "duration") if _s(m.get(k)) or k == "strength"), "strength")
        for k in ("strength", "frequency", "duration"):
            if _s(m.get(k)):
                field = k
        pn, po = floors._prov_for(m, art), prev._prov_for(m, art)
        new, old = floors._field_hit1(m, field, art, pn, scope), prev._field_hit1(m, field, art, po, scope)
        assert _rank(*new) <= _rank(*old), (m, note, new, old)
        better += _rank(*new) < _rank(*old)
        worse += _rank(*new) > _rank(*old)
        same += _rank(*new) == _rank(*old)
        for r in floors._DIGITS.findall(_s(m.get(field))):
            ns, os_ = floors._run_source(m, field, r, art, pn, scope), prev._run_source(m, field, r, art, po, scope)
            assert _rank(ns, False) <= _rank(os_, False), (m, note, r, ns, os_)
        assert (not prev._eta_wrote_strength(m, art, po)) or floors._eta_wrote_strength(m, art, pn)
        if floors._is_catalogue(m):
            assert (not prev._catalogue_name_has_strength(m)) or floors._catalogue_name_has_strength(m)
    assert worse == 0 and better > 300 and same > 300


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix4_legacy_equivalence_on_the_fix4_generators(scope):
    """The origin/main oracle (3e10381c, private copy above) still holds over the FIX4 forms: old eta <=> new eta, eta_coincidence or flagged."""
    rng = random.Random(15102640)
    for _ in range(5000):
        m, note, brand = gen_any(rng)
        brand = brand or "Paracetamol"
        art = _syn(note, [{"kind": "medicine", "name": brand, "text": brand, "names": [brand]}])
        prov = floors._prov_for(m, art)
        for field in ("strength", "frequency", "duration"):
            new, moved = floors._field_hit1(m, field, art, prov, scope)
            old = old_field_source(m, field, art, prov, scope)
            assert (old == "eta") == (new in ("eta", "eta_coincidence") or moved), (m, note, field, old, new, moved)
            for r in floors._DIGITS.findall(_s(m.get(field))):
                nr, orr = floors._run_source(m, field, r, art, prov, scope), old_run_source(m, field, r, art, prov, scope)
                assert (orr == "eta") == (nr in ("eta", "eta_coincidence")), (m, note, field, r, orr, nr)
                if orr != "eta":
                    assert nr == orr


def test_fix4_the_new_probes_fail_on_387abea4(prev):
    """The probes are not vacuous: against FIX3's own code, finding A's forms read as wrote-nothing and finding B's as coincidence."""
    wrong_a = 0
    for note in WROTE:
        m = {"name": "Dolo"}
        art = _syn(note, [{"kind": "medicine", "name": "Dolo", "text": "Dolo", "names": ["Dolo"]}])
        wrong_a += not prev._eta_wrote_strength(m, art, prev._prov_for(m, art))
    assert wrong_a >= 20
    wrong_b = 0
    for value, eta_text in SAME_UNIT:
        m = {"name": "Paracetamol", "duration": value}
        art = _syn(_para(eta_text), [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
        wrong_b += any(prev._run_source(m, "duration", r, art, prev._prov_for(m, art), "global") == "eta_coincidence" for r in floors._DIGITS.findall(value))
    assert wrong_b >= 20


# ---- FIX5 (15 Oct 2026): the VERDICT3 probes -----------------------------------------------------------------------------------
PREV4 = "01e164fd"  # FIX4: the third oracle


@pytest.fixture(scope="module")
def prev4():
    src = subprocess.run(["git", "show", f"{PREV4}:tools/eta2freescript/eval/pdqi9/floors.py"], cwd=Path(__file__).resolve().parent,
                         capture_output=True, text=True, check=True).stdout
    mod = types.ModuleType("tools.eta2freescript.eval.pdqi9.floors_prev4")
    mod.__package__ = "tools.eta2freescript.eval.pdqi9"
    exec(compile(src, f"floors@{PREV4}", "exec"), mod.__dict__)
    return mod


# finding 1, 2, 3: same unit, so eta (each pair, value vs ETA)
SAME_UNIT5 = [
    ("5 mg", "five or ten mg"), ("5 mg", "five and ten mg"), ("5 mg", "five, ten mg"), ("5 mg", "five/ten mg"), ("5 mg", "five\u2014ten mg"),
    ("5 mg", "five ~ ten mg"), ("5 mg", "five to ten mg"), ("5 mg", "five-ten mg"), ("10 mg", "five or ten mg"), ("5 mg", "two hundred or five mg"),
    ("\uff15 mg", "\uff15 \u338e"), ("\uff15 mg", "\uff15 [mg]"), ("\uff15 mg", "\uff15 mg"),
    ("2x daily", "twice a day"), ("2 x a day", "twice a day"), ("2x daily", "twice daily"), ("2 x a day", "twice daily"), ("twice a day", "2x daily"),
    ("twice daily", "2 x a day"), ("2 times a day", "2x daily"), ("3x daily", "thrice a day"), ("1x daily", "once a day"), ("2X daily", "twice a day"),
]


@pytest.mark.parametrize("scope", ["global", "medicine"])
@pytest.mark.parametrize("value,eta_text", SAME_UNIT5)
def test_fix5_same_unit_is_eta(scope, value, eta_text):
    runs, whole = _eta_both_paths(value, eta_text, scope)
    assert set(runs) <= {"eta"}, (value, eta_text, runs)
    assert whole == "eta", (value, eta_text, whole)


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix5_different_units_stay_coincidence(scope):
    for value, eta_text in [("5 mg", "five or ten days"), ("5 mg", "five ml"), ("2x daily", "2 mg"), ("5 days", "five or ten mg"), ("2x daily", "2 days"),
                            ("\uff15 mg", "\uff15 ml")]:
        runs, whole = _eta_both_paths(value, eta_text, scope)
        assert runs == ["eta_coincidence"] and whole == "eta_coincidence", (value, eta_text, runs, whole)


# finding 4 and 5: ETA wrote a strength
WROTE5 = [
    "Medication:\nDolo-DSR 650", "Medication:\n650 Dolo",
    "Medication:\nTab. 650 Dolo", "Medication:\nDolo 650 + Pan 40", "Medication:\nPan & Dolo 40 mg each", "Medication:\nDolo and Pan 40",
    "Medication:\nTab Dolo\n- 650 mg", "Medication:\nTab Dolo\n\u2022 650 mg", "Medication:\nTab Dolo\nStrength: 650 mg", "Medication:\nTab Dolo\nDose: 650 mg",
    "Medication:\nTab Dolo\n* 650", "Medication:\nTab Dolo\n\u00b7 forty mg", "Medication:\nTab Dolo\nDose: forty",
    "Medication:\nTab Dolo\n(650 mg)", "Medication:\nTab Dolo\n650 mg", "Medication:\nDolo \uff16\uff15\uff10",
]
WROTE5_PAIRS = [  # (rx name, note)
    ("Dolo", "Medication:\nDolo-DSR 650"), ("Pan", "Medication:\nPan D 40"), ("Pan D", "Medication:\nPan-D 40"), ("Augmentin", "Medication:\nAugmentin Duo 625"),
    ("Telma AM", "Medication:\nTelma-AM 40"), ("Pan", "Medication:\nPan & Dolo 40 mg each"), ("Pan", "Medication:\nDolo 650 + Pan 40"),
    ("Dolo", "Medication:\nDolo and Pan 40"), ("Telma AM", "Medication:\nTelma-AM 40 tab"), ("Pan D", "Medication:\nPan D 40"),
]


@pytest.mark.parametrize("scope", ["global", "medicine"])
@pytest.mark.parametrize("note", WROTE5)
def test_fix5_note_forms_are_eta_wrote_a_strength(scope, note):
    assert _dolo(note, scope, med=CAT) == ("eta", False), note
    assert floors._eta_wrote_strength({"name": "Dolo"}, _syn(note, []), None) is True, note


@pytest.mark.parametrize("scope", ["global", "medicine"])
@pytest.mark.parametrize("name,note", WROTE5_PAIRS)
def test_fix5_brand_suffix_and_hyphen_pairs(scope, name, note):
    prov = [{"kind": "medicine", "name": name, "text": name, "names": [name]}]
    assert _wrote(name, note, prov, scope) == ("eta", False), (name, note)


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix5_provenance_strength_without_unit_or_note_number(scope):
    for strength in ({"text": "650", "value": "650"}, {"value": "650"}, {"value": 650}, {"value": 650.0}, {"text": "650"}, {"value": "forty"},
                     {"text": "forty"}, {"value": "650", "unit": "tablet"}, "650", 650, 0.5, {"value": "2 daily"}, {"text": "40 daily"}):
        p = {"kind": "medicine", "name": "Dolo", "text": "Dolo", "names": ["Dolo"], "medicine": {"strength": strength}}
        assert _dolo("Medication:\nTab Dolo", scope, [p], med=CAT) == ("eta", False), strength
    for strength in ({"text": "5 days"}, {"text": "twice a day"}, {}, None, {"text": "", "value": None}):
        p = {"kind": "medicine", "name": "Dolo", "text": "Dolo", "names": ["Dolo"], "medicine": {"strength": strength}}
        assert _dolo("Medication:\nTab Dolo", scope, [p], med=CAT) == ("check", True), strength


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix5_controls_stay_wrote_nothing(scope):
    for note in ["Medication:\nDolo x 5 days", "Medication:\nDolo for 5 days", "Medication:\nDolo 5 days", "Medication:\nDolo\nBP 120 mmHg",
                 "Medication:\nDolo-DSR x 5 weeks", "Medication:\nDolo for five days",
                 "Medication:\nDolo\n- for 5 days", "Medication:\nDolo\nDuration: 5 days", "Medication:\nDolo twice a day", "Medication:\nDolo\nBP 120 mmHg\nPan 40"]:
        assert _dolo(note, scope, med=CAT) == ("check", True), note
    # BP on another line that names no medicine is not this medicine's strength, even beside a named line
    assert _dolo("Medication:\nTab Dolo\nafter food\nBP: 120 mmHg", scope, med=CAT) == ("check", True)


def test_fix5_structural_rule_reads_x_then_a_time_word():
    n = lambda t: floors._any_number_not_time(floors._wrote_norm(t))
    assert not n("dolo x 5 days") and not n("dolo 5 weeks") and not n("dolo for five days") and not n("dolo 1 hour") and not n("dolo x 2 weeks")
    assert n("dolo 2x daily") and n("dolo 2 x a day") and n("dolo 3 x per day") and n("dolo 2 times a day")  # FIX6: frequency never cancels
    assert n("dolo 2x mg") and n("dolo 2 x") and n("dolo 650") and n("dolo 1-0-1") and n("dolo \uff16\uff15\uff10") and n("dolo forty")


def render5(rng):
    """(value, eta_text, same_unit) over the new separators with number words, full-width digits and Nx."""
    unit = rng.choice(["mg", "ml", "mcg"])
    kind = rng.choice(["sep", "sep", "fw", "x"])
    if kind == "sep":
        a, b = rng.randint(1, 15), rng.randint(16, 20)
        sep = rng.choice([" or ", " and ", ", ", "/", " / ", "\u2014", " ~ ", " to ", "-", " - ", "\u2013"])
        other = rng.choice([u for u in ("mg", "ml", "mcg") if u != unit])
        same = rng.random() < 0.6
        return f"{a} {unit}", f"{WORD[a]}{sep}{WORD[b]} {unit if same else other}", same
    if kind == "fw":
        n = rng.randint(1, 9)
        fw = chr(0xFF10 + n)
        same = rng.random() < 0.6
        return f"{fw} {unit}", f"{fw} {rng.choice(['[%s]' % unit, unit, '(%s)' % unit]) if same else 'ml' if unit != 'ml' else 'mg'}", same
    n = rng.randint(1, 3)
    w = {1: "once", 2: "twice", 3: "thrice"}[n]
    x = rng.choice([f"{n}x", f"{n} x", f"{n}X"])
    same = rng.random() < 0.6
    return f"{x} {rng.choice(['daily', 'a day', 'per day'])}", f"{w} {rng.choice(['daily', 'a day'])}" if same else f"{n} days", same


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix5_same_unit_generated(scope):
    rng = random.Random(15102650)
    t = f = 0
    for _ in range(3000):
        value, et, same = render5(rng)
        runs, whole = _eta_both_paths(value, et, scope)
        want = "eta" if same else "eta_coincidence"
        assert set(runs) == {want} and whole == want, (value, et, runs, whole)
        t += same
        f += not same
    assert t > 1000 and f > 800


def gen_wrote5(rng):
    """(rx name, note, expected) for the structural rule."""
    pair = rng.choice([("Dolo", "Dolo"), ("Dolo", "Dolo-DSR"), ("Pan", "Pan D"), ("Pan D", "Pan-D"), ("Augmentin", "Augmentin Duo"), ("Telma AM", "Telma-AM"),
                       ("Telma AM", "Telma AM")])
    n = rng.choice(["650", "40", "625", "five", "forty", "0.5"])
    pre = rng.choice(["", "Tab ", "Tab. ", "Cap "])
    kind = rng.choice(["name", "name", "lead", "bullet", "label", "ctl_time", "ctl_none"])
    if kind == "name":
        return pair[0], f"Medication:\n{pre}{pair[1]} {n}{rng.choice(['', ' mg', ' tab', ' BD'])}", True
    if kind == "lead":
        return pair[0], f"Medication:\n{n} {pre}{pair[1]}", True
    if kind == "bullet":
        bullet = rng.choice(["-", "\u2022", "*", "\u00b7"])
        return pair[0], f"Medication:\n{pre}{pair[1]}\n{bullet} {n} mg", True
    if kind == "label":
        return pair[0], f"Medication:\n{pre}{pair[1]}\n{rng.choice(['Strength', 'Dose', 'Tablet strength'])}: {n} mg", True
    if kind == "ctl_time":
        return pair[0], f"Medication:\n{pre}{pair[1]} {rng.choice(['x ', 'for ', ''])}{rng.choice(['5', 'five', '2'])} {rng.choice(['days', 'weeks', 'months', 'hours'])}", False
    return pair[0], f"Medication:\n{pre}{pair[1]}\nBP 120 mmHg", False


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix5_wrote_strength_generated(scope):
    rng = random.Random(15102660)
    t = f = 0
    for _ in range(4000):
        name, note, expect = gen_wrote5(rng)
        prov = [{"kind": "medicine", "name": name, "text": name, "names": [name]}]
        assert _wrote(name, note, prov, scope) == (("eta", False) if expect else ("check", True)), (name, note)
        t += expect
        f += not expect
    assert t > 1500 and f > 800


def gen_any5(rng):
    if rng.random() < 0.5:
        name, note, _ = gen_wrote5(rng)
        field = rng.choice(["strength", "frequency", "duration"])
        m = {"name": name}
        if rng.random() < 0.3:
            m[field] = rng.choice(["", "5 mg", "2x daily", "twice a day", "650", "5 percent", "after food", "\uff15 mg"])
        return m, note, name
    if rng.random() < 0.5:
        value, et, _ = render5(rng)
        return {"name": "Paracetamol", rng.choice(["strength", "frequency", "duration"]): value}, _para(et), "Paracetamol"
    return gen_any(rng)


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix5_moves_no_hit_away_from_eta_vs_fix4_and_fix3(scope, prev, prev4):
    """Property: no FIX5 change moves a hit away from eta compared with 01e164fd (FIX4) or 387abea4 (FIX3)."""
    rng = random.Random(15102670)
    better = worse = same = 0
    for _ in range(6000):
        m, note, brand = gen_any5(rng)
        art = _syn(note, [{"kind": "medicine", "name": brand, "text": brand, "names": [brand]}])
        field = "strength"
        for k in ("strength", "frequency", "duration"):
            if _s(m.get(k)):
                field = k
        pn = floors._prov_for(m, art)
        new = floors._field_hit1(m, field, art, pn, scope)
        for oracle in (prev4, prev):
            po = oracle._prov_for(m, art)
            old = oracle._field_hit1(m, field, art, po, scope)
            assert _rank(*new) <= _rank(*old), (m, note, new, old)
            for r in floors._DIGITS.findall(_s(m.get(field))):
                assert _rank(floors._run_source(m, field, r, art, pn, scope), False) <= _rank(oracle._run_source(m, field, r, art, po, scope), False), (m, note, r)
            assert (not oracle._eta_wrote_strength(m, art, po)) or floors._eta_wrote_strength(m, art, pn), (m, note)
            if floors._is_catalogue(m):
                assert (not oracle._catalogue_name_has_strength(m)) or floors._catalogue_name_has_strength(m)
            if oracle is prev4:
                better += _rank(*new) < _rank(*old)
                worse += _rank(*new) > _rank(*old)
                same += _rank(*new) == _rank(*old)
    assert worse == 0 and better > 300 and same > 300, (better, worse, same)


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix5_legacy_equivalence(scope):
    """origin/main oracle (private copy above) over the FIX5 generators: old eta <=> new eta, eta_coincidence or flagged."""
    rng = random.Random(15102680)
    for _ in range(5000):
        m, note, brand = gen_any5(rng)
        art = _syn(note, [{"kind": "medicine", "name": brand, "text": brand, "names": [brand]}])
        prov = floors._prov_for(m, art)
        for field in ("strength", "frequency", "duration"):
            new, moved = floors._field_hit1(m, field, art, prov, scope)
            old = old_field_source(m, field, art, prov, scope)
            assert (old == "eta") == (new in ("eta", "eta_coincidence") or moved), (m, note, field, old, new, moved)
            for r in floors._DIGITS.findall(_s(m.get(field))):
                nr, orr = floors._run_source(m, field, r, art, prov, scope), old_run_source(m, field, r, art, prov, scope)
                assert (orr == "eta") == (nr in ("eta", "eta_coincidence")), (m, note, field, r, orr, nr)
                if orr != "eta":
                    assert nr == orr


def test_fix5_the_new_probes_fail_on_fix4(prev4):
    wrong = sum(not prev4._eta_wrote_strength({"name": n}, _syn(note, []), None) for n, note in WROTE5_PAIRS)
    assert wrong >= 5
    bad = 0
    for value, et in SAME_UNIT5:
        m = {"name": "Paracetamol", "duration": value}
        art = _syn(_para(et), [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
        bad += any(prev4._run_source(m, "duration", r, art, prev4._prov_for(m, art), "global") == "eta_coincidence" for r in floors._DIGITS.findall(value))
    assert bad >= 10


# ---- FIX6 (15 Oct 2026): VERDICT4 findings 1 and 2 -----------------------------------------------------------------------------
PREV5 = "ec06d654"  # FIX5: the fourth oracle


@pytest.fixture(scope="module")
def prev5():
    src = subprocess.run(["git", "show", f"{PREV5}:tools/eta2freescript/eval/pdqi9/floors.py"], cwd=Path(__file__).resolve().parent,
                         capture_output=True, text=True, check=True).stdout
    mod = types.ModuleType("tools.eta2freescript.eval.pdqi9.floors_prev5")
    mod.__package__ = "tools.eta2freescript.eval.pdqi9"
    exec(compile(src, f"floors@{PREV5}", "exec"), mod.__dict__)
    return mod


# finding 1: a brand strength followed by a frequency word is a strength ETA wrote. (note, brand)
WROTE6 = [
    ("Tab Pan 40 daily before breakfast", "Pan"), ("PAN 40 DAILY", "Pan"), ("Ecosprin 75 daily", "Ecosprin"), ("Glycomet 500 daily x 1 month", "Glycomet"),
    ("Pan forty daily", "Pan"), ("Pan 40 a day", "Pan"), ("Pan 40/day", "Pan"), ("Pan 40 - daily", "Pan"), ("Pan\t40\tdaily", "Pan"),
    ("Tab Pan\n40 daily", "Pan"), ("Pan 40 times daily", "Pan"), ("Pan 40 morning", "Pan"), ("Pan 40 at night", "Pan"), ("Pan 40 OD", "Pan"),
    ("Pan 40 x daily", "Pan"), ("Pan 2 time", "Pan"),
]
WROTE6_NOTHING = ["Dolo x 5 days", "Dolo for 5 days", "Dolo 5 days", "Pan x 5 days", "Dolo for five days", "Dolo 5 weeks", "Dolo 1 hour",
                  "Dolo x 2 months", "Dolo twice a day", "Dolo"]


@pytest.mark.parametrize("scope", ["global", "medicine"])
@pytest.mark.parametrize("note,brand", WROTE6)
def test_fix6_frequency_word_never_cancels_a_number(scope, note, brand):
    got = _wrote(brand, f"Medication:\n{note}", [{"kind": "medicine", "name": brand, "text": brand, "names": [brand]}], scope)
    assert got == ("eta", False), (note, got)
    m = {"name": brand}
    art = _syn(f"Medication:\n{note}", [{"kind": "medicine", "name": brand, "text": brand, "names": [brand]}])
    assert floors._eta_wrote_strength(m, art, floors._prov_for(m, art))


@pytest.mark.parametrize("scope", ["global", "medicine"])
@pytest.mark.parametrize("note", WROTE6_NOTHING)
def test_fix6_duration_word_still_cancels(scope, note):
    brand = "Pan" if note.startswith("Pan") else "Dolo"
    assert _wrote(brand, f"Medication:\n{note}", [{"kind": "medicine", "name": brand, "text": brand, "names": [brand]}], scope, CAT) == ("check", True), note


# finding 2: abbreviation and synonym units are the same unit (each pair, both ways)
SYN6 = [
    ("1 tab", "one tablet"), ("2 tablets", "2 tabs"), ("5 days", "5d"), ("2 weeks", "2 wks"), ("5 ml", "5 cc"), ("10 units", "10 IU"),
    ("5 mg", "five milligram"), ("5 mcg", "5 µg"), ("5 mcg", "5 μg"), ("5 mcg", "5 microgram"), ("12 hourly", "12 hrly"),
    ("12 hr", "12 hourly"), ("5 hours", "5 hrs"), ("5 days", "5 दिन"), ("2 caps", "2 capsules"), ("5 g", "5 gram"), ("3 wk", "3 weeks"),
]


@pytest.mark.parametrize("scope", ["global", "medicine"])
@pytest.mark.parametrize("value,eta_text", SYN6 + [(b, a) for a, b in SYN6 if any(c.isdigit() for c in b)])
def test_fix6_unit_synonyms_are_eta(scope, value, eta_text):
    runs, whole = _eta_both_paths(value, eta_text, scope)
    assert runs and set(runs) <= {"eta"}, (value, eta_text, runs)
    assert whole == "eta", (value, eta_text, whole)


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix6_different_units_stay_coincidence(scope):
    for value, eta_text in [("5 mg", "5 ml"), ("5 mg", "5 mcg"), ("5 days", "5 weeks"), ("5 days", "5 hours"), ("1 tab", "1 mg"), ("5 ml", "5 g"),
                            ("10 units", "10 mg"), ("5 days", "5 साल"), ("2 caps", "2 tablets")]:
        runs, whole = _eta_both_paths(value, eta_text, scope)
        assert runs == ["eta_coincidence"] and whole == "eta_coincidence", (value, eta_text, runs, whole)


def gen_any6(rng):
    r = rng.random()
    if r < 0.3:
        brand = rng.choice(["Pan", "Ecosprin", "Glycomet", "Dolo", "Telma"])
        n = rng.choice(["40", "75", "500", "forty", "2"])
        sep = rng.choice([" ", "\t", " - ", "-", ": "])
        tail = rng.choice([" daily", " a day", "/day", " times", " time a day", " OD", " morning", " at night", " x 5 days", " for 5 days", " days", ""])
        name = rng.choice(["", "Tab ", "Cap "]) + brand
        m = {"name": brand}
        if rng.random() < 0.4:
            m[rng.choice(["strength", "frequency", "duration"])] = rng.choice(["", "5 mg", "2x daily", "650", "5 days"])
        return m, f"Medication:\n{name}{sep}{n}{tail}", brand
    if r < 0.6:
        a, b = rng.choice(SYN6)
        if rng.random() < 0.5:
            a, b = b, a
        return {"name": "Paracetamol", rng.choice(["strength", "frequency", "duration"]): a}, _para(b), "Paracetamol"
    return gen_any5(rng)


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix6_moves_no_hit_away_from_eta_vs_fix5_fix4_and_fix3(scope, prev, prev4, prev5):
    """Property: no FIX6 change moves a hit away from eta compared with ec06d654 (FIX5), 01e164fd (FIX4) or 387abea4 (FIX3).
    Both non-vacuity bounds are asserted against FIX5: hits that got better, and hits that stayed the same."""
    rng = random.Random(15102690)
    better = worse = same = wrote_up = 0
    for _ in range(6000):
        m, note, brand = gen_any6(rng)
        art = _syn(note, [{"kind": "medicine", "name": brand, "text": brand, "names": [brand]}])
        field = "strength"
        for k in ("strength", "frequency", "duration"):
            if _s(m.get(k)):
                field = k
        pn = floors._prov_for(m, art)
        new = floors._field_hit1(m, field, art, pn, scope)
        for oracle in (prev5, prev4, prev):
            po = oracle._prov_for(m, art)
            old = oracle._field_hit1(m, field, art, po, scope)
            assert _rank(*new) <= _rank(*old), (m, note, new, old)
            for r in floors._DIGITS.findall(_s(m.get(field))):
                assert _rank(floors._run_source(m, field, r, art, pn, scope), False) <= _rank(oracle._run_source(m, field, r, art, po, scope), False), (m, note, r)
            assert (not oracle._eta_wrote_strength(m, art, po)) or floors._eta_wrote_strength(m, art, pn), (m, note)
            if floors._is_catalogue(m):
                assert (not oracle._catalogue_name_has_strength(m)) or floors._catalogue_name_has_strength(m)
            if oracle is prev5:
                better += _rank(*new) < _rank(*old)
                worse += _rank(*new) > _rank(*old)
                same += _rank(*new) == _rank(*old)
                wrote_up += floors._eta_wrote_strength(m, art, pn) and not oracle._eta_wrote_strength(m, art, po)
    assert worse == 0 and better > 300 and same > 300 and wrote_up > 300, (better, worse, same, wrote_up)


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix6_legacy_equivalence(scope):
    """origin/main oracle (private copy above) over the FIX6 generators: old eta <=> new eta, eta_coincidence or flagged."""
    rng = random.Random(15102700)
    for _ in range(5000):
        m, note, brand = gen_any6(rng)
        art = _syn(note, [{"kind": "medicine", "name": brand, "text": brand, "names": [brand]}])
        prov = floors._prov_for(m, art)
        for field in ("strength", "frequency", "duration"):
            new, moved = floors._field_hit1(m, field, art, prov, scope)
            old = old_field_source(m, field, art, prov, scope)
            assert (old == "eta") == (new in ("eta", "eta_coincidence") or moved), (m, note, field, old, new, moved)
            for r in floors._DIGITS.findall(_s(m.get(field))):
                nr, orr = floors._run_source(m, field, r, art, prov, scope), old_run_source(m, field, r, art, prov, scope)
                assert (orr == "eta") == (nr in ("eta", "eta_coincidence")), (m, note, field, r, orr, nr)
                if orr != "eta":
                    assert nr == orr


def test_fix6_the_new_probes_fail_on_fix5(prev5):
    wrong = sum(not prev5._eta_wrote_strength({"name": b}, _syn(f"Medication:\n{n}", []), None) for n, b in WROTE6)
    assert wrong >= 8
    bad = 0
    for value, et in SYN6:
        m = {"name": "Paracetamol", "duration": value}
        art = _syn(_para(et), [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
        bad += any(prev5._run_source(m, "duration", r, art, prev5._prov_for(m, art), "global") == "eta_coincidence" for r in floors._DIGITS.findall(value))
    assert bad >= 10


# ---- FIX8 (15 Oct 2026): VERDICT5 findings 1, 2 and 3 --------------------------------------------------------------------------
PREV6 = "66ccda0a"  # FIX7: the fifth oracle


@pytest.fixture(scope="module")
def prev6():
    src = subprocess.run(["git", "show", f"{PREV6}:tools/eta2freescript/eval/pdqi9/floors.py"], cwd=Path(__file__).resolve().parent,
                         capture_output=True, text=True, check=True).stdout
    mod = types.ModuleType("tools.eta2freescript.eval.pdqi9.floors_prev6")
    mod.__package__ = "tools.eta2freescript.eval.pdqi9"
    exec(compile(src, f"floors@{PREV6}", "exec"), mod.__dict__)
    return mod


# finding 1 ("gm") and finding 2 (abbreviations): the same unit, so eta (each pair, both ways)
SYN8 = [
    ("1 g", "1 gm"), ("1 gm", "1 gram"), ("2 gm", "2 g"), ("10 U", "10 units"), ("10 u", "10 IU"), ("1 tsp", "1 teaspoon"), ("2 gtt", "2 drops"),
    ("1 mo", "1 month"), ("1 mnth", "1 month"), ("1 mth", "1 month"), ("1 month", "one mnth"), ("3 dys", "3 days"), ("5 din", "5 days"),
    ("5 din", "5 d"), ("2 mo", "2 months"),
]


@pytest.mark.parametrize("scope", ["global", "medicine"])
@pytest.mark.parametrize("value,eta_text", SYN8 + [(b, a) for a, b in SYN8 if any(c.isdigit() for c in b)])
def test_fix8_unit_synonyms_are_eta(scope, value, eta_text):
    runs, whole = _eta_both_paths(value, eta_text, scope)
    assert runs and set(runs) <= {"eta"}, (value, eta_text, runs)
    assert whole == "eta", (value, eta_text, whole)


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix8_different_units_stay_coincidence(scope):
    # "u" is read only as the whole unit token after the number, so a word that starts with u is not the unit u
    for value, eta_text in [("1 g", "1 mg"), ("5 g", "5 mg"), ("10 u", "10 ml"), ("10 units", "10 ml"), ("2 gtt", "2 ml"), ("1 mo", "1 day"),
                            ("1 month", "1 day"), ("3 dys", "3 weeks"), ("10 u", "10 mg"), ("10 u", "10 uses"), ("1 tsp", "1 ml"), ("5 din", "5 hours"),
                            ("1 gm", "1 mg")]:
        runs, whole = _eta_both_paths(value, eta_text, scope)
        assert runs == ["eta_coincidence"] and whole == "eta_coincidence", (value, eta_text, runs, whole)


# finding 3: a label that ends in a colon, a hyphen or plain whitespace still starts a continuation line
WROTE8 = ["Tab Pan\nTablet strength 40 mg", "Tab Pan\nQty - 40", "Tab Pan\nDose 40 mg", "Tab Pan\nStrength - 40 mg", "Tab Pan\nStrength: 40 mg", "Tab Pan\nStrength-40 mg", "Tab Pan\nDose  40", "Tab Pan\n- Dose 40 mg"]


@pytest.mark.parametrize("scope", ["global", "medicine"])
@pytest.mark.parametrize("note", WROTE8)
def test_fix8_label_before_a_continuation_number(scope, note):
    prov = [{"kind": "medicine", "name": "Pan", "text": "Pan", "names": ["Pan"]}]
    assert _wrote("Pan", f"Medication:\n{note}", prov, scope) == ("eta", False), note
    m = {"name": "Pan"}
    art = _syn(f"Medication:\n{note}", prov)
    assert floors._eta_wrote_strength(m, art, floors._prov_for(m, art)) is True


@pytest.mark.parametrize("scope", ["global", "medicine"])
@pytest.mark.parametrize("note", ["Dolo\nMetformin 500 mg", "Dolo\nBP 120 mmHg", "Dolo\nMetformin - 500 mg", "Dolo\nBP - 120 mmHg"])
def test_fix8_other_unlabelled_lines_are_not_continuations(scope, note):
    prov = [{"kind": "medicine", "name": "Dolo", "text": "Dolo", "names": ["Dolo"]}]
    assert _wrote("Dolo", f"Medication:\n{note}", prov, scope, CAT) == ("check", True), note


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix8_dolo_x_5_days_still_wrote_nothing(scope):
    assert _wrote("Dolo", "Medication:\nDolo x 5 days", [{"kind": "medicine", "name": "Dolo", "text": "Dolo", "names": ["Dolo"]}], scope, CAT) == ("check", True)


def gen_any8(rng):
    r = rng.random()
    if r < 0.3:
        brand = rng.choice(["Pan", "Ecosprin", "Dolo"])
        label = rng.choice(["Dose", "Strength", "Qty", "Dose:", "Strength -", "Strength - ", "Dose "])
        tail = rng.choice([" mg", " daily", " x 5 days", " days", " gm", ""])
        return {"name": brand}, f"Medication:\nTab {brand}\n{label}{rng.choice([' ', ''])}{rng.choice(['40', '5', 'forty'])}{tail}", brand
    if r < 0.6:
        a, b = rng.choice(SYN8)
        if rng.random() < 0.5:
            a, b = b, a
        return {"name": "Paracetamol", rng.choice(["strength", "frequency", "duration"]): a}, _para(b), "Paracetamol"
    return gen_any6(rng)


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix8_moves_no_hit_away_from_eta_vs_66ccda0a(scope, prev6):
    """Property: no FIX8 change moves a hit away from eta compared with 66ccda0a. Non-vacuity bounds are asserted."""
    rng = random.Random(15102810)
    better = worse = same = wrote_up = 0
    for _ in range(6000):
        m, note, brand = gen_any8(rng)
        art = _syn(note, [{"kind": "medicine", "name": brand, "text": brand, "names": [brand]}])
        field = "strength"
        for k in ("strength", "frequency", "duration"):
            if _s(m.get(k)):
                field = k
        pn, po = floors._prov_for(m, art), prev6._prov_for(m, art)
        new, old = floors._field_hit1(m, field, art, pn, scope), prev6._field_hit1(m, field, art, po, scope)
        assert _rank(*new) <= _rank(*old), (m, note, new, old)
        for r in floors._DIGITS.findall(_s(m.get(field))):
            assert _rank(floors._run_source(m, field, r, art, pn, scope), False) <= _rank(prev6._run_source(m, field, r, art, po, scope), False), (m, note, r)
        assert (not prev6._eta_wrote_strength(m, art, po)) or floors._eta_wrote_strength(m, art, pn), (m, note)
        if floors._is_catalogue(m):
            assert (not prev6._catalogue_name_has_strength(m)) or floors._catalogue_name_has_strength(m)
        better += _rank(*new) < _rank(*old)
        worse += _rank(*new) > _rank(*old)
        same += _rank(*new) == _rank(*old)
        wrote_up += floors._eta_wrote_strength(m, art, pn) and not prev6._eta_wrote_strength(m, art, po)
    assert worse == 0 and better > 100 and same > 300 and wrote_up > 100, (better, worse, same, wrote_up)


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_fix8_legacy_equivalence(scope):
    """origin/main oracle (private copy above) over the FIX8 generators: old eta <=> new eta, eta_coincidence or flagged."""
    rng = random.Random(15102820)
    for _ in range(5000):
        m, note, brand = gen_any8(rng)
        art = _syn(note, [{"kind": "medicine", "name": brand, "text": brand, "names": [brand]}])
        prov = floors._prov_for(m, art)
        for field in ("strength", "frequency", "duration"):
            new, moved = floors._field_hit1(m, field, art, prov, scope)
            old = old_field_source(m, field, art, prov, scope)
            assert (old == "eta") == (new in ("eta", "eta_coincidence") or moved), (m, note, field, old, new, moved)
            for r in floors._DIGITS.findall(_s(m.get(field))):
                nr, orr = floors._run_source(m, field, r, art, prov, scope), old_run_source(m, field, r, art, prov, scope)
                assert (orr == "eta") == (nr in ("eta", "eta_coincidence")), (m, note, field, r, orr, nr)
                if orr != "eta":
                    assert nr == orr


def test_fix8_the_new_probes_fail_on_66ccda0a(prev6):
    bad = 0
    for value, et in SYN8:
        m = {"name": "Paracetamol", "duration": value}
        art = _syn(_para(et), [{"kind": "medicine", "name": "Paracetamol", "text": "Paracetamol"}])
        bad += any(prev6._run_source(m, "duration", r, art, prev6._prov_for(m, art), "global") == "eta_coincidence" for r in floors._DIGITS.findall(value))
    assert bad >= 8
    prov = [{"kind": "medicine", "name": "Pan", "text": "Pan", "names": ["Pan"]}]
    wrong = sum(not prev6._eta_wrote_strength({"name": "Pan"}, _syn(f"Medication:\n{n}", prov), None) for n in WROTE8)
    assert wrong >= 2
