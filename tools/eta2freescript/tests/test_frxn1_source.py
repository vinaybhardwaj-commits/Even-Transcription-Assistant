"""FRX-N1 at the field source (16 Oct 2026): the mapper never writes a structure into a text field. Synthetic text only.

S1  duration_words: Stage A's {"value", "unit"} duration reads as words in the presenting complaint.
S2  as_text at every mapper site that turns a Stage A value into gp_extraction text.
S3  property: no brace or bracket reaches gp_extraction or the deterministic note unless an input STRING carried it.
S4  oracle: on plain-string input the mapper is byte-identical to origin/main at BASE_SHA (git show), and a recorder over
    run_consult sees the same model calls and artifacts except where S1/S2 applies.
"""
from __future__ import annotations

import copy
import json
import random
import subprocess
import types
from pathlib import Path

import pytest
import re
from conftest import build_artifact, empty_encounter, mk_consult

from tools.eta2freescript import mapper as M
from tools.eta2freescript import pipeline
from tools.eta2freescript.boundary import Boundary
from tools.eta2freescript.mapper import as_text, build, duration_words
from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.note import flags_by_pointer, render_note
from tools.eta2freescript.pipeline import _fallback_note_ex, run_consult
from tools.eta2freescript.validate import printable_errors

BASE_SHA = "c09539f4ba2178e77c2bd6461af2880c1b94ac9d"
DOC = {"0": "doctor", "1": "patient", "2": "attendant"}
LINES = [(0, 4, "0", "What is the problem?"), (5, 10, "1", "Fever and cough."), (11, 15, "2", "He takes amlodipine 5 mg."),
         (16, 20, "0", "Throat is red."), (21, 30, "0", "Take paracetamol 500 mg twice a day for three days."),
         (31, 35, "0", "Drink water and rest. Refer to the orthopaedics department."),
         (36, 40, "0", "Come back after one week. Get a chest x-ray done.")]
EXAM = [{"performed": "Throat", "finding": "red", "basis": "said", "source_turns": [3]}]
BRACES = "{}[]"


def consult():
    return mk_consult(LINES, roles=DOC)


def art_of(cc=None, **enc):
    enc.setdefault("examination", EXAM)
    if cc is not None:
        enc["chief_complaint"] = cc
    return build_artifact(consult(), empty_encounter(**enc))


def symptoms(art):
    return art["gp_extraction"]["presenting_complaints"]["symptoms"]


def strings(node):
    """Every string anywhere in a JSON-like node."""
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for v in node.values():
            yield from strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from strings(v)


# The mapper's own kept-out markers ("[held_back_inferred_order] x", appended to management_plan by recover.py) are lower-case words
# in brackets. sanitize_note removes them from the note; they are not input and are not what FRX-N1 rejected.
OWN_TAG = re.compile(r"\[[a-z_]{3,}\]")


def stray(s: str) -> set[str]:
    return {ch for ch in BRACES if ch in OWN_TAG.sub("", s)}


def has_brace(node) -> bool:
    return any(stray(s) for s in strings(node))


# ---- S1 ----------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("value,unit,words", [
    (3, "DAYS", "3 days"), (2, "WEEKS", "2 weeks"), (6, "months", "6 months"), (5, "Years", "5 years"),
    (1, "DAYS", "1 day"), (1, "WEEKS", "1 week"), (1, "MONTHS", "1 month"), (1, "years", "1 year"), (1000, "DAYS", "1000 days"),
])
def test_duration_words_dict(value, unit, words):
    assert duration_words({"value": value, "unit": unit}) == words


@pytest.mark.parametrize("bad", [
    {"value": 0, "unit": "DAYS"}, {"value": 1001, "unit": "DAYS"}, {"value": -2, "unit": "DAYS"}, {"value": True, "unit": "DAYS"},
    {"value": 3.0, "unit": "DAYS"}, {"value": "3", "unit": "DAYS"}, {"value": 3, "unit": "HOURS"}, {"value": 3, "unit": None},
    {"value": 3, "unit": 5}, {"value": 3}, {"unit": "DAYS"}, {}, {"route": "oral"}, [], ["3 days"], 3, 3.5, True, None,
])
def test_duration_words_refuses_everything_else(bad):
    assert duration_words(bad) is None


def test_duration_words_str_is_stripped_and_nothing_else():
    assert duration_words("  3 days ") == "3 days"
    assert duration_words("a [b] c") == "a [b] c"
    assert duration_words("") == ""


