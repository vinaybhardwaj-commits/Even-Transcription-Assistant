"""eta -> eta + eta_coincidence (15 Oct 2026, floor-strict kickoff). Synthetic only.
Property 4 (legacy equivalence) is checked against a private copy of the pre-change functions."""
from __future__ import annotations

import random

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
    "day": ["days", "day", "Days"],
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
    assert _wn(note="Medication:\nParacetamol 2 tablets", scope=scope, med=cat_plain) == ("check", True)  # form word
    assert _wn(note="Medication:\nParacetamol 5%", scope=scope) == ("eta", False)  # % is a strength unit
    assert _wn(note="Medication:\nParacetamol 5 puffs", scope=scope, med=cat200) == ("pulse_catalogue", True)
    assert _wn(note="Medication:\nParacetamol 5 zorgs", scope=scope) == ("eta", False)  # an unknown unit counts as a strength
    assert _wn(note="Medication:\nParacetamol 5\nmg", scope=scope) == ("check", True)  # a unit does not cross a line
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
