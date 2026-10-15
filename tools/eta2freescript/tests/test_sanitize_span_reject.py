"""FRX-L1: a bracket span the sanitiser removed from an order line (or a dose/slot field word anywhere) rejects the consult."""
import copy
import json
import random

import pytest
from conftest import CONSULTS, MODEL, stage_a

import oracle_note_main as base
from tools.eta2freescript import note as note_mod
from tools.eta2freescript.ingest import load_consult
from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.note import HEADINGS, ORDER_HEADINGS, sanitize_note, sanitize_note_ex, span_errors
from tools.eta2freescript.pipeline import run_consult
from tools.eta2freescript.validate import _D4_FIELDS, check

UID = "synth-fever-dose"
STAGE_B = (MODEL / UID / "stageB.txt").read_text()
SPANS = ["[frequency]", "[duration]", "[dose]", "[Name]", "[ STRENGTH ]", "[S1]", "[S0|doctor]", "[dose not stated — doctor to verify]",
         "[?]", "[see note]", "[1]", "[]"]


def expected_reject(head, span):
    return head in ORDER_HEADINGS or span.strip("[] ").lower() in _D4_FIELDS


def gen_note(r):
    """A note with every heading, a random number of spans on each line. Returns (text, [(heading, span)])."""
    lines, want = [], []
    for h in HEADINGS:
        parts = ["word%d" % r.randint(0, 9)]
        for _ in range(r.choice([0, 0, 1, 2])):
            sp = r.choice(SPANS)
            parts.insert(r.randint(0, len(parts)), sp)
            want.append((h, sp))
        lines.append(f"{h}: " + " ".join(parts))
        if r.random() < 0.15:  # continuation line without its own heading
            sp = r.choice(SPANS)
            lines.append(f"{sp} more text")
            want.append((h, sp))
    return "\n".join(lines), want


@pytest.mark.parametrize("seed", range(6))
def test_s2_s3_reject_iff_order_line_or_field_word(seed):
    r = random.Random(seed)
    for _ in range(200):
        text, want = gen_note(r)
        out, removed = sanitize_note_ex(text)
        assert sorted(removed) == sorted(want)
        assert out == sanitize_note(text) == base.sanitize_note(text)
        errs = span_errors(removed)
        assert bool(errs) == any(expected_reject(h, s) for h, s in want), (text, errs)
        assert sorted(errs) == sorted({f"FRX-L1 bracket span removed from {h}" for h, s in want if expected_reject(h, s)})


def test_s1_helper_text_is_byte_identical_to_base():
    r = random.Random(77)
    for _ in range(500):
        text, _ = gen_note(r)
        assert sanitize_note_ex(text)[0] == base.sanitize_note(text)


def _run(tmp_path, stage_b):
    c = load_consult(CONSULTS, UID)
    fake = FakeClient({"stageA": json.dumps(stage_a(UID)), "stageB": stage_b})
    return run_consult(c, fake, tmp_path), tmp_path / UID


def test_clean_consult_posts_with_zero_removed(tmp_path):
    lg, od = _run(tmp_path, STAGE_B)
    assert lg["final_valid"] and "sanitize_removed" not in lg and (od / "artifact.json").exists()


# --- gate probes through the full pipeline ---
def test_probe_placeholder_dose_slots_on_medication_rejected(tmp_path):
    bad = STAGE_B.replace("paracetamol 1 g three times a day x 3 days", "Paracetamol [frequency] x [duration]")
    lg, od = _run(tmp_path, bad)
    # the LLM note trips S2, so the deterministic fallback is used; it is clean, so the consult posts (and the LLM note is not what posted)
    assert lg["note_source"] == "deterministic_fallback" and "FRX-L1 bracket span removed from Medication" in lg["llm_note_errors"]
    assert lg["final_valid"] and "[" not in lg["artifact"]["note_text"]


def _llm_with(tmp_path, old, new):
    return _run(tmp_path, STAGE_B.replace(old, new))


def test_probe_s1_on_general_advice_posts_with_count(tmp_path):
    lg, od = _llm_with(tmp_path, "General Advice: Drink plenty of water; Take rest", "General Advice: [S1] Drink plenty of water; Take rest")
    assert lg["final_valid"] and lg["note_source"].startswith("llm_") and lg["sanitize_removed"] == 1
    assert (od / "artifact.json").exists()


def test_probe_s1_on_medication_never_posts_the_trimmed_line(tmp_path):
    lg, od = _llm_with(tmp_path, "Medication: paracetamol", "Medication: [S1] paracetamol")
    assert lg["note_source"] == "deterministic_fallback"
    assert "FRX-L1 bracket span removed from Medication" in lg["llm_note_errors"]


def test_field_word_on_general_advice_rejects_llm_note(tmp_path):
    lg, _ = _llm_with(tmp_path, "General Advice: Drink", "General Advice: [dose] Drink")
    assert lg["note_source"] == "deterministic_fallback" and "FRX-L1 bracket span removed from General Advice" in lg["llm_note_errors"]


def test_reject_when_fallback_note_itself_loses_a_span(tmp_path, monkeypatch):
    real = note_mod.render_note
    from tools.eta2freescript import pipeline
    monkeypatch.setattr(pipeline, "render_note", lambda *a, **k: real(*a, **k).replace("Medication: ", "Medication: [frequency] ", 1))
    lg, od = _run(tmp_path, STAGE_B.replace("Medication: paracetamol", "Medication: [S1] paracetamol"))
    assert not lg["final_valid"] and "FRX-L1 bracket span removed from Medication" in lg["final_errors"]
    assert (od / "artifact.rejected.json").exists() and not (od / "artifact.json").exists()


# --- clean notes unchanged: recorder over 400+ notes vs base ---
def test_recorder_clean_notes_identical_and_flips_by_heading(tmp_path):
    r = random.Random(2026)
    c = load_consult(CONSULTS, UID)
    base_run = run_consult(c, FakeClient({"stageA": json.dumps(stage_a(UID)), "stageB": STAGE_B}), tmp_path)
    art = base_run["artifact"]
    n_clean = n_total = 0
    flips: dict[str, int] = {}
    for _ in range(450):
        lines = STAGE_B.split("\n")
        for i, ln in enumerate(lines):  # a valid LLM note with a span dropped into a line now and then
            if r.random() < 0.08:
                lines[i] = ln + " " + r.choice(SPANS)
        text = "\n".join(lines)
        n_total += 1
        b_text = base.sanitize_note(text)
        n_text, rem = sanitize_note_ex(text)
        a1, a2 = copy.deepcopy(art), copy.deepcopy(art)
        a1["note_text"], a2["note_text"] = b_text, n_text
        v_base, v_new = check(a1), check(a2) + span_errors(rem)
        assert n_text == b_text
        if not rem:
            n_clean += 1
            assert v_base == v_new
        elif not v_base and v_new:
            for e in v_new:
                flips[e] = flips.get(e, 0) + 1
    assert n_total >= 400 and n_clean > 100 and flips
    print("flips posted->rejected by heading:", dict(sorted(flips.items())))
