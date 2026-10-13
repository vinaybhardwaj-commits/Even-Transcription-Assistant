"""B4b scoring harness. Synthetic only: fake Bedrock client, fake Jev, obviously fake frozen prompt files."""
from __future__ import annotations

import copy
import json
import os
import re
import sys
from pathlib import Path

import pytest
from conftest import CONSULTS, build_artifact, stage_a

from tools.eta2freescript import validate
from tools.eta2freescript.eval.pdqi9 import floors, jev_lines, judge, render, run, scoreboard, splits, stats
from tools.eta2freescript.ingest import format_transcript, load_consult
from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.validate import frx_n, printable_errors

MARK = "ZZFAKEPROMPTZZ"
FAKE_FILES = {
    "pdqi9-judge-v3.system.txt": MARK + " judge system. {{REFERENCE_RULE}}",
    "pdqi9-ref-transcript-v3.txt": MARK + " rule with transcript",
    "pdqi9-ref-none-v3.txt": MARK + " rule without transcript",
    "pdqi9-user-v3.txt": MARK + " user\n{{TRANSCRIPT_BLOCK}}\nNote {{NOTE_ID}}:\n{{NOTE}}",
    "floor-items-v1.system.txt": MARK + " floor items system",
    "floor-missing-v1.system.txt": MARK + " floor missing system",
}
UIDS = ["synth-fever-dose", "synth-cough-native", "synth-boundary-knee"]
RX = {"medicines": [{"name": "Paracetamol", "strength": "1 g", "frequency": "three times a day", "duration": "three days"}],
      "diagnoses": [{"name": "Viral fever"}, {"name": "dengue", "is_differential": True}], "comorbidities": [{"name": "HYPERTENSION", "duration": "2 years"}],
      "symptoms": "Fever and body pain", "examination": "Temperature 101 F", "management_plan": "Rest",
      "investigations": [{"name": "CBC", "urgent": True}], "referrals": [], "general_advice": ["Drink water"],
      "follow_up": {"type": "visit", "instructions": "after one week"}, "surgeries": []}


def make_frozen(root: Path, tuning=("synth-fever-dose", "synth-cough-native"), lockbox=("synth-boundary-knee",)) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    root.chmod(0o700)
    for n, t in FAKE_FILES.items():
        (root / n).write_text(t, encoding="utf-8")
        (root / n).chmod(0o600)
    (root / "split-v1.json").write_text(json.dumps({"tuning": list(tuning), "lockbox": list(lockbox)}), encoding="utf-8")
    (root / "split-v1.json").chmod(0o600)
    return root


def item(n, **kw):
    return {"n": n, "said": "yes", "leak": False, "invented": [], "dose_precedence_error": False, "turns": ["T1"], **kw}


def responder(tag: str, prompt: str, system: str) -> str:
    if tag.startswith("pdqi9-v3"):
        return json.dumps(dict(zip(judge.ITEM_KEYS, [3, 4, 4, 3, 5, 4, 3, 4, 4])))
    if tag.startswith("floor-items-v1"):
        n = len(re.findall(r"^\d+\. \[", prompt.split("ITEMS:")[1], re.M))
        return json.dumps({"items": [item(i) for i in range(1, n + 1)]})
    if tag.startswith("floor-missing-v1"):
        n = len(re.findall(r"^\d+\. \[", prompt.split("SIGNED:")[1].split("DRAFT:")[0], re.M))
        return json.dumps({"signed": [{"n": i, "in_draft": True, "covered_by": None} for i in range(1, n + 1)]})
    raise KeyError(tag)


@pytest.fixture
def frozen(tmp_path):
    return judge.load_frozen(make_frozen(tmp_path / "frozen"))


@pytest.fixture
def fever():
    c = load_consult(CONSULTS, "synth-fever-dose")
    art = build_artifact(c, stage_a("synth-fever-dose"))
    return c, art


# ---- render -----------------------------------------------------------------------------------------------------

def test_render_is_deterministic_and_has_the_twelve_headings_in_order():
    a, b = render.render(copy.deepcopy(RX)), render.render(copy.deepcopy(RX))
    assert a == b and render.RENDER_VERSION == "render-v2"
    heads = [ln[:-1] for ln in a.split("\n") if ln.endswith(":") and not ln.startswith(" ")]
    assert heads == list(render.HEADINGS) and len(heads) == 12


def test_same_template_for_every_arm_and_neutral_text():
    other = {"medicines": [{"name": "Zinc"}]}
    h = lambda t: [ln for ln in t.split("\n") if ln.endswith(":") and not ln.startswith(" ")]
    assert h(render.render(RX)) == h(render.render(other)) == h(render.render({}))
    txt = render.render(other)
    assert "Strength: not specified" in txt and "Frequency: not specified" in txt and "Duration: not specified" in txt and "Instructions: not specified" in txt
    assert not re.search(r"\[|\]|\{\{|ETA|Pulse|doctor|signed", txt, re.I)


def test_sentence_case_of_mostly_uppercase_strings_only():
    txt = render.render({"comorbidities": [{"name": "HYPERTENSION AND DIABETES. ON DRUGS"}], "investigations": [{"name": "ECG"}, {"name": "Ultrasound abdomen"}]})
    assert "Hypertension and diabetes. On drugs" in txt and "ECG" in txt and "Ultrasound abdomen" in txt


def test_input_is_schema_validated():
    with pytest.raises(render.PrescriptionError):
        render.render({"medicines": [{"strength": "1 g"}]})
    with pytest.raises(render.PrescriptionError):
        render.render({"medicines": "paracetamol"})


# ---- judge: blinding, shuffling, parsing, cache, frozen dir ---------------------------------------------------------

def test_note_id_is_the_specified_hash():
    import hashlib
    assert judge.note_id("u1", "Bn") == hashlib.sha256(b"20261012u1Bn").hexdigest()[:10]


