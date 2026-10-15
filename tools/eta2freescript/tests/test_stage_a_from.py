"""--stage-a-from: the second arm reuses the first arm's stored Stage A output, so only Stage B differs.

P1 off = old (against base 23d0f118), P2 on = shared, P3 non-vacuity, P4 fail closed, P5 flag clash, P6 provenance suffix.
Generated consults are synthetic and seeded; nothing here reads real text.
"""
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import CONSULTS, MODEL, ROOT

from tools.eta2freescript.__main__ import main
from tools.eta2freescript.ingest import load_consult
from tools.eta2freescript.models import FakeClient, ModelClient, StageAFromClient
from tools.eta2freescript.pipeline import Options, run_consult

BASE = "23d0f118"
SEED = 20261015
N = 200

# Shared by the in-process tests and the P1 subprocess (which runs it against the base tree), so it imports the package lazily.
GEN_SRC = r'''
import copy, json, random

T0 = 1_790_000_000_000
LINES = ["Good morning, please sit down.", "I have had a fever for three days.", "Any cough or cold?", "A little cough at night.",
         "Take this tablet twice a day after food.", "Come back after one week.", "Thank you doctor.", "Next patient please.",
         "How is the pain in the knee?", "It hurts when I climb stairs.", "Drink plenty of water and rest.", "Goodbye, take care."]
ENC = {"schema": "even.encounter.v2", "speaker_roles": [], "chief_complaint": {}, "hpi": [], "comorbidities": [], "history": [],
       "drug_history": [], "allergy_history": [], "examination": [], "vitals": [], "assessment": {}, "diagnoses": [], "plan": [],
       "prescription": [], "regimen_slots": [], "investigations": [], "advice": [], "follow_up": {}, "referrals": [],
       "red_flags_safety_net": [], "uncertainties": []}


def gen_consult(i, seed):
    from tools.eta2freescript.ingest import Consult, RoleFlags, Turn
    rng = random.Random(f"{seed}-{i}")
    n = rng.randint(4, 14)
    sp = ["0", "1"] + (["2"] if rng.random() < 0.3 else [])
    role_track = rng.random() < 0.7
    roles = {"0": "doctor", "1": "patient", "2": "attendant"}
    t, turns = 0.0, []
    for k in range(n):
        t += rng.choice([0.5, 1, 2, 3, 400]) if k else 0
        d = rng.uniform(1, 6)
        s = rng.choice(sp)
        turns.append(Turn(idx=k, t0_ms=T0 + int(t * 1000), t1_ms=T0 + int((t + d) * 1000), speaker=s, text=rng.choice(LINES), lang="en",
                          role=roles[s] if role_track else "unknown", role_source="role_track" if role_track else "none"))
        t += d
    flags = RoleFlags(attender_present="2" in sp, two_consults=rng.random() < 0.15, diar_partial=False) if role_track else None
    return Consult(uid=f"gen-{i}", turns=turns, clip_t0_ms=T0, clip_t1_ms=T0 + int((t + 1) * 1000), language_code="en",
                   english_source="native", diarised=True, room="synth-room", role_track=role_track, role_flags=flags)


def stage_a_raw(i, n_turns, variant, seed):
    """variant 0 = arm 1. variant 1 = a deliberately different Stage A. Roughly 40 percent of arm-1 consults name foreign turns."""
    rng = random.Random(f"{seed}-A-{i}")
    if variant == 0:
        foreign = sorted(rng.sample(range(n_turns), rng.randint(1, n_turns - 1))) if rng.random() < 0.4 else []
    else:
        foreign = sorted(set(range(n_turns)) - set(rng.sample(range(n_turns), rng.randint(1, n_turns - 1))))
    enc = copy.deepcopy(ENC)
    enc["consult_boundary"] = {"suspected": bool(foreign), "foreign_turns": foreign, "reason": "synthetic" if foreign else None}
    enc["chief_complaint"] = {"text": f"synthetic complaint {variant}", "basis": "said", "source_turns": [0]}
    return json.dumps(enc)


def responder(variant, seed):
    def f(tag, prompt, system):
        stage, _, rest = tag.partition(":")
        i = int(rest.split("-")[-1])
        if stage.startswith("stageA-"):
            return stage_a_raw(i, NTURNS[i], variant, seed)
        return f"Chief complaint: synthetic note variant {variant}"
    return f


NTURNS = {}
'''
G = {}
exec(GEN_SRC, G)