def test_fixture_dict_duration_reads_as_words():
    cc = {"text": "fever and cough", "duration": {"value": 3, "unit": "DAYS"}, "basis": "said", "source_turns": [1]}
    s = symptoms(art_of(cc))
    assert not any(ch in s for ch in BRACES)
    assert "3 days" in s


def test_fixture_str_duration_is_the_same_note_as_the_dict():
    d = {"text": "fever and cough", "duration": {"value": 3, "unit": "DAYS"}, "basis": "said", "source_turns": [1]}
    s = dict(d, duration="3 days")
    a, b = art_of(d), art_of(s)
    assert a["gp_extraction"] == b["gp_extraction"]
    assert a["note_text"] == b["note_text"]
    assert symptoms(a) == "fever and cough (3 days)."


def test_fixture_weeks():
    s = symptoms(art_of({"text": "knee pain", "duration": {"value": 2, "unit": "WEEKS"}, "basis": "said", "source_turns": [1]}))
    assert s == "knee pain (2 weeks)."


def test_duration_already_in_the_text_is_not_repeated_whatever_the_case():
    cc = {"text": "fever for 3 Days", "duration": {"value": 3, "unit": "DAYS"}, "basis": "said", "source_turns": [1]}
    assert symptoms(art_of(cc)) == "fever for 3 Days."
    cc = {"text": "fever for 3 days", "duration": "3 DAYS", "basis": "said", "source_turns": [1]}
    assert symptoms(art_of(cc)) == "fever for 3 days."


@pytest.mark.parametrize("dur", [{"value": 0, "unit": "DAYS"}, {"route": "oral"}, ["3", ["x"]], 3, True, {"value": 3, "unit": "HOURS"}])
def test_a_duration_with_no_words_keeps_the_text_and_records_one_item(dur):
    a = art_of({"text": "fever and cough", "duration": dur, "basis": "said", "source_turns": [1]})
    assert symptoms(a) == "fever and cough."
    items = [p for p in a["provenance"] if p["text"] == "fever and cough (duration not representable)"]
    assert len(items) == 1 and items[0]["json_pointer"] is None and items[0]["status"] == "discussed_only"
    assert not any(ch in items[0]["text"] for ch in BRACES) and "DAYS" not in items[0]["text"]


def test_an_empty_duration_is_not_a_problem():
    for dur in (None, "", "  ", [], {}):
        a = art_of({"text": "fever", "duration": dur, "basis": "said", "source_turns": [1]})
        assert symptoms(a) == "fever."
        assert not [p for p in a["provenance"] if "not representable" in p["text"]] or dur in ([], {})


# ---- S2: as_text -------------------------------------------------------------------------------------------
@pytest.mark.parametrize("v,out", [
    ("abc", "abc"), (" a [b] ", " a [b] "), ("", ""), (5, "5"), (2.5, "2.5"), (0, "0"),
    (["a", "b"], "a, b"), (["a", 2, 3.5], "a, 2, 3.5"), ([], ""),
    ({"value": 3, "unit": "DAYS"}, "3 days"), ({"value": 1, "unit": "weeks"}, "1 week"),
])
def test_as_text_representable(v, out):
    assert as_text(v) == out


@pytest.mark.parametrize("v", [
    {"route": "oral", "timing": ["a", "b"]}, {}, {"value": 0, "unit": "DAYS"}, [["a"]], [{"a": 1}], ["a", None], ["a", True],
    [["a"], "b"], True, False, None,
])
def test_as_text_everything_else_is_none(v):
    assert as_text(v) is None


def test_as_text_never_returns_a_repr():
    for v in ({"a": 1}, [{"a": 1}], [[1]], {"value": 3}):
        assert as_text(v) is None


def _inv(timing, status="ordered", **kw):
    it = {"name": "chest x-ray", "order_status": status, "timing": timing, "decision_turn": 6, "basis": "said", "source_turns": [6]}
    return art_of(investigations=[dict(it, **kw)])


def test_site_investigation_timing_dict_is_absent_not_a_repr():
    a = _inv({"route": "oral", "timing": ["before food"]})
    inv = a["gp_extraction"]["further_investigations"][0]
    assert "instruction" not in inv and inv["name"] == "chest x-ray"
    assert [p for p in a["provenance"] if p["text"] == "investigation (value not representable)"]
    assert not has_brace(a["gp_extraction"])


