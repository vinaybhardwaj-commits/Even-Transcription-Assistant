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


# ---- FIX1: pins for the guards the first round of tests left unpinned (traversal, empty, delegation, byte-exactness) ----

class RecordingClient(ModelClient):
    """Records all six arguments, which FakeClient does not (it drops max_tokens and temperature)."""

    def __init__(self):
        self.calls = []

    def resolve(self, alias):
        return "anthropic.claude-test", "converse"

    def _chat(self, alias, prompt, system, max_tokens, temperature, tag):
        self.calls.append((alias, prompt, system, max_tokens, temperature, tag))
        return f"out:{len(self.calls)}"


def _is_unusable(uid):
    return uid in ("", ".", "..") or "/" in uid or "\\" in uid


def _plant(path, tmp_path):
    """Put a valid Stage A file at path when it lies inside the test tree, so a missing file cannot explain a raise."""
    try:
        path.resolve().relative_to(tmp_path.resolve())
    except ValueError:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"consult_boundary": {"foreign_turns": []}}')
    return True


def _generated_bad_uids(n=120):
    import random
    rng = random.Random(f"{SEED}-uids")
    segs = ["..", ".", "a", "b", "", "x..", "..x", "sub"]
    out = set()
    while len(out) < n:
        uid = rng.choice(["/", "\\"]).join(rng.choice(segs) for _ in range(rng.randint(1, 4)))
        if _is_unusable(uid):
            out.add(uid)
    return sorted(out)


FIXED_BAD_UIDS = ["..", "../x", ".", "", "a/b", "/abs", "a\\b", "..\\outside", "sub/../x", "/etc"]


@pytest.mark.parametrize("uid", FIXED_BAD_UIDS + _generated_bad_uids())
def test_traversal_uids_raise_value_error_with_zero_inner_calls(tmp_path, uid):
    root = tmp_path / "w" / "x" / "y" / "root"
    root.mkdir(parents=True)
    # a valid file at the traversal target, plus one at the absolute-uid target, so only the guard can stop the read
    if uid.startswith("/"):
        uid = str(tmp_path / "abs")  # an absolute uid, with a valid file at its target
        _plant(tmp_path / "abs" / "stageA.raw.txt", tmp_path)
    else:
        _plant(root / uid / "stageA.raw.txt", tmp_path)
    assert _is_unusable(uid)
    inner = RecordingClient()
    w = StageAFromClient(inner, root)
    with pytest.raises(ValueError):
        w.stage_a_text(uid)
    with pytest.raises(ValueError):
        w.stage_a_sha12(uid)
    if ":" not in uid:
        with pytest.raises(ValueError):
            w.chat("sonnet", "P", "S", tag=f"stageA-v2:{uid}")
    assert inner.calls == []


def test_traversal_target_files_exist_for_the_fixed_list(tmp_path):
    """Guard against the test passing only because the file is missing: the planted target is readable on its own."""
    root = tmp_path / "root"
    root.mkdir()
    for uid in ("..", "../x", ".", "", "a/b", "a\\b"):
        assert _plant(root / uid / "stageA.raw.txt", tmp_path)
        assert (root / uid / "stageA.raw.txt").is_file()


def test_colon_uid_is_parsed_to_its_last_segment_and_traversal_still_raises(tmp_path):
    root = tmp_path / "w" / "root"
    root.mkdir(parents=True)
    _plant(root / ".." / "stageA.raw.txt", tmp_path)
    inner = RecordingClient()
    with pytest.raises(ValueError):
        StageAFromClient(inner, root).chat("sonnet", "P", "S", tag="stageA-v2:x:..")
    assert inner.calls == []


EMPTY_BODIES = ["", " ", "\n", "\r\n", "\t \n", "  \r\n  \r\n", "\r", " \n"]


@pytest.mark.parametrize("body", EMPTY_BODIES)
def test_empty_or_whitespace_file_raises_in_the_client_and_says_empty(tmp_path, body):
    (tmp_path / "u1").mkdir()
    (tmp_path / "u1" / "stageA.raw.txt").write_bytes(body.encode())
    inner = RecordingClient()
    w = StageAFromClient(inner, tmp_path)
    for call in (lambda: w.stage_a_text("u1"), lambda: w.stage_a_sha12("u1"), lambda: w.chat("sonnet", "P", "S", tag="stageA-v2:u1")):
        with pytest.raises(ValueError, match="is empty"):
            call()
    assert inner.calls == []


