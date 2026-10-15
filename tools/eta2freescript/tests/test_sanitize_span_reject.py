"""FRX-L1: a bracket span the sanitiser removed from an order line (or a dose/slot field word anywhere) rejects the consult."""
import copy
import json
import random
import re
import unicodedata

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
    """FIX3: a span is benign only if it is a speaker label `s`+1-3 digits AND its line is a non-order line."""
    return head is None or head in ORDER_HEADINGS or not re.fullmatch(r"s[0-9]{1,3}", span.strip("[] ").lower())


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


# --- FIX2: fail-closed line classification on a normalised view (N1-N3) ---
from tools.eta2freescript.note import _norm_view  # noqa: E402

NON_ORDER = [h for h in HEADINGS if h not in ORDER_HEADINGS]
CF = ["​", "﻿", "⁠", "­", "‍", "‎", "‏", "‪", "⁦"]
SP = "[three times a day]"
PRE = {  # name -> (text written before the heading, case function, text between heading and colon)
    "col0": "", "indent": "  ", "tab": "\t", "nbsp": " ", "ideo_space": "　", "lead_span": "[S1] ", "lead_span_tight": "[S1]",
    "bullet": "- ", "dot": "• ", "star": "* ", "quote": "> ", "num": "1. ", "numparen": "1) ", "alpha": "(a) ", "bold": "**",
    "hash": "## ", "after_text": "Plan: ", "after_sentence": "Rest. ", "after_heading": "General Advice: rest; ",
    "after_span_list": "[S1] - ",
}
CASES = {"same": lambda s: s, "upper": str.upper, "lower": str.lower, "mixed": lambda s: "".join(c.upper() if i % 2 else c.lower() for i, c in enumerate(s))}
COLONS = {"colon": ":", "space_colon": " :", "fullwidth": "：", "fullwidth_sp": " ：", "bold_close": ":**"}


def _placements():
    for pn, pre in PRE.items():
        for cn, cf in CASES.items():
            for kn, colon in COLONS.items():
                yield pn, cn, kn, pre, cf, colon
    for c in CF:  # Cf characters: alone, doubled, combined with each other and with the indent / bullet / case / colon variants
        for pre in ("", "  ", "- ", "[S1] ", "1. "):
            yield f"cf{ord(c):x}", "same", "colon", pre + c, lambda s: s, ":"
            yield f"cf{ord(c):x}x2", "mixed", "space_colon", pre + c + c, CASES["mixed"], " :"
    yield "cf_all", "upper", "fullwidth", "".join(CF), CASES["upper"], "："
    yield "cf_in_word", "same", "colon", "", lambda s: s[:3] + "​" + s[3:], ":"
    yield "cf_before_colon", "same", "colon", "", lambda s: s, "​:"


def _line(head, pre, cf, colon, body):
    return f"{pre}{cf(head)}{colon} {body}"


@pytest.mark.parametrize("head", sorted(ORDER_HEADINGS))
def test_fx2_order_line_span_rejects_in_every_placement(head):
    n = 0
    for pn, cn, kn, pre, cf, colon in _placements():
        for before in ("General Advice: rest", "Medication: x", "Presenting Complaint: cough"):
            text = before + "\n" + _line(head, pre, cf, colon, f"item {SP} x 3 days")
            _, removed = sanitize_note_ex(text)
            errs = span_errors(removed)
            assert any(e.startswith("FRX-L1") for e in errs) and any(sp == SP for _, sp in removed), (pn, cn, kn, before, repr(text))
            assert f"FRX-L1 bracket span removed from {head}" in errs, (pn, cn, kn, before, repr(text), errs)
            n += 1
    assert n > 1000


@pytest.mark.parametrize("head", sorted(ORDER_HEADINGS))
def test_fx2_continuation_of_an_order_section_rejects(head):
    for pre in ("", "  ", "- ", "​"):
        for cont in (f"{SP} more", "second line [S1]", "  [dose] x"):
            _, removed = sanitize_note_ex(f"General Advice: rest\n{pre}{head}: a\n{cont}")
            assert f"FRX-L1 bracket span removed from {head}" in span_errors(removed), (head, pre, cont)