def test_shuffling_is_reproducible_and_seed_dependent():
    a = judge.plan_calls(["u2", "u1", "u3"], ["A", "B0", "Bn"])
    assert a == judge.plan_calls(["u3", "u1", "u2"], ["A", "B0", "Bn"])
    assert a != judge.plan_calls(["u2", "u1", "u3"], ["A", "B0", "Bn"], seed=1)
    assert len(a) == 3 * 3 * 4 and len(set(a)) == len(a)
    assert a != sorted(a)


def test_no_arm_name_reaches_any_judge_input(frozen, tmp_path, fever):
    c, _ = fever
    fc = FakeClient(responder)
    tr = format_transcript(c)
    for arm in ("A", "B0", "Bn"):
        for ref in judge.REFS:
            judge.score_note(fc, frozen, uid="synth-fever-dose", arm=arm, judge="opus", ref=ref, note=render.render(RX), transcript=tr,
                             cache_dir=tmp_path / "c", render_version=render.RENDER_VERSION)
    assert len(fc.calls) == 6
    for call in fc.calls:
        blob = call["prompt"] + call["system"]
        assert not re.search(r"\bB0\b|\bBn\b|\bA\b arm|arm [AB]", blob)
        assert any(judge.note_id("synth-fever-dose", arm) in call["prompt"] for arm in ("A", "B0", "Bn"))
    assert "{{" not in fc.calls[0]["prompt"] + fc.calls[0]["system"]
    assert "rule with transcript" in "".join(x["system"] for x in fc.calls) and tr in fc.calls[0]["prompt"] + fc.calls[1]["prompt"]


GOOD = {k: 3 for k in judge.ITEM_KEYS}


@pytest.mark.parametrize("text,ok", [
    (json.dumps(GOOD), True), ("```json\n" + json.dumps(GOOD) + "\n```", True),
    (json.dumps({**GOOD, "accurate": 1, "up_to_date": 5}), True),
    ("[1,2,3,4,5,1,2,3,4]", False), (json.dumps({"scores": GOOD}), False), (json.dumps({k: 3 for k in list(GOOD)[:8]}), False),
    (json.dumps({**GOOD, "extra": 3}), False), (json.dumps({**{k: 3 for k in list(GOOD)[:8]}, "bogus": 3}), False),
    (json.dumps({**GOOD, "useful": 6}), False), (json.dumps({**GOOD, "useful": 0}), False), (json.dumps({**GOOD, "useful": 3.0}), False),
    (json.dumps({**GOOD, "useful": True}), False), (json.dumps({**GOOD, "useful": "3"}), False), ("Scores: " + json.dumps(GOOD), False), ("not json", False)])
def test_parse_is_strict(text, ok):
    assert (judge.parse_scores(text) is not None) is ok


def test_one_retry_then_parse_failure_and_failures_are_cached_per_key(frozen, tmp_path):
    fc = FakeClient(lambda *a: "garbage")
    kw = dict(uid="u", arm="A", judge="opus", ref="none", note="n", transcript="t", cache_dir=tmp_path, render_version="render-v2")
    r = judge.score_note(fc, frozen, **kw)
    assert r["parse_failure"] and r["scores"] is None and len(fc.calls) == 2
    judge.score_note(fc, frozen, **kw)
    assert len(fc.calls) == 2  # cached
    replies = iter(["garbage", json.dumps(GOOD)])
    fc2 = FakeClient(lambda *a: next(replies))
    r2 = judge.score_note(fc2, frozen, **{**kw, "uid": "v"})
    assert r2["scores"] == [3] * 9 and r2["attempts"] == 2 and len(fc2.calls) == 2


def test_cache_key_changes_with_note_judge_ref(frozen, tmp_path):
    fc = FakeClient(responder)
    kw = dict(uid="u", arm="A", judge="opus", ref="none", note="n", transcript="t", cache_dir=tmp_path, render_version="render-v2")
    judge.score_note(fc, frozen, **kw)
    judge.score_note(fc, frozen, **kw)
    assert len(fc.calls) == 1
    judge.score_note(fc, frozen, **{**kw, "note": "n2"})
    judge.score_note(fc, frozen, **{**kw, "judge": "sonnet"})
    judge.score_note(fc, frozen, **{**kw, "ref": "transcript"})
    assert len(fc.calls) == 4


def test_frozen_dir_permissions_refused_and_hashes_recorded(tmp_path):
    import hashlib
    root = make_frozen(tmp_path / "f")
    fz = judge.load_frozen(root)
    for n in judge.FROZEN_FILES:
        assert fz.hashes[n] == hashlib.sha256((root / n).read_bytes()).hexdigest()
    (root / "pdqi9-user-v3.txt").chmod(0o640)
    with pytest.raises(judge.FrozenError, match="pdqi9-user"):
        judge.load_frozen(root)
    (root / "pdqi9-user-v3.txt").chmod(0o600)
    root.chmod(0o750)
    with pytest.raises(judge.FrozenError):
        judge.load_frozen(root)
    root.chmod(0o700)
    (root / "split-v1.json").unlink()
    with pytest.raises(judge.FrozenError, match="missing"):
        judge.load_frozen(root)


# ---- splits and lockbox -----------------------------------------------------------------------------------------

def test_overlapping_splits_refused():
    with pytest.raises(splits.SplitError):
        splits.Splits(["a", "b"], ["b"])


def test_lockbox_refusal_and_once_per_candidate(tmp_path, monkeypatch):
    sp = splits.Splits(["t1", "t2"], ["l1", "l2"])
    led = tmp_path / "ledger" / "lockbox.jsonl"
    monkeypatch.setenv(splits.LEDGER_ENV, str(led))
    assert splits.gate(sp, ["t1", "t2"], False, None) == "tuning"
    with pytest.raises(splits.SplitError, match="lockbox"):
        splits.gate(sp, ["t1", "l1"], False, None)
    with pytest.raises(splits.SplitError):
        splits.gate(sp, ["l1"], False, "c1")
    with pytest.raises(splits.SplitError, match="candidate"):
        splits.gate(sp, ["l1"], True, None)
    with pytest.raises(splits.SplitError, match="tuning uids"):
        splits.gate(sp, ["l1", "t1"], True, "c1")
    with pytest.raises(splits.SplitError, match="neither"):
        splits.gate(sp, ["zz"], False, None)
    assert not led.exists()
    assert splits.gate(sp, ["l1", "l2"], True, "c1") == "lockbox"
    assert oct(led.stat().st_mode & 0o777) == "0o600"
    with pytest.raises(splits.SplitError, match="second run"):
        splits.gate(sp, ["l1"], True, "c1")
    assert splits.gate(sp, ["l1"], True, "c2") == "lockbox"
    lines = led.read_text().splitlines()
    assert [json.loads(x)["candidate"] for x in lines] == ["c1", "c2"]


