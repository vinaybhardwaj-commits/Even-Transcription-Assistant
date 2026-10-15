"""ordered_not_supported (15 Oct 2026): an unsupported drug that would be `eta` is `ordered_not_supported` when it is in the signed Rx AND
the doctor said it in an unquarantined turn. Synthetic only; the oracle is origin/main at f675fef7 (read through git)."""
from __future__ import annotations

import random
import types
from pathlib import Path

import pytest
from conftest import mk_consult
from test_pdqi9_attribution import _syn, item
from test_pdqi9_harness import frozen, make_frozen  # noqa: F401

from tools.eta2freescript.eval.pdqi9 import floors, scoreboard

BASE = "f675fef7"  # origin/main when the order was written
BASE_SHA = "f675fef7facaef568acc33f1cd99a3535db5ea98"
FIX_BASE_SHA = "df3c6dd0de2b87841be50647672a87f05d5db47f"
ORACLE_DIR = Path(__file__).resolve().parent / "fixtures" / "oracles"


def _oracle_src(sha: str) -> str:
    """The vendored floors.py at `sha`, read as text (CI may check out shallow)."""
    return (ORACLE_DIR / f"floors_{sha}.py").read_bytes().decode("utf-8")


ROLES = {"0": "doctor", "1": "patient"}


@pytest.fixture(scope="module")
def old():
    src = _oracle_src(BASE_SHA)
    mod = types.ModuleType("tools.eta2freescript.eval.pdqi9.floors_base")
    mod.__package__ = "tools.eta2freescript.eval.pdqi9"
    exec(compile(src, f"floors@{BASE}", "exec"), mod.__dict__)
    return mod


def _c(*lines, roles=ROLES):
    """lines: (speaker, text); turn idx is the position."""
    return mk_consult([(i * 5, i * 5 + 4, sp, tx) for i, (sp, tx) in enumerate(lines)], roles=roles)


def _art(note="Medication:\nDolo Pan Zorbex Qualix Metformin", quarantined=()):
    a = _syn(note)
    if quarantined:
        a["clip_boundary"] = {"suspected": True, "quarantined_turns": list(quarantined), "reasons": []}
    return a


def _src(m, signed, art, consult, scope="medicine", old_mod=None):
    mod = old_mod or floors
    its = floors.numbered_items({"medicines": [m]})
    kw = {} if old_mod else {"consult": consult, "signed_rx": {"medicines": signed}}
    out = mod._judge_attribution([item(1, said="no")], its, art, scope, **kw)["unsupported_drugs"]
    return next(k for k in floors.SOURCES if out.get(k))


def test_fixed_cases():
    m, art = {"name": "Dolo"}, _art()
    said = _c(("0", "I will start Dolo for the fever"), ("1", "ok"))
    assert _src(m, [{"name": "Dolo"}], art, said) == "ordered_not_supported"          # in A, named by the doctor
    assert _src(m, [{"name": "Other"}], art, said) == "eta"                             # not in A
    assert _src(m, [], art, said) == "eta"
    patient_only = _c(("0", "take rest"), ("1", "I take Dolo at home"))
    assert _src(m, [{"name": "Dolo"}], art, patient_only) == "eta"                      # in A, only the patient says it


def test_each_condition_is_necessary_alone():
    m, art = {"name": "Zorbex"}, _art()
    c_said, c_not = _c(("0", "zorbex twice a day")), _c(("0", "rest and fluids"))
    assert _src(m, [{"name": "Zorbex"}], art, c_said) == "ordered_not_supported"
    assert _src(m, [{"name": "Zorbex"}], art, c_not) == "eta"                           # (i) without (ii)
    assert _src(m, [{"name": "Qualix"}], art, c_said) == "eta"                          # (ii) without (i)


