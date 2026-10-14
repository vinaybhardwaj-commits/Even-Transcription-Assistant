"""Stage B v8 (each fact once, short Plan of Management): file diff against v5, version selection, v5 default unchanged."""
import difflib
import hashlib
import re
import json

import pytest

from conftest import CONSULTS, MODEL, stage_a

from tools.eta2freescript import STAGE_B_VERSION
from tools.eta2freescript.__main__ import main
from tools.eta2freescript.ingest import load_consult
from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.pipeline import Options, run_consult
from tools.eta2freescript.prompts import PROMPTS, load_prompt

V5_SHA256 = "ac00de96cb433f1d40ed629d890872154a71a3c1d28b933c80a619ba2beb82d4"
UIDS = ["synth-fever-dose", "synth-boundary-knee"]


def _lines(name):
    return (PROMPTS / f"{name}.md").read_text(encoding="utf-8").splitlines()


def _header_end(lines):
    return next(i for i, l in enumerate(lines) if l.startswith("## SYSTEM"))


ORDER = ["Medication", "Further Investigation", "Surgery or Procedure", "Refer to", "Follow up", "Diagnoses",
         "Co-morbidities", "Examination", "Presenting Complaint", "Plan of Management", "General Advice"]
ORDER_STR = ", ".join(ORDER)


def _assert_order(rule10):
    """The FULL owning-section order, as one substring."""
    assert ORDER_STR in rule10


def _rule(name, n):
    return next(l for l in _lines(name) if l.startswith(f"{n}. "))


def test_v5_file_is_unchanged():
    assert hashlib.sha256((PROMPTS / "stageB-v5.md").read_bytes()).hexdigest() == V5_SHA256


def test_v8_differs_from_v5_only_in_header_and_two_rules():
    a, b = _lines("stageB-v5"), _lines("stageB-v8")
    ha, hb = _header_end(a), _header_end(b)
    added, removed = [], []
    for l in difflib.unified_diff(a[ha:], b[hb:], lineterm="", n=0):
        if l.startswith(("---", "+++", "@@")):
            continue
        (added if l.startswith("+") else removed).append(l[1:])
    assert removed == []
    assert len(added) == 2
    assert added[0].startswith("10. EACH FACT ONCE.") and added[1].startswith("11. PLAN OF MANAGEMENT")
    assert "at most 150 characters" in added[1] and '"; "' in added[1] and "rule 7" in added[1]
    _assert_order(added[0])
    assert "dropping a fact is never allowed" in added[0]
    # header comment says v8 and names the change
    assert b[0].startswith("# Stage B v8") and "prompt_id: stageB-v8" in b[1] and "changes vs v5" in "\n".join(b[:ha])
    # the two rules sit at the end of the Rules list, before the USER block
    assert b[hb:].index(added[0]) == a[ha:].index(next(l for l in a if l.startswith("9. "))) + 1


def test_rule10_order_is_pinned_and_every_adjacent_swap_is_caught():
    rule10 = _rule("stageB-v8", 10)
    _assert_order(rule10)
    assert len(ORDER) == 11
    for i in range(len(ORDER) - 1):
        sw = ORDER[:i] + [ORDER[i + 1], ORDER[i]] + ORDER[i + 2:]
        mutated = rule10.replace(ORDER_STR, ", ".join(sw))
        assert mutated != rule10
        with pytest.raises(AssertionError):
            _assert_order(mutated)


def test_rule10_and_rule11_appended_sentences():
    r10, r11 = _rule("stageB-v8", 10), _rule("stageB-v8", 11)
    assert ("Rule 10 never removes or merges a line that rule 2 requires: every order-list entry keeps its own line "
            "in its own section, even if the same item is in another list.") in r10
    assert "Rule 10 never shortens follow_up_instructions in Follow up (rule 5); write them as given." in r10
    assert ("If the decisions not carried elsewhere need more than 150 characters, keep every decision in the shortest "
            "clinical shorthand. Never dropping a fact wins over the length limit.") in r11