def test_site_investigation_timing_list_and_duration_are_text():
    assert _inv(["before food", "morning"])["gp_extraction"]["further_investigations"][0]["instruction"] == "before food, morning"
    assert _inv({"value": 2, "unit": "WEEKS"})["gp_extraction"]["further_investigations"][0]["instruction"] == "2 weeks"
    assert _inv("after lunch")["gp_extraction"]["further_investigations"][0]["instruction"] == "after lunch"


def test_site_conditional_investigation_timing_reaches_the_plan_as_text():
    a = _inv({"x": [1]}, status="conditional")
    assert not has_brace(a["gp_extraction"])
    assert "chest x-ray if indicated." in a["gp_extraction"]["plan_of_management"]["management_plan"]
    a = _inv(["fever persists"], status="conditional")
    assert "chest x-ray if fever persists." in a["gp_extraction"]["plan_of_management"]["management_plan"]


def _ref(reason, **kw):
    it = {"to": "Orthopaedics", "reason": reason, "for_this_patient": True, "basis": "said", "source_turns": [5]}
    return art_of(referrals=[dict(it, **kw)])


def test_site_referral_reason():
    a = _ref({"why": ["knee"]})
    assert a["gp_extraction"]["referrals"] == [{"speciality": "Orthopaedics"}]
    assert [p for p in a["provenance"] if p["text"] == "referral (value not representable)"]
    assert _ref(["knee pain", "locking"])["gp_extraction"]["referrals"][0]["notes"] == "knee pain, locking"
    assert _ref("knee: pain")["gp_extraction"]["referrals"][0]["notes"] == "knee - pain"
    assert _ref(3)["gp_extraction"]["referrals"][0]["notes"] == "3"


def test_colon_replacement_on_str_input_is_unchanged():
    a = art_of(examination=[{"performed": "BP: right arm", "finding": "130/80: normal", "basis": "said", "source_turns": [3]}])
    assert a["gp_extraction"]["examination"] == "BP - right arm - 130/80 - normal"


@pytest.mark.parametrize("enc,path", [
    ({"hpi": [{"text": {"a": 1}, "basis": "said", "source_turns": [1]}]}, "symptoms"),
    ({"history": [{"type": "past_medical", "text": [["x"]], "basis": "said", "source_turns": [1]}]}, "symptoms"),
    ({"examination": [{"performed": {"a": 1}, "finding": [["x"]], "basis": "said", "source_turns": [3]}]}, "examination"),
    ({"diagnoses": [{"label": "viral fever", "raw_name": {"a": 1}, "as_said": [[1]], "rank": "primary", "doctor_named": True,
                     "basis": "said", "source_turns": [3]}]}, "diagnoses"),
    ({"comorbidities": [{"name": {"a": 1}, "basis": "said", "source_turns": [2]}]}, "comorbidities"),
    ({"plan": [{"text": {"a": 1}, "basis": "said", "source_turns": [5]}]}, "plan_of_management"),
    ({"advice": [{"text": [{"a": 1}], "basis": "said", "source_turns": [5]}]}, "general_advice"),
    ({"follow_up": {"type": "MANDATORY_FOLLOW_UP", "when": {"a": [1]}, "condition": [[2]], "interval": {"value": 1, "unit": "WEEKS"},
                    "basis": "said", "source_turns": [6]}}, "follow_up"),
    ({"procedures": [{"name": "knee arthroscopy", "raw_name": ["x"], "notes": {"a": 1}, "advised_kind": "advised", "decision_turn": 5,
                      "basis": "said", "source_turns": [5]}]}, "plan_of_management"),
])
def test_site_other_text_fields_never_leak_a_structure(enc, path):
    a = art_of(**enc)
    assert not has_brace(a["gp_extraction"]), a["gp_extraction"]


def test_site_prescription_text_fields():
    base = {"action": "start", "decision_turn": 4, "generic": "paracetamol", "basis": "said", "confidence": 0.85, "source_turns": [4]}
    for k in ("strength", "frequency", "duration", "instructions", "route", "dosage_form"):
        a = art_of(prescription=[dict(base, **{k: {"a": ["x"]}})])
        assert not has_brace(a["gp_extraction"]), (k, a["gp_extraction"])
    # guard() itself raises on a dict name (guard.py is outside this change), so the name fields go straight to build()
    enc = empty_encounter(examination=EXAM, prescription=[dict(base, generic={"a": 1}, brand_as_said=["Dolo", ["x"]])])
    a = build_direct(enc)
    assert not has_brace(a["gp_extraction"]) and not has_brace(a["slots"])
    full = dict(base, strength="500 mg", frequency="twice a day", duration="three days")
    # C1: route is a dose field, so a list there is no longer joined ("oral"); only instructions joins
    a = art_of(prescription=[dict(full, instructions=["after food", "with water"], route="oral")])
    b = art_of(prescription=[dict(full, instructions="after food, with water", route="oral")])
    assert a["gp_extraction"] == b["gp_extraction"] and a["gp_extraction"]["medicines"]