def test_lockbox_needs_the_ledger_env_and_tuning_runs_do_not(tmp_path, monkeypatch):
    sp = splits.Splits(["t1"], ["l1"])
    monkeypatch.delenv(splits.LEDGER_ENV, raising=False)
    with pytest.raises(splits.SplitError, match=splits.LEDGER_ENV):
        splits.gate(sp, ["l1"], True, "c1")
    assert splits.gate(sp, ["t1"], False, None) == "tuning"
    assert not list(tmp_path.iterdir())


# ---- floors -----------------------------------------------------------------------------------------------------

def items_reply(rows):
    return lambda tag, p, s: json.dumps({"items": rows(p)}) if tag.startswith("floor-items") else responder(tag, p, s)


def test_judge_floor_counts_a_breaking_case_and_a_passing_case(frozen, tmp_path):
    items = floors.numbered_items({"medicines": [{"name": "Paracetamol", "strength": "1 g"}, {"name": "Zorbex"}, {"name": "Cetrizine"}],
                                   "diagnoses": [{"name": "Viral fever"}, {"name": "Cough"}]})
    assert [i["kind"] for i in items] == ["medicine"] * 3 + ["diagnosis"] * 2
    bad = [item(1, invented=["frequency", "duration"], dose_precedence_error=True), item(2, said="no", leak=True), item(3, said="unclear"),
           item(4, said="no"), item(5, said="unclear")]
    r = floors.judge_items(FakeClient(lambda *a: json.dumps({"items": bad})), frozen, items, "T0 hi", tmp_path / "a", "u", "Bn")
    assert r == {"unsupported_drugs": 1, "leak_items": 1, "invented_fields": 1, "dose_precedence_errors": 1, "hallucinations": 2,
                 "unclear_items": 2, "parse_failure": False}
    good = [item(i) for i in range(1, 6)]
    r = floors.judge_items(FakeClient(lambda *a: json.dumps({"items": good})), frozen, items, "T0 hi", tmp_path / "b", "u", "Bn")
    assert {k: v for k, v in r.items() if k != "parse_failure"} == dict.fromkeys(floors._ZERO, 0)
    fc = FakeClient(lambda *a: json.dumps({"items": good}))
    floors.judge_items(fc, frozen, items, "T0 hi", tmp_path / "c", "u", "Bn")
    assert "ITEMS:\n1. [medicine] Paracetamol" in fc.calls[0]["prompt"] and fc.calls[0]["prompt"].startswith("TRANSCRIPT:\nT0 hi")


@pytest.mark.parametrize("mut", [
    lambda x: x.update(said="partial"), lambda x: x.update(invented=["dose"]), lambda x: x.update(invented="strength"), lambda x: x.update(leak="no"),
    lambda x: x.update(dose_precedence_error=None), lambda x: x.update(turns="T1"), lambda x: x.update(turns=[1]), lambda x: x.update(n=True),
    lambda x: x.pop("turns"), lambda x: x.pop("leak")])
def test_floor_items_reply_is_parsed_exactly(frozen, tmp_path, mut):
    items = floors.numbered_items({"diagnoses": [{"name": "a"}]})
    row = item(1)
    mut(row)
    fc = FakeClient(lambda *a: json.dumps({"items": [row]}))
    r = floors.judge_items(fc, frozen, items, "t", tmp_path, "u", "Bn")
    assert r["parse_failure"] and r["hallucinations"] is None and len(fc.calls) == 2
    fc = FakeClient(lambda *a: json.dumps({"items": [item(1)], "extra": 1}))
    assert floors.judge_items(fc, frozen, items, "t", tmp_path / "x", "u", "Bn")["parse_failure"]
    fc = FakeClient(lambda *a: json.dumps({"items": [item(1), item(2)]}))
    assert floors.judge_items(fc, frozen, items, "t", tmp_path / "y", "u", "Bn")["parse_failure"]
    t = floors.aggregate([{**floors_row(), "hallucinations": None, "unsupported_drugs": None}])
    assert not next(x for x in t["rows"] if x["floor"] == "unsupported drugs")["pass"]


def floors_row(**kw):
    base = {"uid": "u", "arm": "Bn", "unsupported_drugs": 0, "leak_items": 0, "invented_fields": 0, "dose_precedence_errors": 0, "hallucinations": 0,
            "invented_numbers": 0, "dose_precedence_det": 0, "printable_errors": 0, "unknown_key_errors": 0, "validator_failures": 0, "artifact_missing": False,
            "unclear_items": 0, "completion": {"missing": 2, "covered": 2, "parse_failure": False}}
    return {**base, **kw}


def test_invented_numbers_breaking_and_passing(fever):
    c, art = fever
    ok = {"medicines": [{"name": "Paracetamol", "strength": "1 g", "frequency": "three times a day"}]}
    assert floors.invented_numbers(ok, art, c)["count"] == 0
    assert floors.invented_numbers({"medicines": [{"name": "Paracetamol", "strength": "5 g"}]}, art, c) == {"offending_runs": 1, "unmatched_medicines": 0, "count": 1}
    assert floors.invented_numbers({"medicines": [{"name": "Zorbex", "strength": "10 mg"}]}, art, c)["unmatched_medicines"] == 1
    assert floors.invented_numbers({"medicines": [{"name": "Paracetamol", "strength": "1 g"}]}, None, c)["unmatched_medicines"] == 1
    assert floors.invented_numbers({"medicines": [{"name": "Dolo", "frequency": "twice a day"}]}, art, c)["count"] == 0  # brand match, no digits