def test_v8_keeps_v5_placeholders_and_headings():
    s5, u5 = load_prompt("stageB-v5")
    s8, u8 = load_prompt("stageB-v8")
    assert u5 == u8 and "{{GP_EXTRACTION}}" in u8 and "{{FLAGS}}" in u8
    assert s8.split("Rules")[0] == s5.split("Rules")[0]


def test_stage_b_version_constant_stays_v5():
    assert STAGE_B_VERSION == "v5"


def test_cli_flag_v8_selects_the_v8_prompt(tmp_path, capsys):
    base = ["run", "--consult", "synth-fever-dose", "--data", str(CONSULTS), "--replay", str(MODEL)]
    assert main(base + ["--out", str(tmp_path / "a"), "--stage-b-version", "v8"]) == 0
    assert "note=llm_stageB-v8" in capsys.readouterr().out
    assert main(base + ["--out", str(tmp_path / "b")]) == 0
    assert "note=llm_stageB-v5" in capsys.readouterr().out


def test_fake_client_v8_call_uses_the_v8_system_prompt(tmp_path):
    c = load_consult(CONSULTS, "synth-fever-dose")
    fake = FakeClient({"stageA": json.dumps(stage_a("synth-fever-dose")), "stageB-v8": (MODEL / "synth-fever-dose" / "stageB.txt").read_text()})
    lg = run_consult(c, fake, tmp_path, Options(stage_b="stageB-v8"))
    assert [x["tag"] for x in fake.calls] == ["stageA-v2:synth-fever-dose", "stageB-v8:synth-fever-dose"]
    assert fake.calls[1]["system"] == load_prompt("stageB-v8")[0] and "EACH FACT ONCE" in fake.calls[1]["system"]
    assert lg["note_source"] == "llm_stageB-v8"


def _mask(b):
    """Blank the per-run random ids, wall-clock timestamps and timings; everything else must match byte for byte."""
    s = re.sub(rb'("(?:artifact_id|run_id)": ")[0-9a-f-]+"', rb'\1X"', b)
    s = re.sub(rb'("created_at": ")[^"]*"', rb'\1T"', s)
    return re.sub(rb'("secs_\w+": )[0-9.]+', rb'\g<1>0', s)


def _run(tmp_path, opts, uid):
    fake = FakeClient({"stageA": json.dumps(stage_a(uid)), "stageB": (MODEL / uid / "stageB.txt").read_text()})
    d = tmp_path / uid
    run_consult(load_consult(CONSULTS, uid), fake, d, opts)
    return {p.name: _mask(p.read_bytes()) for p in sorted((d / uid).iterdir())}, fake


def _v5_system_bytes():
    """The SYSTEM block of stageB-v5.md taken straight from the file bytes, independent of load_prompt."""
    raw = (PROMPTS / "stageB-v5.md").read_bytes()
    return raw.split(b"## SYSTEM", 1)[1].split(b"## USER", 1)[0].strip()


@pytest.mark.parametrize("uid", UIDS)
def test_v5_default_sends_exactly_the_v5_system_block(tmp_path, uid):
    assert hashlib.sha256((PROMPTS / "stageB-v5.md").read_bytes()).hexdigest() == V5_SHA256
    _, fake = _run(tmp_path, Options(), uid)
    assert [x["tag"] for x in fake.calls] == [f"stageA-v2:{uid}", f"stageB-v5:{uid}"]
    sent = fake.calls[1]["system"]
    assert sent.encode("utf-8") == _v5_system_bytes()
    assert "EACH FACT ONCE" not in sent


def test_default_run_output_is_deterministic_after_masking(tmp_path):
    a, _ = _run(tmp_path / "a", Options(), UIDS[0])
    b, _ = _run(tmp_path / "b", Options(), UIDS[0])
    assert a == b
