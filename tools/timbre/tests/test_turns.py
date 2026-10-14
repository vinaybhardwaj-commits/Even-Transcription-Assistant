"""Turn building, roles, aggregation and benchmark helpers. Pure Python, no models, no network."""

from __future__ import annotations

import json
import math

import pytest

from tools.timbre import turns as T
from tools.timbre import turns_bench as B

T0 = 1_789_041_703_000  # tape_utc epoch ms of the clip start


def _rs(p):
    return (p["role"], p["role_source"])


def seg(speaker, a_s, b_s):
    return {"speaker": speaker, "t0_ms": T0 + int(a_s * 1000), "t1_ms": T0 + int(b_s * 1000)}


def test_epoch_ms_offset_is_t0_ms_minus_manifest_t0():
    assert T.clip_offset_s(T0 + 12_500, T0) == 12.5
    clip = T.segments_to_clip([seg("a", 3.0, 8.0)], T0)
    assert clip == [(3.0, 8.0, "a")]
    # a clip-relative reading of epoch ms would be wildly outside the clip
    assert T.segments_to_clip([{"speaker": "a", "t0_ms": 3000, "t1_ms": 8000}], T0, duration_s=60) == []


def test_segments_clipped_to_duration():
    out = T.segments_to_clip([seg("a", 55, 70)], T0, duration_s=60)
    assert out == [(55.0, 60.0, "a")]


def test_merge_gap_under_half_second_joins_and_larger_gap_does_not():
    segs = [(0.0, 2.0, "a"), (2.4, 4.0, "a"), (4.6, 6.0, "a")]  # gaps 0.4 (merge), 0.6 (keep)
    out = T.merge_same_speaker(segs)
    assert out == [(0.0, 4.0, "a"), (4.6, 6.0, "a")]


def test_merge_gap_exactly_half_second_is_not_merged():
    assert len(T.merge_same_speaker([(0.0, 1.0, "a"), (1.5, 3.0, "a")])) == 2


def test_merge_keeps_speakers_apart_and_joins_across_an_interjection():
    segs = [(0.0, 3.0, "a"), (3.1, 3.4, "b"), (3.2, 6.0, "a")]
    out = T.merge_same_speaker(segs)
    assert (0.0, 6.0, "a") in out and (3.1, 3.4, "b") in out


def test_drop_turns_under_1_5_s():
    turns = [(0.0, 1.4, "a"), (2.0, 3.5, "a"), (5.0, 9.0, "b")]
    assert T.drop_short(turns) == [(2.0, 3.5, "a"), (5.0, 9.0, "b")]


def test_split_over_30_s_into_30_s_chunks_and_drop_tiny_tail():
    out = T.split_long([(0.0, 75.0, "a")])
    assert out == [(0.0, 30.0, "a"), (30.0, 60.0, "a"), (60.0, 75.0, "a")]
    out = T.split_long([(0.0, 61.0, "a")])  # tail of 1 s is under the minimum
    assert out == [(0.0, 30.0, "a"), (30.0, 60.0, "a")]
    assert T.split_long([(0.0, 30.0, "a")]) == [(0.0, 30.0, "a")]


def test_overlap_fraction_counts_union_of_other_speakers_only():
    raw = [(0.0, 10.0, "a"), (2.0, 4.0, "b"), (3.0, 5.0, "b"), (8.0, 12.0, "a")]
    # b covers 2..5 = 3 s of a's 0..10
    assert T.overlap_fraction((0.0, 10.0, "a"), raw) == pytest.approx(0.3)
    # own speaker never counts
    assert T.overlap_fraction((8.0, 12.0, "a"), raw) == 0.0
    assert T.overlap_fraction((20.0, 22.0, "a"), raw) == 0.0


def test_build_turns_end_to_end():
    segs = [seg("s0", 0, 2), seg("s0", 2.3, 5), seg("s1", 4, 4.5), seg("s1", 10, 10.8), seg("s0", 20, 100)]
    turns = T.build_turns(segs, T0, duration_s=120)
    spk = [(t["speaker"], t["t0_s"], t["t1_s"]) for t in turns]
    assert ("s0", 0.0, 5.0) in spk  # merged
    assert not any(t["speaker"] == "s1" for t in turns)  # both s1 pieces under 1.5 s
    long_ = [t for t in turns if t["t0_s"] >= 20]
    assert [round(t["dur_s"]) for t in long_] == [30, 30, 20]
    first = next(t for t in turns if t["t0_s"] == 0.0)
    assert first["overlap_frac"] == pytest.approx(0.1)  # 0.5 s of 5 s
    assert [t["turn"] for t in turns] == list(range(len(turns)))