def _gen_text_bodies(n=60):
    import random
    rng = random.Random(f"{SEED}-bytes")
    ws = ["", " ", "  ", "\n", "\r\n", "\r", "\t", "\n\n", " \r\n", "\r\r\n"]
    core = ['{"consult_boundary": {"foreign_turns": [1, 2]}}', "{\r\n  \"a\": 1,\r\n  \"b\": \"café\"\r\n}", "{\"a\":\r1}", "x"]
    out = ["{}", "{}\n", "\n{}", " {} \r\n", "{}\r", "{\"a\": 1}\r\n\r\n"]  # fixed edge shapes first
    while len(out) < n:
        out.append(rng.choice(ws) + rng.choice(core) + rng.choice(ws))
    return out


def test_returned_text_is_byte_equal_to_the_file(tmp_path):
    inner = RecordingClient()
    w = StageAFromClient(inner, tmp_path)
    bodies = _gen_text_bodies()
    shapes = set()
    for i, body in enumerate(bodies):
        raw = body.encode("utf-8")
        d = tmp_path / f"u{i}"
        d.mkdir()
        (d / "stageA.raw.txt").write_bytes(raw)
        for got in (w.stage_a_text(f"u{i}"), w.chat("sonnet", "P", "S", tag=f"stageA-v2:u{i}")):
            assert got.encode("utf-8") == raw
        assert w.stage_a_sha12(f"u{i}") == hashlib.sha256(raw).hexdigest()[:12]
        shapes.add((body[:1].isspace(), body[-1:].isspace(), "\r\n" in body, "\r" in body.replace("\r\n", ""), not body.endswith("\n")))
    assert any(s[0] for s in shapes) and any(s[1] for s in shapes) and any(s[2] for s in shapes) and any(s[3] for s in shapes) and any(s[4] for s in shapes)
    assert inner.calls == []


def test_all_six_delegated_arguments_equal_an_unwrapped_call(tmp_path):
    import random
    rng = random.Random(f"{SEED}-deleg")
    (tmp_path / "u1").mkdir()
    (tmp_path / "u1" / "stageA.raw.txt").write_text("{}")
    wrapped_inner, plain = RecordingClient(), RecordingClient()
    w = StageAFromClient(wrapped_inner, tmp_path)
    tags = ["stageB-v9:u1", "judge-v1:u1", "judge-v1:stageA-x:u1", "xstageA-v2:u1", "", "stageB-v9", "stageAv2:u1",
            " stageB-v9:u1", "stageB-v9:u1 ", "stageB-v9:u1\n", "\tjudge-v1:u1", " stageA-v2:u1"]
    seen_mt, seen_t = set(), set()
    for k in range(60):
        args = (rng.choice(["sonnet", "opus", "haiku"]), f"prompt-{k}-{rng.random()}", f"system-{rng.random()}")
        mt = rng.choice([1, 17, 255, 4096, 7999, 8001, 16000, rng.randint(1, 64000)])
        t = rng.choice([0.0, 0.1, 0.25, 0.5, 0.7, 1.0, round(rng.random(), 3)])
        tag = rng.choice(tags)
        seen_mt.add(mt)
        seen_t.add(t)
        assert w.chat(*args, max_tokens=mt, temperature=t, tag=tag) == plain.chat(*args, max_tokens=mt, temperature=t, tag=tag)
    # defaults too: the wrapper must not change them
    assert w.chat("sonnet", "P", "S", tag="stageB-v9:u1") == plain.chat("sonnet", "P", "S", tag="stageB-v9:u1")
    assert len(wrapped_inner.calls) == 61 and wrapped_inner.calls == plain.calls
    assert any(m not in (8000,) for m in seen_mt) and any(x not in (0.0,) for x in seen_t)
    assert {c[3] for c in wrapped_inner.calls} - {8000} and {c[4] for c in wrapped_inner.calls} - {0.0}
    # a Stage A call adds nothing to the inner client's record
    w.chat("sonnet", "P", "S", max_tokens=1234, temperature=0.9, tag="stageA-v2:u1")
    assert len(wrapped_inner.calls) == 61