@pytest.mark.parametrize("head", NON_ORDER)
def test_fx2_speaker_label_on_properly_attributed_non_order_line_still_posts(head):
    for pre in ("", "  ", "[S1] ", "​", "- ", "："[:0]):
        text = f"Medication: x\n{pre}{head}: keep warm [S1]\n{head.upper()}​ : and more [S2]"
        out, removed = sanitize_note_ex(text)
        assert removed and all(h == head for h, _ in removed), (head, pre, removed)
        assert span_errors(removed) == []
        assert out == base.sanitize_note(text)


def test_fx2_span_before_any_heading_rejects():
    for text in ("[S1] opening words\nGeneral Advice: rest", "preamble [S1]\nMedication: x", "[S1]\nGeneral Advice: rest", "​[S1] hi"):
        _, removed = sanitize_note_ex(text)
        assert removed[0][0] is None
        assert span_errors(removed) == ["FRX-L1 bracket span removed from unattributed"], text


def test_fx2_order_heading_anywhere_beats_a_non_order_start():
    for text in ("General Advice: rest. Medication: x [500 mg]", "Plan of Management: a, Follow up: b [S1]", "Examination: Refer to: ENT [S1]",
                 "Diagnoses: Surgery or Procedure : knee [x]"):
        _, removed = sanitize_note_ex(text)
        assert span_errors(removed) and removed[0][0] in ORDER_HEADINGS, (text, removed)


def test_fx2_posted_text_never_depends_on_the_view():
    r = random.Random(5)
    for _ in range(300):
        pn, cn, kn, pre, cf, colon = r.choice(list(_placements()))
        text = "\n".join(_line(r.choice(HEADINGS), pre, cf, colon, f"w {r.choice(SPANS)} z") for _ in range(4))
        assert sanitize_note_ex(text)[0] == base.sanitize_note(text)


def test_fx2_norm_view():
    assert _norm_view("[S1] ​**1.  MEDICATION ：** x") == "medication:x" or _norm_view("[S1] ​**1.  MEDICATION ：** x").startswith("medication:")
    assert _norm_view("­⁠Follow‍ up　: a").startswith("follow up:")


# --- VERDICT / VERDICT2 probes as fixed cases, through the full pipeline ---
_PROBES = [
    "[S1] Medication: paracetamol 1 g [three times a day] x 3 days",
    "  Medication: paracetamol 1 g [three times a day] x 3 days",
    "​Medication: paracetamol 1 g x 3 days [500 mg]",
    "﻿Medication: paracetamol 1 g x 3 days [500 mg]",
    "⁠Follow up: review in [one] week",
    "­Refer to: cardiology [urgent]",
    "‍Further Investigation: CBC [fasting]",
    "‎Surgery or Procedure: dressing [left knee]",
    "- Medication: paracetamol 1 g x 3 days [500 mg]",
    "• Medication: paracetamol 1 g x 3 days [500 mg]",
    "1. Medication: paracetamol 1 g x 3 days [500 mg]",
    "**Medication:** paracetamol 1 g x 3 days [500 mg]",
    "medication: paracetamol 1 g x 3 days [500 mg]",
    "MEDICATION: paracetamol 1 g x 3 days [500 mg]",
    "Medication : paracetamol 1 g x 3 days [500 mg]",
    "Medication： paracetamol 1 g x 3 days [500 mg]",
    "Rest. Medication: paracetamol 1 g x 3 days [500 mg]",
    "General Advice: rest; Medication: paracetamol 1 g x 3 days [500 mg]",
    "Plan: Medication: paracetamol 1 g x 3 days [500 mg]",
    " Follow up: review After [one] week",
    "[S1] Surgery or Procedure: dressing [left knee]",
]


@pytest.mark.parametrize("extra", _PROBES)
@pytest.mark.parametrize("emptied", [False, True])
def test_fx2_verdict_probes_never_post_the_trimmed_line(tmp_path, extra, emptied):
    lg, od = _extra_line(tmp_path, extra, medication="Medication:" if emptied else None)
    assert any(e.startswith("FRX-L1") for e in lg["llm_note_errors"]), lg["llm_note_errors"]
    assert lg["note_source"] == "deterministic_fallback" and "note_repaired" not in lg
    assert lg["final_valid"] and "​" not in lg["artifact"]["note_text"] and "[500 mg]" not in lg["artifact"]["note_text"]