def test_dose_precedence_breaking_and_passing(fever):
    _, art = fever
    assert any("doctor_dose_precedence" in p["flags"] for p in art["provenance"])
    assert floors.dose_precedence({"medicines": [{"name": "Paracetamol", "strength": "1 g"}]}, art) == 0
    assert floors.dose_precedence({"medicines": [{"name": "Paracetamol", "strength": "1000 mg"}]}, art) == 1
    assert floors.dose_precedence({"medicines": [{"name": "Paracetamol", "strength": "650 mg"}]}, art) == 1
    assert floors.dose_precedence({"medicines": [{"name": "Paracetamol"}]}, art) == 1
    assert floors.dose_precedence({"medicines": []}, art) == 1


def test_printable_floor_counts_note_text_and_replayed_fields(fever):
    _, art = fever
    assert floors.printable_count(RX, art) == 0
    assert floors.printable_count({"general_advice": ["[doctor to verify] dose"]}, art) >= 2
    bad = {**art, "note_text": art["note_text"] + "\nPlan of Management: tbd {{x}}"}
    assert floors.printable_count({}, bad) >= 2


def test_validator_floor(fever):
    _, art = fever
    assert floors.validator_failures(None) == 1
    assert floors.validator_failures({**art, "note_text": "[x] broken"}) == 1
    assert floors.validator_failures({"schema_version": "nope"}) == 1
    assert floors.validator_failures(art) == (1 if validate.check(art) else 0)


def test_completion_recall_counts_and_review_numbering(frozen, tmp_path):
    signed = floors.numbered_items({"diagnoses": [{"name": "a"}, {"name": "b"}, {"name": "c"}]})
    rows = lambda *r: lambda *a: json.dumps({"signed": [{"n": n, "in_draft": d, "covered_by": c} for n, d, c in r]})
    review = [{"kind": "pick_drug", "prompt": "p", "detail": "dd"}, {"kind": "exam_missing", "prompt": "q"}]
    fc = FakeClient(rows((1, True, None), (2, False, 2), (3, False, None)))
    r = floors.completion_counts(fc, frozen, signed, signed[:1], review, "t", tmp_path, "u", "Bn")
    assert r == {"missing": 2, "covered": 1, "parse_failure": False}
    u = fc.calls[0]["prompt"]
    assert "SIGNED:\n1. [diagnosis] a" in u and "DRAFT:\n1. [diagnosis] a" in u and "REVIEW:\n1. [pick_drug] p | detail: dd\n2. [exam_missing] q" in u
    for i, bad in enumerate([rows((1, True, None), (2, False, 3), (3, False, None)), rows((1, True, None), (2, False, True), (3, False, None)),
                             rows((1, True, None), (2, False, 0), (3, False, None)), rows((1, True, None), (2, False, None)),
                             lambda *a: json.dumps({"items": []})]):
        out = floors.completion_counts(FakeClient(bad), frozen, signed, [], review, "t", tmp_path / f"z{i}", "u", "Bn")
        assert out["parse_failure"] and out["missing"] is None, i


def test_floor_table_pass_and_fail():
    good = floors.aggregate([floors_row(), floors_row()], [floors_row(completion={"missing": 2, "covered": 1, "parse_failure": False}), floors_row()])
    assert good["all_pass"], good
    for key, val in (("unsupported_drugs", 1), ("leak_items", 1), ("invented_fields", 1), ("dose_precedence_errors", 1), ("invented_numbers", 1),
                     ("dose_precedence_det", 1), ("printable_errors", 1), ("validator_failures", 1)):
        t = floors.aggregate([floors_row(**{key: val}), floors_row()], [floors_row()])
        assert not t["all_pass"] and [x["pass"] for x in t["rows"]].count(False) == 1 + (key == "validator_failures" and 0), key
    assert floors.aggregate([floors_row(hallucinations=1)] * 5 + [floors_row()] * 0)["rows"][7]["pass"] is False
    assert floors.aggregate([floors_row(hallucinations=1)] + [floors_row()] * 5)["rows"][7]["pass"] is True   # 1/6 <= 0.2
    assert floors.aggregate([floors_row(hallucinations=2)] + [floors_row()] * 5)["rows"][7]["pass"] is False  # 2/6 > 0.2
    worse = floors.aggregate([floors_row(completion={"missing": 4, "covered": 1, "parse_failure": False})], [floors_row()])
    assert not next(x for x in worse["rows"] if x["floor"] == "completion recall")["pass"]
    assert not floors.aggregate([])["all_pass"]


# ---- stats ------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("use_scipy", [True, False])
def test_wilcoxon_hand_computed(use_scipy):
    # d = [1,-2,3,-4,5,6]: ranks 1..6, W+ = 15, W- = 6; subsets of {1..6} with sum <= 6 = 14, p = 2*14/64
    x, y = [1, 0, 3, 0, 5, 6], [0, 2, 0, 4, 0, 0]
    r = stats.wilcoxon(x, y, use_scipy=use_scipy)
    assert r["n"] == 6 and r["statistic"] == 6 and r["p"] == pytest.approx(0.4375)
    r = stats.wilcoxon([2, 3, 4, 5, 6, 7], [1, 1, 1, 1, 1, 1], use_scipy=use_scipy)  # all positive: p = 2/64 ... diffs 1..6
    assert r["statistic"] == 0 and r["p"] == pytest.approx(2 / 64)
    z = stats.wilcoxon([1, 2, 3, 3], [1, 2, 0, 0], use_scipy=use_scipy)  # zero differences dropped
    assert z["n"] == 2
    assert stats.wilcoxon([1, 2], [1, 2], use_scipy=use_scipy) == {"n": 0, "statistic": None, "p": None}


def test_python_fallback_matches_scipy_with_ties():
    pytest.importorskip("scipy")
    d = [1, 1, 2, 2, 2, -1, 3, 4, -2, 5, 1, 2, 3, 3, -3, 4, 5, 6, 1, 2, 2, 3, 4, -5, 1, 2, 3, 1, 2, 4]
    zeros = [0] * len(d)
    assert stats.wilcoxon(d, zeros, use_scipy=False)["p"] == pytest.approx(stats.wilcoxon(d, zeros, use_scipy=True)["p"], rel=1e-6)


