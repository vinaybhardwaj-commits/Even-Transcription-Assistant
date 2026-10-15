"""Reject fixes: K1 keep the reject, K2 the fallback adds no template characters, K3 no null raw_name."""
import copy
import json
import random
import re
import stat
import subprocess
import unicodedata
from pathlib import Path

import pytest
from conftest import CONSULTS, MODEL, build_artifact, mk_consult, stage_a

from tools.eta2freescript import pipeline
from tools.eta2freescript.ingest import load_consult
from tools.eta2freescript.mapper import raw_name_or
from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.note import HEADINGS, _clean, render_note, sanitize_note
from tools.eta2freescript.pipeline import _fallback_note, run_consult
from tools.eta2freescript.validate import printable_errors

TEMPLATE = re.compile(r"[\[\]{}]")
PKG = Path(__file__).resolve().parents[1]


# --- K1 ----------------------------------------------------------------------------------------------------------------
def _fake(uid="synth-fever-dose"):
    return FakeClient({"stageA-v2": json.dumps(stage_a(uid)), "stageB-v9": (MODEL / uid / "stageB.txt").read_text()})


def test_k1_reject_keeps_the_artifact_beside_the_validation_file(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline, "check", lambda art: ["synthetic reject"])
    lg = run_consult(load_consult(CONSULTS, "synth-fever-dose"), _fake(), tmp_path)
    od = tmp_path / "synth-fever-dose"
    assert lg["written"] is False and lg["final_valid"] is False and lg["final_errors"] == ["synthetic reject"]
    assert not (od / "artifact.json").exists() and not (od / "artifact.v0.1.json").exists()
    rej = json.loads((od / "artifact.rejected.json").read_text())
    assert rej == json.loads(json.dumps(lg["artifact"], ensure_ascii=False))
    assert rej["note_text"] and rej["gp_extraction"]["medicines"] and "completion_required" in rej
    assert stat.S_IMODE((od / "artifact.rejected.json").stat().st_mode) == 0o600
    assert (od / "note_text.llm.txt").read_text().endswith("\n") and "Medication:" in (od / "note_text.llm.txt").read_text()
    v = json.loads((od / "artifact.validation.json").read_text())
    assert v["written"] is False and v["final_valid"] is False and "artifact" not in v


def test_k1_a_written_consult_leaves_no_rejected_file(tmp_path):
    lg = run_consult(load_consult(CONSULTS, "synth-fever-dose"), _fake(), tmp_path)
    od = tmp_path / "synth-fever-dose"
    assert lg["written"] is True and (od / "artifact.json").exists() and not (od / "artifact.rejected.json").exists()


def test_k1_nothing_reads_the_rejected_file():
    users = sorted(p.name for p in PKG.rglob("*.py") if "tests" not in p.parts and "vendor" not in p.parts and "artifact.rejected" in p.read_text())
    assert users == ["nightly.py", "pipeline.py"]
    hits = [l.strip() for l in (PKG / "nightly.py").read_text().splitlines() if "artifact.rejected" in l]
    assert len(hits) == 1 and hits[0].startswith("for name in (() if error_type else (")  # the keep-list copy, not a read


# --- K2: the fallback adds no template characters. It does NOT rewrite brackets (Fable gate FRF-1): [ ] { } and lookalikes in field text
# keep failing FRX-N1, exactly as on base. ------------------------------------------------------------------------------------------------------------------
def _bracketish(c: str) -> bool:
    """What FRX-N1 rejects: [ ] { } and every Ps/Pe character except ( ), after NFKC. Written here, not imported from note.py."""
    return any(x in "[]{}" or (unicodedata.category(x) in ("Ps", "Pe") and x not in "()") for x in unicodedata.normalize("NFKC", c))


POOL = ["", None, "tab", "Paracetamol 500 mg", "BD", "5 days", "after food", "fever", "a: b", "\n", "—", " ", "twice a day",
        "[ok]", "[a [b] c]", "x]", "[y", "{z}", "{a {b} c}", "p}", "{q", "［w］", "【v】", "「u」", "⟨t⟩", "a_b"]
CLEAN_POOL = [p for p in POOL if not (p and any(_bracketish(c) for c in p))]


