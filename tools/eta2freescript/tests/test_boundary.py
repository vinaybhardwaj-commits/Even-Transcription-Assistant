"""Clip-boundary guard signals."""
from conftest import mk_consult

from tools.eta2freescript.boundary import detect
from tools.eta2freescript.ingest import RoleFlags

ROLES = {"0": "doctor", "1": "patient", "2": "patient"}


def knee_like(flags=None, clip_s=200):
    lines = [(0, 7, "0", "continue the tablet"), (8, 13, "2", "thank you"), (14, 16, "0", "take care"),
             (70, 80, "0", "come in"), (81, 120, "1", "my knee hurts"), (121, 180, "0", "apply this"), (181, 195, "1", "okay")]
    return mk_consult(lines, roles=ROLES, flags=flags or RoleFlags(), clip_s=clip_s)


def test_clean_consult_has_no_boundary():
    c = mk_consult([(0, 5, "0", "hello"), (6, 20, "1", "fever"), (21, 40, "0", "take this")], roles=ROLES)
    b = detect(c)
    assert not b.suspected and not b.quarantined and b.reasons == []


def test_two_consults_with_gap_quarantines_minor_side():
    b = detect(knee_like(RoleFlags(two_consults=True, gap_at_s=60)))
    assert b.quarantined >= {0, 1, 2} and not b.quarantined & {3, 4, 5, 6}
    assert "role_track_two_consults" in b.reasons


def test_two_consults_without_gap_only_flags():
    c = mk_consult([(0, 5, "0", "hello"), (6, 20, "1", "fever")], roles=ROLES, flags=RoleFlags(two_consults=True))
    b = detect(c)
    assert b.suspected and not b.quarantined and b.reasons == ["role_track_two_consults:no_gap"]


def test_two_consults_gap_outside_clip_only_flags():
    c = mk_consult([(0, 5, "0", "hello"), (6, 20, "1", "fever")], roles=ROLES, flags=RoleFlags(two_consults=True, gap_at_s=500))
    b = detect(c)
    assert b.reasons == ["role_track_two_consults:gap_outside_clip"] and not b.quarantined


def test_second_patient_voice_at_the_edge_is_quarantined():
    b = detect(knee_like())
    assert "second_patient_voice" in b.reasons and {0, 1} <= b.quarantined


def test_second_patient_voice_at_the_end():
    lines = [(0, 10, "0", "hello"), (11, 100, "1", "pain"), (101, 140, "0", "plan"), (141, 143, "1", "ok"), (190, 195, "2", "hello doctor")]
    b = detect(mk_consult(lines, roles=ROLES, clip_s=200))
    assert "second_patient_voice" in b.reasons and b.quarantined == {4}


def test_interleaved_second_patient_only_flags():
    lines = [(0, 10, "0", "hello"), (11, 40, "1", "pain"), (41, 60, "2", "me too"), (61, 100, "1", "more"), (101, 140, "0", "plan")]
    b = detect(mk_consult(lines, roles=ROLES, clip_s=150))
    assert "second_patient_voice:interleaved" in b.reasons and not b.quarantined


def test_second_patient_needs_a_role_track():
    b = detect(mk_consult([(0, 5, "2", "bye"), (60, 200, "1", "pain")], roles=ROLES, role_track=False, clip_s=210))
    assert "second_patient_voice" not in " ".join(b.reasons)


def test_long_gap_with_a_stranger_is_quarantined():
    lines = [(0, 5, "3", "next month then"), (60, 120, "0", "come in"), (121, 190, "1", "my back")]
    b = detect(mk_consult(lines, roles={"0": "doctor", "1": "patient", "3": "unknown"}, clip_s=200))
    assert "long_gap" in b.reasons and b.quarantined == {0}


def test_long_gap_without_confirmation_only_flags():
    lines = [(0, 5, "0", "one moment"), (60, 120, "0", "so"), (121, 190, "1", "my back")]
    b = detect(mk_consult(lines, roles={"0": "doctor", "1": "patient"}, clip_s=200))
    assert b.reasons == ["long_gap:unconfirmed"] and not b.quarantined


def test_long_gap_confirmed_by_stage_a_foreign_turn():
    lines = [(0, 5, "0", "one moment"), (60, 120, "0", "so"), (121, 190, "1", "my back")]
    b = detect(mk_consult(lines, roles={"0": "doctor", "1": "patient"}, clip_s=200), {"suspected": True, "foreign_turns": [0]})
    assert "long_gap" in b.reasons and "stage_a_topic" in b.reasons and b.quarantined == {0}


def test_stage_a_topic_and_unlocalised():
    c = mk_consult([(0, 5, "0", "a"), (6, 20, "1", "b"), (21, 40, "0", "c")], roles=ROLES)
    b = detect(c, {"suspected": True, "foreign_turns": [2, 99, "x"]})
    assert b.reasons == ["stage_a_topic"] and b.quarantined == {2}
    b = detect(c, {"suspected": True, "foreign_turns": []})
    assert b.reasons == ["stage_a_topic:unlocalised"] and b.suspected and not b.quarantined


def test_as_json_shape():
    b = detect(knee_like(RoleFlags(two_consults=True, gap_at_s=60)))
    j = b.as_json()
    assert set(j) == {"suspected", "quarantined_turns", "reasons"} and j["quarantined_turns"] == sorted(j["quarantined_turns"])