def test_holm_rank_biserial_and_median():
    assert stats.holm([0.01, 0.04, 0.03]) == pytest.approx([0.03, 0.06, 0.06])
    assert stats.holm([0.5, None, 0.01]) == pytest.approx([0.5, None, 0.02])
    assert stats.holm([0.2, 0.001, 0.2]) == pytest.approx([0.4, 0.003, 0.4])
    x, y = [1, 0, 3, 0, 5, 6], [0, 2, 0, 4, 0, 0]
    assert stats.rank_biserial(x, y) == pytest.approx(9 / 21)
    assert stats.rank_biserial(y, x) == pytest.approx(-9 / 21)
    assert stats.rank_biserial([1], [1]) is None
    assert stats.median_diff(x, y) == pytest.approx(2.0)  # diffs sorted -4 -2 1 3 5 6 -> (1+3)/2


# ---- printable floor uses B1's public printable_errors (B1 owns the frx_n equivalence tests) ---------------------------

def test_printable_floor_calls_b1_printable_errors(monkeypatch):
    seen = []
    monkeypatch.setattr(validate, "printable_errors", lambda t, p: seen.append((t, p)) or [])
    assert floors.printable_count({"general_advice": ["a"]}, {"note_text": "N", "completion_required": [{"prompt": "P"}]}) == 0
    assert ("N", ["P"]) in seen and ("General Advice:\na", []) in seen


# ---- jev --------------------------------------------------------------------------------------------------------

class _FakeJev:
    def __init__(self, structured=True):
        self.args, self.structured = [], structured

    def call(self, tool, args):
        assert tool == "jev_ask"
        self.args.append(args)
        ans = {k: {"type": "noul", "noul": 0.2 if "LOW" in args["state"]["lines"][k] else 0.9} for k in args["questions"]}
        body = {"answers": ans, "model": "jev-test-1", "usage": {}}
        return {"structuredContent": body} if self.structured else {"content": [{"type": "text", "text": json.dumps(body)}]}


def test_jev_not_run_without_cmd(monkeypatch):
    monkeypatch.delenv("JEV_MCP_CMD", raising=False)
    r = jev_lines.check_lines("a\nb", "t")
    assert r["status"] == "not run" and "JEV_MCP_CMD" in r["reason"]
    assert not hasattr(jev_lines, "deid_from_env")


def test_jev_args_are_exactly_the_strict_shape():
    a = jev_lines.jev_ask_args("tape", {"L1": "x", "L3": "y"})
    assert set(a) == {"state", "questions"} and a["state"] == {"transcript": "tape", "lines": {"L1": "x", "L3": "y"}}
    assert set(a["questions"]) == {"L1", "L3"}
    for k, q in a["questions"].items():
        assert set(q) == {"type", "instructions"} and q["type"] == "noul" and f"line {k}?" in q["instructions"]


@pytest.mark.parametrize("structured", [True, False])
def test_jev_one_call_per_consult_and_low_lines_reported(structured):
    fj = _FakeJev(structured)
    r = jev_lines.check_lines("Plan: ok\n\nFollow up: LOW support\nNAME Jane", "tape", client=fj)
    assert len(fj.args) == 1 and fj.args[0]["state"]["lines"] == {"L1": "Plan: ok", "L3": "Follow up: LOW support", "L4": "NAME Jane"}
    assert r == {"status": "ok", "lines": 3, "low": [{"line": 3, "p_yes": 0.2}], "errors": 0, "model": "jev-test-1", "calls": 1}
    assert "Jane" not in json.dumps(r) and "LOW" not in json.dumps(r)


def test_jev_splits_beyond_200_questions_and_counts_missing_answers():
    fj = _FakeJev()
    r = jev_lines.check_lines("\n".join(f"line {i}" for i in range(450)), "t", client=fj)
    assert [len(a["questions"]) for a in fj.args] == [200, 200, 50] and r["calls"] == 3 and r["lines"] == 450 and r["errors"] == 0

    class Partial(_FakeJev):
        def call(self, tool, args):
            out = super().call(tool, args)
            out["structuredContent"]["answers"].pop("L2")
            out["structuredContent"]["answers"]["L1"]["noul"] = 7  # out of range = unusable
            return out
    r = jev_lines.check_lines("a\nb\nc", "t", client=Partial())
    assert r["errors"] == 2 and r["low"] == []


FAKE_JEV_SERVER = r'''
import json, sys
for raw in sys.stdin:
    msg = json.loads(raw)
    if "id" not in msg:
        continue
    if msg["method"] == "initialize":
        res = {"protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "fake-jev", "version": "0"}}
    else:
        a = msg["params"]["arguments"]
        assert set(a) == {"state", "questions"}
        ans = {k: {"type": "noul", "noul": 0.2 if "LOW" in a["state"]["lines"][k] else 0.9} for k in a["questions"]}
        res = {"content": [{"type": "text", "text": json.dumps({"answers": ans, "model": "jev-fake", "usage": {}})}]}
    print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": res}), flush=True)
'''


def test_jev_over_stdio_with_fake_server(monkeypatch, tmp_path):
    # Written at test time: tests/fixtures is compared file-for-file by test_fixtures_regenerate_identically.
    server = tmp_path / "fake_jev_server.py"
    server.write_text(FAKE_JEV_SERVER, encoding="utf-8")
    monkeypatch.setenv("JEV_MCP_CMD", json.dumps([sys.executable, str(server)]))
    r = jev_lines.check_lines("fine line\nLOW line", "tape")
    assert r["status"] == "ok" and r["lines"] == 2 and [x["line"] for x in r["low"]] == [2] and r["model"] == "jev-fake"
    monkeypatch.setenv("JEV_MCP_CMD", json.dumps(["/nonexistent/binary"]))
    assert jev_lines.check_lines("a", "t")["status"] == "error"


# ---- end to end -------------------------------------------------------------------------------------------------