def test_fx2_prefixed_general_advice_and_cf_general_advice_still_post(tmp_path):
    for extra in ("[S1] General Advice: keep warm", "​General Advice: keep warm [S1]", "- general advice : keep warm [S1]"):
        lg, _ = _extra_line(tmp_path / str(hash(extra)), extra)
        assert lg["final_valid"] and lg["note_source"].startswith("llm_") and lg["sanitize_removed"] >= 1, extra


# --- FIX2 mutations: each one must fail at least one test above ---
def _mutated(monkeypatch, which):
    if which == "no_cf":
        monkeypatch.setattr(note_mod, "_norm_view", _norm_no_cf)
    elif which == "no_casefold":
        monkeypatch.setattr(note_mod, "_norm_view", lambda l: _norm_no_casefold(l))
    elif which == "no_anywhere":
        monkeypatch.setattr(note_mod, "_order_heading_inside", lambda v: None)
    elif which == "unattributed_benign":
        real_se = note_mod.span_errors
        monkeypatch.setattr(note_mod, "span_errors", lambda rem: real_se([(h, s) for h, s in rem if h is not None]))


def _norm_no_cf(line):
    import re as _re, unicodedata as ud
    s = ud.normalize("NFKC", line).translate(note_mod._COLONS)
    s = _re.sub(r"\s+", " ", note_mod._MARKUP.sub("", s)).casefold()
    s = _re.sub(r"\s+:", ":", s)
    prev = None
    while prev != s:
        prev, s = s, note_mod._LEAD.sub("", s).lstrip()
    return s


def _norm_no_casefold(line):
    import re as _re, unicodedata as ud
    s = ud.normalize("NFKC", "".join(c for c in line if ud.category(c) != "Cf")).translate(note_mod._COLONS)
    s = _re.sub(r"\s+", " ", note_mod._MARKUP.sub("", s))
    s = _re.sub(r"\s+:", ":", s)
    prev = None
    while prev != s:
        prev, s = s, note_mod._LEAD.sub("", s).lstrip()
    return s


def _kills(monkeypatch, which):
    _mutated(monkeypatch, which)
    probes = [
        ("General Advice: rest\n​Medication: a [500 mg]", "Medication"),
        ("General Advice: rest\nMEDICATION: a [500 mg]", "Medication"),
        ("General Advice: rest. Medication: a [500 mg]", "Medication"),
        ("General Advice: rest\nMed\u200bication: a [500 mg]", "Medication"),
        ("General Advice: rest\nRefer\u200d to\u2060: ENT [urgent]", "Refer to"),
        ("[S1] opening\nGeneral Advice: rest", "unattributed"),
    ]
    failed = []
    for text, head in probes:
        _, rem = sanitize_note_ex(text)
        if f"FRX-L1 bracket span removed from {head}" not in note_mod.span_errors(rem):
            failed.append(text)
    return failed


@pytest.mark.parametrize("which", ["no_cf", "no_casefold", "no_anywhere", "unattributed_benign"])
def test_fx2_mutation_is_caught(monkeypatch, which):
    assert _kills(monkeypatch, which), f"mutant {which} survived"


# --- FIX3: fail closed on the SPAN. Benign only if the content is a speaker label AND the line is not an order line. ---
VARIANT_HEADS = ["Follow-up", "Followup", "Follow Up", "Investigations", "Investigation", "Further Investigations", "Referral", "Referred to",
                 "Refer", "Medications", "Medicines", "Medicine", "Rx", "Tab", "Prescription", "Drugs", "Procedure", "Surgery", "Review",
                 "М\u0435dication", "Medicati\u00f3n", "Medicatio\u0301n"]
LAYOUTS = {"col0": "{h}: {b}", "indent": "   {h}: {b}", "no_sep": "{h} {b}", "dash": "{h} - {b}", "inline": "General Advice: rest; {h}: {b}",
           "tab": "\t{h}: {b}"}
ALLOWED = ["[S1]", "[s1]", "[ S12 ]", "[S123]", "[\u200bS1]", "[\uff33\uff11]", "[ s  1 ]".replace("  ", " ").replace(" 1", "1")]
HARMFUL = ["[500 mg]", "[three times a day]", "[dose]", "[Name]", "[frequency?]", "[dose/frequency]", "[]", "[ ]", "[?]", "[see note]", "[1]",
           "[S]", "[S1234]", "[S1|doctor]", "[S0|doctor]", "[S 1 2]", "[do\u200bse]", "[d\u00adose]", "[\uff44\uff4f\uff53\uff45]", "[Dose:]",
           "[\u0455\u0031]", "[S\u0661]", "[dose not stated \u2014 doctor to verify]", "[x", "[[S1]", "[urgent]", "[left knee]"]