def make_consults(n=N):
    cs = [G["gen_consult"](i, SEED) for i in range(n)]
    G["NTURNS"].update({i: len(c.turns) for i, c in enumerate(cs)})
    return cs


def run_arm(cs, out, variant, stage_a_from=None):
    inner = FakeClient(G["responder"](variant, SEED))
    client = StageAFromClient(inner, stage_a_from) if stage_a_from else inner
    logs = {}
    for c in cs:
        logs[c.uid] = run_consult(c, client, out)
    return inner, logs


def stage_calls(inner, prefix):
    return [c for c in inner.calls if c["tag"].startswith(prefix)]


def test_p2_shared_stage_a(tmp_path):
    cs = make_consults()
    x, y = tmp_path / "x", tmp_path / "y"
    f1, l1 = run_arm(cs, x, 0)
    f2, l2 = run_arm(cs, y, 1, stage_a_from=x)
    assert len(cs) >= 200 and len(stage_calls(f1, "stageA-")) == len(cs)
    assert stage_calls(f2, "stageA-") == []  # zero Stage A calls in arm 2
    assert len(stage_calls(f2, "stageB-")) == len(cs)
    with_foreign = 0
    for c in cs:
        e1 = (x / c.uid / "encounter.json").read_bytes()
        assert e1 == (y / c.uid / "encounter.json").read_bytes()
        assert (x / c.uid / "stageA.raw.txt").read_bytes() == (y / c.uid / "stageA.raw.txt").read_bytes()
        assert l1[c.uid]["boundary"] == l2[c.uid]["boundary"]
        a1 = json.loads((x / c.uid / "artifact.json").read_text()) if (x / c.uid / "artifact.json").exists() else None
        a2 = json.loads((y / c.uid / "artifact.json").read_text()) if (y / c.uid / "artifact.json").exists() else None
        assert (a1 is None) == (a2 is None)
        if a1:
            assert a1["clip_boundary"] == a2["clip_boundary"]
        with_foreign += bool(json.loads(e1)["consult_boundary"]["foreign_turns"])
    assert with_foreign >= 20
    # Stage B prompts equal arm 1's (same prompt version), in the same order; only the Stage B response differs.
    b1 = [(c["alias"], c["tag"], c["prompt"], c["system"]) for c in stage_calls(f1, "stageB-")]
    b2 = [(c["alias"], c["tag"], c["prompt"], c["system"]) for c in stage_calls(f2, "stageB-")]
    assert b1 == b2
    assert l1[cs[0].uid]["note_source"] and "variant 1" not in json.dumps(l1)


def test_p3_non_vacuous_without_the_option(tmp_path):
    cs = make_consults()
    _, l1 = run_arm(cs, tmp_path / "x", 0)
    _, l2 = run_arm(cs, tmp_path / "y", 1)  # no --stage-a-from: the different Stage A takes effect
    diff = [u for u in l1 if l1[u]["boundary"] != l2[u]["boundary"]]
    assert len(diff) >= 1


