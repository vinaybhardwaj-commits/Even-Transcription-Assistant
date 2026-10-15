"""Judge and floor caches are keyed by the exact judge input, never by arm (FREESCRIPT-JUDGE-CACHE-ARMLESS, 15 Oct 2026).

Synthetic only. P1 shared cell, P2 distinct cells, P3 single arm unchanged against main 59739ddb, P4 no arm in a key, P5 non-vacuity
(the same scenarios run against a copy of the source with `arm` put back into the key must fail)."""
from __future__ import annotations

import json
import random
import subprocess
import sys
import types
from pathlib import Path

import pytest
from test_pdqi9_harness import MARK, _lockbox_rule, make_frozen, responder  # noqa: F401 (autouse fixture)

from tools.eta2freescript.eval.pdqi9 import floors, judge
from tools.eta2freescript.models import FakeClient

BASE_SHA = "59739ddb3c02cd4ddcf86d68774b7da7ceeaf2f7"
PKG = "tools.eta2freescript.eval.pdqi9"
HERE = Path(__file__).resolve()
SRC = HERE.parents[1] / "eval" / "pdqi9"


class Rec(FakeClient):
    """Records every model call with all of its arguments, in order."""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.full: list[tuple] = []

    def _chat(self, alias, prompt, system, max_tokens, temperature, tag):
        self.full.append((alias, tag, system, max_tokens, temperature, prompt))
        return super()._chat(alias, prompt, system, max_tokens, temperature, tag)


def _load(name: str, source: str, judge_name: str | None = None):
    """Exec `source` as module PKG.name. A floors source has its `.judge` import pointed at `judge_name`."""
    if judge_name:
        source = source.replace("from .judge import", f"from .{judge_name} import")
    mod = types.ModuleType(f"{PKG}.{name}")
    mod.__package__, mod.__file__ = PKG, str(SRC / f"{name}.py")
    sys.modules[mod.__name__] = mod
    exec(compile(source, mod.__file__, "exec"), mod.__dict__)
    return mod


def _git_show(path: str) -> str:
    top = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=HERE.parent, check=True, capture_output=True, text=True).stdout.strip()
    return subprocess.run(["git", "show", f"{BASE_SHA}:tools/eta2freescript/eval/pdqi9/{path}"], cwd=top, check=True, capture_output=True, text=True).stdout


@pytest.fixture(scope="module")
def base_mods():
    j = _load("judge_base59", _git_show("judge.py"))
    f = _load("floors_base59", _git_show("floors.py"), "judge_base59")
    return j, f


@pytest.fixture
def fdir(tmp_path):
    return make_frozen(tmp_path / "frozen")


def _items(rng: random.Random, n: int) -> list[dict]:
    return [{"n": i, "kind": rng.choice(["medicine", "advice", "investigation"]), "text": f"x{rng.randrange(10**6)}"} for i in range(1, n + 1)]


def _consult(seed: int) -> dict:
    rng = random.Random(seed)
    items = _items(rng, rng.randint(1, 5))
    return {"uid": f"synth-{seed}", "note": f"note {rng.randrange(10**9)} " * rng.randint(1, 4), "transcript": f"T1 line {rng.randrange(10**9)}\nT2 more",
            "items": items, "signed": _items(rng, rng.randint(1, 4)), "review": [{"kind": "k", "prompt": f"p{rng.randrange(99)}", "detail": "d"} for _ in range(rng.randint(0, 3))]}


def _floor_pair(mod_floors, client, frozen, c, cache, kind):
    a = mod_floors.judge_items(client, frozen, c["items"], c["transcript"], cache, c["uid"], kind)
    b = mod_floors.completion_counts(client, frozen, c["signed"], c["items"], c["review"], c["transcript"], cache, c["uid"], kind)
    return a, b


def _shared_cell(jmod, fmod, fdir, tmp_path):
    """Two arms, identical input. Returns (calls on second arm, judge rows equal minus cached, floor rows equal)."""
    frozen = jmod.load_frozen(fdir)
    c = _consult(1)
    cj, cf = tmp_path / "pdqi9", tmp_path / "floors"
    fc1, fc2 = Rec(responder), Rec(responder)
    kw = dict(uid=c["uid"], judge="opus", ref="transcript", note=c["note"], transcript=c["transcript"], cache_dir=cj, render_version="rv")
    r1 = jmod.score_note(fc1, frozen, arm="A", **kw)
    r2 = jmod.score_note(fc2, frozen, arm="Bn", **kw)
    f1 = _floor_pair(fmod, fc1, frozen, c, cf, "Bn")
    f2 = _floor_pair(fmod, fc2, frozen, c, cf, "B0")
    strip = lambda r: {k: v for k, v in r.items() if k != "cached"}
    return len(fc2.full), strip(r1) == strip(r2) and r2["cached"], f1 == f2, len(fc1.full)