def test_roles_by_most_overlap_else_unknown():
    raw = [(0.0, 10.0, "n0"), (10.0, 20.0, "n1"), (30.0, 40.0, "n2")]
    roles = [(0.0, 9.0, "doctor"), (9.0, 12.0, "patient"), (12.0, 20.0, "patient")]
    got = T.assign_roles(raw, roles)
    assert got == {"n0": ("doctor", 0.9), "n1": ("patient", 1.0), "n2": None}
    layered = T.assign_roles_layered(raw, [("text-judge", roles)])
    assert layered["n2"] == ("unknown", None, None) and layered["n0"] == ("doctor", "overlap:text-judge", 0.9)


def test_norm_role_maps_attender_variants_and_rejects_unknown_labels():
    assert T.norm_role("attendant") == "other" and T.norm_role("Doctor") == "doctor"
    assert T.norm_role("voiceprint") is None


def _row(dur, overlap, **scores):
    return {"t0_s": 0.0, "dur_s": dur, "overlap_frac": overlap, "scores": scores}


def test_aggregate_excludes_overlapped_and_reports_seconds():
    rows = [
        _row(2.0, 0.0, **{"odyssey.arousal": 0.4}),
        _row(4.0, 0.1, **{"odyssey.arousal": 0.6}),
        _row(3.0, 0.9, **{"odyssey.arousal": 0.99}),  # overlapped, excluded
        _row(2.0, 0.0, **{"odyssey.arousal": 0.8}),
    ]
    agg = T.aggregate_person(rows, "odyssey.arousal")
    assert agg["value"] == pytest.approx(0.6)
    assert agg["n_turns"] == 3 and agg["seconds"] == pytest.approx(8.0)
    assert agg["overlap_excluded_s"] == pytest.approx(3.0)
    assert agg["iqr"] == pytest.approx(0.2)


def test_aggregate_returns_none_not_zero_for_unscorable_person():
    rows = [_row(2.0, 0.0, **{"odyssey.arousal": None}), _row(2.0, 0.95, **{"odyssey.arousal": 0.5})]
    assert T.aggregate_person(rows, "odyssey.arousal") is None
    assert T.feature_rows("c", {"speaker": "s", "role": "doctor", "role_source": "overlap:role.llm-roles", "role_overlap_frac": 1.0}, rows, ["odyssey.arousal"], {}, "r", "g") == []


def test_reliability_stays_null_until_measured():
    assert T.reliability_lookup(None, "odyssey.arousal", "doctor") is None
    assert T.reliability_lookup({}, "odyssey.arousal", "doctor") is None
    assert T.reliability_lookup({"odyssey.arousal|doctor": None}, "odyssey.arousal", "doctor") is None
    assert T.reliability_lookup({"odyssey.arousal|doctor": float("nan")}, "odyssey.arousal", "doctor") is None
    assert T.reliability_lookup({"odyssey.arousal|doctor": 0.52}, "odyssey.arousal", "doctor") == 0.52
    assert T.reliability_lookup({"odyssey.arousal|doctor": 0.52}, "odyssey.arousal", "patient") is None
    rows = [_row(2.0, 0.0, **{"odyssey.arousal": 0.5})]
    person = {"speaker": "s", "role": "patient", "role_source": "overlap:role.llm-roles", "role_overlap_frac": 1.0}
    out = T.feature_rows("c", person, rows, ["odyssey.arousal"], {"odyssey": {"model_id": "m", "model_rev": "r"}}, "run", "sha")
    assert out[0]["reliability"] is None and out[0]["stat"] == "median"
    out = T.feature_rows("c", person, rows, ["odyssey.arousal"], {}, "run", "sha", {"odyssey.arousal|patient": 0.45})
    assert out[0]["reliability"] == 0.45