def test_what_does_not_satisfy_said_by_the_doctor():
    m = {"name": "Pan"}
    sg = [{"name": "Pan"}]
    assert _src(m, sg, _art(), _c(("0", "start pantoprazole daily"))) == "eta"          # substring of another word
    assert _src(m, sg, _art(), _c(("0", "start Pan daily"))) == "ordered_not_supported"
    assert _src(m, sg, _art(), _c(("0", "start PAN, daily"))) == "ordered_not_supported"
    assert _src(m, sg, _art(), _c(("0", "take  pan\n daily"))) == "ordered_not_supported"
    assert not floors._said_by_doctor({"pa"}, _art(), _c(("0", "Pa pa pa")))            # under 3 chars never counts
    assert floors._said_by_doctor({"pan"}, _art(), _c(("0", "Pa pan")))
    q = _c(("0", "rest"), ("0", "start Pan daily"))
    assert _src(m, sg, _art(quarantined=[1]), q) == "eta"                               # quarantined doctor turn
    assert _src(m, sg, _art(quarantined=[0]), q) == "ordered_not_supported"             # another turn quarantined only
    assert _src(m, sg, _art(), _c(("1", "start Pan daily"), ("2", "Pan"), roles={"1": "patient", "2": "attendant"})) == "eta"
    assert _src(m, sg, _art(), _c(("0", "start Pan daily"), roles={})) == "eta"         # no resolvable role
    assert _src(m, sg, _art(), mk_consult([(0, 4, "0", "start Pan daily")], roles={"0": "doctor"}, role_track=False)) == "eta"


def test_only_eta_hits_move_and_other_sources_are_untouched():
    m = {"uid": "u1", "name": "Dolo", "other": False}  # a catalogue row Pulse resolved, ETA never wrote it
    c = _c(("0", "Dolo"))
    none = _art("Medication: nothing")
    assert floors._name_source(m, none) == "pulse_catalogue"
    assert _src(m, [{"name": "Dolo"}], none, c) == "pulse_catalogue"
    assert _src({"name": "Dolo"}, [{"name": "Dolo"}], none, c) == "pulse_extraction"
    # ETA wrote the drug: it would be eta, so the rule applies
    wrote = _art("Medication:\nDolo")
    assert _src({"name": "Dolo"}, [{"name": "Dolo"}], wrote, c) == "ordered_not_supported"
    assert _src({"name": "Dolo"}, [{"name": "Dolo"}], wrote, _c(("0", "rest"))) == "eta"


def test_both_scopes_and_brand_generic_matching():
    m = {"name": "Dolo", "generic": "paracetamol"}
    for sc in floors.FLOOR_SCOPES:
        assert _src(m, [{"name": "Crocin", "generic": "Paracetamol"}], _art("Medication:\nDolo"), _c(("0", "paracetamol bd")), sc) == "ordered_not_supported"
    out = floors._judge_attribution([item(1, said="no")], floors.numbered_items({"medicines": [{"name": "Dolo"}]}), _art("Medication:\nDolo"), None)
    assert out["unsupported_drugs"]["eta"] == 1                                         # no consult, no signed Rx: the rule does not apply


# ---- generated, against the origin/main oracle -------------------------------------------------------------------------
NAMES = ["Dolo", "Pan", "Zorbex", "Qualix", "Metformin", "Amlo", "Telma", "Cefix"]
SAID = ["start {n} now", "{n}, twice a day", "no {n} today", "{n}x", "pre{n} please", "take PAN daily", "continue  {n}\ndaily", "rest"]


def _gen(rng):
    names = rng.sample(NAMES, 3)
    m = rng.choice([{"name": names[0]}, {"name": names[0], "generic": names[1]}, {"uid": "u", "name": names[0], "other": False},
                    {"name": names[0], "brand_name": names[2]}])
    signed = [{"name": rng.choice(names)} for _ in range(rng.randint(0, 2))]
    lines = [(rng.choice(["0", "1", "2"]), rng.choice(SAID).format(n=rng.choice(names))) for _ in range(rng.randint(1, 4))]
    roles = {k: rng.choice(["doctor", "patient", "attendant", "staff", "unknown"]) for k in ("0", "1", "2")}
    c = _c(*lines, roles=roles)
    q = [i for i in range(len(lines)) if rng.random() < 0.3]
    note = rng.choice(["Medication: nothing", f"Medication:\n{names[0]}", f"Medication:\n{names[2]}"])
    art = _syn(note, [{"kind": "medicine", "name": names[0], "text": names[0], "names": [names[0]]}] if rng.random() < 0.3 else [])
    if q:
        art["clip_boundary"] = {"suspected": True, "quarantined_turns": q, "reasons": []}
    return m, signed, art, c


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_legacy_equivalence_and_monotone_against_the_oracle(old, scope):
    rng = random.Random(15102615)
    moved = stayed = 0
    for _ in range(8000):
        m, signed, art, c = _gen(rng)
        o, n = _src(m, signed, art, c, scope, old), _src(m, signed, art, c, scope)
        assert (o == "eta") == (n in ("eta", "eta_coincidence", "ordered_not_supported")), (m, signed, o, n)
        if o != "eta":
            assert n == o                                                               # every other source unchanged
        assert not (n == "eta" and o != "eta")                                          # nothing becomes eta that was not
        if n == "ordered_not_supported":
            moved += 1
            assert floors._ordered_not_supported(m, {"medicines": signed}, art, c)
            assert any(floors._rx_names(m) & floors._rx_names(s) for s in signed)      # (i) FIX1: equality, not containment
            q = set((art.get("clip_boundary") or {}).get("quarantined_turns") or [])
            names = {x for x in floors._rx_names(m) if len(x) >= 3}
            assert any(t.role == "doctor" and t.idx not in q and any(__import__("re").search(r"(?<![\w-])" + x + r"(?![\w-])", t.text.lower()) for x in names)
                       for t in c.turns)                                                # (ii)
        elif o == "eta":
            stayed += 1
    assert moved > 100 and stayed > 100