def test_delegation_and_resolve(tmp_path):
    cs = make_consults(5)
    x = tmp_path / "x"
    run_arm(cs, x, 0)
    ref = FakeClient(G["responder"](1, SEED), model_id="anthropic.claude-other", route="converse")
    inner = FakeClient(G["responder"](1, SEED), model_id="anthropic.claude-other", route="converse")
    w = StageAFromClient(inner, x)
    assert w.resolve("sonnet") == ref.resolve("sonnet") and w.ledger is inner.ledger
    assert isinstance(w, ModelClient)
    out = w.chat("opus", "P", "S", max_tokens=123, temperature=0.4, tag=f"stageB-v9:{cs[0].uid}")
    assert out == ref.chat("opus", "P", "S", max_tokens=123, temperature=0.4, tag=f"stageB-v9:{cs[0].uid}")
    assert inner.calls == ref.calls and len(inner.calls) == 1
    # judge / other tags go through unchanged; a stageA-looking uid segment later in the tag is not a Stage A call
    w.chat("opus", "P", "S", tag="judge-v1:stageA-x:gen-1")
    assert inner.calls[-1]["tag"] == "judge-v1:stageA-x:gen-1"
    # Stage A returns the stored text exactly
    assert w.chat("sonnet", "P", "S", tag=f"stageA-v2:{cs[0].uid}") == (x / cs[0].uid / "stageA.raw.txt").read_bytes().decode()
    assert len(inner.calls) == 2


@pytest.mark.parametrize("how", ["missing", "empty", "blank", "dir", "bad_utf8"])
def test_p4_fail_closed_unit(tmp_path, how):
    cs = make_consults(3)
    x = tmp_path / "x"
    run_arm(cs, x, 0)
    p = x / cs[1].uid / "stageA.raw.txt"
    p.unlink()
    if how == "empty":
        p.write_text("")
    elif how == "blank":
        p.write_text(" \n")
    elif how == "dir":
        p.mkdir()
    elif how == "bad_utf8":
        p.write_bytes(b"\xff\xfe\x00{")
    inner = FakeClient(G["responder"](1, SEED))
    client = StageAFromClient(inner, x)
    with pytest.raises((FileNotFoundError, ValueError)):
        run_consult(cs[1], client, tmp_path / "y")
    assert inner.calls == []  # no live Stage A, and Stage B was never reached
    run_consult(cs[0], client, tmp_path / "y")  # the others are unaffected
    assert [c["tag"] for c in inner.calls if c["tag"].endswith(cs[1].uid)] == []


def cli_arm1(tmp_path):
    out = tmp_path / "arm1"
    assert main(["run", "--all", "--data", str(CONSULTS), "--client", "replay", "--replay", str(MODEL), "--out", str(out), "--workers", "1"]) == 0
    return out


def test_p4_cli_prints_error_and_continues(tmp_path, capsys):
    out1 = cli_arm1(tmp_path)
    uids = sorted(p.name for p in CONSULTS.iterdir())
    (out1 / uids[0] / "stageA.raw.txt").unlink()
    (out1 / uids[1] / "stageA.raw.txt").write_text("")
    capsys.readouterr()
    rc = main(["run", "--all", "--data", str(CONSULTS), "--client", "replay", "--replay", str(MODEL), "--out", str(tmp_path / "arm2"),
               "--workers", "1", "--stage-a-from", str(out1)])
    lines = {l.split()[0]: l for l in capsys.readouterr().out.splitlines() if l.strip()}
    assert rc == 1
    assert lines[uids[0]].split()[1] == "ERROR" and lines[uids[1]].split()[1] == "ERROR"
    assert "valid=True" in lines[uids[2]] and "stageA=from:" in lines[uids[2]]
    assert "stageA=" not in lines[uids[0]] and "stageA=" not in lines[uids[1]]


def test_p5_with_no_stage_b_exits_2(tmp_path, capsys):
    out1 = cli_arm1(tmp_path)
    capsys.readouterr()
    rc = main(["run", "--all", "--data", str(CONSULTS), "--client", "replay", "--replay", str(MODEL), "--out", str(tmp_path / "arm2"),
               "--stage-a-from", str(out1), "--no-stage-b"])
    assert rc == 2 and "cannot be combined" in capsys.readouterr().err
    assert not (tmp_path / "arm2").exists() or not any((tmp_path / "arm2").iterdir())