def test_spearman_basic_and_degenerate():
    assert T.spearman([1, 2, 3, 4], [10, 20, 30, 40]) == pytest.approx(1.0)
    assert T.spearman([1, 2, 3, 4], [4, 3, 2, 1]) == pytest.approx(-1.0)
    assert T.spearman([1, 1, 1], [1, 2, 3]) is None
    assert T.spearman([1, 2], [1, 2]) is None


def _person_turns(vals, role="patient", bench="b01", sp="s0"):
    return [
        {"kind": "turn", "bench_id": bench, "speaker": sp, "role": role, "t0_s": float(i * 10), "t1_s": float(i * 10 + 5),
         "dur_s": 5.0, "overlap_frac": 0.0, "scores": {"odyssey.arousal": v}, "status": {"odyssey": "ok"}}
        for i, v in enumerate(vals)
    ]


def test_split_half_person_odd_even_medians_and_minimum():
    tr = _person_turns([1, 2, 3, 4, 5, 6])
    # position 0,2,4 -> 1,3,5 ; 1,3,5 -> 2,4,6
    assert T.split_half_person(tr, "odyssey.arousal") == (3, 4)
    assert T.split_half_person(_person_turns([1, 2, 3]), "odyssey.arousal") is None


def test_b1_perfectly_stable_persons_score_high_and_noise_scores_low():
    rows = []
    for i in range(8):
        level = i / 10.0
        rows += _person_turns([level, level + 0.001, level, level + 0.001], bench=f"b{i:02d}")
    res = B.b1_split_half(rows, ["odyssey.arousal"])
    r = res["odyssey.arousal|patient"]
    assert r["n_persons"] == 8 and r["spearman"] == pytest.approx(1.0) and r["pass"] is True
    rows = []
    # odd turns carry the signal, even turns are anti-ordered noise
    for i in range(8):
        rows += _person_turns([i / 10, (7 - i) / 10, i / 10, (7 - i) / 10], bench=f"b{i:02d}")
    res = B.b1_split_half(rows, ["odyssey.arousal"])
    assert res["odyssey.arousal|patient"]["pass"] is False


def test_b2_cross_model_agreement():
    rows = []
    for i in range(10):
        r = _person_turns([0.1 * i])[0]
        r["turn"] = i
        r["scores"] = {"odyssey.arousal": 0.1 * i, "audeering.arousal": 0.2 * i + 0.05}
        rows.append(r)
    res = B.b2_cross_model(rows)
    assert res["arousal|all"]["spearman"] == pytest.approx(1.0) and res["arousal|all"]["n_turns"] == 10


def test_b4_role_separation_orders_roles():
    rows = []
    for i in range(4):
        rows += _person_turns([0.8, 0.8], role="doctor", bench=f"d{i}")
        rows += _person_turns([0.2, 0.2], role="patient", bench=f"p{i}")
    res = B.b4_role_separation(rows, ["odyssey.arousal"])["odyssey.arousal"]
    assert res["doctor_gt_patient_auc"] == 1.0
    assert res["by_role"]["doctor"]["median"] == pytest.approx(0.8)


def test_reliability_table_only_contains_measured_pairs():
    b1 = {"odyssey.arousal|patient": {"spearman": 0.5}, "odyssey.valence|patient": {"spearman": None}}
    assert B.reliability_table(b1) == {"odyssey.arousal|patient": 0.5}


def test_log_payload_roundtrip_and_tamper(tmp_path, capsys):
    f = tmp_path / "x.jsonl"
    f.write_text("\n".join(json.dumps({"i": i, "v": i / 7}) for i in range(500)) + "\n")
    T.emit_log_payload(f, chunk=300)
    text = "[log] " + capsys.readouterr().out.replace("\nTIMBRE_TURNS_PART", "\n[log] TIMBRE_TURNS_PART")
    assert T.decode_log_payload(text) == f.read_bytes()
    with pytest.raises(ValueError):
        T.decode_log_payload(text.replace("TIMBRE_TURNS_PART 00001", "TIMBRE_TURNS_PART 00009", 1))


def test_model_pins_are_full_commit_shas():
    assert len(T.MODEL_PINS) == 4
    for sha in T.MODEL_PINS.values():
        assert len(sha) == 40 and all(c in "0123456789abcdef" for c in sha)