def _mutants():
    j = _load("judge_mut", (SRC / "judge.py").read_text(encoding="utf-8").replace("key = (uid, judge,", "key = (uid, arm, judge,"))
    fsrc = (SRC / "floors.py").read_text(encoding="utf-8")
    assert "hashlib.sha256(user.encode()).hexdigest())" in fsrc
    f = _load("floors_mut", fsrc.replace("hashlib.sha256(user.encode()).hexdigest())", "hashlib.sha256(user.encode()).hexdigest(), arm)").replace("from .judge import", "from .judge_mut import"))
    return j, f


# ---- P1 shared cell --------------------------------------------------------------------------------------------

def test_p1_second_arm_makes_no_calls_and_rows_match(fdir, tmp_path):
    second_calls, judge_same, floor_same, first_calls = _shared_cell(judge, floors, fdir, tmp_path)
    assert first_calls > 0 and second_calls == 0 and judge_same and floor_same


def test_p1_shared_pdqi_prompt_is_one_prompt(fdir, tmp_path):
    frozen = judge.load_frozen(fdir)
    fc = Rec(responder)
    for arm in ("A", "B0", "Bn"):
        judge.score_note(fc, frozen, uid="u", arm=arm, judge="sonnet", ref="none", note="same", transcript="", cache_dir=tmp_path / "c", render_version="rv")
    assert len(fc.full) == 1 and judge.note_id("u", "same") in fc.full[0][5]


# ---- P2 distinct cells -----------------------------------------------------------------------------------------

def test_p2_different_input_makes_separate_calls_and_files(fdir, tmp_path):
    frozen = judge.load_frozen(fdir)
    fc = Rec(responder)
    kw = dict(uid="u", judge="opus", ref="transcript", transcript="T1 a", cache_dir=tmp_path / "pdqi9", render_version="rv")
    judge.score_note(fc, frozen, arm="A", note="n1", **kw)
    judge.score_note(fc, frozen, arm="Bn", note="n2", **kw)
    judge.score_note(fc, frozen, arm="Bn", note="n1", **{**kw, "transcript": "T1 b"})
    assert len(fc.full) == 3 and len(list((tmp_path / "pdqi9").glob("*.json"))) == 3
    assert len({judge.note_id("u", n) for n in ("n1", "n2", "n3")}) == 3
    c1, c2 = _consult(2), _consult(3)
    c2 = {**c2, "uid": c1["uid"]}
    for c, k in ((c1, "Bn"), (c2, "B0")):
        _floor_pair(floors, fc, frozen, c, tmp_path / "floors", k)
    assert len(list((tmp_path / "floors").glob("*.json"))) >= 2
    n_before = len(fc.full)
    _floor_pair(floors, fc, frozen, c2, tmp_path / "floors", "Bn")  # c2 judged under the other arm label: all cached
    assert len(fc.full) == n_before


# ---- P3 single arm unchanged vs main 59739ddb ------------------------------------------------------------------

def test_p3_single_arm_call_sequence_identical_to_base(base_mods, fdir, tmp_path):
    bj, bf = base_mods
    frozen_new, frozen_old = judge.load_frozen(fdir), bj.load_frozen(fdir)
    new, old = Rec(responder), Rec(responder)
    n_consults = 200
    for s in range(n_consults):
        c = _consult(1000 + s)
        arm = random.Random(s).choice(["A", "B0", "Bn"])
        for j, r in ((j, r) for j in judge.JUDGES for r in judge.REFS):
            kw = dict(uid=c["uid"], judge=j, ref=r, note=c["note"], transcript=c["transcript"], render_version="rv")
            a = judge.score_note(new, frozen_new, arm=arm, cache_dir=tmp_path / "n" / "p", **kw)
            b = bj.score_note(old, frozen_old, arm=arm, cache_dir=tmp_path / "o" / "p", **kw)
            assert a["scores"] == b["scores"] and a["parse_failure"] == b["parse_failure"]
        fk = "Bn" if arm != "B0" else "B0"
        assert _floor_pair(floors, new, frozen_new, c, tmp_path / "n" / "f", fk) == _floor_pair(bf, old, frozen_old, c, tmp_path / "o" / "f", fk)
    assert len(new.full) == len(old.full) > 4 * n_consults
    swapped = 0
    for x, y in zip(new.full, old.full):
        assert x[:5] == y[:5]  # alias, tag, system, max_tokens, temperature, in order
        if x[5] != y[5]:
            assert x[1].startswith("pdqi9-v3")  # only a PDQI prompt may differ, and only at the NOTE_ID
            head, tail = x[5].split("Note ", 1)[0], x[5].split(":\n", 1)[1]
            assert head == y[5].split("Note ", 1)[0] and tail == y[5].split(":\n", 1)[1]
            swapped += 1
    assert swapped > 0


# ---- P4 no arm in a key ----------------------------------------------------------------------------------------