def test_input_strings_with_brackets_still_fail_frx_n1():
    """The bracket rule stands (ruling FRF-1): a bracket the model wrote in a string is still a reject, as on base."""
    a = art_of({"text": "fever [S1] cough", "duration": None, "basis": "said", "source_turns": [1]})
    assert "[" in symptoms(a)
    note, _ = _fallback_note_ex(a, flags_by_pointer(a), [])
    # sanitize_note removes a [..] span; a lone brace is not removed and rejects
    a = art_of({"text": "fever {x} cough", "duration": None, "basis": "said", "source_turns": [1]})
    assert "{" in symptoms(a)
    note, _ = _fallback_note_ex(a, flags_by_pointer(a), [])
    assert any("template brace" in e for e in printable_errors(note, []))


# ---- generators --------------------------------------------------------------------------------------------
WORDS = ["fever", "cough", "knee pain", "three days", "twice a day", "after food", "orthopaedics", "left knee", "morning", "rest",
         "chest x-ray", "viral fever", "red throat", "drink water", "come back after one week"]


def structure(rng):
    return rng.choice([
        lambda: {"value": rng.randint(1, 9), "unit": rng.choice(["DAYS", "WEEKS", "MONTHS", "YEARS", "days", "Weeks"])},
        lambda: {"value": rng.choice([0, -1, 1001, True, 2.5, "3", None]), "unit": rng.choice(["DAYS", "HOURS", None, 3])},
        lambda: {"route": rng.choice(WORDS), "timing": [rng.choice(WORDS), rng.choice(WORDS)]},
        lambda: {},
        lambda: [rng.choice(WORDS) for _ in range(rng.randint(0, 3))],
        lambda: [rng.choice(WORDS), [rng.choice(WORDS)]],
        lambda: [{"a": rng.choice(WORDS)}, rng.randint(1, 5)],
        lambda: [rng.randint(1, 9), 2.5, rng.choice(WORDS)],
        lambda: rng.randint(0, 40),
        lambda: rng.random() * 10,
        lambda: rng.choice([True, False]),
        lambda: None,
    ])()