def _gen_gx(r, pool):
    def s():
        return r.choice(pool)

    def maybe(d):
        return {k: v for k, v in d.items() if r.random() < 0.85}

    gx = {}
    if r.random() < 0.85:
        gx["medicines"] = [maybe({"name": s(), "raw_name": s(), "frequency": s(), "duration": s(), "instructions": s(),
                                  "aliases": [s() for _ in range(r.randint(0, 2))]}) for _ in range(r.randint(0, 4))]
    if r.random() < 0.8:
        gx["presenting_complaints"] = maybe({"symptoms": s(), "diagnoses": [maybe({"diagnosis_or_impression": s(), "is_differential_diagnosis": r.random() < 0.5})
                                                                           for _ in range(r.randint(0, 3))]})
    if r.random() < 0.6:
        gx["follow_up"] = maybe({"followup_type": s(), "followup_date": s(), "follow_up_instructions": s()})
    if r.random() < 0.6:
        gx["comorbidities"] = [maybe({"name": s()}) for _ in range(r.randint(0, 3))]
    if r.random() < 0.6:
        gx["further_investigations"] = [maybe({"name": s(), "raw_name": s(), "instruction": s()}) for _ in range(r.randint(0, 3))]
    if r.random() < 0.6:
        gx["referrals"] = [maybe({"speciality": s(), "notes": s()}) for _ in range(r.randint(0, 3))]
    if r.random() < 0.6:
        gx["plan_of_management"] = maybe({"management_plan": s(), "surgery_or_procedure_recommendations": [maybe({"name": s()}) for _ in range(r.randint(0, 3))]})
    for k in ("examination", "general_advice"):
        if r.random() < 0.8:
            gx[k] = s()
    return gx


def _combo_art(gx):
    """An artifact whose first two medicines form a spoken combination group (brand in a doctor turn)."""
    ev = [{"speaker": "doctor", "segment_ref": "u:1", "quote_en": "take Brandx twice a day"}]
    gx = copy.deepcopy(gx)
    meds = gx.setdefault("medicines", [])
    while len(meds) < 2:
        meds.append({})
    for m in meds[:2]:
        m.update({"raw_name": "Brandx", "aliases": ["Brandx"], "frequency": "bd", "duration": "5 days", "instructions": "after food"})
    meds[0]["name"], meds[1]["name"] = "alpha", "beta"
    return {"gp_extraction": gx, "provenance": [{"json_pointer": f"/medicines/{i}", "flags": [], "evidence": ev} for i in range(2)]}


def _all_outputs(gx, art):
    from tools.eta2freescript.note import combination_groups
    groups = combination_groups(art)
    return {"render_note": render_note(gx, {}, [], groups), "sanitize_note": sanitize_note(render_note(gx, {}, [], groups)),
            "_fallback_note": _fallback_note(art, {}, [])}


@pytest.mark.parametrize("seed", range(8))
def test_k2_no_template_character_for_clean_extractions(seed):
    r = random.Random(seed)
    combos = 0
    for n in range(150):
        gx = _gen_gx(r, CLEAN_POOL)
        art = _combo_art(gx) if n % 3 == 0 else {"gp_extraction": gx, "provenance": []}
        if n % 3 == 0:
            gx = art["gp_extraction"]
            combos += 1
        for name, out in _all_outputs(gx, art).items():
            assert not TEMPLATE.search(out), (name, gx, out)
            assert [l.partition(":")[0] for l in out.split("\n") if l.partition(":")[0] in HEADINGS] == HEADINGS or name == "sanitize_note"
    assert combos


def _brackets(text: str) -> list[str]:
    return [c for c in text if _bracketish(c)]


def _frxn1(gx) -> list[str]:
    return [e for e in printable_errors(render_note(gx), []) if e.startswith("FRX-N1")]


@pytest.mark.parametrize("seed", range(8))
def test_k2_fields_carrying_brackets_still_fail_frxn1(seed):
    r = random.Random(100 + seed)
    seen = 0
    for _ in range(200):
        gx = _full_gx(r, POOL)
        out = render_note(gx)
        if _brackets(out):
            seen += 1
            assert _frxn1(gx), (gx, out)
    assert seen


_BASE_SHA = "40500139"