def test_p4_cache_files_for_two_arms_have_the_same_names(fdir, tmp_path):
    frozen = judge.load_frozen(fdir)
    names = {}
    for arm in ("A", "Bn", "B0", "anything-else"):
        d = tmp_path / arm
        judge.score_note(Rec(responder), frozen, uid="u", arm=arm, judge="opus", ref="transcript", note="n", transcript="t", cache_dir=d / "pdqi9", render_version="rv")
        _floor_pair(floors, Rec(responder), frozen, _consult(5), d / "floors", arm)
        names[arm] = sorted(p.relative_to(d).as_posix() for p in d.rglob("*.json"))
    assert len({tuple(v) for v in names.values()}) == 1 and len(names["A"]) == 3


def test_p4_no_arm_label_in_any_key_source():
    jsrc, fsrc = (SRC / "judge.py").read_text(encoding="utf-8"), (SRC / "floors.py").read_text(encoding="utf-8")
    assert "key = (uid, judge," in jsrc and "cache_extra" not in fsrc and "cache_path(cache_dir, name, uid, frozen.prompt_sha(name), hashlib.sha256(user.encode()).hexdigest())" in fsrc


# ---- J2 note id ------------------------------------------------------------------------------------------------

def test_j2_note_id_follows_uid_and_note_only():
    rng = random.Random(7)
    notes = [f"note {rng.randrange(10**12)}" for _ in range(300)]
    ids = {judge.note_id("u", n) for n in notes}
    assert len(ids) == len(set(notes))
    assert judge.note_id("u", "n") == judge.note_id("u", "n") != judge.note_id("v", "n")
    assert judge.note_id("u", "n", seed=1) != judge.note_id("u", "n")
    for arm in ("A", "B0", "Bn"):
        assert arm not in judge.note_id("u", "n")  # a hex id; and no arm argument exists
    with pytest.raises(TypeError):
        judge.note_id("u", "n", "Bn", 1)


# ---- P5 non-vacuity --------------------------------------------------------------------------------------------

def test_p5_scenarios_pass_on_the_code_and_fail_when_arm_is_put_back(fdir, tmp_path):
    good = _shared_cell(judge, floors, fdir, tmp_path / "good")
    assert good[0] == 0 and good[1] and good[2]
    mj, mf = _mutants()
    # arm back in the pdqi key only: P1's second-arm calls come from the pdqi cell (2 floor cells stay shared)
    bad_j = _shared_cell(mj, floors, fdir, tmp_path / "bad_j")
    assert bad_j[0] > 0
    # arm back in the floor key only
    bad_f = _shared_cell(judge, mf, fdir, tmp_path / "bad_f")
    assert bad_f[0] > 0
    # P4: mutated keys give different file names per arm
    fz = mj.load_frozen(fdir)
    seen = set()
    for arm in ("A", "Bn"):
        d = tmp_path / "m" / arm
        mj.score_note(Rec(responder), fz, uid="u", arm=arm, judge="opus", ref="transcript", note="n", transcript="t", cache_dir=d, render_version="rv")
        seen.add(tuple(sorted(p.name for p in d.glob("*.json"))))
    assert len(seen) == 2
    seen = set()
    for arm in ("A", "Bn"):
        d = tmp_path / "mf" / arm
        _floor_pair(mf, Rec(responder), fz, _consult(5), d, arm)
        seen.add(tuple(sorted(p.name for p in d.glob("*.json"))))
    assert len(seen) == 2


# ---- J3 scores.json note_id matches the prompt ----------------------------------------------------------------

def test_scores_json_note_id_is_the_id_in_that_cells_prompt(tmp_path, monkeypatch):
    from test_pdqi9_harness import RX, UIDS, _argv, _write_inputs
    from tools.eta2freescript.eval.pdqi9 import render, run
    monkeypatch.delenv("JEV_MCP_CMD", raising=False)
    fd = make_frozen(tmp_path / "frozen")
    arts, arms = _write_inputs(tmp_path, UIDS[:2])
    fc = Rec(responder)
    assert run.main(_argv(tmp_path, arms, arts, fd, tmp_path / "out"), client=fc) == 0
    rows = json.loads((tmp_path / "out" / "scores.json").read_text())
    prompts = {u: [c[5] for c in fc.full if c[1].startswith("pdqi9-v3") and c[1].endswith(":" + u)] for u in UIDS[:2]}
    assert rows and {r["arm"] for r in rows} == {"A", "B0", "Bn"}
    for r in rows:
        assert any(f"Note {r['note_id']}:" in p for p in prompts[r["uid"]]), r["arm"]
    by = {(r["uid"], r["arm"]): r["note_id"] for r in rows}
    u = UIDS[0]
    assert by[(u, "A")] == by[(u, "Bn")] == judge.note_id(u, render.render(RX)) != by[(u, "B0")]