class Gen:
    """Stage A encounters with every text-bearing field a str, a structure or missing. mode: "str" = plain strings only."""

    def __init__(self, seed: int, mode: str, brackets: bool = False, plain=()):
        # plain: keys that stay strings. guard() raises on a dict drug name, so run_consult cannot be fed one.
        self.rng, self.mode, self.brackets, self.plain = random.Random(seed), mode, brackets, set(plain)
        self.injected = 0

    def val(self, pool, plain=False):
        r = self.rng
        p = r.random()
        if self.mode == "str" or plain:
            if p < 0.12:
                return ...
            return self.s(pool)
        if p < 0.40:
            return self.s(pool)
        if p < 0.55:
            return ...
        self.injected += 1
        return structure(r)

    def s(self, pool):
        s = self.rng.choice(pool)
        if s is not None and self.brackets and self.rng.random() < 0.15:
            s = s + self.rng.choice([" [S1]", " {x}", " ]", " ["])
        return s

    def put(self, d, key, pool):
        v = self.val(pool, key in self.plain)
        if v is not ...:
            d[key] = v

    def item(self, fields, **fixed):
        d = dict(fixed)
        for k, pool in fields.items():
            self.put(d, k, pool)
        return d

    def enc(self):
        r = self.rng
        n = lambda lo=0, hi=2: r.randint(lo, hi)
        # The one deliberate change on plain-string input is S1's case-insensitive "already in the text" test ("fever for 3 days" with
        # "3 Days" no longer repeats it), so the "str" oracle draws no duration that differs from the text only in case.
        e = empty_encounter()
        basis = lambda: r.choice(["said", "said", "said", "inferred"])
        tl = lambda: sorted(r.sample(range(7), r.randint(1, 2)))
        cc = self.item({"text": ["fever and cough", "knee pain", "fever for 3 days", "sore throat"],
                        "duration": ["3 days", "2 weeks", "one week", "1 day"] + ([] if self.mode == "str" else ["1 DAY", "3 Days"])}, basis="said", source_turns=[1])
        e["chief_complaint"] = cc
        e["hpi"] = [self.item({"text": WORDS}, basis=basis(), source_turns=tl()) for _ in range(n())]
        e["history"] = [self.item({"text": WORDS}, type=r.choice(["past_medical", "family", "social", "place"]),
                                  clinically_relevant=r.random() < 0.5, basis=basis(), source_turns=tl()) for _ in range(n())]
        e["comorbidities"] = [self.item({"name": ["diabetes", "hypertension", "asthma"]}, basis="said", source_turns=[2],
                                        duration=r.choice([None, {"value": 2, "unit": "YEARS"}, "2 years"])) for _ in range(n())]
        e["diagnoses"] = [self.item({"label": ["viral fever", "knee osteoarthritis", "tonsillitis", "gastritis"],
                                     "raw_name": WORDS, "as_said": WORDS},
                                    rank=("primary" if i == 0 else "secondary"), doctor_named=True, status="confirmed",
                                    basis=basis(), source_turns=[3]) for i in range(n())]
        e["examination"] = [self.item({"performed": ["Throat", "Chest", "Knee"], "finding": ["red", "clear", "tender"]},
                                      basis=basis(), source_turns=[3]) for _ in range(n())]
        e["prescription"] = [self.item({"generic": ["paracetamol", "amlodipine"], "brand_as_said": [None, "Dolo"],
                                        "strength": ["500 mg", "5 mg"], "frequency": ["twice a day", "once a day"],
                                        "duration": ["three days", "one week"], "route": ["oral"], "instructions": ["after food", "with water"],
                                        "dosage_form": ["tablet"]},
                                       action="start", decision_turn=4, basis=basis(), confidence=0.85, source_quote_turn=4,
                                       source_turns=[4]) for _ in range(1 if r.random() < 0.3 else 0)]  # medicines dominate the run time
        e["investigations"] = [self.item({"name": ["chest x-ray", "ECG"], "timing": ["tomorrow", "after the course", "if fever persists"]},
                                         order_status=r.choice(["ordered", "ordered", "conditional", "asked_only"]),
                                         decision_turn=6, basis=basis(), source_turns=[6]) for _ in range(n())]
        e["referrals"] = [self.item({"to": ["Orthopaedics", "Cardiology"], "reason": WORDS},
                                    for_this_patient=True, basis=basis(), source_turns=[5]) for _ in range(n())]
        e["procedures"] = [self.item({"name": ["knee arthroscopy", "surgery"], "raw_name": WORDS, "notes": WORDS + ["if no relief"]},
                                     advised_kind=r.choice(["advised", "conditional"]), decision_turn=5, basis=basis(),
                                     source_turns=[5]) for _ in range(n())]
        e["plan"] = [self.item({"text": WORDS + ["Plan knee arthroscopy"]}, basis=basis(), source_turns=[5]) for _ in range(n())]
        e["advice"] = [self.item({"text": ["Drink water and rest", "Avoid cold drinks"]}, basis=basis(), source_turns=[5]) for _ in range(n())]
        e["red_flags_safety_net"] = [self.item({"text": ["Return if fever persists"]}, basis=basis(), source_turns=[5]) for _ in range(n(0, 1))]
        if r.random() < 0.8:
            e["follow_up"] = self.item({"when": ["after one week", "next Monday"], "condition": ["with reports", "if not better"]},
                                       type=r.choice(["MANDATORY_FOLLOW_UP", "IF_REQUIRED", None]),
                                       interval=r.choice([None, {"value": 1, "unit": "WEEKS"}]), basis="said", source_turns=[6])
        return e


def build_direct(enc, mod=M):
    return mod.build(consult(), copy.deepcopy(enc), Boundary(), "anthropic.claude-test", "0" * 64, "0" * 64)


def fallback(art) -> str:
    banned = [n for p in art["provenance"] if not p.get("json_pointer") for n in (p.get("names") or []) if n]
    return _fallback_note_ex(art, flags_by_pointer(art), banned)[0]


def bracket_errors(note: str) -> list[str]:
    return [e for e in printable_errors(note, []) if "bracket" in e or "brace" in e]


def input_chars(enc) -> set[str]:
    return {ch for s in strings(enc) for ch in BRACES if ch in s}


# ---- S3 ----------------------------------------------------------------------------------------------------
N_CASES = 5000