def test_plan_clip_roles_and_sha_check(tmp_path):
    import hashlib

    scope = "reb/2026-09-10/room_x/_consults/c1"
    d = tmp_path / scope
    (d / "tracks").mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"t0_ms": T0}))
    nem = {"version": "v", "config_hash": "abc", "model": "m", "status": "ok",
           "segments": [seg("speaker_0", 0, 20), seg("speaker_1", 21, 40)]}
    nem_text = json.dumps(nem)
    nem_rel = f"{scope}/tracks/diar.nemotron__v__abc.json"
    (tmp_path / nem_rel).write_text(nem_text)
    role = {"status": "ok", "segments": [
        {"speaker": "3", "role": "doctor", "t0_ms": T0, "t1_ms": T0 + 20_000},
        {"speaker": "1", "role": "patient", "t0_ms": T0 + 21_000, "t1_ms": T0 + 40_000}]}
    (d / "tracks" / "role.text-judge__v1__x.json").write_text(json.dumps(role))
    clip = {"bench_id": "b01", "consult_uid": "c1", "scope": scope, "clip_t0_ms": T0, "audio_duration_ms": 60_000,
            "audio_r2_key": "consult-clips/x/consult.flac",
            "tracks": {"diar_nemotron": {"key": nem_rel, "sha256": hashlib.sha256(nem_text.encode()).hexdigest()}}}
    rec = T.plan_clip(clip, tmp_path)
    assert _rs(rec["persons"]["speaker_0"]) == ("doctor", "overlap:role.text-judge")
    assert rec["persons"]["speaker_1"]["role"] == "patient"
    assert [t["speaker"] for t in rec["turns"]] == ["speaker_0", "speaker_1"]
    assert set(rec) == {"bench_id", "consult_uid", "audio_r2_key", "manifest_t0_ms", "duration_s", "nemotron_track", "persons", "turns"}
    clip["tracks"]["diar_nemotron"]["sha256"] = "0" * 64
    with pytest.raises(ValueError):
        T.plan_clip(clip, tmp_path)


# ---- round 2: role precedence per speaker, thresholds, null rules -------------------------

def _plan_fixture(tmp_path, layers, silver=None, nem_segs=None):
    """layers: {prefix: [(speaker_in_role_layer, role, a_s, b_s)]}. Returns (clip, label)."""
    import hashlib

    scope = "reb/2026-09-10/room_x/_consults/c1"
    d = tmp_path / scope
    (d / "tracks").mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"t0_ms": T0}))
    nem = {"version": "v", "config_hash": "abc", "model": "m", "status": "ok",
           "segments": nem_segs or [seg("speaker_0", 0, 20), seg("speaker_1", 21, 40)]}
    text = json.dumps(nem)
    rel = f"{scope}/tracks/diar.nemotron__v__abc.json"
    (tmp_path / rel).write_text(text)
    for prefix, items in layers.items():
        segs = [{"speaker": sp, "role": r, "t0_ms": T0 + int(a * 1000), "t1_ms": T0 + int(b * 1000)} for sp, r, a, b in items]
        (d / "tracks" / f"{prefix}__v1__x.json").write_text(json.dumps({"status": "ok", "segments": segs}))
    clip = {"bench_id": "b01", "consult_uid": "c1", "scope": scope, "clip_t0_ms": T0, "audio_duration_ms": 60_000,
            "audio_r2_key": "consult-clips/x/consult.flac",
            "tracks": {"diar_nemotron": {"key": rel, "sha256": hashlib.sha256(text.encode()).hexdigest()}}}
    label = None
    if silver is not None:
        sar_rel = f"{scope}/tracks/diar.sarvam__v__y.json"
        sar = {"segments": [seg("0", 0, 20), seg("1", 21, 40)]}
        (tmp_path / sar_rel).write_text(json.dumps(sar))
        clip["tracks"]["diar_sarvam"] = {"key": sar_rel}
        label = {"speaker_roles": silver}
    return clip, label


