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


# --- FIX1 F1: the heading a line belongs to does not depend on column 0 ---
PLACEMENTS = {  # name -> prefix written before "<Heading>:"
    "col0": "", "space1": " ", "space3": "   ", "tab": "\t", "span": "[S1] ", "span_nospace": "[S1]", "span_tab": "[S1]\t",
    "tab_span": "\t[S1] ", "space_span_space": "  [S0|doctor]  ",
}


def gen_note_placed(r):
    """Every heading at a random placement, with 0-2 inner spans each. Returns (text, [(heading, span)])."""
    lines, want = [], []
    for h in HEADINGS:
        pname = r.choice(sorted(PLACEMENTS))
        pre = PLACEMENTS[pname]
        parts = ["word%d" % r.randint(0, 9)]
        for _ in range(r.choice([0, 0, 1, 2])):
            sp = r.choice(SPANS)
            parts.insert(r.randint(0, len(parts)), sp)
            want.append((h, sp))
        if pre.strip():
            want.append((h, pre.strip()))
        lines.append(f"{pre}{h}: " + " ".join(parts))
    return "\n".join(lines), want


@pytest.mark.parametrize("seed", range(6))
def test_f1_reject_in_every_placement(seed):
    r = random.Random(1000 + seed)
    for _ in range(200):
        text, want = gen_note_placed(r)
        out, removed = sanitize_note_ex(text)
        assert sorted(removed) == sorted(want), text
        assert out == base.sanitize_note(text)  # the posted text is unchanged from base, whatever the placement
        errs = span_errors(removed)
        assert sorted(errs) == sorted({f"FRX-L1 bracket span removed from {h}" for h, s in want if expected_reject(h, s)}), (text, errs)


@pytest.mark.parametrize("pname", sorted(PLACEMENTS))
@pytest.mark.parametrize("head", sorted(ORDER_HEADINGS))
def test_f1_order_line_span_rejects_in_each_placement(head, pname):
    text = "General Advice: rest\n" + PLACEMENTS[pname] + head + ": item [three times a day] x 3 days"
    out, removed = sanitize_note_ex(text)
    assert (head, "[three times a day]") in removed
    assert f"FRX-L1 bracket span removed from {head}" in span_errors(removed)


def test_f1_prefixed_heading_reports_its_own_heading_not_the_previous_one():
    _, removed = sanitize_note_ex("Refer to: cardiology\n[S1] General Advice: rest")
    assert removed == [("General Advice", "[S1]")]
    _, removed = sanitize_note_ex("General Advice: rest\n[S1] Surgery or Procedure: dressing [left knee]")
    assert removed == [("Surgery or Procedure", "[S1]"), ("Surgery or Procedure", "[left knee]")]
    _, removed = sanitize_note_ex("General Advice: rest\n Follow up: review After [one] week")
    assert removed == [("Follow up", "[one]")]


def test_f1_text_of_non_column0_lines_is_not_reflowed():
    t = "Medication: a\n[S1] Medication: b\n\tMedication: c [x]\n  Follow up: d"
    assert sanitize_note_ex(t)[0] == base.sanitize_note(t) == "Medication: a\n Medication: b\n\tMedication: c\n  Follow up: d"


def _extra_line(tmp_path, extra, medication=None):
    b = STAGE_B if medication is None else STAGE_B.replace("Medication: paracetamol 1 g three times a day x 3 days", medication)
    return _run(tmp_path, b + "\n" + extra)


@pytest.mark.parametrize("extra", [
    "[S1] Medication: paracetamol 1 g [three times a day] x 3 days",
    "  Medication: paracetamol 1 g [three times a day] x 3 days",
    "\tMedication: paracetamol 1 g [three times a day] x 3 days",
    " [S1]  Medication: paracetamol 1 g [three times a day] x 3 days",
])
def test_f1_probe_medication_line_not_at_column0_rejects_the_llm_note(tmp_path, extra):
    lg, od = _extra_line(tmp_path, extra)
    assert "FRX-L1 bracket span removed from Medication" in lg["llm_note_errors"]
    assert lg["note_source"] == "deterministic_fallback" and "note_repaired" not in lg
    assert lg["final_valid"] and "x 3 days" not in lg["artifact"]["note_text"]  # the trimmed extra line is not what posts (the fallback says "x for three days")