def test_property_no_structure_reaches_gp_extraction_or_the_note():
    structured = 0
    for seed in range(N_CASES):
        g = Gen(seed, "mixed")
        enc = g.enc()
        structured += g.injected > 0
        art = build_direct(enc)
        assert not has_brace(art["gp_extraction"]), (seed, [s for s in strings(art["gp_extraction"]) if stray(s)])
        assert bracket_errors(fallback(art)) == [], seed
    assert structured > N_CASES * 0.9


def test_property_with_bracketed_input_strings_only_those_brackets_survive():
    """A bracket in an input STRING may come out (it still fails FRX-N1, as on base); a bracket from a structure may not."""
    survived = rejected = 0
    for seed in range(N_CASES):
        g = Gen(10_000 + seed, "mixed", brackets=True)
        enc = g.enc()
        art = build_direct(enc)
        seen = {ch for s in strings(art["gp_extraction"]) for ch in stray(s)}
        assert seen <= input_chars(enc), (seed, seen, input_chars(enc))
        if seen:
            survived += 1
        errs = bracket_errors(fallback(art))
        if errs:
            rejected += 1
            assert seen, seed  # a reject needs a bracket that came from an input string
        if not input_chars(enc):
            assert errs == [], seed
    assert survived > 100 and rejected > 100


# ---- S4: oracle against origin/main at BASE_SHA ------------------------------------------------------------
def _base_mapper():
    pkg = "tools/eta2freescript/mapper.py"
    root = Path(__file__).resolve().parents[3]
    try:
        src = subprocess.run(["git", "-C", str(root), "show", f"{BASE_SHA}:{pkg}"], capture_output=True, check=True).stdout.decode("utf-8")
    except (subprocess.CalledProcessError, FileNotFoundError):  # pragma: no cover - CI checks out full history
        pytest.skip(f"git history for {BASE_SHA[:8]} not available")
    mod = types.ModuleType("tools.eta2freescript._mapper_base")
    mod.__package__ = "tools.eta2freescript"
    mod.__file__ = "mapper_base.py"
    exec(compile(src, f"{BASE_SHA[:8]}:{pkg}", "exec"), mod.__dict__)
    return mod


@pytest.fixture(scope="module")
def base():
    return _base_mapper()


VOLATILE = {"artifact_id", "created_at", "run_id", "code_sha256"}


def stable(node):
    if isinstance(node, dict):
        return {k: stable(v) for k, v in node.items() if k not in VOLATILE}
    if isinstance(node, list):
        return [stable(v) for v in node]
    return node


def test_oracle_plain_string_input_is_byte_identical_to_base(base):
    assert base.MAPPER_VERSION == M.MAPPER_VERSION and not hasattr(base, "as_text")
    for seed in range(N_CASES):
        g = Gen(20_000 + seed, "str")
        enc = g.enc()
        assert g.injected == 0
        old, new = build_direct(enc, base), build_direct(enc)
        assert old["gp_extraction"] == new["gp_extraction"], seed
        assert json.dumps(stable(old), sort_keys=True) == json.dumps(stable(new), sort_keys=True), seed
        assert fallback(old) == fallback(new), seed


def _responder(enc):
    def respond(tag, prompt, system):
        if tag.startswith("stageA"):
            return json.dumps(enc)
        return "not a note"
    return respond


def _record(mod, enc, out):
    saved = pipeline.build
    pipeline.build = mod.build
    try:
        fake = FakeClient(_responder(enc))
        lg = run_consult(consult(), fake, out)
    finally:
        pipeline.build = saved
    calls = [(c["alias"], c["tag"], c["prompt"], c["system"]) for c in fake.calls]
    return calls, lg


def test_recorder_over_run_consult_changes_only_where_a_structure_was_present(base, tmp_path):
    n, injected, changed, crashed = 240, 0, 0, 0
    for i in range(n):
        g = Gen(30_000 + i, "mixed" if i % 2 else "str", plain=("generic", "brand_as_said"))
        enc = g.enc()
        injected += g.injected > 0
        new_calls, new = _record(M, enc, tmp_path / f"n{i}")
        try:
            old_calls, old = _record(base, enc, tmp_path / f"o{i}")
        except (AttributeError, TypeError):  # base cannot map a structure where text belongs: that consult changes
            assert g.injected > 0, i
            changed += 1
            crashed += 1
            assert not has_brace(new["artifact"]["gp_extraction"]), i
            continue
        assert len(old_calls) == len(new_calls) and old_calls[0] == new_calls[0], i  # Stage A: same prompt, same call count
        same = (old_calls == new_calls and json.dumps(stable(old["artifact"]), sort_keys=True) == json.dumps(stable(new["artifact"]), sort_keys=True)
                and old["final_valid"] == new["final_valid"])
        if not same:
            changed += 1
            assert g.injected > 0, i
        assert not has_brace(new["artifact"]["gp_extraction"]), i
    assert injected > 100 and changed > 50
    print(f"recorder: {n} consults, {injected} with a structure in a text field, {changed} changed ({crashed} of them crash on base)")