def _write_inputs(tmp_path: Path, uids):
    arts = tmp_path / "arts"
    arts.mkdir()
    for u in uids:
        art = build_artifact(load_consult(CONSULTS, u), stage_a(u))
        (arts / f"{u}.json").write_text(json.dumps(art), encoding="utf-8")
    def arm(name, rx, extra=None):
        path = tmp_path / f"{name}.jsonl"
        path.write_text("\n".join(json.dumps({"uid": u, "prescription": rx, **(extra or {})}) for u in uids) + "\n", encoding="utf-8")
        return str(path)

    return arts, ",".join([arm("A", RX), arm("B0", {**RX, "examination": "Throat red"}), arm("Bn", RX, {"drops": ["x", "y"]})])


def _argv(tmp_path, arms, arts, frozen_dir, out, extra=()):
    return ["--round", "R1", "--arms", arms, "--artifacts", str(arts), "--consults", str(CONSULTS), "--frozen", str(frozen_dir), "--out", str(out),
            "--scoreboard", str(tmp_path / "SCOREBOARD.md"), *extra]


def test_end_to_end_tuning_run_writes_row_and_leaks_nothing_private(tmp_path, monkeypatch):
    monkeypatch.delenv("JEV_MCP_CMD", raising=False)
    fdir = make_frozen(tmp_path / "frozen")
    arts, arms = _write_inputs(tmp_path, UIDS[:2])
    fc = FakeClient(responder)
    assert run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out"), client=fc) == 0
    n_calls = len(fc.calls)
    assert sum(c["tag"].startswith("pdqi9-v3") for c in fc.calls) == 2 * 3 * 4
    row = json.loads((tmp_path / "SCOREBOARD.R1.json").read_text())
    assert row["n"] == 2 and row["split"] == "tuning" and row["render"] == "render-v2" and row["replay_drops"] == 4
    assert set(row["frozen_hashes"]) == set(judge.FROZEN_FILES) and row["verdict"].startswith("PENDING")
    assert row["jev"]["status"] == "not run" and row["totals"]["opus/none"]["Bn"]["median"] == 34
    assert len(row["floors"]["rows"]) >= 10 and "succinct_bn_minus_a" in row and set(row["rendered_chars_mean"]) == {"A", "B0", "Bn"}
    md = (tmp_path / "SCOREBOARD.md").read_text().splitlines()
    assert len(md) == 3 and md[2].startswith("| R1 |")
    for p in [tmp_path / "SCOREBOARD.md", tmp_path / "SCOREBOARD.R1.json", *(tmp_path / "out").rglob("*")]:
        if p.is_file():
            assert MARK not in p.read_text(errors="ignore"), p
    # second run reuses the cache for the scored notes
    assert run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out"), client=(fc2 := FakeClient(responder))) == 0
    assert not fc2.calls and n_calls > 0
    assert len((tmp_path / "SCOREBOARD.md").read_text().splitlines()) == 4


def test_end_to_end_lockbox_gate(tmp_path, monkeypatch):
    monkeypatch.delenv("JEV_MCP_CMD", raising=False)
    led = tmp_path / "fixed-ledger.jsonl"
    fdir = make_frozen(tmp_path / "frozen")
    arts, arms = _write_inputs(tmp_path, ["synth-boundary-knee"])
    fc = FakeClient(responder)
    with pytest.raises(splits.SplitError):
        run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out"), client=fc)
    assert not fc.calls
    monkeypatch.delenv(splits.LEDGER_ENV, raising=False)
    with pytest.raises(splits.SplitError, match=splits.LEDGER_ENV):
        run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out", ["--lockbox", "--candidate", "c9"]), client=fc)
    assert not fc.calls
    monkeypatch.setenv(splits.LEDGER_ENV, str(led))
    assert run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out", ["--lockbox", "--candidate", "c9"]), client=fc) == 0
    n = len(fc.calls)
    # a fresh --out does not reset the ledger
    with pytest.raises(splits.SplitError, match="second run"):
        run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out2", ["--lockbox", "--candidate", "c9"]), client=fc)
    assert len(fc.calls) == n and len(led.read_text().splitlines()) == 1


def test_bundles_mode_refused_without_load_bundle_and_used_when_present(tmp_path, monkeypatch):
    from tools.eta2freescript import ingest
    monkeypatch.delenv("JEV_MCP_CMD", raising=False)
    fdir = make_frozen(tmp_path / "frozen")
    arts, arms = _write_inputs(tmp_path, UIDS[:1])
    argv = ["--round", "R1", "--arms", arms, "--artifacts", str(arts), "--bundles", str(tmp_path / "bundles"), "--frozen", str(fdir),
            "--out", str(tmp_path / "out"), "--scoreboard", str(tmp_path / "SB.md")]
    monkeypatch.delattr(ingest, "load_bundle", raising=False)
    fc = FakeClient(responder)
    with pytest.raises(SystemExit, match="load_bundle"):
        run.main(argv, client=fc)
    assert not fc.calls
    seen = []
    (tmp_path / "bundles").mkdir()
    (tmp_path / "bundles" / "synth-fever-dose.json").write_text(json.dumps({"marker": 7}), encoding="utf-8")
    monkeypatch.setattr(ingest, "load_bundle", lambda b, english="auto", use_role_track=True: seen.append(b) or load_consult(CONSULTS, "synth-fever-dose"), raising=False)
    assert run.main(argv, client=fc) == 0 and seen == [{"marker": 7}]
    with pytest.raises(SystemExit, match="exactly one"):
        run.main(argv + ["--consults", str(CONSULTS)], client=fc)


def test_run_refuses_loose_frozen_dir_before_any_call(tmp_path):
    fdir = make_frozen(tmp_path / "frozen")
    (fdir / "floor-items-v1.system.txt").chmod(0o644)
    arts, arms = _write_inputs(tmp_path, UIDS[:1])
    fc = FakeClient(responder)
    with pytest.raises(judge.FrozenError):
        run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out"), client=fc)
    assert not fc.calls


# ---- fix round 3 (D1-D6) ----------------------------------------------------------------------------------------

PROBE = {"medicines": [{"name": "Drug", "strength": "dose not stated", "frequency": "to be confirmed", "duration": "TBD"}],
         "follow_up": {"date": "to be decided"}}