def _all_lines():
    for h in HEADINGS + VARIANT_HEADS:
        for ln, tpl in LAYOUTS.items():
            yield h, ln, tpl


def test_fx3_every_non_allowlisted_span_rejects_everywhere():
    n = 0
    for h, ln, tpl in _all_lines():
        for sp in HARMFUL:
            for text in (f"General Advice: rest\n" + tpl.format(h=h, b=f"item {sp} x 3 days"), tpl.format(h=h, b=f"item {sp}"),
                         f"Examination: ok\n" + tpl.format(h=h, b=f"{sp} item")):
                _, removed = sanitize_note_ex(text)
                if not removed:  # an unbalanced '[x' is not a span; nothing was removed
                    assert "]" not in sp or sp == "[[S1]", (sp, text)
                    continue
                errs = span_errors(removed)
                assert errs and all(e.startswith("FRX-L1 bracket span removed from ") for e in errs), (h, ln, sp, repr(text), errs)
                n += 1
    assert n > 3000


def test_fx3_empty_and_before_any_heading():
    for text in ("[] opening\nGeneral Advice: rest", "General Advice: rest []", "[500 mg] x\nExamination: a", "preamble [do\u200bse]\nMedication: x"):
        assert span_errors(sanitize_note_ex(text)[1]), text
    assert span_errors(sanitize_note_ex("[dose] hi")[1]) == ["FRX-L1 bracket span removed from unattributed"]


@pytest.mark.parametrize("head", NON_ORDER)
def test_fx3_speaker_label_posts_only_on_a_non_order_line(head):
    for sp in ALLOWED:
        for tpl in ("{h}: keep warm {s}", "  {h}: {s} keep warm", "{h}: a\n{s} more", "- {h} : {s} b"):
            _, removed = sanitize_note_ex(tpl.format(h=head, s=sp))
            assert removed and span_errors(removed) == [], (head, sp, tpl, removed)
    _, removed = sanitize_note_ex(f"{head}: keep warm [S1] [dose]")
    assert span_errors(removed) == [f"FRX-L1 bracket span removed from {head}"]


@pytest.mark.parametrize("head", sorted(ORDER_HEADINGS))
def test_fx3_speaker_label_never_posts_on_an_order_line(head):
    for sp in ALLOWED:
        for tpl in ("{h}: x {s}", "General Advice: a\n{h}: x\n{s} more", "[S1] {h}: x {s}", "General Advice: a; {h}: {s}"):
            _, removed = sanitize_note_ex(tpl.format(h=head, s=sp))
            assert f"FRX-L1 bracket span removed from {head}" in span_errors(removed), (head, sp, tpl)


def test_fx3_posted_text_is_byte_identical_to_base_for_every_span_class():
    r = random.Random(33)
    pool = HARMFUL + ALLOWED
    for _ in range(600):
        h = r.choice(HEADINGS + VARIANT_HEADS)
        tpl = r.choice(list(LAYOUTS.values()))
        text = "\n".join(tpl.format(h=r.choice([h] + HEADINGS), b=f"w {r.choice(pool)} z {r.choice(pool)}") for _ in range(3))
        assert sanitize_note_ex(text)[0] == base.sanitize_note(text) == sanitize_note(text)


@pytest.mark.parametrize("head", VARIANT_HEADS)
@pytest.mark.parametrize("layout", ["{h}: {b}", "{h} - {b}", "{h} {b}", "General Advice: rest; {h}: {b}"])
def test_fx3_verdict3_variant_heading_probes_never_post_the_trimmed_line(tmp_path, head, layout):
    extra = layout.format(h=head, b="paracetamol 1 g three times a day x 3 days [500 mg]")
    lg, od = _extra_line(tmp_path, extra)
    assert "FRX-L1 bracket span removed from General Advice" in lg["llm_note_errors"] or any(e.startswith("FRX-L1") for e in lg["llm_note_errors"])
    assert lg["note_source"] == "deterministic_fallback" and "[500 mg]" not in lg["artifact"]["note_text"]