# ---- C1 (16 Oct 2026): a list in a dose field is absent plus one "(value not representable)" item, never a join -----------------
C1_BASE_SHA = "7130c5a7"
DOSE_LISTS = {"strength": [500, 250], "frequency": ["twice a day", "once a day"], "duration": [3, 5], "route": ["oral", "topical"]}
RX_BASE = {"action": "start", "decision_turn": 4, "generic": "paracetamol", "basis": "said", "confidence": 0.85, "source_turns": [4],
           "strength": "500 mg", "frequency": "twice a day", "duration": "three days", "route": "oral"}
SLOT_BASE = {"dosage_form": "gel", "frequency": "twice a day", "duration": "for two weeks", "strength": "500 mg", "quote_turn": 4,
             "source_turns": [4]}
JOINS = ("500, 250", "twice a day, once a day", "3, 5", "oral, topical")


def direct(**enc):
    """The mapper alone (guard() would recover a dose from the quote and hide the list); note_text as the pipeline renders it."""
    enc.setdefault("examination", EXAM)
    art = build_direct(empty_encounter(**enc))
    art["note_text"] = render_note(art["gp_extraction"], flags_by_pointer(art))
    return art


def not_representable(art):
    return [p for p in art["provenance"] if p["text"] == "medicine (value not representable)"]


def whole(art):
    return json.dumps({k: art[k] for k in ("gp_extraction", "slots", "provenance", "note_text") if k in art}) + fallback(art)


@pytest.mark.parametrize("field", sorted(DOSE_LISTS))
def test_c1_prescription_dose_list_is_absent_with_one_item(field):
    a = direct(prescription=[dict(RX_BASE, **{field: DOSE_LISTS[field]})])
    assert len(not_representable(a)) == 1
    med = a["gp_extraction"]["medicines"][0]
    if field != "route":
        assert field not in med or med[field] in (None, "")
    for j in JOINS:
        assert j not in whole(a), (field, j)
    assert any(f"{field}_unstated" in (p.get("flags") or []) for p in a["provenance"]) or field == "route"


@pytest.mark.parametrize("field", sorted(DOSE_LISTS))
def test_c1_regimen_slot_dose_list_is_absent_with_one_item(field):
    a = direct(regimen_slots=[dict(SLOT_BASE, **{field: DOSE_LISTS[field]})])
    assert len(not_representable(a)) == 1
    assert a["slots"], a
    # the absent branch: the same slot as when the field is None (frequency and duration may still be read from the doctor's clause)
    none = direct(regimen_slots=[dict(SLOT_BASE, **{field: None})])
    nid = lambda slots: json.dumps([{k: v for k, v in x.items() if k != "slot_id"} for x in slots], sort_keys=True)
    assert nid(a["slots"]) == nid(none["slots"])
    for j in JOINS:
        assert j not in whole(a), (field, j)
    assert not any(stray(x) for slot in a["slots"] for part in (slot[k] for k in ("form", "frequency", "duration", "strength"))
                   for x in strings(part)), a["slots"]


def test_c1_regimen_slot_every_structure_in_a_dose_field_is_absent():
    for field in DOSE_FIELDS_UNDER_TEST:
        for bad in ([1, 2], ["a"], [], {"value": 3, "unit": "DAYS"}, {"a": 1}, [["a"]], True):
            a = direct(regimen_slots=[dict(SLOT_BASE, **{field: bad})])
            assert len(not_representable(a)) == 1, (field, bad)
            assert not has_brace(a["slots"]) and "True" not in json.dumps(a["slots"]), (field, bad)


DOSE_FIELDS_UNDER_TEST = ("strength", "frequency", "duration", "route")


def test_c1_dose_fields_are_the_guard_constant():
    from tools.eta2freescript.guard import DOSE_FIELDS
    assert tuple(DOSE_FIELDS) == DOSE_FIELDS_UNDER_TEST and M.DOSE_FIELDS is DOSE_FIELDS


