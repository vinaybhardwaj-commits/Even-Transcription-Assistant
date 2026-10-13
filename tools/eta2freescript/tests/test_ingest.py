"""Ingest: role-track join, flags, fallbacks, native-only transcripts."""
import json
import shutil

import pytest
from conftest import CONSULTS, T0, mk_consult

from tools.eta2freescript.ingest import (RoleFlags, Turn, apply_inferred_roles, format_transcript, join_roles, list_consults,
                                         load_consult, parse_role_flags, valid_role_doc)


def turns(*spans):
    return [Turn(idx=i, t0_ms=a, t1_ms=b, speaker=sp, text="x") for i, (a, b, sp) in enumerate(spans)]


def doc(segs, extras=None):
    return {"layer": "role", "engine": "llm-roles", "status": "ok", "config_hash": "cfg", "segments": segs, "extras": extras or {}}


def test_exact_key_join():
    ts = turns((0, 1000, "0"), (1000, 2000, "1"))
    join_roles(ts, doc([{"t0_ms": 0, "t1_ms": 1000, "speaker": "0", "role": "doctor"}, {"t0_ms": 1000, "t1_ms": 2000, "speaker": "1", "role": "patient"}]))
    assert [t.role for t in ts] == ["doctor", "patient"] and {t.role_source for t in ts} == {"role_track"}


def test_overlap_join_same_speaker_only():
    ts = turns((0, 1000, "0"), (1100, 2000, "1"))
    join_roles(ts, doc([{"t0_ms": 200, "t1_ms": 1300, "speaker": "0", "role": "doctor"}, {"t0_ms": 1000, "t1_ms": 2100, "speaker": "1", "role": "attender"}]))
    assert [t.role for t in ts] == ["doctor", "attendant"]


def test_map_then_unknown_fallback():
    ts = turns((0, 1000, "0"), (5000, 6000, "1"), (7000, 8000, "2"))
    join_roles(ts, doc([], {"map": {"0": "staff", "1": "other"}}))
    assert [t.role for t in ts] == ["staff", "other", "unknown"]


def test_label_is_capped_and_ordinary_labels_unchanged():
    from tools.eta2freescript.ingest import MAX_LABEL_CHARS, _label
    assert MAX_LABEL_CHARS == 128
    assert len(_label("a" * 300)) == 128
    assert _label("SPEAKER_00") == "SPEAKER_00"


def test_map_keys_are_normalised_like_labels():
    from tools.eta2freescript.ingest import _label
    ts = turns((0, 1000, _label("0\n1")))
    join_roles(ts, doc([], {"map": {"0\n1": "doctor"}}))
    assert ts[0].role == "doctor"


def test_numeric_speaker_labels_and_bad_roles():
    ts = turns((0, 1000, "0"))
    join_roles(ts, doc([{"t0_ms": 0, "t1_ms": 1000, "speaker": 0, "role": "nurse"}]))
    assert ts[0].role == "unknown"


def test_flag_parsing_both_two_consults_shapes():
    f = parse_role_flags(doc([], {"attender_present": True, "two_consults": {"flag": True, "gap_at_s": 61.5}, "diar_partial": False}))
    assert (f.attender_present, f.two_consults, f.gap_at_s, f.diar_partial, f.config_hash) == (True, True, 61.5, False, "cfg")
    f = parse_role_flags(doc([], {"two_consults": True}))
    assert f.two_consults is True and f.gap_at_s is None
    assert parse_role_flags({"extras": "junk"}) == RoleFlags()


@pytest.mark.parametrize("bad", [None, {}, {"status": "error", "segments": []}, {"status": "ok"},
                                 {"status": "ok", "segments": [], "engine": "pyannote"}])
def test_invalid_role_docs(bad):
    assert not valid_role_doc(bad)


def test_role_track_consult_loads_with_overlap_join():
    c = load_consult(CONSULTS, "synth-fever-dose")
    assert c.role_track and c.speaker_source == "role_track"
    assert {t.role for t in c.turns} == {"doctor", "patient"}
    assert c.english_source == "native" and c.room == "synth-room-1"


def test_invalid_role_track_falls_back_to_inferred(tmp_path):
    shutil.copytree(CONSULTS / "synth-fever-dose", tmp_path / "u1")
    (tmp_path / "u1" / "role.json").write_text(json.dumps({"status": "error"}))
    c = load_consult(tmp_path, "u1")
    assert not c.role_track and c.speaker_source == "model_inferred" and c.role_flags is None
    assert load_consult(CONSULTS, "synth-fever-dose", use_role_track=False).speaker_source == "model_inferred"


