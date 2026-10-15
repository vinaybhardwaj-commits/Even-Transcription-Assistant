"""Per-arm quarantine in judge and floor transcripts. Synthetic only (fake client, fake frozen files).

baseline_run_7c523d3f.py.txt is origin/main's run.py (7c523d3f) verbatim, so the 'equal sets are byte-identical to today' claim is
tested against the old code itself, not against a description of it."""
from __future__ import annotations

import json
import random
import re
import types
from pathlib import Path

import pytest
from conftest import CONSULTS, build_artifact, stage_a
from test_pdqi9_harness import UIDS, _argv, _lockbox_rule, _write_inputs, make_frozen, responder  # noqa: F401 (autouse fixture)

from tools.eta2freescript.eval.pdqi9 import floors, judge, run
from tools.eta2freescript.ingest import load_consult
from tools.eta2freescript.models import FakeClient

BASELINE = Path(__file__).with_name("baseline_run_7c523d3f.py.txt")
U = UIDS[0]


def baseline_module():
    mod = types.ModuleType("tools.eta2freescript.eval.pdqi9.run_baseline")
    mod.__package__ = "tools.eta2freescript.eval.pdqi9"
    mod.__file__ = run.__file__  # code_sha() reads sibling sources relative to run.py
    mod.__dict__["__name__"] = "tools.eta2freescript.eval.pdqi9.run_baseline"
    exec(compile(BASELINE.read_text(encoding="utf-8"), str(BASELINE), "exec"), mod.__dict__)
    return mod


def set_quarantine(arts: Path, uid: str, turns, b0_turns=None):
    """Write the bn artifact's quarantined_turns; when b0_turns is not None also write DIR/b0/<uid>.json with its own set."""
    art = json.loads((arts / f"{uid}.json").read_text(encoding="utf-8"))
    art.setdefault("clip_boundary", {})["quarantined_turns"] = sorted(turns)
    (arts / f"{uid}.json").write_text(json.dumps(art), encoding="utf-8")
    if b0_turns is not None:
        art["clip_boundary"]["quarantined_turns"] = sorted(b0_turns)
        (arts / "b0").mkdir(exist_ok=True)
        (arts / "b0" / f"{uid}.json").write_text(json.dumps(art), encoding="utf-8")


def marked(transcript: str) -> set[int]:
    return {int(m.group(1)) for m in re.finditer(r"^T(\d+) .*\[QUARANTINED", transcript, re.M)}


@pytest.fixture
def spy(monkeypatch):
    """Records (kind, arm, transcript) for every judge and floor call run.main makes."""
    seen = []
    real_score, real_floors = judge.score_note, floors.consult_floors

    def score(client, frozen, **kw):
        seen.append(("judge", kw["arm"], kw["transcript"]))
        return real_score(client, frozen, **kw)

    def cf(client, frozen, **kw):
        seen.append(("floor", kw["arm_kind"], kw["transcript"]))
        return real_floors(client, frozen, **kw)

    monkeypatch.setattr(judge, "score_note", score)
    monkeypatch.setattr(floors, "consult_floors", cf)
    return seen


def go(tmp_path, monkeypatch, bn, b0, module=run, uids=(U,)):
    monkeypatch.delenv("JEV_MCP_CMD", raising=False)
    fdir = make_frozen(tmp_path / "frozen")
    arts, arms = _write_inputs(tmp_path, list(uids))
    for u in uids:
        set_quarantine(arts, u, bn, b0)
    fc = FakeClient(responder)
    assert module.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out"), client=fc) == 0
    return fc


def test_unequal_sets_each_arm_gets_its_own_artifacts_set(tmp_path, monkeypatch, spy):
    go(tmp_path, monkeypatch, bn={1, 2}, b0={3})
    by = {}
    for kind, arm, tr in spy:
        by.setdefault((kind, arm), set()).add(tr)
    assert set(by) == {("judge", "A"), ("judge", "B0"), ("judge", "Bn"), ("floor", "B0"), ("floor", "Bn")}
    assert all(len(v) == 1 for v in by.values())
    got = {k: marked(next(iter(v))) for k, v in by.items()}
    assert got[("judge", "B0")] == got[("floor", "B0")] == {3}
    assert got[("judge", "Bn")] == got[("floor", "Bn")] == got[("judge", "A")] == {1, 2}  # A keeps today's (the bn set)


def test_b0_missing_falls_back_to_bn_set(tmp_path, monkeypatch, spy):
    go(tmp_path, monkeypatch, bn={1, 2}, b0=None)
    assert {marked(tr) == {1, 2} for _, _, tr in spy} == {True} and len(spy) > 0


def test_equal_sets_every_call_and_cache_key_identical_to_origin_main(tmp_path, monkeypatch):
    base_dir, new_dir = tmp_path / "base", tmp_path / "new"
    base_dir.mkdir(), new_dir.mkdir()
    fc_old = go(base_dir, monkeypatch, bn={1, 2}, b0={1, 2}, module=baseline_module())
    fc_new = go(new_dir, monkeypatch, bn={1, 2}, b0={1, 2})
    key = lambda c: (c["alias"], c["tag"], c["prompt"], c["system"])
    assert [key(c) for c in fc_old.calls] == [key(c) for c in fc_new.calls] and len(fc_new.calls) > 0
    names = lambda d: sorted(p.relative_to(d / "out").as_posix() for p in (d / "out" / "cache").rglob("*.json"))
    assert names(base_dir) == names(new_dir) and len(names(new_dir)) > 0  # cache keys are the file names


def test_a_and_bn_cells_unchanged_when_only_b0_set_differs(tmp_path, monkeypatch):
    base_dir, new_dir = tmp_path / "base", tmp_path / "new"
    base_dir.mkdir(), new_dir.mkdir()
    fc_old = go(base_dir, monkeypatch, bn={1, 2}, b0={3}, module=baseline_module())
    fc_new = go(new_dir, monkeypatch, bn={1, 2}, b0={3})
    nid = lambda arm: judge.note_id(U, arm)
    a_bn = lambda fc: [c["prompt"] for c in fc.calls if c["tag"].startswith("pdqi9") and (nid("A") in c["prompt"] or nid("Bn") in c["prompt"])]
    assert a_bn(fc_old) == a_bn(fc_new) and a_bn(fc_new)
    b0 = lambda fc: [c["prompt"] for c in fc.calls if c["tag"].startswith("pdqi9") and nid("B0") in c["prompt"]]
    assert b0(fc_old) != b0(fc_new)  # the old code gave B0 the bn transcript; that is the bug


def test_random_sets_each_arm_marks_exactly_its_own_set(tmp_path, monkeypatch, spy):
    n_turns = len(load_consult(CONSULTS, U).turns)
    rng = random.Random(1015)
    for i in range(25):
        d = tmp_path / f"r{i}"
        d.mkdir()
        spy.clear()
        bn = set(rng.sample(range(n_turns), rng.randint(0, n_turns)))
        b0 = set(rng.sample(range(n_turns), rng.randint(0, n_turns)))
        go(d, monkeypatch, bn=bn, b0=b0)
        for kind, arm, tr in spy:
            assert marked(tr) == (b0 if arm == "B0" else bn), (i, kind, arm)