def test_d2_printable_floor_renders_fields_under_their_headings():
    n = floors.printable_count(PROBE, None)
    assert n >= 4
    assert floors.printable_count({"medicines": [{"name": "Drug", "strength": "5 mg", "frequency": "bd", "duration": "5 days"}]}, None) == 0
    t = floors.printable_text({"medicines": [{"name": "Para", "strength": "500 mg", "frequency": "bd", "duration": "3 days", "instructions": "after food"}],
                               "investigations": [{"name": "CBC"}], "surgeries": [{"name": "X"}], "referrals": [{"speciality": "ENT"}],
                               "follow_up": {"date": "d"}, "diagnoses": [{"name": "Fever"}], "general_advice": ["rest"],
                               "examination": "e", "symptoms": "s", "management_plan": "p"})
    assert "Medication:\nPara 500 mg bd for 3 days after food" in t
    for h in ("Further Investigation", "Surgery or Procedure", "Refer to", "Follow up", "Diagnoses", "General Advice", "Examination",
              "Presenting Complaint", "Plan of Management"):
        assert f"{h}:\n" in t


@pytest.mark.parametrize("dur", ["Days 5", "weeks", "Months - 3", "5 days", "1 month", "continue", "SOS"])
def test_b4b1_duration_with_unit_word_is_not_a_printable_error(dur):
    rx = {"medicines": [{"name": "Drug", "strength": "5 mg", "frequency": "bd", "duration": dur}]}
    assert floors.printable_count(rx, None) == 0
    assert " for " + dur in floors.printable_text(rx)


@pytest.mark.parametrize("dur", ["[days]", "to be decided"])
def test_b4b1_placeholder_duration_still_counts_errors_unchanged(dur):
    # B1 reports two FRX-N1 findings for each of these on one line (two bracket hits; d2 + d3); the count is the same under "x" and "for".
    assert floors.printable_count({"medicines": [{"name": "Drug", "strength": "5 mg", "frequency": "bd", "duration": dur}]}, None) == 2


def test_d3_b0_parse_failure_is_not_evaluated_and_blocks_kept():
    bad = {"missing": None, "covered": None, "parse_failure": True}
    t = floors.aggregate([floors_row(completion={"missing": 4, "covered": 1, "parse_failure": False})], [floors_row(completion=bad)])
    row = next(x for x in t["rows"] if x["floor"] == "completion recall")
    assert row["recall_pass"] == "not_evaluated" and row["pass"] is False and row["blocks_kept"] and not t["all_pass"]
    t = floors.aggregate([floors_row(completion=bad)], [floors_row()])
    assert next(x for x in t["rows"] if x["floor"] == "completion recall")["recall_pass"] == "not_evaluated"
    t = floors.aggregate([floors_row()], [floors_row()])
    assert next(x for x in t["rows"] if x["floor"] == "completion recall")["recall_pass"] == "pass"


def test_d4_floor_parsers_are_exact(frozen, tmp_path):
    items = floors.numbered_items({"diagnoses": [{"name": "a"}]})
    ok = json.dumps({"items": [item(1)]})
    for i, text in enumerate(["Sure! " + ok + " done", ok + " trailing", "```json\n" + ok, ok + "\n```", "[" + ok + "]"]):
        assert floors.judge_items(FakeClient(lambda *a, t=text: t), frozen, items, "t", tmp_path / f"p{i}", "u", "Bn")["parse_failure"], text
    extra = json.dumps({"items": [{**item(1), "extra": 1}]})
    assert floors.judge_items(FakeClient(lambda *a: extra), frozen, items, "t", tmp_path / "e", "u", "Bn")["parse_failure"]
    for i, text in enumerate([ok, "```json\n" + ok + "\n```", "```\n" + ok + "\n```"]):
        assert not floors.judge_items(FakeClient(lambda *a, t=text: t), frozen, items, "t", tmp_path / f"g{i}", "u", "Bn")["parse_failure"]
    signed = [{"n": 1, "kind": "diagnosis", "text": "a"}]
    row = {"n": 1, "in_draft": True, "covered_by": None}
    for i, text in enumerate([json.dumps({"signed": [{**row, "extra": 1}]}), "ok " + json.dumps({"signed": [row]})]):
        assert floors.completion_counts(FakeClient(lambda *a, t=text: t), frozen, signed, [], [], "t", tmp_path / f"s{i}", "u", "Bn")["parse_failure"]
    assert not floors.completion_counts(FakeClient(lambda *a: json.dumps({"signed": [row]})), frozen, signed, [], [], "t", tmp_path / "sg", "u", "Bn")["parse_failure"]


def _scores(a, b, b0):
    """scores dict for 6 consults, one combo: arms A, Bn, B0 each a list of 9-item score lists."""
    d = {}
    for i in range(6):
        for arm, v in (("A", a), ("Bn", b), ("B0", b0)):
            d[(f"u{i}", arm, "opus/none")] = {"total": sum(v[i]), "items": v[i]}
    return d


def test_d1_item_level_comparisons_are_not_the_total():
    A = [[3] * 9 for _ in range(6)]
    # Bn: succinct item (index 6) up 2, thorough (index 2) down 1, others equal
    Bn = [[3, 3, 2, 3, 3, 3, 5, 3, 3] for _ in range(6)]
    sc = _scores(A, Bn, A)
    suc = run.compare_family(sc, [f"u{i}" for i in range(6)], ["opus/none"], "Bn", "A", run.SUCCINCT)["opus/none"]
    tot = run.compare_family(sc, [f"u{i}" for i in range(6)], ["opus/none"], "Bn", "A")["opus/none"]
    tho = run.compare_family(sc, [f"u{i}" for i in range(6)], ["opus/none"], "Bn", "B0", run.THOROUGH)["opus/none"]
    assert suc["median_diff"] == 2 and suc["mean_diff"] == 2 and suc["p"] == pytest.approx(0.03125) and suc["rank_biserial"] == 1
    assert tot["median_diff"] == 1 and tho["median_diff"] == -1 and tho["mean_diff"] == -1


