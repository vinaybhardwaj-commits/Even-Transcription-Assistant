"""Clip-boundary guard signals."""
from conftest import mk_consult

from tools.eta2freescript.boundary import detect
from tools.eta2freescript.ingest import RoleFlags

ROLES = {"0": "doctor", "1": "patient", "2": "patient"}


def knee_like(flags=None, clip_s=200):
    lines = [(0, 7, "0", "continue the tablet"), (8, 13, "2", "I will come next month for my sugar."), (14, 16, "0", "take care"),
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
    lines = [(0, 10, "0", "hello"), (11, 100, "1", "pain"), (101, 140, "0", "plan"), (141, 143, "1", "ok"), (190, 195, "2", "I have had a fever since yesterday.")]
    c = mk_consult(lines, roles=ROLES, clip_s=200)
    b = detect(c)
    assert "second_patient_voice:unconfirmed" in b.reasons and not b.quarantined
    b = detect(c, {"suspected": True, "foreign_turns": [4]})
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
    lines = [(0, 5, "0", "The old knee is still swollen."), (60, 120, "0", "so"), (121, 190, "1", "my back")]
    b = detect(mk_consult(lines, roles={"0": "doctor", "1": "patient"}, clip_s=200))
    assert b.reasons == ["long_gap:unconfirmed"] and not b.quarantined


def test_edge_admin_talk_does_not_flag():
    lines = [(0, 3, "0", "One moment."), (60, 120, "0", "so"), (121, 190, "1", "my back")]
    b = detect(mk_consult(lines, roles={"0": "doctor", "1": "patient"}, clip_s=200))
    assert not b.suspected and not b.quarantined
    b = detect(mk_consult(lines, roles={"0": "doctor", "1": "patient"}, clip_s=200), {"suspected": True, "foreign_turns": [0]})
    assert not b.suspected and not b.quarantined


def test_long_gap_confirmed_by_stage_a_foreign_turn():
    lines = [(0, 5, "0", "That was for the previous patient."), (60, 120, "0", "so"), (121, 190, "1", "my back")]
    b = detect(mk_consult(lines, roles={"0": "doctor", "1": "patient"}, clip_s=200), {"suspected": True, "foreign_turns": [0]})
    assert "long_gap" in b.reasons and "stage_a_topic" in b.reasons and b.quarantined == {0}


def test_long_side_previous_patient_does_not_quarantine_the_current_one():
    """The previous consult is the long side. Stage A marks it foreign and leaves the short side as this patient."""
    lines = [(0, 40, "2", "My reflux is back."), (41, 80, "0", "I am referring you to gastro and the diagnosis is reflux. Avoid spice."),
             (81, 120, "2", "Thank you, see you next month."), (170, 185, "1", "My knee hurts."), (186, 195, "0", "Get an X-ray.")]
    roles = {"0": "doctor", "1": "patient", "2": "patient"}
    c = mk_consult(lines, roles=roles, clip_s=200)
    foreign = [0, 1, 2]
    b = detect(c, {"suspected": True, "foreign_turns": foreign})
    assert b.quarantined == {0, 1, 2}
    assert 3 not in b.quarantined and 4 not in b.quarantined


def test_long_gap_does_not_quarantine_turns_stage_a_left_current():
    lines = [(0, 4, "2", "See you next month for the reflux."), (5, 8, "0", "Come in, what happened to the knee?"),
             (60, 140, "1", "It hurts on stairs."), (141, 190, "0", "Get an X-ray.")]
    c = mk_consult(lines, roles={"0": "doctor", "1": "patient", "2": "patient"}, clip_s=200)
    b = detect(c, {"suspected": True, "foreign_turns": [0]})
    assert 0 in b.quarantined and 1 not in b.quarantined


def test_late_short_side_without_labels_is_only_flagged():
    lines = [(0, 40, "1", "My reflux is back."), (41, 90, "0", "I am referring you to gastro."), (140, 150, "2", "Doctor my knee hurts badly.")]
    b = detect(mk_consult(lines, roles={"0": "doctor", "1": "patient", "2": "patient"}, clip_s=160))
    assert "long_gap:unconfirmed" in b.reasons and not b.quarantined


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