def _base_note_module():
    """note.py at base 40500139: from git when the history is there, else the frozen oracle copy (which has no combination groups)."""
    import importlib.util
    import tempfile
    try:
        src = subprocess.run(["git", "show", f"{_BASE_SHA}:tools/eta2freescript/note.py"], cwd=PKG, capture_output=True, check=True, text=True).stdout
        path = Path(tempfile.mkdtemp()) / "note_base.py"
        path.write_text(src.replace("from .validate import", "from tools.eta2freescript.validate import"))
    except (subprocess.CalledProcessError, FileNotFoundError):
        path = Path(__file__).parent / "oracle_note_main.py"
    spec = importlib.util.spec_from_file_location("note_at_base", path)
    mod = importlib.util.module_from_spec(spec)
    mod.__package__ = "tools.eta2freescript"
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize("seed", range(8))
def test_k2_property_the_renderer_neither_adds_nor_removes_brackets(seed):
    """For ANY field text (strings, bracket-heavy pool), the bracket/brace characters in the rendered note equal base's."""
    base = _base_note_module()
    r = random.Random(1300 + seed)
    for _ in range(300):
        gx = _full_gx(r, [p for p in POOL if p is not None] + ["".join(r.choice("[]{}［］｛｝【】「」⟨⟩ab :") for _ in range(r.randint(1, 8))) for _ in range(6)])
        got, want = render_note(gx), base.render_note(copy.deepcopy(gx))
        assert _brackets(got) == _brackets(want), (gx, got, want)
        assert got == want, (gx, got, want)
        assert sanitize_note(got) == base.sanitize_note(want)


def test_k2_empty_none_and_missing_fields_render_every_heading():
    for gx in ({}, {"medicines": None, "follow_up": None, "presenting_complaints": None},
               {"medicines": [{}, {"name": None, "frequency": None, "duration": None, "instructions": None}],
                "follow_up": {"followup_type": None, "followup_date": None, "follow_up_instructions": None},
                "comorbidities": [{}], "referrals": [{}], "further_investigations": [{}],
                "plan_of_management": {"surgery_or_procedure_recommendations": [{}]},
                "presenting_complaints": {"diagnoses": [{}]}}):
        out = render_note(gx)
        assert [l.partition(":")[0] for l in out.split("\n")] == HEADINGS and not TEMPLATE.search(out)


def test_k2_clean_leaves_brackets_alone():
    for s_ in ("take [a [b] c] daily", "x ]", "[ y", "{z}", "p } q", "［w］", "a 【v】 b", "「u」", "take 1 [0-1-0] bd"):
        assert _clean(s_) == s_.strip(), s_
    assert _clean("a: b\n[c]") == "a - b [c]"


# The three probes are checked on the renderer's own output (render_note), which is what FRF-1 is about. sanitize_note (untouched, and the same
# as base) strips a well-formed "[...]" span before validation, so the first and third probes reach FRX-N1 only through that path on base too.
def test_k2_gate_probe_placeholder_dose_slots_are_rejected():
    gx = {"medicines": [{"name": "Paracetamol", "frequency": "[frequency]", "duration": "[duration]"}]}
    out = render_note(gx)
    assert "Paracetamol [frequency] x [duration]" in out
    assert "FRX-N1 note_text contains a bracket" in printable_errors(out, [])


def test_k2_gate_probe_serialised_structure_in_instructions_is_rejected():
    gx = {"medicines": [{"name": "Amoxicillin", "frequency": "TID", "duration": "5 days", "instructions": str({"route": "oral", "timing": ["after food"]})}]}
    out = render_note(gx)
    assert "{" in out and "[" in out
    errs = printable_errors(out, [])
    assert "FRX-N1 note_text contains a bracket" in errs and "FRX-N1 note_text contains a template brace" in errs


def test_k2_gate_probe_speaker_label_is_rejected():
    gx = {"medicines": [{"name": "Cetirizine", "instructions": "[S1] take at night"}]}
    out = render_note(gx)
    assert "Cetirizine [S1] take at night" in out
    assert "FRX-N1 note_text contains a bracket" in printable_errors(out, [])


@pytest.mark.parametrize("seed", range(8))
def test_k2_fields_without_brackets_render_exactly_as_before(seed):
    r = random.Random(900 + seed)
    for _ in range(300):
        v = r.choice([p for p in CLEAN_POOL if p is not None])
        assert _clean(v) == (v or "").replace(":", " -").replace("\n", " ").strip()
        gx = _full_gx(r)
        assert render_note(gx) == base_render(gx)


def _full_gx(r, pool=None):
    """Every field present and a string (the inputs on which base does not crash); by default none carries a bracket."""
    pool = pool or [p for p in CLEAN_POOL if p is not None]

    def s():
        return r.choice(pool)

    return {"medicines": [{"name": s(), "frequency": s(), "duration": s(), "instructions": s(), "raw_name": s(), "aliases": []} for _ in range(r.randint(0, 3))],
            "presenting_complaints": {"symptoms": s(), "diagnoses": [{"diagnosis_or_impression": s(), "is_differential_diagnosis": r.random() < 0.5} for _ in range(r.randint(0, 2))]},
            "follow_up": {"followup_type": s(), "followup_date": s(), "follow_up_instructions": s()},
            "comorbidities": [{"name": s()} for _ in range(r.randint(0, 2))],
            "further_investigations": [{"name": s(), "raw_name": s(), "instruction": s()} for _ in range(r.randint(0, 2))],
            "referrals": [{"speciality": s(), "notes": s()} for _ in range(r.randint(0, 2))],
            "plan_of_management": {"management_plan": s(), "surgery_or_procedure_recommendations": [{"name": s()} for _ in range(r.randint(0, 2))]},
            "examination": s(), "general_advice": s()}