def test_the_probe_is_not_vacuous_on_the_oracle(old):
    """The oracle has no such source: it calls the fixed case eta."""
    assert "ordered_not_supported" not in old.SOURCES
    m, art = {"name": "Dolo"}, _art()
    assert _src(m, [{"name": "Dolo"}], art, None, "medicine", old) == "eta"


# ---- columns -------------------------------------------------------------------------------------------------------------
def test_source_order_basis_and_header():
    assert floors.SOURCES == ("eta", "eta_coincidence", "ordered_not_supported", "pulse_catalogue", "pulse_extraction", "check")
    assert floors._worst(["check", "ordered_not_supported", "pulse_catalogue"]) == "ordered_not_supported"
    assert floors._worst(["ordered_not_supported", "eta_coincidence"]) == "eta_coincidence"
    assert floors._tally(["ordered_not_supported", "eta"])["ordered_not_supported"] == 1
    rows = [{"floor": "unsupported drugs", "bn": 2, "eta": 0, "eta_coincidence": 0, "ordered_not_supported": 2, "pulse_catalogue": 0,
             "pulse_extraction": 0, "check": 0, "eta_wrote_nothing": 0, "by_scope": {}}]
    h = floors.header(rows, "eta")
    assert h["ordered_not_supported"] == 2 and h["total"] == 2
    assert floors.header([{**rows[0], "ordered_not_supported": None}], "eta")["ordered_not_supported"] == 0
    old_row = {k: v for k, v in rows[0].items() if k != "ordered_not_supported"}
    assert floors.header([old_row], "eta")["ordered_not_supported"] == 0               # an old row reads 0


def test_basis_eta_passes_on_eta_only():
    row = {"uid": "u", "arm": "Bn", "unsupported_drugs": 1, "leak_items": 0, "invented_fields": 0, "dose_precedence_errors": 0, "hallucinations": 0,
           "unclear_items": 0, "invented_numbers": 0, "dose_precedence_det": 0, "printable_errors": 0, "unknown_key_errors": 0,
           "validator_failures": 0, "artifact_missing": False, "unmatched_no_digits": 0,
           "attribution": {"unsupported_drugs": floors._tally(["ordered_not_supported"])},
           "completion": {"missing": 0, "covered": 0, "parse_failure": False}}
    t = floors.aggregate([row], None, "eta", "medicine")
    r = next(x for x in t["rows"] if x["floor"] == "unsupported drugs")
    assert r["bn"] == 1 and r["ordered_not_supported"] == 1 and r["eta"] == 0 and r["pass"] is True
    assert next(x for x in floors.aggregate([row], None, "all", "medicine")["rows"] if x["floor"] == "unsupported drugs")["pass"] is False


def test_split_cell_prints_it_and_legacy_adds_it():
    t = {"eta": 4, "eta_coincidence": 3, "ordered_not_supported": 5, "pulse_catalogue": 2, "pulse_extraction": 1, "check": 0, "eta_wrote_nothing": 2}
    s = scoreboard.split_cell(t)
    assert "ordered_not_supported 5" in s and "eta_legacy (old rule) 14]" in s
    assert s.index("eta_coincidence") < s.index("ordered_not_supported") < s.index("pulse_catalogue")
    o = {"eta": 5, "pulse_catalogue": 0, "pulse_extraction": 1, "check": 0}               # a stored row from before the source
    assert "ordered_not_supported 0" in scoreboard.split_cell(o) and "eta_legacy (old rule) 5]" in scoreboard.split_cell(o)
    assert "ordered_not_supported -" in scoreboard.split_cell({**o, "eta": None}) and "eta_legacy (old rule) -" in scoreboard.split_cell({**o, "eta": None})