def test_precedence_llm_over_text_judge_over_caa_with_all_three_present(tmp_path):
    cover0 = [("a", "doctor", 0, 20)]
    layers = {
        "role.llm-roles": [("a", "patient", 0, 20)],
        "role.text-judge": cover0,
        "role.caa-labels": [("a", "other", 0, 20)],
    }
    clip, _ = _plan_fixture(tmp_path, layers)
    rec = T.plan_clip(clip, tmp_path)
    assert _rs(rec["persons"]["speaker_0"]) == ("patient", "overlap:role.llm-roles")


def test_precedence_falls_back_per_speaker_not_per_consult(tmp_path):
    # llm-roles covers speaker_0 only; text-judge covers both; caa covers speaker_1 with another role
    layers = {
        "role.llm-roles": [("a", "doctor", 0, 20)],
        "role.text-judge": [("a", "other", 0, 20), ("b", "patient", 21, 40)],
        "role.caa-labels": [("b", "doctor", 21, 40)],
    }
    clip, _ = _plan_fixture(tmp_path, layers)
    p = T.plan_clip(clip, tmp_path)["persons"]
    assert _rs(p["speaker_0"]) == ("doctor", "overlap:role.llm-roles")
    assert _rs(p["speaker_1"]) == ("patient", "overlap:role.text-judge")


def test_text_judge_beats_caa_and_caa_used_last(tmp_path):
    clip, _ = _plan_fixture(tmp_path, {"role.text-judge": [("a", "doctor", 0, 20)], "role.caa-labels": [("a", "patient", 0, 20), ("b", "other", 21, 40)]})
    p = T.plan_clip(clip, tmp_path)["persons"]
    assert p["speaker_0"]["role_source"] == "overlap:role.text-judge" and p["speaker_0"]["role"] == "doctor"
    assert _rs(p["speaker_1"]) == ("other", "overlap:role.caa-labels")


def test_silver_only_when_no_role_layer_track_exists(tmp_path):
    silver = {"0": "doctor", "1": "patient"}
    clip, label = _plan_fixture(tmp_path, {}, silver=silver)
    p = T.plan_clip(clip, tmp_path, label)["persons"]
    assert _rs(p["speaker_0"]) == ("doctor", "silver-labels")
    # a role-layer track exists (even if it covers only one speaker): silver is not consulted
    clip, label = _plan_fixture(tmp_path / "two", {"role.text-judge": [("a", "other", 0, 20)]}, silver=silver)
    p = T.plan_clip(clip, tmp_path / "two", label)["persons"]
    assert _rs(p["speaker_0"]) == ("other", "overlap:role.text-judge")
    assert _rs(p["speaker_1"]) == ("unknown", None)


def test_role_source_is_none_when_role_unknown(tmp_path):
    clip, _ = _plan_fixture(tmp_path, {"role.llm-roles": [("a", "doctor", 0, 20)]})
    p = T.plan_clip(clip, tmp_path)["persons"]
    assert p["speaker_1"]["role"] == "unknown" and p["speaker_1"]["role_source"] is None
    clip, _ = _plan_fixture(tmp_path / "none", {})
    p = T.plan_clip(clip, tmp_path / "none")["persons"]
    assert all(_rs(v) == ("unknown", None) for v in p.values())


def test_overlap_threshold_025_excluded_and_020_kept():
    assert T.OVERLAP_EXCLUDE_FRAC == 0.2
    assert T.is_overlapped({"overlap_frac": 0.25}) is True
    assert T.is_overlapped({"overlap_frac": 0.2}) is False
    assert T.is_overlapped({"overlap_frac": 0.2001}) is True
    rows = [_row(2.0, 0.25, **{"odyssey.arousal": 0.9}), _row(2.0, 0.2, **{"odyssey.arousal": 0.5})]
    agg = T.aggregate_person(rows, "odyssey.arousal")
    assert agg["n_turns"] == 1 and agg["value"] == 0.5 and agg["overlap_excluded_s"] == 2.0


def test_split_half_person_applies_overlap_exclusion():
    tr = _person_turns([1, 2, 3, 4, 5, 6])
    tr[2]["overlap_frac"] = 0.9  # value 3 is dropped: usable 1,2,4,5,6 -> odd 1,4,6 even 2,5
    assert T.split_half_person(tr, "odyssey.arousal") == (4, 3.5)
    # with the cut switched off (overlap_frac=1.0) the turn stays
    assert T.split_half_person(tr, "odyssey.arousal", overlap_frac=1.0) == (3, 4)