def base_render(gx):
    """render_note as it stood before the reject fixes: the frozen oracle copy of note.py (no combination groups, as here)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("oracle_note_main", Path(__file__).parent / "oracle_note_main.py")
    mod = importlib.util.module_from_spec(spec)
    mod.__package__ = "tools.eta2freescript"
    spec.loader.exec_module(mod)
    return mod.render_note(gx)


# --- bundle persistence --------------------------------------------------------------------------------------------------
def test_k1_bundle_mode_keeps_the_rejected_artifact_and_posting_ignores_it(tmp_path, monkeypatch):
    from tools.eta2freescript import nightly
    monkeypatch.setattr(pipeline, "check", lambda art: ["synthetic reject"])
    tmp_out, keep = tmp_path / "tmp", tmp_path / "keep"
    lg = run_consult(load_consult(CONSULTS, "synth-fever-dose"), _fake(), tmp_out)
    nightly._keep_derived(tmp_out, str(keep), "synth-fever-dose", lg, 0)
    kd = keep / "synth-fever-dose"
    assert sorted(p.name for p in kd.iterdir()) == ["artifact.rejected.json", "artifact.validation.json"]
    assert stat.S_IMODE((kd / "artifact.rejected.json").stat().st_mode) == 0o600
    assert json.loads((kd / "artifact.rejected.json").read_text())["note_text"]
    assert nightly._repost_log(str(keep), "synth-fever-dose") is None  # posting reads artifact.json only


# --- K3 ----------------------------------------------------------------------------------------------------------------
def test_k3_raw_name_or_falls_back_in_order():
    assert raw_name_or("said", "brand", "gen", "name") == "said"
    assert raw_name_or(None, "brand", "gen", "name") == "brand"
    assert raw_name_or("", " ", "gen", "name") == "gen"
    assert raw_name_or(None, None, None, "name") == "name"
    assert raw_name_or(None, "") is None and raw_name_or("", None) == ""  # all empty: as before


def _meds(art):
    return art["gp_extraction"].get("medicines") or []


@pytest.mark.parametrize("uid", ["synth-fever-dose", "synth-cough-native", "synth-boundary-knee"])
def test_k3_every_emitted_medicine_has_a_non_empty_raw_name(uid):
    c = load_consult(CONSULTS, uid)
    base = stage_a(uid)
    r = random.Random(uid)
    seen = 0
    for _ in range(40):
        enc = copy.deepcopy(base)
        for rx in enc.get("prescription") or []:
            for k in ("generic", "brand_as_said", "name_interpretation"):
                if r.random() < 0.5:
                    rx[k] = r.choice([None, ""])
                elif r.random() < 0.2:
                    rx.pop(k, None)
            if r.random() < 0.3:
                rx["brand_as_said"] = r.choice(["Dolo 650", "Ascoril", "Augmentin 625"])
            if r.random() < 0.3:
                rx["generic"] = r.choice(["paracetamol", "amoxicillin + clavulanic acid"])
        art = build_artifact(c, enc)
        for m in _meds(art):
            seen += 1
            assert isinstance(m["raw_name"], str) and m["raw_name"].strip(), (uid, m)
    assert seen


def test_k3_a_heard_name_only_medicine_gets_its_spoken_name():
    c = mk_consult([(0, 3, "S0", "Take Dolo 650 twice a day for three days."), (3, 5, "S1", "Okay.")], roles={"S0": "doctor", "S1": "patient"})
    from conftest import empty_encounter
    enc = empty_encounter(prescription=[{"action": "start", "decision_turn": 0, "generic": None, "brand_as_said": None, "name_interpretation": "Dolo 650",
                                         "strength": None, "frequency": "twice a day", "duration": "three days", "instructions": None, "basis": "said",
                                         "confidence": 0.8, "source_quote_turn": 0, "source_turns": [0]}])
    for m in _meds(build_artifact(c, enc)):
        assert isinstance(m["raw_name"], str) and m["raw_name"].strip()