def test_fx3_verdict3_prose_probe_and_field_word_variants(tmp_path):
    lg, _ = _llm_with(tmp_path, "General Advice: Drink plenty of water; Take rest",
                      "General Advice: Drink plenty of water; paracetamol 1 g [three times a day] if fever")
    assert lg["note_source"] == "deterministic_fallback" and any(e.startswith("FRX-L1") for e in lg["llm_note_errors"])
    for sp in ("[do\u200bse]", "[d\u00adose]", "[\uff44\uff4f\uff53\uff45]", "[Dose:]", "[frequency?]", "[dose/frequency]"):
        lg, _ = _llm_with(tmp_path / str(abs(hash(sp))), "General Advice: Drink", f"General Advice: {sp} Drink")
        assert lg["note_source"] == "deterministic_fallback", sp


def test_fx3_colon_map_is_exercised():
    for colon in ("\u2236", "\ua789", "\u02d0"):
        _, removed = sanitize_note_ex(f"General Advice: rest\nMedication{colon} a [S1]")
        assert span_errors(removed) == ["FRX-L1 bracket span removed from Medication"], colon


def test_fx3_s_label_in_a_full_pipeline_still_posts_with_count(tmp_path):
    lg, _ = _llm_with(tmp_path, "General Advice: Drink plenty of water; Take rest", "General Advice: [ s12 ] Drink plenty of water; Take rest")
    assert lg["final_valid"] and lg["note_source"].startswith("llm_") and lg["sanitize_removed"] == 1


# --- FIX3 mutations: each must fail at least one probe ---
def _fx3_probes():
    out = []
    for text, benign in (("General Advice: rest [S1]", True), ("General Advice: rest [s1]", True), ("General Advice: rest [ S12 ]", True),
                         ("General Advice: rest [\uff33\uff11]", True), ("General Advice: rest [\u200bS1]", True),
                         ("General Advice: rest [500 mg]", False), ("General Advice: rest []", False), ("Examination: a [urgent]", False),
                         ("Follow-up: x [500 mg]", False), ("Rx: x [500 mg]", False), ("Medication - x [S1]", False),
                         ("General Advice: rest [S1|doctor]", False), ("General Advice: rest [do\u200bse]", False),
                         ("Medication: x [S1]", False), ("Follow up: x [S1]", False)):
        out.append((text, benign))
    return out


def _fx3_wrong(monkeypatch=None):
    wrong = []
    for text, benign in _fx3_probes():
        got = note_mod.span_errors(sanitize_note_ex(text)[1]) == []
        if got != benign:
            wrong.append(text)
    return wrong


def test_fx3_probes_pass_unmutated():
    assert _fx3_wrong() == []


def _spk_key_no_nfkc(span):
    s = span.strip()[1:-1]
    s = "".join(c for c in s if unicodedata.category(c) != "Cf")
    return re.sub(r"\s+", " ", s).strip().casefold()


def _spk_key_no_casefold(span):
    s = span.strip()[1:-1]
    s = unicodedata.normalize("NFKC", "".join(c for c in s if unicodedata.category(c) != "Cf"))
    return re.sub(r"\s+", " ", s).strip()


@pytest.mark.parametrize("which", ["widen_any", "no_nfkc", "no_casefold", "no_order_check", "line_only"])
def test_fx3_mutation_is_caught(monkeypatch, which):
    if which == "widen_any":
        monkeypatch.setattr(note_mod, "SPAN_ALLOWLIST", re.compile(r".*"))
    elif which == "no_nfkc":
        monkeypatch.setattr(note_mod, "_span_key", _spk_key_no_nfkc)
    elif which == "no_casefold":
        monkeypatch.setattr(note_mod, "_span_key", _spk_key_no_casefold)
    elif which == "no_order_check":  # drop A1(b): attribution ignored
        real = note_mod.span_errors
        monkeypatch.setattr(note_mod, "span_errors", lambda rem: real([("General Advice", s) for _, s in rem]))
    elif which == "line_only":  # restore FIX2 line-only classification
        def old(removed):
            heads = []
            for head, span in removed:
                if head is None or head in ORDER_HEADINGS or span.strip("[] \t").lower() in _D4_FIELDS:
                    h = head or "unattributed"
                    if h not in heads:
                        heads.append(h)
            return [f"FRX-L1 bracket span removed from {h}" for h in heads]
        monkeypatch.setattr(note_mod, "span_errors", old)
    assert _fx3_wrong(), f"mutant {which} survived"
