"""14 Oct 2026 ruling: tolerant single-object extraction, shape logging without text, failures not cached. Synthetic only."""
from __future__ import annotations

import json

import pytest
from test_pdqi9_harness import GOOD, _lockbox_rule, item, make_frozen  # noqa: F401  (autouse lockbox rule fixture)

from tools.eta2freescript.eval.pdqi9 import floors, judge, render, scoreboard
from tools.eta2freescript.models import FakeClient, UsageLedger

MARK = "ZZREPLYMARKERZZ"
G = json.dumps(GOOD)


@pytest.fixture
def frozen(tmp_path):
    from test_pdqi9_harness import make_frozen as mk
    return judge.load_frozen(mk(tmp_path / "frozen"))


def kw(tmp_path, **extra):
    return dict(uid="u", arm="A", judge="opus", ref="none", note="n", transcript="t", cache_dir=tmp_path / "c", render_version="render-v2", **extra)


def test_prose_wrapped_single_object_is_tolerated():
    r, info, _ = judge.parse_scores_ex(f"Here are my scores: {G} Hope that helps!")
    assert r is not None and info["tolerated"] and info["n_spans"] == 1 and info["leading_chars"] > 0 and info["trailing_chars"] > 0


def test_clean_object_is_not_marked_tolerated():
    r, info, _ = judge.parse_scores_ex(G)
    assert r is not None and not info["tolerated"]


def test_two_objects_fail():
    r, info, _ = judge.parse_scores_ex(f"{G} and then {G}")
    assert r is None and info["n_spans"] == 2


def test_extra_key_fails_and_is_named():
    r, _, diff = judge.parse_scores_ex("Result: " + json.dumps({**GOOD, "bonus": 3}))
    assert r is None and diff == ["bonus"]


@pytest.mark.parametrize("v", [0, 6, 3.0, True, "3"])
def test_out_of_range_or_wrong_type_fails_even_when_wrapped(v):
    assert judge.parse_scores_ex("Scores: " + json.dumps({**GOOD, "useful": v}) + " ok")[0] is None


def test_fence_plus_trailing_sentence_is_tolerated():
    r, info, _ = judge.parse_scores_ex("```json\n" + G + "\n```\nLet me know if you want more detail.")
    assert r is not None and info["tolerated"] and info["fenced"]


def test_brace_inside_a_string_is_handled():
    d = {"items": [item(1, turns=["T1 } {"])]}
    text = "Sure: " + json.dumps(d) + " done"
    got, info = floors._exact_json(text)
    assert got == d and info["tolerated"] and info["n_spans"] == 1
    esc = 'x {"a": "q\\" } z", "b": 1} y'
    got, info = floors._exact_json(esc)
    assert got == {"a": 'q" } z', "b": 1}


def test_unbalanced_stray_brace_does_not_swallow_the_object():
    got, info = floors._exact_json("see { here: " + json.dumps({"k": 1}))
    assert got == {"k": 1}


def test_prose_braces_make_two_spans_and_fail():
    assert judge.parse_scores_ex("note {sic} " + G)[0] is None


def test_parse_failure_is_not_cached_and_rerun_retries(frozen, tmp_path):
    fc = FakeClient(lambda *a: "garbage")
    r = judge.score_note(fc, frozen, **kw(tmp_path))
    assert r["parse_failure"] and len(fc.calls) == 2
    fc2 = FakeClient(lambda *a: "Scores " + G)
    r2 = judge.score_note(fc2, frozen, **kw(tmp_path))
    assert r2["scores"] == [3] * 9 and r2["tolerated"] and not r2["cached"] and len(fc2.calls) == 1
    assert judge.score_note(fc2, frozen, **kw(tmp_path))["cached"] and len(fc2.calls) == 1