# ---- FIX2: every way the stored Stage A file can fail is caught at StageAFromClient itself (not via pipeline or parse_json) ----
# The rule, as a property: the client raises, the type is one R2 allows, and the inner client gets 0 calls (no live fallback).

import os
import random as _random

_R2_TYPES = (FileNotFoundError, ValueError, PermissionError)
_NEEDS_NON_ROOT = pytest.mark.skipif(os.geteuid() == 0, reason="root reads a chmod 000 file, so the case proves nothing")


def _bad_utf8_bodies():
    """Byte strings that are not valid UTF-8, in several shapes. Each is checked to really fail strict decoding."""
    json_a, json_b = b'{"a": "', b'", "b": [1, 2]}'
    fixed = [
        b"\xff", b"\xfe\xff", b"\x80", b"\xc3", b"\xe2\x82", b"\xf0\x9f\x98", b"\xc0\xaf", b"\xed\xa0\x80", b"\xf8\x88\x80\x80\x80",
        json_a + b"\xff" + json_b,  # invalid byte inside otherwise valid JSON: a lenient decode would parse it
        json_a + b"\xe2\x82" + json_b,  # truncated multibyte sequence inside valid JSON
        json_a + b"\xc0\xaf" + json_b,  # overlong encoding inside valid JSON
        b"\xff" + json_a + b"x" + json_b,  # at the start
        json_a + b"x" + json_b + b"\xff",  # at the end
        "{}".encode("utf-16"),  # UTF-16 with BOM
        '{"a": "\u00e9"}'.encode("utf-16-be"),  # UTF-16 without a BOM, with a non-ASCII char
        "{\"a\": \"café\"}".encode("latin-1"),  # latin-1 text where UTF-8 is required
    ]
    rng = _random.Random(f"{SEED}-badutf8")
    pieces = [b"\xff", b"\xfe", b"\xc3", b"\xe2\x82", b"\x80", b"\xc0\xaf", b"\xed\xa0\x80", b"\xf5\x80\x80\x80"]
    out = list(fixed)
    while len(out) < len(fixed) + 40:
        body = json_a + rng.choice([b"", b"abc ", "café ".encode()]) + rng.choice(pieces) + rng.choice([b"", b" tail"]) + json_b
        out.append(rng.choice([b"", b"\n", b"  "]) + body + rng.choice([b"", b"\n"]))
    for b in out:
        try:
            b.decode("utf-8")
        except UnicodeDecodeError:
            continue
        raise AssertionError(f"not invalid UTF-8: {b!r}")
    return out


def _mk_file(root, uid, data):
    (root / uid).mkdir(parents=True, exist_ok=True)
    (root / uid / "stageA.raw.txt").write_bytes(data)


def _case_root_missing(root, uid):
    pass  # root itself is never created


def _case_uid_dir_missing(root, uid):
    root.mkdir(parents=True, exist_ok=True)


def _case_file_missing(root, uid):
    (root / uid).mkdir(parents=True, exist_ok=True)
    (root / uid / "stageA.json").write_text("{}")  # a neighbour file, not the one asked for


def _case_dir(root, uid):
    (root / uid / "stageA.raw.txt").mkdir(parents=True)
    (root / uid / "stageA.raw.txt" / "inside").write_text("{}")


def _case_dangling_symlink(root, uid):
    (root / uid).mkdir(parents=True, exist_ok=True)
    (root / uid / "stageA.raw.txt").symlink_to(root / "nowhere")


def _case_chmod_file(root, uid):
    _mk_file(root, uid, b'{"consult_boundary": {"foreign_turns": []}}')
    (root / uid / "stageA.raw.txt").chmod(0o000)


def _case_chmod_dir(root, uid):
    _mk_file(root, uid, b'{"consult_boundary": {"foreign_turns": []}}')
    (root / uid).chmod(0o000)


