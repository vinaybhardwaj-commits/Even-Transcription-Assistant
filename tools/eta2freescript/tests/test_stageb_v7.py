"""Stage B v7 (lever 2: Presenting Complaint in one line): prompt diff vs v5, selection by --stage-b-version, v5 default unchanged."""
import difflib
import json

from conftest import CONSULTS, MODEL, stage_a

from tools.eta2freescript.__main__ import main
from tools.eta2freescript.ingest import load_consult
from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.pipeline import Options, run_consult
from tools.eta2freescript.prompts import prompt_path

UIDS = ("synth-fever-dose", "synth-boundary-knee", "synth-cough-native")


def _changed(a, b):
    return [l for l in difflib.unified_diff(a.splitlines(), b.splitlines(), lineterm="", n=0) if l[:1] in "+-" and l[:3] not in ("+++", "---")]


def _stable(path):
    """artifact.json bytes with only the per-run identifiers (id, clock, run id) blanked; everything else, prompt hash included, must match."""
    a = json.loads(path.read_text(encoding="utf-8"))
    a["artifact_id"], a["created_at"], a["generator"]["run_id"] = "", "", ""
    return json.dumps(a, indent=1, sort_keys=True).encode()


def test_v7_differs_from_v5_only_in_pc_rule_and_header():
    v5 = prompt_path("stageB-v5").read_text(encoding="utf-8")
    v7 = prompt_path("stageB-v7").read_text(encoding="utf-8")
    ch = _changed(v5, v7)
    removed = [l[1:] for l in ch if l[0] == "-"]
    added = [l[1:] for l in ch if l[0] == "+"]
    header = ("# Stage B", "<!-- prompt_id", "     changes vs")
    # every removed line is a header line; every added line is a header line or the single PC rule
    assert all(l.startswith(header) for l in removed)
    pc = [l for l in added if not l.startswith(header)]
    assert len(pc) == 1 and pc[0].startswith("10. Presenting Complaint:") and "ONE line." in pc[0] and "Relevant:" in pc[0] and '"Hx - "' in pc[0] and "Never drop or merge away a clinical fact" in pc[0]
    # and the body (from ## SYSTEM on) is v5's body plus exactly that line
    body5 = v5[v5.index("## SYSTEM"):].splitlines()
    body7 = [l for l in v7[v7.index("## SYSTEM"):].splitlines() if l != pc[0]]
    assert body5 == body7


def test_stage_b_version_flag_selects_v7_prompt(tmp_path, capsys):
    c = load_consult(CONSULTS, "synth-fever-dose")
    note = (MODEL / "synth-fever-dose" / "stageB.txt").read_text()
    fake = FakeClient({"stageA-v2": json.dumps(stage_a("synth-fever-dose")), "stageB-v7": note})
    lg = run_consult(c, fake, tmp_path, Options(stage_b="stageB-v7"))
    assert [x["tag"] for x in fake.calls] == ["stageA-v2:synth-fever-dose", "stageB-v7:synth-fever-dose"]
    assert "Never drop or merge away a clinical fact" in fake.calls[1]["system"] and lg["note_source"] == "llm_stageB-v7"
    # through the CLI parser too
    out = tmp_path / "cli"
    assert main(["run", "--consult", "synth-fever-dose", "--data", str(CONSULTS), "--replay", str(MODEL), "--out", str(out), "--stage-b-version", "v7"]) == 0
    assert "note=llm_stageB-v7" in capsys.readouterr().out


def test_default_is_v5_and_output_byte_identical(tmp_path):
    for uid in UIDS:
        outs = []
        for name, opts in (("default", Options()), ("v5", Options(stage_b="stageB-v5"))):
            d = tmp_path / name
            fake = FakeClient({"stageA": json.dumps(stage_a(uid)), "stageB": (MODEL / uid / "stageB.txt").read_text() if (MODEL / uid / "stageB.txt").exists() else ""})
            run_consult(load_consult(CONSULTS, uid), fake, d, opts)
            outs.append((_stable(d / uid / "artifact.json"), [x["system"] for x in fake.calls]))
        assert outs[0] == outs[1]
        assert "Never drop or merge away a clinical fact" not in outs[0][1][-1]


def test_v7_two_hx_lines_rule_in_prompt_and_fallback_keeps_both(tmp_path):
    uid = "synth-fever-dose"
    enc = stage_a(uid)
    enc["history"] = [
        {"type": "family", "text": "Mother had tuberculosis", "clinically_relevant": True, "basis": "said", "source_turns": [3]},
        {"type": "occupation", "text": "Works with poultry", "clinically_relevant": True, "basis": "said", "source_turns": [3]},
    ]
    note_llm = (MODEL / uid / "stageB.txt").read_text()
    fake = FakeClient({"stageA-v2": json.dumps(enc), "stageB-v7": note_llm})
    run_consult(load_consult(CONSULTS, uid), fake, tmp_path / "llm", Options(stage_b="stageB-v7"))
    system = fake.calls[1]["system"]
    assert 'Then a tail "Relevant: …" holding EVERY other fact' in system and "Never drop or merge away a clinical fact" in system
    # no LLM: the deterministic fallback note carries both Hx facts
    fake = FakeClient({"stageA-v2": json.dumps(enc)})
    lg = run_consult(load_consult(CONSULTS, uid), fake, tmp_path / "det", Options(stage_b="stageB-v7", stage_b_enabled=False))
    assert [x["tag"] for x in fake.calls] == ["stageA-v2:" + uid]
    note = lg["artifact"]["note_text"]
    assert "Hx - Mother had tuberculosis" in note and "Hx - Works with poultry" in note


def test_v7_cough_native_rule_in_prompt_and_fallback_keeps_no_fever(tmp_path):
    uid = "synth-cough-native"
    fake = FakeClient({"stageA-v2": json.dumps(stage_a(uid)), "stageB-v7": ""})
    run_consult(load_consult(CONSULTS, uid), fake, tmp_path / "llm", Options(stage_b="stageB-v7"))
    system = fake.calls[1]["system"]
    assert 'every stated negative or normal finding' in system and '"no fever" stays "no fever"' in system
    fake = FakeClient({"stageA-v2": json.dumps(stage_a(uid))})
    lg = run_consult(load_consult(CONSULTS, uid), fake, tmp_path / "det", Options(stage_b="stageB-v7", stage_b_enabled=False))
    assert "no fever" in lg["artifact"]["note_text"].lower()