def test_native_only_transcript():
    c = load_consult(CONSULTS, "synth-cough-native")
    assert c.english_source == "none:native-hi" and c.lang == "hi" and {t.lang for t in c.turns} == {"hi"}
    with pytest.raises(ValueError, match="english_segments"):
        load_consult(CONSULTS, "synth-cough-native", english="on")


def test_english_off_prefers_native_when_present(tmp_path):
    d = tmp_path / "u2"
    d.mkdir()
    seg = {"t0_ms": T0, "t1_ms": T0 + 1000, "speaker_id": "0"}
    (d / "transcript.json").write_text(json.dumps({"consult_uid": "u2", "language_code": "hi-IN", "model_translate": "mt-x",
                                                   "english_segments": [seg | {"text": "fever"}],
                                                   "native_segments": [seg | {"text": "bukhar", "lang": "hi"}]}))
    assert load_consult(tmp_path, "u2").english_source == "mt:mt-x"
    off = load_consult(tmp_path, "u2", english="off")
    assert off.english_source == "none:native-hi" and off.turns[0].text == "bukhar"


def test_empty_transcript_raises(tmp_path):
    (tmp_path / "u3").mkdir()
    (tmp_path / "u3" / "transcript.json").write_text(json.dumps({"consult_uid": "u3", "english_segments": [{"t0_ms": 0, "t1_ms": 1, "text": " "}]}))
    with pytest.raises(ValueError):
        load_consult(tmp_path, "u3")


def test_inferred_roles_respect_confidence_and_track():
    c = mk_consult([(0, 1, "0", "a"), (2, 3, "1", "b"), (4, 5, "2", "c")], role_track=False)
    apply_inferred_roles(c.turns, [{"speaker": "S0", "role": "doctor", "confidence": 0.9}, {"speaker": "S1", "role": "attender", "confidence": 0.6},
                                   {"speaker": "S2", "role": "patient", "confidence": 0.3}])
    assert [t.role for t in c.turns] == ["doctor", "attendant", "unknown"]
    assert {t.role_source for t in c.turns} == {"model_inferred"}
    tr = mk_consult([(0, 1, "0", "a")], roles={"0": "doctor"})
    apply_inferred_roles(tr.turns, [{"speaker": "S0", "role": "patient", "confidence": 1.0}])
    assert tr.turns[0].role == "doctor"


def test_format_transcript_shows_track_roles_and_quarantine():
    tr = mk_consult([(0, 1, "0", "hello"), (65, 66, "1", "hi")], roles={"0": "doctor", "1": "patient"})
    lines = format_transcript(tr, {1}).split("\n")
    assert lines[0] == "T0 [S0|doctor] (00:00) hello"
    assert lines[1] == "T1 [S1|patient] (01:05) [QUARANTINED: possible other consult] hi"
    inf = mk_consult([(0, 1, "0", "hello")], role_track=False)
    assert format_transcript(inf) == "T0 [S0] (00:00) hello"


def test_list_consults_only_dirs_with_transcripts(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "transcript.json").write_text("{}")
    (tmp_path / "b").mkdir()
    (tmp_path / "_eta2freescript").mkdir()
    assert list_consults(tmp_path) == ["a"]
    assert list_consults(CONSULTS) == ["synth-boundary-knee", "synth-cough-native", "synth-fever-dose"]


def test_label_never_contains_a_line_break_or_control():
    import unicodedata
    from tools.eta2freescript.ingest import _label
    bad = ("Cc", "Zl", "Zp")
    for v in ("0\n1", "\r\nSPEAKER_00", "a b", "a b", "a\x0bb\x0cc\x85d\x00e"):
        out = _label(v)
        assert not any(unicodedata.category(c) in bad for c in out), repr(v)
    assert _label("0\n1") == "0 1"
    assert _label("a b") == "a b"
    assert _label("SPEAKER_00") == "SPEAKER_00"
    assert _label(3) == "3"
    assert _label(True) is None


def test_label_caps_every_type():
    from tools.eta2freescript.ingest import MAX_LABEL_CHARS, _label
    assert MAX_LABEL_CHARS == 128
    for v in (10**2400, -(10**3000), int("9" * 4300), 1e300):
        out = _label(v)
        assert isinstance(out, str) and len(out) <= 128, type(v)
    assert _label(7) == "7"