def test_bool_reliability_rejected_and_bool_score_ignored():
    assert T.reliability_lookup({"f|r": True}, "f", "r") is None
    assert T.reliability_lookup({"f|r": False}, "f", "r") is None
    assert T.reliability_lookup({"f|r": 1}, "f", "r") == 1.0
    assert T._val({"scores": {"x": True}}, "x") is None


def test_nan_and_inf_scores_become_none():
    for bad in (float("nan"), float("inf"), "0.5", None):
        assert T._val({"scores": {"x": bad}}, "x") is None
    assert T._val({"scores": {"x": 0.25}}, "x") == 0.25

    class FakeEx:
        def extract(self, crop, sr):
            return {"status": "ok", "features": {"arousal": float("nan"), "valence": 0.3, "dominance": float("inf")}}

    scores, status = T.score_turn({"odyssey": FakeEx()}, b"")
    assert scores["odyssey.arousal"] is None and scores["odyssey.dominance"] is None and scores["odyssey.valence"] == 0.3
    assert status == {"odyssey": "ok"}


def test_b1_reported_with_and_without_overlap_cut(tmp_path):
    rows = []
    for i in range(8):
        lvl = i / 10.0
        trs = _person_turns([lvl] * 12, bench=f"b{i:02d}")
        # three overlapped turns sit in the odd half and carry a value that reverses the ordering
        for k in (0, 2, 4):
            trs[k]["overlap_frac"] = 0.9
            trs[k]["scores"]["odyssey.arousal"] = 9.0 - lvl * 10
        rows += trs
    cut = B.b1_split_half(rows, ["odyssey.arousal"])["odyssey.arousal|patient"]
    nocut = B.b1_split_half(rows, ["odyssey.arousal"], overlap_frac=1.0)["odyssey.arousal|patient"]
    assert cut["n_persons"] == 8 and nocut["n_persons"] == 8
    assert cut["spearman"] == pytest.approx(1.0)
    assert nocut["spearman"] is None or nocut["spearman"] < cut["spearman"]
    summ = B.overlap_summary(rows)["patient"]
    assert summ["overlap_excluded_turns"] == 24 and summ["overlap_excluded_s"] == 120.0
    f = tmp_path / "scores.jsonl"
    f.write_text("\n".join(json.dumps(r) for r in [{"kind": "meta"}] + rows))
    res = B.run_all(f)
    assert "b1_split_half" in res and "b1_split_half_no_overlap_cut" in res
    assert res["overlap_excluded_by_role"]["patient"]["overlap_excluded_s"] == 120.0


# ---- round 3 ---------------------------------------------------------------------------

def test_status_ok_role_track_without_segments_blocks_silver(tmp_path):
    silver = {"0": "doctor", "1": "patient"}
    clip, label = _plan_fixture(tmp_path, {"role.text-judge": []}, silver=silver)  # abstaining judge, status ok
    p = T.plan_clip(clip, tmp_path, label)["persons"]
    assert all(_rs(v) == ("unknown", None) for v in p.values())


def test_status_ok_track_with_only_unmappable_roles_blocks_silver(tmp_path):
    silver = {"0": "doctor", "1": "patient"}
    items = [("a", "voiceprint-guess", 0, 20), ("b", "", 21, 40)]
    clip, label = _plan_fixture(tmp_path, {"role.caa-labels": items}, silver=silver)
    p = T.plan_clip(clip, tmp_path, label)["persons"]
    assert all(_rs(v) == ("unknown", None) for v in p.values())


def test_not_ok_role_track_does_not_block_silver(tmp_path):
    silver = {"0": "doctor", "1": "patient"}
    clip, label = _plan_fixture(tmp_path, {}, silver=silver)
    bad = tmp_path / clip["scope"] / "tracks" / "role.llm-roles__v1__x.json"
    bad.write_text(json.dumps({"status": "error", "segments": [{"speaker": "a", "role": "doctor", "t0_ms": T0, "t1_ms": T0 + 20_000}]}))
    p = T.plan_clip(clip, tmp_path, label)["persons"]
    assert _rs(p["speaker_0"]) == ("doctor", "silver-labels")