def test_consult_floors_end_to_end_both_scopes_count_unchanged(frozen, tmp_path):
    """Through consult_floors (the caller): the split carries the new source at BOTH scopes; the floor count is the judge's, unchanged."""
    from test_pdqi9_harness import items_reply
    from tools.eta2freescript.models import FakeClient
    rx = {"medicines": [{"name": "Dolo"}, {"name": "Zorbex"}]}
    c = _c(("0", "start dolo"), ("1", "zorbex"))
    signed = {"medicines": [{"name": "Dolo"}, {"name": "Zorbex"}]}
    client = FakeClient(items_reply(lambda p: [item(1, said="no"), item(2, said="no")]))
    rec = floors.consult_floors(client, frozen, uid="u", arm_kind="Bn", rx=rx, signed_rx=signed, art=_art("Medication:\nDolo\nZorbex"),
                                consult=c, transcript="T0 hi", cache_dir=tmp_path)
    assert rec["unsupported_drugs"] == 2
    for a in [rec["attribution"]] + list(rec["attribution_by_scope"].values()):
        u = a["unsupported_drugs"]
        assert (u["ordered_not_supported"], u["eta"]) == (1, 1)                         # Dolo: doctor said it; Zorbex: only the patient did


# ---- FIX1 (15 Oct 2026): condition (i) is name EQUALITY, condition (ii) treats a hyphen as part of the word ------------------
import re  # noqa: E402

FIX_BASE = "df3c6dd0"  # the first ONS commit: _names_match for (i), (?<!\w)/(?!\w) for (ii)


@pytest.fixture(scope="module")
def v1():
    src = _oracle_src(FIX_BASE_SHA)
    mod = types.ModuleType("tools.eta2freescript.eval.pdqi9.floors_v1")
    mod.__package__ = "tools.eta2freescript.eval.pdqi9"
    exec(compile(src, f"floors@{FIX_BASE}", "exec"), mod.__dict__)
    return mod


def _p4_cases():
    """The refuter's F1 (a family relative signed, not the drug ETA wrote) and F2 (hyphen-glued doctor text)."""
    f1 = [("Pan 40", "Pan-D"), ("Telma", "Telma-H"), ("Dolo", "Dolonex")]
    for wrote, signed in f1:
        yield {"name": wrote}, [{"name": signed}], _art(f"Medication:\n{wrote}"), _c(("0", f"start {wrote.split()[0].lower()} {signed.lower()} now"))
    f2 = [("Pan", "Pan"), ("Telma", "Telma"), ("Dolo", "Dolo")]
    for wrote, signed in f2:
        yield {"name": wrote}, [{"name": signed}], _art(f"Medication:\n{wrote}"), _c(("0", f"start {wrote.lower()}-d now"), ("0", f"x-{wrote.lower()} later"))


def test_p4_refuter_examples_were_ons_and_are_eta(v1):
    n = 0
    for m, signed, art, c in _p4_cases():
        before = _src_mod(v1, m, signed, art, c)
        after = _src(m, signed, art, c)
        assert before == "ordered_not_supported", (m, signed)                           # non-vacuous: df3c6dd0 got it wrong
        assert after == "eta", (m, signed)
        n += 1
    assert n == 6


def _src_mod(mod, m, signed, art, consult, scope="medicine"):
    its = floors.numbered_items({"medicines": [m]})
    out = mod._judge_attribution([item(1, said="no")], its, art, scope, consult=consult, signed_rx={"medicines": signed})["unsupported_drugs"]
    return next(k for k in mod.SOURCES if out.get(k))