def test_f1_probe_repair_path_with_emptied_medication_and_prefixed_line(tmp_path):
    lg, _ = _extra_line(tmp_path, "[S1] Medication: paracetamol 1 g [three times a day] x 3 days", medication="Medication:")
    assert "FRX-L1 bracket span removed from Medication" in lg["llm_note_errors"]
    assert lg["note_source"] == "deterministic_fallback" and "note_repaired" not in lg


def test_f1_probe_prefixed_follow_up_and_surgery_lines_through_pipeline(tmp_path):
    lg, _ = _extra_line(tmp_path, " Follow up: review After [one] week")
    assert "FRX-L1 bracket span removed from Follow up" in lg["llm_note_errors"] and lg["note_source"] == "deterministic_fallback"
    lg, _ = _extra_line(tmp_path, "[S1] Surgery or Procedure: dressing [left knee]")
    assert "FRX-L1 bracket span removed from Surgery or Procedure" in lg["llm_note_errors"] and lg["note_source"] == "deterministic_fallback"


def test_f1_probe_prefixed_general_advice_posts_with_count(tmp_path):
    lg, _ = _extra_line(tmp_path, "[S1] General Advice: keep warm")
    assert lg["final_valid"] and lg["note_source"].startswith("llm_") and lg["sanitize_removed"] == 1


# --- FIX1 F2: the span accounting points the first round left untested ---
def _run_a(tmp_path, stage_b, mutate_a):
    c = load_consult(CONSULTS, UID)
    a = copy.deepcopy(stage_a(UID))
    mutate_a(a)
    return run_consult(c, FakeClient({"stageA": json.dumps(a), "stageB": stage_b}), tmp_path), tmp_path / UID


def test_m4_repaired_llm_note_that_loses_a_span_is_not_kept(tmp_path):
    """Stage A timing `today [fasting]` + an LLM note with an empty Medication: the note goes to repair, the repaired note is
    rebuilt from gp_extraction and the sanitiser removes [fasting] from Further Investigation. Posting that repaired note
    (`CBC (today)`) is the defect; the span check on the repaired note must stop it."""
    def m(a):
        a["investigations"][0]["timing"] = "today [fasting]"
    lg, od = _run_a(tmp_path, STAGE_B.replace("Medication: paracetamol 1 g three times a day x 3 days", "Medication:"), m)
    assert lg["note_repaired"] is False
    assert "FRX-L1 bracket span removed from Further Investigation" in lg["llm_note_errors"]
    assert lg["note_source"] == "deterministic_fallback" and not lg["llm_note_valid"]


def test_m5_recovery_rerender_replaces_the_removed_spans(tmp_path, monkeypatch):
    """A recovery re-render rebuilds the note, so what the sanitiser removed from the LLM note no longer applies."""
    from tools.eta2freescript import pipeline, recover
    monkeypatch.setattr(recover, "soften_f2_m3", lambda art: ["FRX-F2 forced"])
    lg, _ = _llm_with(tmp_path, "General Advice: Drink plenty of water; Take rest", "General Advice: [S1] Drink plenty of water; Take rest")
    assert lg["field_recovery"] and lg["final_valid"] and "sanitize_removed" not in lg


def test_m5_recovery_rerender_that_loses_a_span_rejects(tmp_path, monkeypatch):
    from tools.eta2freescript import pipeline, recover
    monkeypatch.setattr(recover, "soften_f2_m3", lambda art: ["FRX-F2 forced"])
    real, n = pipeline._fallback_note_ex, [0]

    def second_call_loses_a_span(*a, **k):
        n[0] += 1
        text, rem = real(*a, **k)
        return (text, rem) if n[0] == 1 else (text, rem + [("Medication", "[frequency]")])
    monkeypatch.setattr(pipeline, "_fallback_note_ex", second_call_loses_a_span)
    lg, od = _run(tmp_path, STAGE_B)
    assert not lg["final_valid"] and "FRX-L1 bracket span removed from Medication" in lg["final_errors"]
    assert (od / "artifact.rejected.json").exists() and not (od / "artifact.json").exists()


def test_m11_c4_retry_fallback_returns_its_removed_spans(tmp_path, monkeypatch):
    from tools.eta2freescript import pipeline
    lg, _ = _run(tmp_path, STAGE_B)
    art = copy.deepcopy(lg["artifact"])
    art["gp_extraction"]["medicines"][0]["name"] = "paracetamol [dose]"
    monkeypatch.setattr(pipeline, "check", lambda a: ["C4 forced"])  # the first render "fails C4", so the retry path runs
    text, rem = pipeline._fallback_note_ex(art, {}, [])
    assert "[dose]" not in text and ("Medication", "[dose]") in rem