def test_run_all_no_overlap_cut_equals_b1_with_overlap_frac_1_and_differs(tmp_path):
    rows = []
    for i in range(8):
        lvl = i / 10.0
        trs = _person_turns([lvl] * 12, bench=f"b{i:02d}")
        for k in (0, 2, 4):
            trs[k]["overlap_frac"] = 0.9
            trs[k]["scores"]["odyssey.arousal"] = 9.0 - lvl * 10
        rows += trs
    f = tmp_path / "s.jsonl"
    f.write_text("\n".join(json.dumps(r) for r in [{"kind": "meta"}] + rows))
    res = B.run_all(f)
    assert res["b1_split_half_no_overlap_cut"] == B.b1_split_half(rows, overlap_frac=1.0)
    assert res["b1_split_half"] == B.b1_split_half(rows)
    assert res["b1_split_half_no_overlap_cut"] != res["b1_split_half"]


def _models(pinned, rev):
    return {"odyssey": {"model_id": "m", "pinned_rev": pinned, "model_rev": rev}}


def test_check_revisions_aborts_on_mismatch_and_on_missing_pin():
    T.check_revisions(_models("a" * 40, "a" * 40))
    with pytest.raises(SystemExit):
        T.check_revisions(_models("a" * 40, "b" * 40))
    with pytest.raises(SystemExit):
        T.check_revisions(_models("a" * 40, None))
    with pytest.raises(SystemExit):
        T.check_revisions(_models(None, None))  # None == None must not pass


def test_cmd_score_aborts_when_loaded_revision_differs_from_pin(tmp_path, monkeypatch):
    import sys
    import types

    class Spec:
        model_id = "3loi/SER-Odyssey-Baseline-WavLM-Multi-Attributes"

    class FakeEx:
        spec = Spec()
        revision = None

    base = types.ModuleType("tools.timbre.extractors.base")
    base.build_extractor = lambda name, device: FakeEx()
    base.cached_hub_revision = lambda repo: "f" * 40  # not the pin
    pkg = types.ModuleType("tools.timbre.extractors")
    pkg.base = base
    monkeypatch.setitem(sys.modules, "tools.timbre.extractors", pkg)
    monkeypatch.setitem(sys.modules, "tools.timbre.extractors.base", base)
    monkeypatch.setattr(T, "pin_models", lambda pins=None: None)
    plan = tmp_path / "plan.jsonl"
    plan.write_text("")
    out = tmp_path / "out.jsonl"
    with pytest.raises(SystemExit):
        T.main(["score", "--plan", str(plan), "--out", str(out), "--workdir", str(tmp_path / "w"), "--device", "cpu"])
    assert out.read_text() == ""  # nothing was written after the mismatch


def test_hf_cache_dir_honours_hub_cache_then_hf_home(monkeypatch, tmp_path):
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.setenv("HF_HOME", str(tmp_path / "home"))
    assert T.hf_cache_dir() == tmp_path / "home" / "hub"
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path / "cache"))
    assert T.hf_cache_dir() == tmp_path / "cache"


def test_canonical_status_ok_only_and_newest_by_created_at_then_mtime(tmp_path):
    import os

    tracks = tmp_path / "tracks"
    tracks.mkdir()

    def put(name, created, status="ok", mtime=None, tag=""):
        f = tracks / name
        f.write_text(json.dumps({"status": status, "extras": {"created_at": created} if created else {}, "tag": tag}))
        if mtime is not None:
            os.utime(f, (mtime, mtime))

    put("role.x__v1__a.json", "2026-10-14T01:00:00Z", tag="old")
    put("role.x__v1__b.json", "2026-10-14T05:00:00Z", tag="new")
    put("role.x__v1__c.json", "2026-10-14T09:00:00Z", status="error", tag="newest-but-error")
    d, name = T._canonical(tmp_path, "role.x")
    assert d["tag"] == "new" and name == "role.x__v1__b.json"
    assert T._canonical(tmp_path, "role.none") == (None, None)
    # no created_at anywhere: newest mtime wins
    for f in tracks.glob("role.y__*"):
        f.unlink()
    put("role.y__v1__a.json", None, mtime=1_000_000, tag="older-mtime")
    put("role.y__v1__b.json", None, mtime=2_000_000, tag="newer-mtime")
    assert T._canonical(tmp_path, "role.y")[0]["tag"] == "newer-mtime"
    # a created_at beats a missing one
    put("role.z__v1__a.json", "2026-10-14T01:00:00Z", mtime=1_000_000, tag="has-created")
    put("role.z__v1__b.json", None, mtime=9_000_000, tag="no-created")
    assert T._canonical(tmp_path, "role.z")[0]["tag"] == "has-created"