def test_r1_equality_of_names():
    said = _c(("0", "start pan now"))
    assert _src({"name": "Pan 40"}, [{"name": "Pan 20"}], _art("Medication:\nPan"), said) == "ordered_not_supported"   # strength is another floor's job
    assert _src({"name": "Pan"}, [{"name": "Pan-D"}], _art("Medication:\nPan"), said) == "eta"
    assert _src({"name": "Pan"}, [{"name": "Pan D"}], _art("Medication:\nPan"), said) == "eta"
    assert _src({"name": "Pan"}, [{"name": "Pantoprazole"}], _art("Medication:\nPan"), said) == "eta"
    assert _src({"name": "Pan", "generic": "pantoprazole"}, [{"name": "Other", "generic": "Pantoprazole"}], _art("Medication:\nPan"),
                _c(("0", "start pantoprazole"))) == "ordered_not_supported"                      # any equal name pair, brand or generic
    assert floors._names_equal({"ab"}, {"ab"}) is False                                  # under 3 chars never equal


FAMILY_BASES = ["pan", "telma", "dolo", "zorbex", "amlo", "cefix", "qualix", "metformin"]
FAMILY_MODS = [("suffix_token", lambda b: f"{b} d"), ("hyphen_suffix", lambda b: f"{b}-d"), ("strength", lambda b: f"{b} 40"),
               ("form", lambda b: f"{b} tablet"), ("same", lambda b: b)]


def _fam(rng):
    base = rng.choice(FAMILY_BASES)
    (kr, fr), (ks, fs) = rng.choice(FAMILY_MODS), rng.choice(FAMILY_MODS)
    replay, signed = fr(base), fs(base)
    if rng.random() < 0.5:
        replay, signed = signed, replay
        kr, ks = ks, kr
    return base, kr, ks, replay, signed


@pytest.mark.parametrize("scope", ["global", "medicine"])
def test_p1_p2_p3_generated_against_df3c6dd0(v1, scope):
    rng = random.Random(15102627)
    n_ons = n_fam_eta = n_hyph_eta = n_word = 0
    for _ in range(6000):
        base, kr, ks, replay, signed = _fam(rng)
        glue = rng.choice(["whole", "hyph_after", "hyph_before", "inside", "punct"])
        core = floors._norm_name(replay)                                                # what the doctor must say, as a whole word
        txt = {"whole": f"start {core} now", "hyph_after": f"start {core}-x now", "hyph_before": f"start x-{core} now",
               "inside": f"start pre{core}post now", "punct": f"{core}, twice"}[glue]
        art, c = _art(f"Medication:\n{replay}"), _c(("0", txt))
        o = _src_mod(v1, {"name": replay}, [{"name": signed}], art, c, scope)
        n = _src({"name": replay}, [{"name": signed}], art, c, scope)
        # P1: FIX1 only moves ONS -> eta
        if n == "ordered_not_supported":
            assert o == "ordered_not_supported"
            n_ons += 1
        if o != "ordered_not_supported":
            assert n == o
        assert (o in ("eta", "ordered_not_supported")) == (n in ("eta", "ordered_not_supported"))     # same legacy-eta set
        # P2: a suffix token or hyphen suffix on exactly one side is never ONS
        # (_norm_name erases the hyphen, so token and hyphen suffixes on both sides are the same normalised name: equal, by R1)
        suf = {"suffix_token", "hyphen_suffix"}
        differs = (kr in suf) != (ks in suf)
        if differs:
            assert n == "eta", (replay, signed)
            n_fam_eta += 1
        else:
            # strength / form / same: ONS iff the doctor said it as a whole word
            assert (n == "ordered_not_supported") == (glue in ("whole", "punct")), (replay, signed, glue, n)
            n_word += 1
        # P3: only whole-word text satisfies (ii)
        said = floors._said_by_doctor({core}, art, c)
        assert said == (glue in ("whole", "punct")), (glue, txt)
        if glue in ("hyph_after", "hyph_before"):
            assert n == "eta"
            n_hyph_eta += 1
    assert n_ons > 500 and n_fam_eta > 500 and n_hyph_eta > 500 and n_word > 500


def test_r3_nothing_becomes_eta_that_base_did_not_call_eta(old):
    rng = random.Random(15102628)
    for _ in range(5000):
        base, kr, ks, replay, signed = _fam(rng)
        art = _art(rng.choice([f"Medication:\n{replay}", "Medication: nothing"]))
        c = _c(("0", rng.choice([f"start {base}", f"{base}-d", "rest"])))
        m = rng.choice([{"name": replay}, {"uid": "u", "name": replay, "other": False}])
        o, n = _src(m, [{"name": signed}], art, c, "medicine", old), _src(m, [{"name": signed}], art, c)
        assert not (n == "eta" and o != "eta")
        assert (o == "eta") == (n in ("eta", "eta_coincidence", "ordered_not_supported"))