_FAIL_CASES = [
    ("root-missing", _case_root_missing, (FileNotFoundError,), False),
    ("uid-dir-missing", _case_uid_dir_missing, (FileNotFoundError,), False),
    ("file-missing", _case_file_missing, (FileNotFoundError,), False),
    ("is-a-directory", _case_dir, (FileNotFoundError,), False),
    ("dangling-symlink", _case_dangling_symlink, (FileNotFoundError,), False),
    ("chmod-000-file", _case_chmod_file, (PermissionError,), True),
    # Reading inside a mode-000 directory is a PermissionError at the OS, but models.py checks existence first and Path.exists() reports
    # False for it on some Python/filesystem combinations, so the client raises FileNotFoundError. Both are a hard failure with zero inner calls.
    ("chmod-000-dir", _case_chmod_dir, (FileNotFoundError, PermissionError), True),
] + [(f"empty-{i}", (lambda root, uid, b=b: _mk_file(root, uid, b)), (ValueError,), False)
     for i, b in enumerate([b"", b" ", b"\n", b"\r\n", b"\t", b"\r", b" \n \r\n ", b"\n" * 500, " ".encode(), "  ".encode(), b"\x0b\x0c"])] \
  + [(f"bad-utf8-{i}", (lambda root, uid, b=b: _mk_file(root, uid, b)), (UnicodeDecodeError,), False)
     for i, b in enumerate(_bad_utf8_bodies())]


@pytest.mark.parametrize("name,build,expected,needs_non_root", _FAIL_CASES, ids=[c[0] for c in _FAIL_CASES])
def test_every_stored_stage_a_failure_raises_at_the_client_with_zero_inner_calls(tmp_path, name, build, expected, needs_non_root):
    if needs_non_root and os.geteuid() == 0:
        pytest.skip("root reads a chmod 000 file, so the case proves nothing")
    root = tmp_path / "root"
    build(root, "u1")
    inner = RecordingClient()
    w = StageAFromClient(inner, root)
    calls = (lambda: w.stage_a_text("u1"), lambda: w.stage_a_sha12("u1"), lambda: w.chat("sonnet", "P", "S", tag="stageA-v2:u1"),
             lambda: w.chat("sonnet", "P", "S", max_tokens=99, temperature=0.3, tag="stageA-v9:run7:u1"))
    try:
        for call in calls:
            with pytest.raises(_R2_TYPES) as ei:
                call()
            assert isinstance(ei.value, expected), f"{name}: got {type(ei.value).__name__}, wanted {expected}"
        assert inner.calls == [], f"{name}: the inner client was called, which is a live Stage A fallback"
    finally:  # let pytest delete the tree
        for p in (root / "u1", root / "u1" / "stageA.raw.txt"):
            if p.exists() and not p.is_symlink():
                p.chmod(0o755 if p.is_dir() else 0o644)


def test_failure_cases_cover_every_class_the_rule_names():
    names = " ".join(c[0] for c in _FAIL_CASES)
    for needed in ("root-missing", "file-missing", "is-a-directory", "chmod-000-file", "bad-utf8-", "empty-"):
        assert needed in names
    assert sum(c[0].startswith("bad-utf8-") for c in _FAIL_CASES) >= 40


def test_a_good_file_is_not_caught_by_the_failure_property(tmp_path):
    """Non-vacuity: the same four calls on a valid file return text and make 0 inner calls, so the cases above fail for their own reason."""
    _mk_file(tmp_path, "u1", b'{"a": "caf\xc3\xa9"}')
    inner = RecordingClient()
    w = StageAFromClient(inner, tmp_path)
    assert w.stage_a_text("u1") == '{"a": "café"}'
    assert w.chat("sonnet", "P", "S", tag="stageA-v2:u1") == '{"a": "café"}'
    assert len(w.stage_a_sha12("u1")) == 12
    assert inner.calls == []


def test_a_utf8_bom_is_kept_byte_for_byte(tmp_path):
    """A valid UTF-8 file that starts with a BOM must come back with the BOM (utf-8-sig would drop it and break byte-equality)."""
    inner = RecordingClient()
    w = StageAFromClient(inner, tmp_path)
    for i, raw in enumerate([b"\xef\xbb\xbf{}", b"\xef\xbb\xbf" + b'{"a": "caf\xc3\xa9"}\r\n', b"{}\xef\xbb\xbf", b"\xef\xbb\xbf\xef\xbb\xbf{}"]):
        _mk_file(tmp_path, f"u{i}", raw)
        for got in (w.stage_a_text(f"u{i}"), w.chat("sonnet", "P", "S", tag=f"stageA-v2:u{i}")):
            assert got.encode("utf-8") == raw
        assert w.stage_a_sha12(f"u{i}") == hashlib.sha256(raw).hexdigest()[:12]
    assert inner.calls == []