def test_floor_failure_is_not_cached_and_rerun_retries(frozen, tmp_path):
    items = floors.numbered_items({"diagnoses": [{"name": "a"}]})
    fc = FakeClient(lambda *a: "garbage")
    assert floors.judge_items(fc, frozen, items, "t", tmp_path, "u", "Bn")["parse_failure"] and len(fc.calls) == 2
    fc2 = FakeClient(lambda *a: "Here: " + json.dumps({"items": [item(1)]}))
    r = floors.judge_items(fc2, frozen, items, "t", tmp_path, "u", "Bn")
    assert not r["parse_failure"] and r["tolerated"] and len(fc2.calls) == 1


def test_shape_lines_contain_no_reply_text(frozen, tmp_path):
    log = tmp_path / "out" / "judge-shapes.jsonl"
    fc = FakeClient(lambda *a: f"{MARK} {G} {MARK}")
    fc.ledger = UsageLedger(tmp_path / "usage.jsonl")
    fc.ledger.record("opus", "pdqi9-v3:opus-none:u", 1.0, 10, 77, "end_turn")
    judge.score_note(fc, frozen, **kw(tmp_path, shape_log=log))
    bad = FakeClient(lambda *a: f"{MARK} " + json.dumps({**GOOD, "extra_x": 1}))
    judge.score_note(bad, frozen, **{**kw(tmp_path, shape_log=log), "uid": "v"})
    items = floors.numbered_items({"diagnoses": [{"name": "a"}]})
    floors.judge_items(FakeClient(lambda *a: f"{MARK} " + json.dumps({"items": [item(1)]})), frozen, items, "t", tmp_path / "f", "u", "Bn", log)
    text = log.read_text()
    assert MARK not in text and "uid\": \"u\"" not in text
    lines = [json.loads(x) for x in text.splitlines()]
    assert len(lines) == 4  # 1 ok + 2 attempts on the extra-key reply + 1 floor
    keys = {"prompt", "judge", "ref", "arm", "uid_hash", "out_tokens", "stop_reason", "leading_chars", "trailing_chars", "fenced", "n_spans",
            "tolerated", "parse_ok", "key_diff"}
    assert all(set(x) == keys and len(x["uid_hash"]) == 12 for x in lines)
    assert lines[0]["out_tokens"] == 77 and lines[0]["stop_reason"] == "end_turn" and lines[0]["tolerated"] and lines[0]["parse_ok"]
    assert lines[1]["key_diff"] == ["extra_x"] and not lines[1]["parse_ok"]
    assert lines[3]["prompt"] == "floor-items-v1" and lines[3]["arm"] == "Bn" and lines[3]["parse_ok"]


def test_scoreboard_row_has_the_new_counts(tmp_path, monkeypatch):
    from test_pdqi9_harness import UIDS, _argv, _write_inputs, responder
    from tools.eta2freescript.eval.pdqi9 import run
    monkeypatch.delenv("JEV_MCP_CMD", raising=False)
    fdir = make_frozen(tmp_path / "frozen")
    arts, arms = _write_inputs(tmp_path, UIDS[:1])

    def wrapped(tag, prompt, system):
        out = responder(tag, prompt, system)
        if tag.startswith("pdqi9-v3:opus-none"):
            return "Here you go: " + out + " Thanks."
        if tag.startswith("pdqi9-v3:sonnet-none"):
            return "no json at all"
        if tag.startswith("floor-missing"):
            return "no json at all"
        return out

    assert run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out"), client=FakeClient(wrapped)) == 0
    row = json.loads((tmp_path / "SCOREBOARD.R1.json").read_text())
    assert row["tolerated_cells"] == 3 and row["parse_fail_cells"] == 3 and row["parse_failures"] == 3
    assert row["floor_rows_unparsed"] == 2 and row["floor_rows_tolerated"] == 0
    md = (tmp_path / "SCOREBOARD.md").read_text().splitlines()
    head = [c.strip() for c in md[0].split("|")]
    assert {"tolerated_cells", "parse_fail_cells", "floor_rows_unparsed"} <= set(head)
    assert len(md[0].split("|")) == len(md[2].split("|"))
    assert (tmp_path / "out" / "judge-shapes.jsonl").exists()
    assert "Here you go" not in (tmp_path / "out" / "judge-shapes.jsonl").read_text()