def test_c1_all_four_lists_at_once_on_both_sites_leave_no_join_anywhere():
    a = direct(prescription=[dict(RX_BASE, **DOSE_LISTS)], regimen_slots=[dict(SLOT_BASE, **DOSE_LISTS)])
    assert len(not_representable(a)) == 2
    for j in JOINS:
        assert j not in whole(a), j


def test_c1_control_instructions_list_still_joins():
    a = direct(prescription=[dict(RX_BASE, instructions=["after food", "with water"])])
    assert not not_representable(a)
    assert "after food, with water" in whole(a)
    b = direct(prescription=[dict(RX_BASE, instructions="after food, with water")])
    assert a["gp_extraction"] == b["gp_extraction"]


@pytest.mark.parametrize("key", ["instructions", "dosage_form", "drug_class_said", "name_interpretation"])
def test_c1_control_non_dose_rx_lists_still_join(key):
    a = direct(prescription=[dict(RX_BASE, **{key: ["x", "y"]})])
    assert not not_representable(a)
    assert a["gp_extraction"] == direct(prescription=[dict(RX_BASE, **{key: "x, y"})])["gp_extraction"]


def test_c1_control_other_text_fields_still_join():
    a = art_of(advice=[{"text": ["drink water", "rest"], "basis": "said", "source_turns": [5]}])
    assert "drink water, rest" in whole(a)
    inv = _inv(["before food", "morning"])
    assert inv["gp_extraction"]["further_investigations"][0]["instruction"] == "before food, morning"
    assert not not_representable(a) and not not_representable(inv)


def _base_c1():
    global BASE_SHA
    saved = BASE_SHA
    BASE_SHA = C1_BASE_SHA
    try:
        return _base_mapper()
    finally:
        BASE_SHA = saved


@pytest.fixture(scope="module")
def base_c1():
    return _base_c1()


def test_c1_oracle_plain_string_input_is_byte_identical_to_7130c5a7(base_c1):
    assert base_c1.MAPPER_VERSION == M.MAPPER_VERSION and hasattr(base_c1, "as_text")
    n = 2500
    for seed in range(n):
        g = Gen(40_000 + seed, "str")
        enc = g.enc()
        if seed % 2:  # plain-string regimen slots too
            enc["regimen_slots"] = [dict(SLOT_BASE, frequency=g.rng.choice(["twice a day", "once a day"]),
                                         duration=g.rng.choice([None, "for two weeks"]), strength=g.rng.choice([None, "500 mg"]))]
        old, new = build_direct(enc, base_c1), build_direct(enc)
        assert json.dumps(stable(old), sort_keys=True) == json.dumps(stable(new), sort_keys=True), seed
        assert fallback(old) == fallback(new), seed
    assert n >= 2000


def _inject(enc, rng):
    """List values in dose fields of prescription and regimen_slots. Returns True when one went in."""
    hit = False
    for rx in enc["prescription"]:
        for k in rng.sample(sorted(DOSE_LISTS), rng.randint(1, 2)) if rng.random() < 0.7 else []:
            rx[k] = list(DOSE_LISTS[k])
            hit = True
    if rng.random() < 0.7:
        slot = dict(SLOT_BASE)
        if rng.random() < 0.7:
            slot[rng.choice(["strength", "frequency", "duration", "route"])] = [500, 250]
            hit = True
        enc["regimen_slots"] = [slot]
    return hit


def test_c1_recorder_changes_only_where_a_list_dose_field_was_injected(base_c1, tmp_path):
    n, injected, changed = 240, 0, 0
    for i in range(n):
        g = Gen(50_000 + i, "str")
        enc = g.enc()
        enc["prescription"] = enc["prescription"] or [dict(RX_BASE)]
        hit = _inject(enc, random.Random(i))
        injected += hit
        new_calls, new = _record(M, enc, tmp_path / f"n{i}")
        old_calls, old = _record(base_c1, enc, tmp_path / f"o{i}")
        same = (old_calls == new_calls and json.dumps(stable(old["artifact"]), sort_keys=True) == json.dumps(stable(new["artifact"]), sort_keys=True)
                and old["final_valid"] == new["final_valid"])
        if not same:
            changed += 1
            assert hit, i
        for j in JOINS:
            assert j not in json.dumps(new["artifact"]), (i, j)
    assert injected > 100 and changed > 20
    print(f"c1 recorder: {n} consults, {injected} with a list dose field, {changed} changed")