def test_p6_suffix_exactly_when_option_set(tmp_path, capsys):
    out1 = cli_arm1(tmp_path)
    off = capsys.readouterr().out
    assert "stageA=" not in off and off.count("valid=") == 3
    rc = main(["run", "--all", "--data", str(CONSULTS), "--client", "replay", "--replay", str(MODEL), "--out", str(tmp_path / "arm2"),
               "--workers", "1", "--stage-a-from", str(out1)])
    on = capsys.readouterr().out.splitlines()
    assert rc == 0 and len(on) == 3
    for line in on:
        uid = line.split()[0]
        m = re.search(r" stageA=from:([0-9a-f]{12}) ", line + " ")
        assert m and line.count("stageA=") == 1
        assert m.group(1) == hashlib.sha256((out1 / uid / "stageA.raw.txt").read_bytes()).hexdigest()[:12]
    # no schema change: the artifact keys and the other files are the same set as without the option
    a = json.loads((tmp_path / "arm2" / "synth-fever-dose" / "artifact.json").read_text())
    b = json.loads((out1 / "synth-fever-dose" / "artifact.json").read_text())
    assert set(a) == set(b) and "stage_a_sha12" not in json.dumps(a)
    assert sorted(p.name for p in (tmp_path / "arm2" / "synth-fever-dose").iterdir()) == sorted(p.name for p in (out1 / "synth-fever-dose").iterdir())


DRIVER = r'''
import hashlib, json, sys
tree, out, n, seed = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
sys.path.insert(0, tree)
from pathlib import Path
src = Path(sys.argv[5]).read_text()
G = {}
exec(src, G)
from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.pipeline import run_consult
import tools.eta2freescript.pipeline as pl
assert Path(pl.__file__).resolve().is_relative_to(Path(tree).resolve()), pl.__file__
cs = [G["gen_consult"](i, seed) for i in range(n)]
G["NTURNS"].update({i: len(c.turns) for i, c in enumerate(cs)})
fake = FakeClient(G["responder"](0, seed))
for c in cs:
    run_consult(c, fake, Path(out))
def norm(o):
    if isinstance(o, dict):
        return {k: ("<n>" if k in ("created_at", "code_sha256", "run_id", "artifact_id", "secs_stageA", "secs_stageB", "secs_total") else norm(v)) for k, v in o.items()}
    if isinstance(o, list):
        return [norm(x) for x in o]
    return o
files = {}
for c in cs:
    for name in ("artifact.json", "encounter.json", "artifact.validation.json", "stageA.raw.txt", "note_text.llm.txt"):
        p = Path(out) / c.uid / name
        if p.exists():
            raw = p.read_text()
            files[f"{c.uid}/{name}"] = json.dumps(norm(json.loads(raw)), sort_keys=True) if name.endswith(".json") else raw
print(json.dumps({"calls": fake.calls, "files": files}, sort_keys=True))
'''


def test_p1_off_is_old(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    try:
        tar = subprocess.run(["git", "-C", str(ROOT), "archive", BASE, "tools/eta2freescript"], capture_output=True, check=True).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        pytest.skip(f"base {BASE} not available in this checkout")
    subprocess.run(["tar", "-x", "-C", str(base)], input=tar, check=True)
    drv, gen = tmp_path / "drv.py", tmp_path / "gen.txt"
    drv.write_text(DRIVER)
    gen.write_text(GEN_SRC)

    def go(tree, out):
        r = subprocess.run([sys.executable, str(drv), str(tree), str(out), str(N), str(SEED), str(gen)], capture_output=True, text=True, cwd=tree)
        assert r.returncode == 0, r.stderr[-800:]
        return json.loads(r.stdout)

    old, new = go(base, tmp_path / "o_old"), go(ROOT, tmp_path / "o_new")
    assert len(old["calls"]) >= 2 * N and len(old["files"]) >= 3 * N
    assert old["calls"] == new["calls"]  # alias, tag, prompt, system, in order
    assert old["files"].keys() == new["files"].keys()
    bad = [k for k in old["files"] if old["files"][k] != new["files"][k]]
    assert bad == []