def test_d1_end_to_end_row_has_item_total_and_target_fields(tmp_path, monkeypatch):
    monkeypatch.delenv("JEV_MCP_CMD", raising=False)
    fdir = make_frozen(tmp_path / "frozen")
    arts, arms = _write_inputs(tmp_path, UIDS[:2])
    assert run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out"), client=FakeClient(responder)) == 0
    row = json.loads((tmp_path / "SCOREBOARD.R1.json").read_text())
    for k in ("succinct_bn_minus_a", "thorough_bn_minus_b0", "total_bn_minus_a", "total_bn_minus_b0"):
        assert set(row[k]) == {f"{j}/{r}" for j in judge.JUDGES for r in judge.REFS} and "mean_diff" in row[k]["opus/none"]
    t = row["target_12_7"]
    assert set(t) >= {"items_all_gt", "total_holm_lt_0_05_median_ge_2", "thorough_mean_ge_minus_0_1", "direction_holds_sonnet", "met"}
    assert t["met"] is False   # identical scores everywhere
    # D6: every scores.json and floors.json row carries the frozen hashes, render version and split sha
    for r in json.loads((tmp_path / "out" / "scores.json").read_text()):
        assert set(r["frozen_hashes"]) == set(judge.FROZEN_FILES) and r["render_version"] == "render-v2" and r["split_sha"] == r["frozen_hashes"]["split-v1.json"]
    fl = json.loads((tmp_path / "out" / "floors.json").read_text())
    assert fl["Bn"] and fl["B0"]
    for r in fl["Bn"] + fl["B0"]:
        assert set(r["frozen_hashes"]) == set(judge.FROZEN_FILES) and r["render_version"] == "render-v2" and r["split_sha"]


def test_d1_target_check_logic():
    combos = [f"{j}/{r}" for j in judge.JUDGES for r in judge.REFS]
    good = {"median_diff": 2, "p_holm": 0.01, "mean_diff": 0.0}
    fam = {"bn_vs_a": good}
    gt = dict.fromkeys(combos, 9)
    tot = dict.fromkeys(combos, good)
    th = dict.fromkeys(combos, good)
    assert run.target_check(gt, fam, th, tot)["met"]
    # opus/none is not part of met
    assert run.target_check({**gt, "opus/none": 3}, fam, {**th, "opus/none": {"mean_diff": -5}}, tot)["met"]
    assert not run.target_check({**gt, "opus/transcript": 8}, fam, th, tot)["met"]
    assert not run.target_check(gt, {"bn_vs_a": {**good, "median_diff": 1}}, th, tot)["met"]
    assert not run.target_check(gt, {"bn_vs_a": {**good, "p_holm": 0.05}}, th, tot)["met"]
    assert not run.target_check(gt, fam, {**th, "opus/transcript": {"mean_diff": -0.2}}, tot)["met"]
    for ref in ("transcript", "none"):
        assert not run.target_check(gt, fam, th, {**tot, f"sonnet/{ref}": {**good, "median_diff": 0}})["met"]


def test_ruling_total_family_is_the_three_totals_under_the_primary_judge():
    A = [[3] * 9 for _ in range(6)]
    Bn = [[4] * 9 for _ in range(6)]
    B0 = [[3, 3, 3, 3, 3, 3, 3, 3, 4] for _ in range(6)]
    sc = {(f"u{i}", arm, run.PRIMARY): {"total": sum(v[i]), "items": v[i]} for i in range(6) for arm, v in (("A", A), ("Bn", Bn), ("B0", B0))}
    fam = run.total_family(sc, [f"u{i}" for i in range(6)], run.PRIMARY)
    assert set(fam) == {"bn_vs_a", "bn_vs_b0", "b0_vs_a"} and fam["bn_vs_a"]["median_diff"] == 9
    assert fam["bn_vs_a"]["p_holm"] == pytest.approx(3 * 0.03125)


def test_ruling_unknown_key_strings_are_checked_and_counted_apart():
    clean = {"general_advice": ["rest"]}
    assert floors.unknown_key_errors(clean) == 0
    rx = {**clean, "extra_note": "[doctor to verify]", "medicines": [{"name": "D", "mystery": ["{{x}}"]}], "follow_up": {"zzz": "ok"}}
    assert floors.unknown_key_errors(rx) >= 2
    assert floors.printable_count(rx, None) == 0
    row = floors.aggregate([floors_row(unknown_key_errors=1)])["rows"][-3]
    assert row["floor"] == "unknown-key printable errors" and not row["pass"]


class _J:
    def __init__(self, fail): self.fail = fail
    def call(self, tool, args):
        if self.fail:
            raise RuntimeError("x")
        return {"structuredContent": {"answers": {k: {"noul": 0.9} for k in args["questions"]}, "model": "m"}}


def _jev_main(tmp_path, monkeypatch, check):
    monkeypatch.delenv("JEV_MCP_CMD", raising=False)
    monkeypatch.setattr(run.jev_lines, "check_lines", check)
    fdir = make_frozen(tmp_path / "frozen")
    arts, arms = _write_inputs(tmp_path, UIDS[:2])
    assert run.main(_argv(tmp_path, arms, arts, fdir, tmp_path / "out"), client=FakeClient(responder)) == 0
    return json.loads((tmp_path / "SCOREBOARD.R1.json").read_text())["jev"]


def test_d5_jev_status_counts_error_ok_and_not_run(tmp_path, monkeypatch):
    err = {"status": "error", "reason": "JevError"}
    j = _jev_main(tmp_path, monkeypatch, lambda *a, **k: err)
    assert j["status"] == "failed" and j["consults_error"] == 2 and j["consults_ok"] == 0 and j["summary"].startswith("jev: failed (2 consults")
    ok = {"status": "ok", "lines": 3, "low": [], "errors": 0, "model": "m", "calls": 1}
    seq = iter([ok, err])
    j = _jev_main(tmp_path / "b", monkeypatch, lambda *a, **k: next(seq))
    assert j["status"] == "partial" and (j["consults_ok"], j["consults_error"], j["consults_not_run"]) == (1, 1, 0) and "error 1" in j["summary"]