def test_plan_clip_rejects_manifest_t0_mismatch(tmp_path):
    clip, _ = _plan_fixture(tmp_path, {})
    clip["clip_t0_ms"] = T0 + 1
    with pytest.raises(ValueError):
        T.plan_clip(clip, tmp_path)


def test_attender_maps_to_other_and_role_segments_use_it():
    assert T.norm_role("attender") == "other"
    segs = [{"role": "attender", "t0_ms": T0, "t1_ms": T0 + 5000}, {"role": "x", "t0_ms": T0, "t1_ms": T0 + 5000}]
    assert T.role_segments_to_clip(segs, T0) == [(0.0, 5.0, "other")]


def test_overlap_summary_threshold_is_point_two_inclusive_below():
    rows = [
        {"role": "patient", "dur_s": 2.0, "overlap_frac": 0.2},
        {"role": "patient", "dur_s": 3.0, "overlap_frac": 0.2001},
        {"role": "patient", "dur_s": 4.0, "overlap_frac": 0.25},
    ]
    s = B.overlap_summary(rows)["patient"]
    assert s["turns"] == 3 and s["seconds"] == 9.0
    assert s["overlap_excluded_turns"] == 2 and s["overlap_excluded_s"] == 7.0


def test_role_source_format_and_role_overlap_frac(tmp_path):
    # speaker_0 (0-20 s): llm-roles covers 0-15 as doctor and 15-20 as patient -> doctor, 0.75
    # speaker_1 (21-40 s): llm-roles has nothing there; caa-labels covers 21-30 -> overlap:role.caa-labels, 9/19
    layers = {
        "role.llm-roles": [("a", "doctor", 0, 15), ("a", "patient", 15, 20)],
        "role.caa-labels": [("b", "patient", 21, 30)],
    }
    clip, _ = _plan_fixture(tmp_path, layers)
    p = T.plan_clip(clip, tmp_path)["persons"]
    assert p["speaker_0"] == {"role": "doctor", "role_source": "overlap:role.llm-roles", "role_overlap_frac": 0.75}
    assert p["speaker_1"]["role_source"] == "overlap:role.caa-labels"
    assert p["speaker_1"]["role_overlap_frac"] == pytest.approx(9 / 19, abs=1e-4)
    # silver keeps its own name; unknown has no fraction
    clip, label = _plan_fixture(tmp_path / "s", {}, silver={"0": "doctor"})
    p = T.plan_clip(clip, tmp_path / "s", label)["persons"]
    assert p["speaker_0"] == {"role": "doctor", "role_source": "silver-labels", "role_overlap_frac": 1.0}
    assert p["speaker_1"] == {"role": "unknown", "role_source": None, "role_overlap_frac": None}


def test_role_comes_from_time_overlap_never_from_extras_map(tmp_path):
    clip, _ = _plan_fixture(tmp_path, {})
    tr = tmp_path / clip["scope"] / "tracks" / "role.llm-roles__v1__x.json"
    tr.write_text(json.dumps({"status": "ok", "segments": [], "extras": {"map": {"0": "doctor", "speaker_0": "doctor"}}}))
    p = T.plan_clip(clip, tmp_path)["persons"]
    assert all(v == {"role": "unknown", "role_source": None, "role_overlap_frac": None} for v in p.values())


def test_feature_rows_and_turn_rows_carry_role_source_and_overlap_frac():
    person = {"speaker": "s", "role": "doctor", "role_source": "overlap:role.llm-roles", "role_overlap_frac": 0.8}
    rows = [_row(2.0, 0.0, **{"odyssey.arousal": 0.5})]
    out = T.feature_rows("c", person, rows, ["odyssey.arousal"], {}, "r", "g")
    assert out[0]["role_source"] == "overlap:role.llm-roles" and out[0]["role_overlap_frac"] == 0.8
