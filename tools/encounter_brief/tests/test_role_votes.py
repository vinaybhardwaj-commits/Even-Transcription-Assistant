"""Unit tests for role_votes.v1 (synthetic fixtures only; no audio, no real consults)."""
import ast
import base64
import json
import os
import stat
import subprocess
import sys

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
MOD = os.path.join(os.path.dirname(HERE), "role_votes.py")
sys.path.insert(0, os.path.dirname(HERE))
import role_votes as R  # noqa: E402

DIM = 8


def basis(i, j=None, w=0.0):
    """A unit vector on axis i, optionally tilted toward axis j by weight w."""
    v = np.zeros(DIM)
    v[i] = 1.0
    if j is not None:
        v[j] = w
    return v / np.linalg.norm(v)


def with_cos(target, c, other_axis):
    """A unit vector with cosine exactly c to the unit vector `target` (axis-aligned)."""
    v = c * target.copy()
    o = np.zeros(DIM)
    o[other_axis] = 1.0
    return v + np.sqrt(1 - c * c) * o


def cen(*uids):
    return {u: basis(i) for i, u in enumerate(uids)}


def segs(*spec):
    """spec: (speaker, t0_s, t1_s) -> bundle segments in ms."""
    return [{"speaker": s, "t0_ms": int(a * 1000), "t1_ms": int(b * 1000)} for s, a, b in spec]


def vote_rows(bundle, ps, rename=None):
    """Per-segment vote rows (clef-votes.jsonl shape) for the bundle segments, optionally renaming labels."""
    rename = rename or {}
    out = []
    for s in bundle:
        p = ps.get(s["speaker"])
        r = {"consult_id": "c", "t0_ms": s["t0_ms"], "t1_ms": s["t1_ms"], "slot": rename.get(s["speaker"], s["speaker"])}
        r.update({k: (p[i] if p else None) for i, k in enumerate(R.KEYS)})
        out.append(r)
    return out


def slot_rows(ps, rename=None):
    rename = rename or {}
    return [dict({"consult_id": "c", "slot": rename.get(lab, lab)}, **dict(zip(R.KEYS, p))) for lab, p in ps.items()]


BUNDLE = segs(("speaker_0", 0, 10), ("speaker_1", 10, 20), ("speaker_0", 20, 30), ("speaker_1", 30, 40))
ROLE = [{"role": "doctor", "speaker": "A", "t0_ms": 0, "t1_ms": 10000}, {"role": "patient", "speaker": "B", "t0_ms": 10000, "t1_ms": 20000},
        {"role": "doctor", "speaker": "A", "t0_ms": 20000, "t1_ms": 30000}, {"role": "patient", "speaker": "B", "t0_ms": 30000, "t1_ms": 40000}]
PS = {"speaker_0": [0.9, 0.05, 0.03, 0.02], "speaker_1": [0.1, 0.8, 0.05, 0.05]}


def build(bundle=BUNDLE, role=ROLE, clef=None, jev=None, duid="d0", vecs=None, centroids=None, rename=None,
          extra_clef=(), extra_jev=()):
    C = centroids if centroids is not None else cen("d0", "d1", "d2")
    if vecs is None:
        vecs = {"speaker_0": with_cos(C["d0"], 0.80, 7), "speaker_1": with_cos(C["d0"], 0.30, 6)}
    return R.build_layer(bundle_segs=bundle, role_segs=role,
                         clef_rows=vote_rows(bundle, PS if clef is None else clef, rename) + list(extra_clef),
                         jev_rows=slot_rows(PS if jev is None else jev, rename) + list(extra_jev),
                         doctor_uid=duid, vecs=vecs, cen=C, role_engine="llm-roles", meta={"m": 1})


def lab(layer, name):
    return next(x for x in layer["labels"] if x["label"] == name)


# ---------------------------------------------------------------- margins and thresholds

def test_margin_049_fails_and_050_passes_next_label():
    C = cen("d0", "d1")
    for other, ok in ((0.651, False), (0.65, True)):
        vecs = {"speaker_0": with_cos(C["d0"], 0.70, 7), "speaker_1": with_cos(C["d0"], other, 6)}
        per, old, _ = R.voiceprint(vecs, ["speaker_0", "speaker_1"], C, "d0")
        assert per["speaker_0"]["margin_next_label"] == pytest.approx(0.70 - other, abs=1e-6)
        assert per["speaker_0"]["armc"] is ok
        assert per["speaker_0"]["armc_old"] is ok
        assert (old["treating_label"] == "speaker_0") is ok


def test_margin_049_fails_and_050_passes_runner_up_centroid():
    C = cen("d0", "d1")
    for to_d1, ok in ((0.651, False), (0.65, True)):
        # cos 0.70 to d0, `to_d1` to d1, one label only (no next label)
        v = 0.70 * C["d0"] + to_d1 * C["d1"]
        rest = 1 - 0.70 ** 2 - to_d1 ** 2
        v[7] = np.sqrt(rest)
        per, old, _ = R.voiceprint({"speaker_0": v}, ["speaker_0"], C, "d0")
        assert per["speaker_0"]["margin_runner_up_centroid"] == pytest.approx(0.70 - to_d1, abs=1e-6)
        assert per["speaker_0"]["armc"] is ok
        assert per["speaker_0"]["armc_old"] is True  # merge_c's one-margin rule ignores the centroid runner-up
        assert old["treating_label"] == "speaker_0"


def test_cos_min_boundary():
    C = cen("d0", "d1")
    for c, ok in ((0.6499, False), (0.6501, True)):
        per, old, _ = R.voiceprint({"speaker_0": with_cos(C["d0"], c, 7)}, ["speaker_0"], C, "d0")
        assert per["speaker_0"]["armc"] is ok
        assert old["treating_reason"] == ("ok" if ok else "below_cos_min")


def test_one_centroid_set_abstains_but_armc_old_passes():
    C = cen("d0")
    per, old, _ = R.voiceprint({"speaker_0": with_cos(C["d0"], 0.9, 7)}, ["speaker_0"], C, "d0")
    assert per["speaker_0"]["margin_runner_up_centroid"] is None
    assert per["speaker_0"]["status"] == "abstain" and per["speaker_0"]["armc_old"] is True


def test_at_most_one_label_passes():
    C = cen("d0", "d1")
    vecs = {f"speaker_{i}": with_cos(C["d0"], c, 7 - i) for i, c in enumerate((0.9, 0.89, 0.88))}
    per, _, _ = R.voiceprint(vecs, sorted(vecs), C, "d0")
    assert sum(p["armc"] for p in per.values()) == 0  # inside margin: nobody passes
    vecs["speaker_0"] = with_cos(C["d0"], 0.99, 7)
    per, _, _ = R.voiceprint(vecs, sorted(vecs), C, "d0")
    assert [k for k, p in per.items() if p["armc"]] == ["speaker_0"]


# ---------------------------------------------------------------- statuses

def test_no_enrolment():
    L = build(duid="nobody")
    assert "no_enrolment" in L["degraded"] and L["armc_on"] is False
    assert all(x["voiceprint"]["status"] == "no_enrolment" and not x["rule_b"] for x in L["labels"])
    assert L["voiceprint_match_label"] is None


def test_no_doctor_uid():
    L = build(duid=None)
    assert "no_doctor_uid" in L["degraded"] and L["armc_on"] is False
    assert all(x["voiceprint"]["status"] == "no_doctor_uid" for x in L["labels"])


def test_no_vectors():
    L = build(vecs={})
    assert "no_vectors" in L["degraded"] and L["armc_on"] is False
    assert all(x["voiceprint"]["status"] == "absent" for x in L["labels"])


# ---------------------------------------------------------------- Clef vote (M3)

def test_clef_doctor_on_slot_and_null_elsewhere():
    L = build()
    assert lab(L, "speaker_0")["clef_omni"]["role"] == "doctor" and lab(L, "speaker_0")["clef_omni"]["doctor_rank"] == 1
    s1 = lab(L, "speaker_1")["clef_omni"]
    assert s1["role"] is None and s1["doctor_rank"] is None  # null even on the patient_slot
    assert s1["decision"] == "patient"  # the recorded decision is kept for reproduction, never as a vote


def test_clef_undecided_gives_no_doctor():
    L = build(clef={"speaker_0": [0.7, 0.1, 0.1, 0.1], "speaker_1": [0.6, 0.3, 0.05, 0.05]})  # margin 0.1 < 0.2
    assert all(x["clef_omni"]["role"] is None for x in L["labels"])
    assert lab(L, "speaker_0")["clef_omni"]["status"] == "undecided"
    assert lab(L, "speaker_0")["clef_omni"]["reason_code"] == "doctor_margin"
    assert L["rule_a_labels"] == [] and L["rule_b_label"] is None


def test_choose_slots_matches_merge_b_decide_rules():
    order = ["a", "b", "c"]
    assert R.choose_slots({"a": [0.59, 0.1, 0, 0], "b": [0.1, 0.9, 0, 0]}, order)[2] == "doctor_p_low"
    assert R.choose_slots({"a": [0.9, 0.1, 0, 0], "b": [0.1, 0.59, 0, 0]}, order)[2] == "patient_p_low"
    assert R.choose_slots({"a": [0.9, 0.1, 0, 0], "b": [0.1, 0.6, 0, 0]}, order) == ("a", "b", "decided")
    assert R.decide_recorded({"a": [0.9, 0.1, 0, 0], "b": [0.1, 0.6, 0, 0], "c": [0.1, 0.1, 0.1, 0.7]}, order) == {"a": "doctor", "b": "patient", "c": "staff"}


# ---------------------------------------------------------------- rules A and B, order capability

def test_happy_path_rule_a_and_b_agree():
    L = build()
    assert L["mapping"]["status"] == "clean"
    assert L["rule_a_labels"] == ["speaker_0"] and L["rule_b_label"] == "speaker_0"
    assert L["voiceprint_match_label"] == "speaker_0"
    assert L["order_capable_labels"] == ["speaker_0"] and L["conflicts"] == []


def test_voiceprint_match_on_other_label_blocks_3of3_label():
    """N1: staff voted doctor 3/3 while the voiceprint matches another label -> nothing orders."""
    C = cen("d0", "d1", "d2")
    vecs = {"speaker_0": with_cos(C["d0"], 0.30, 7), "speaker_1": with_cos(C["d0"], 0.85, 6)}
    L = build(vecs=vecs, centroids=C)
    assert L["rule_a_labels"] == ["speaker_0"]
    assert L["voiceprint_match_label"] == "speaker_1"
    assert L["rule_b_label"] is None  # Clef / Jev do not rank speaker_1 first
    assert L["order_capable_labels"] == [] and "doctor_conflict" in L["conflicts"]


def test_rule_b_alone_makes_order_capable():
    role = [dict(r, role="patient") for r in ROLE]  # voter 1 never says doctor
    L = build(role=role)
    assert lab(L, "speaker_0")["voter1_role_track"]["role"] == "patient"
    # OQ-5: voter 1 calls the arm (c) label non-doctor -> unknown, no order
    assert L["rule_b_label"] is None and L["order_capable_labels"] == [] and "doctor_conflict" in L["conflicts"]
    role = [dict(r, role="undecided") for r in ROLE]
    L = build(role=role)
    assert L["rule_a_labels"] == [] and L["order_capable_labels"] == ["speaker_0"]


@pytest.mark.parametrize("d3,c,cands,want,conf", [
    (set(), None, set(), set(), []),
    (set(), "x", {"x"}, {"x"}, []),
    (set(), "x", {"x", "y"}, set(), ["doctor_conflict"]),  # M1: a second near-doctor label blocks arm (c)
    ({"a"}, None, set(), {"a"}, []),
    ({"a"}, "a", {"a"}, {"a"}, []),
    ({"a"}, "x", {"x"}, set(), ["doctor_conflict"]),
    ({"a"}, None, {"a", "y"}, set(), ["doctor_conflict"]),  # M1: ... and 3-of-3
    ({"a", "b"}, None, set(), set(), ["second_doctor"]),
    ({"a", "b"}, "a", {"a"}, {"a"}, ["second_doctor"]),
    ({"a", "b"}, "a", {"a", "b"}, set(), ["doctor_conflict", "second_doctor"]),  # fix1 M1: both 3/3 and both near-doctor
    ({"a", "b"}, None, {"a", "b"}, set(), ["second_doctor"]),
    (set(), "x", {"x", "y"}, set(), ["doctor_conflict"]),
    ({"a", "b"}, "a", {"a", "y"}, set(), ["doctor_conflict", "second_doctor"]),
    ({"a", "b"}, "x", {"x"}, set(), ["doctor_conflict", "second_doctor"]),
    ({"a"}, None, {"x"}, set(), ["doctor_conflict"]),
])
def test_order_capable_table(d3, c, cands, want, conf):
    got, conflicts = R.order_capable(d3, c, cands)
    assert got == want and conflicts == conf


# ---------------------------------------------------------------- mapping (OQ-3, M5)

def test_mapping_clean_with_renamed_labels():
    L = build(rename={"speaker_0": "spk1", "speaker_1": "spk0"})
    assert L["mapping"]["status"] == "clean"
    assert L["mapping"]["vote_labels"] == {"speaker_0": "spk1", "speaker_1": "spk0"}
    assert L["order_capable_labels"] == ["speaker_0"]


def test_mapping_failure_drops_voters_2_and_3():
    L = R.build_layer(bundle_segs=BUNDLE, role_segs=ROLE, clef_rows=[], jev_rows=slot_rows(PS), doctor_uid="d0",
                      vecs={"speaker_0": with_cos(basis(0), 0.8, 7)}, cen=cen("d0", "d1"), role_engine="llm-roles", meta={})
    assert L["mapping"]["status"] == "failed" and "mapping_failed" in L["degraded"]
    assert L["armc_on"] is False and L["rule_a_labels"] == [] and L["rule_b_label"] is None
    assert all(x["jev"]["status"] == "absent" and x["clef_omni"]["status"] == "absent" for x in L["labels"])
    assert L["order_capable_labels"] == []


def test_mapping_ambiguous_when_two_vote_labels_share_one_bundle_label():
    vote_side = segs(("v0", 0, 15), ("v1", 15, 20), ("v0", 20, 40))  # v0 holds most of both bundle labels
    rows = vote_rows(vote_side, {"v0": PS["speaker_0"], "v1": PS["speaker_1"]})
    m = R.map_labels(rows, BUNDLE)
    assert m["status"] == "ambiguous"
    L = R.build_layer(bundle_segs=BUNDLE, role_segs=ROLE, clef_rows=rows, jev_rows=slot_rows({"v0": PS["speaker_0"]}),
                      doctor_uid="d0", vecs={"speaker_0": with_cos(basis(0), 0.8, 7)}, cen=cen("d0", "d1"), role_engine="llm-roles", meta={})
    assert "mapping_ambiguous" in L["degraded"] and L["armc_on"] is False and L["order_capable_labels"] == []


def test_mapping_no_overlap_fails():
    far = segs(("v0", 100, 110))
    assert R.map_labels(vote_rows(far, {"v0": PS["speaker_0"]}), BUNDLE)["status"] == "failed"


def test_role_track_not_llm_is_degraded():
    L = R.build_layer(bundle_segs=BUNDLE, role_segs=ROLE, clef_rows=vote_rows(BUNDLE, PS), jev_rows=slot_rows(PS), doctor_uid="d0",
                      vecs={}, cen=cen("d0", "d1"), role_engine="text-judge", meta={})
    assert "role_track_not_llm" in L["degraded"]


# ---------------------------------------------------------------- reproduction helpers

def test_decide_c_matches_merge_c():
    labels = ["a", "b", "c"]
    ps = {"a": [0.8, 0.1, 0.05, 0.05], "b": [0.7, 0.2, 0.05, 0.05], "c": [0.1, 0.8, 0.05, 0.05]}
    assert R.decide_c(labels, ps, "a") == {"a": "doctor", "b": "other_clinician", "c": "patient"}
    assert R.decide_c(labels, ps, None) == {"a": "undecided", "b": "undecided", "c": "undecided"}


def test_score_consult_counts_confident_doctor_segments():
    L = build()
    s = R.score_consult(L, BUNDLE, ROLE)
    assert s["base_conf_doc"] == 2 and s["old_conf"] == 2 and s["new_conf"] == 2 and s["order_capable"] == 1


def test_centroids_loader_round_trip(tmp_path):
    v = np.arange(1, DIM + 1, dtype=np.float32)
    p = tmp_path / "c.json"
    p.write_text(json.dumps([{"pulse_doctor_uid": "d0", "b64": base64.b64encode(v.tobytes()).decode()}]))
    got = R.load_centroids(str(p))
    assert np.allclose(got["d0"], v / np.linalg.norm(v))


# ---------------------------------------------------------------- storage

def test_write_layer_mode_0600_beside_manifest(tmp_path):
    b = tmp_path / "eta" / "reb" / "x" / "bundle"
    b.mkdir(parents=True)
    path, fb = R.write_layer({"layer": "role_votes"}, str(b), str(tmp_path / "eta"), str(tmp_path / "fb"))
    assert path == str(b / R.FILE_NAME) and fb is False
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_write_layer_falls_back_when_not_writable(tmp_path):
    b = tmp_path / "eta" / "reb" / "x" / "bundle"
    b.mkdir(parents=True)
    os.chmod(b, 0o500)
    try:
        path, fb = R.write_layer({"layer": "role_votes"}, str(b), str(tmp_path / "eta"), str(tmp_path / "fb"))
    finally:
        os.chmod(b, 0o700)
    assert fb is True and path == str(tmp_path / "fb" / "reb" / "x" / "bundle" / R.FILE_NAME)
    assert json.load(open(path))["storage"] == {"fallback": True}
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


# ---------------------------------------------------------------- no network, no posting (N3)

BANNED = {"requests", "httpx", "aiohttp", "urllib", "urllib3", "http", "socket", "websocket", "websockets", "ssl",
          "psycopg", "psycopg2", "asyncpg", "sqlalchemy", "sqlite3", "pymysql", "boto3", "botocore", "neon",
          "clef", "jev_text", "tools", "lib", "app"}


def _imports(path):
    tree = ast.parse(open(path).read())
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                names.add("." + (node.module or ""))
            else:
                names.add(node.module.split(".")[0])
    return names


def test_no_http_db_or_repo_lib_imports_anywhere_in_module():
    got = _imports(MOD)
    assert not (got & BANNED), got & BANNED
    assert not any(n.startswith(".") for n in got)


def test_import_loads_no_network_module():
    code = ("import sys; sys.path.insert(0, %r); import role_votes; "
            "bad = sorted(m for m in sys.modules if m.split('.')[0] in %r); print(','.join(bad))") % (os.path.dirname(MOD), sorted(BANNED - {"tools", "lib", "app", "ssl", "socket"}))
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout.strip()
    assert out == ""


def test_posting_disabled_and_asserted(tmp_path, monkeypatch):
    assert R.POSTING_ENABLED is False
    monkeypatch.setattr(R, "POSTING_ENABLED", True)
    with pytest.raises(AssertionError):
        R.write_layer({}, str(tmp_path), str(tmp_path), str(tmp_path / "fb"))


# ---------------------------------------------------------------- M1: N1 candidates ignore the next-label margin

def test_m1_second_near_doctor_label_blocks_3of3_even_when_next_label_margin_fails():
    C = cen("d0", "d1", "d2")
    vecs = {"speaker_0": with_cos(C["d0"], 0.80, 7), "speaker_1": with_cos(C["d0"], 0.78, 6)}  # next-label margin 0.02
    L = build(vecs=vecs, centroids=C)
    assert L["rule_a_labels"] == ["speaker_0"] and L["voiceprint_match_label"] is None  # neither passes arm (c)
    assert L["n1_candidates"] == ["speaker_0", "speaker_1"]
    assert L["order_capable_labels"] == [] and "doctor_conflict" in L["conflicts"]


def test_m1_second_near_doctor_label_blocks_arm_c():
    C = cen("d0", "d1", "d2")
    vecs = {"speaker_0": with_cos(C["d0"], 0.90, 7), "speaker_1": with_cos(C["d0"], 0.72, 6)}  # arm (c) passes on speaker_0
    role = [dict(r, role="undecided") for r in ROLE]
    L = build(role=role, vecs=vecs, centroids=C)
    assert L["rule_b_label"] == "speaker_0" and L["voiceprint_match_label"] == "speaker_0"
    assert L["n1_candidates"] == ["speaker_0", "speaker_1"]
    assert L["order_capable_labels"] == [] and "doctor_conflict" in L["conflicts"]


def test_m1_candidate_needs_the_runner_up_centroid_margin():
    C = cen("d0", "d1", "d2")
    vecs = {"speaker_0": with_cos(C["d0"], 0.90, 7), "speaker_1": with_cos(C["d0"], 0.72, 1)}  # speaker_1 sits on d1
    L = build(vecs=vecs, centroids=C)
    assert lab(L, "speaker_1")["voiceprint"]["n1_candidate"] is False
    assert L["n1_candidates"] == ["speaker_0"] and L["order_capable_labels"] == ["speaker_0"]


# ---------------------------------------------------------------- M2 / D2: max non-doctor p over all rows

@pytest.mark.parametrize("which", ["clef", "jev"])
def test_m2_non_doctor_p_on_a_later_row_with_null_p_doctor_blocks_arm_c(which):
    role = [dict(r, role="undecided") for r in ROLE]
    row = {"consult_id": "c", "t0_ms": 0, "t1_ms": 10000, "slot": "speaker_0", "p_doctor": None, "p_patient": 0.7, "p_attender": None, "p_staff": None}
    assert build(role=role)["order_capable_labels"] == ["speaker_0"]
    L = build(role=role, **{"extra_" + which: [row]})
    assert L["rule_b_label"] is None and L["order_capable_labels"] == [] and "doctor_conflict" in L["conflicts"]


def test_m2_max_nondoctor_counts_every_row_and_null_keys_are_zero():
    rows = [{"slot": "s", "p_doctor": None, "p_patient": None, "p_attender": 0.2, "p_staff": None},
            {"slot": "s", "p_doctor": 0.9, "p_patient": 0.1, "p_attender": None, "p_staff": 0.4},
            {"slot": "t", "p_doctor": None, "p_patient": None, "p_attender": None, "p_staff": None}]
    assert R.max_nondoctor(rows) == {"s": 0.4, "t": 0.0}


# ---------------------------------------------------------------- test gaps: rule B needs a Jev rank, coverage, roles

def test_rule_b_requires_jev_doctor_rank_one():
    role = [dict(r, role="undecided") for r in ROLE]
    jev = {"speaker_0": [0.5, 0.2, 0.2, 0.1], "speaker_1": [0.9, 0.05, 0.03, 0.02]}  # Jev ranks speaker_1 first
    L = build(role=role, jev=jev)
    assert lab(L, "speaker_0")["clef_omni"]["doctor_rank"] == 1 and lab(L, "speaker_0")["jev"]["doctor_rank"] == 2
    assert lab(L, "speaker_0")["voiceprint"]["armc"] is True
    assert L["rule_b_label"] is None and L["order_capable_labels"] == []


def test_mapping_ambiguous_label_not_covered():
    bundle = segs(("speaker_0", 0, 10), ("speaker_1", 10, 20), ("speaker_2", 20, 30))
    votes = [{"slot": "a", "t0_ms": 0, "t1_ms": 10000}, {"slot": "b", "t0_ms": 10000, "t1_ms": 20000}]
    m = R.map_labels(votes, bundle)
    assert m["status"] == "ambiguous" and m["reason"] == "label_not_covered"
    assert m["vote_labels"] == {"speaker_0": "a", "speaker_1": "b"}
    short = segs(("speaker_0", 0, 10), ("speaker_1", 10, 20), ("speaker_2", 20, 21))  # under 2 s: need not be covered
    assert R.map_labels(votes, short)["status"] == "clean"


def test_role_normalisation():
    assert [R.norm_role(r) for r in ("attender", "relative", "attendant", "doctor", "patient", "staff", None)] == \
        ["attendant", "attendant", "attendant", "doctor", "patient", "staff", None]
    role = [{"role": "attender", "t0_ms": 0, "t1_ms": 6000}, {"role": "relative", "t0_ms": 6000, "t1_ms": 12000},
            {"role": "patient", "t0_ms": 12000, "t1_ms": 16000}]
    assert R.role_majority([{"t0_ms": 0, "t1_ms": 16000}], role) == ("attendant", 0.75)
    assert R.segment_role({"t0_ms": 0, "t1_ms": 5000}, role) == "attendant"
    assert R.segment_role({"t0_ms": 40000, "t1_ms": 41000}, role) == "undecided"


# ---------------------------------------------------------------- W1-W3, offline

def _ro(tmp_path):
    b = tmp_path / "eta" / "reb" / "x" / "bundle"
    b.mkdir(parents=True)
    os.chmod(b, 0o500)
    return b


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_w1_fallback_dirs_are_0700_under_a_wide_umask(tmp_path):
    b = _ro(tmp_path)
    old = os.umask(0)
    try:
        path, fb = R.write_layer({"layer": "role_votes"}, str(b), str(tmp_path / "eta"), str(tmp_path / "fb" / "root"))
    finally:
        os.umask(old)
        os.chmod(b, 0o700)
    assert fb is True
    d = os.path.dirname(path)
    while d != str(tmp_path / "fb"):
        assert stat.S_IMODE(os.stat(d).st_mode) == 0o700, d
        d = os.path.dirname(d)


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_w2_fallback_path_cannot_escape_its_root(tmp_path):
    outside = tmp_path / "elsewhere" / "bundle"
    outside.mkdir(parents=True)
    os.chmod(outside, 0o500)
    try:
        with pytest.raises(ValueError):
            R.write_layer({"layer": "role_votes"}, str(outside), str(tmp_path / "eta"), str(tmp_path / "fb"))
    finally:
        os.chmod(outside, 0o700)
    assert not (tmp_path / "fb").exists() and not (tmp_path / "elsewhere" / "bundle" / R.FILE_NAME).exists()
    with pytest.raises(ValueError):
        R.fallback_dir(str(tmp_path / "eta" / ".." / "x"), str(tmp_path / "eta"), str(tmp_path / "fb"))
    assert R.read_layer(str(outside), str(tmp_path / "eta"), str(tmp_path / "fb")) is None


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_w2_symlinked_fallback_directory_is_refused(tmp_path):
    b = _ro(tmp_path)
    (tmp_path / "target").mkdir()
    (tmp_path / "fb").mkdir()
    os.symlink(tmp_path / "target", tmp_path / "fb" / "reb")
    try:
        with pytest.raises(PermissionError):
            R.write_layer({"layer": "role_votes"}, str(b), str(tmp_path / "eta"), str(tmp_path / "fb"))
    finally:
        os.chmod(b, 0o700)
    assert list((tmp_path / "target").iterdir()) == []


def test_w3_temp_file_is_exclusive_and_never_follows_a_symlink(tmp_path, monkeypatch):
    b = tmp_path / "eta" / "reb" / "x" / "bundle"
    b.mkdir(parents=True)
    victim = tmp_path / "victim"
    victim.write_text("keep")
    monkeypatch.setattr(os, "urandom", lambda n: b"\x00" * n)
    tmp = f"{b / R.FILE_NAME}.{os.getpid()}.00000000.tmp"
    os.symlink(victim, tmp)
    with pytest.raises(OSError):
        R.write_layer({"layer": "role_votes"}, str(b), str(tmp_path / "eta"), str(tmp_path / "fb"))
    assert victim.read_text() == "keep"


def test_w3_planted_regular_temp_file_is_refused(tmp_path, monkeypatch):
    b = tmp_path / "eta" / "reb" / "x" / "bundle"
    b.mkdir(parents=True)
    monkeypatch.setattr(os, "urandom", lambda n: b"\x00" * n)
    planted = b / f"{R.FILE_NAME}.{os.getpid()}.00000000.tmp"
    planted.write_text("planted")
    with pytest.raises(FileExistsError):
        R.write_layer({"layer": "role_votes"}, str(b), str(tmp_path / "eta"), str(tmp_path / "fb"))
    assert planted.read_text() == "planted"


def test_hf_hub_offline_is_assigned_not_defaulted(monkeypatch):
    monkeypatch.setenv("HF_HUB_OFFLINE", "0")
    monkeypatch.setitem(sys.modules, "torch", type(sys)("torch"))
    monkeypatch.setitem(sys.modules, "speechbrain", type(sys)("speechbrain"))
    monkeypatch.setitem(sys.modules, "speechbrain.inference", type(sys)("speechbrain.inference"))
    sp = type(sys)("speechbrain.inference.speaker")
    sp.EncoderClassifier = type("E", (), {"from_hparams": staticmethod(lambda **k: object())})
    sys.modules["torch"].set_num_threads = lambda n: None
    monkeypatch.setitem(sys.modules, "speechbrain.inference.speaker", sp)
    R.load_encoder()
    assert os.environ["HF_HUB_OFFLINE"] == "1"


# ---------------------------------------------------------------- fix1 (Opus refute findings M1-M2, L3-L7)

def test_fix1_m1_two_3of3_near_doctor_labels_order_nothing():
    # build_layer cannot yet produce two 3/3 labels (choose_slots names one doctor), so the function is pinned directly.
    assert R.order_capable({"a", "b"}, "a", {"a", "b"}) == (set(), ["doctor_conflict", "second_doctor"])
    assert R.order_capable({"a", "b"}, "a", {"a"}) == ({"a"}, ["second_doctor"])
    assert R.order_capable({"a"}, "a", {"a", "b"}) == (set(), ["doctor_conflict"])


@pytest.mark.parametrize("role", ["other", "unknown", "Patient", " PATIENT ", "Other", "UNKNOWN", "attender", "relative"])
def test_fix1_m2_any_decided_non_doctor_role_blocks_arm_c(role):
    assert R.blocks_arm_c(role) is True
    r = [dict(x, role=role) for x in ROLE]
    L = build(role=r)
    assert L["rule_b_label"] is None and L["order_capable_labels"] == [] and "doctor_conflict" in L["conflicts"]


@pytest.mark.parametrize("role", ["doctor", "Doctor", " doctor ", "undecided", "", None])
def test_fix1_m2_doctor_and_undecided_do_not_block(role):
    assert R.blocks_arm_c(role) is False


def test_fix1_m2_role_normalisation_folds_case_and_space():
    assert R.norm_role(" Attender ") == "attendant" and R.norm_role("DOCTOR") == "doctor" and R.norm_role(None) is None


def test_fix1_l3_one_centroid_still_counts_a_second_near_doctor_label_as_candidate():
    C = cen("d0")
    vecs = {"speaker_0": with_cos(C["d0"], 0.90, 7), "speaker_1": with_cos(C["d0"], 0.80, 6)}
    per, _, _ = R.voiceprint(vecs, ["speaker_0", "speaker_1"], C, "d0")
    assert per["speaker_1"]["margin_runner_up_centroid"] is None
    assert per["speaker_1"]["n1_candidate"] is True and per["speaker_1"]["armc"] is False
    L = build(vecs=vecs, centroids=C)
    assert L["n1_candidates"] == ["speaker_0", "speaker_1"]
    assert L["order_capable_labels"] == [] and "doctor_conflict" in L["conflicts"]
    below = {"speaker_0": with_cos(C["d0"], 0.90, 7), "speaker_1": with_cos(C["d0"], 0.60, 6)}
    assert not R.voiceprint(below, ["speaker_0", "speaker_1"], C, "d0")[0]["speaker_1"]["n1_candidate"]


def test_fix1_l4_nan_counts_as_one():
    rows = [{"slot": "s", "p_doctor": 0.1, "p_patient": float("nan"), "p_attender": 0.9, "p_staff": None},
            {"slot": "t", "p_doctor": 0.1, "p_patient": 0.2, "p_attender": None, "p_staff": float("nan")}]
    assert R.max_nondoctor(rows) == {"s": 1.0, "t": 1.0}
    role = [dict(r, role="undecided") for r in ROLE]
    row = {"consult_id": "c", "t0_ms": 0, "t1_ms": 10000, "slot": "speaker_0", "p_doctor": None, "p_patient": float("nan"),
           "p_attender": None, "p_staff": None}
    L = build(role=role, extra_clef=[row])
    assert L["rule_b_label"] is None and "doctor_conflict" in L["conflicts"]


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_fix1_l5_existing_fallback_root_is_tightened_to_0700(tmp_path):
    root = tmp_path / "fb"
    root.mkdir(mode=0o755)
    os.chmod(root, 0o755)
    b = _ro(tmp_path)
    try:
        path, fb = R.write_layer({"layer": "role_votes"}, str(b), str(tmp_path / "eta"), str(root))
    finally:
        os.chmod(b, 0o700)
    assert fb is True and stat.S_IMODE(os.stat(root).st_mode) == 0o700


def test_fix1_l5_existing_fallback_root_owned_by_another_user_is_refused(tmp_path, monkeypatch):
    root = tmp_path / "fb"
    root.mkdir()
    os.chmod(root, 0o755)
    monkeypatch.setattr(os, "getuid", lambda: os.stat(root).st_uid + 1)
    with pytest.raises(PermissionError):
        R.make_private_dirs(str(root / "a"), str(root))
    assert stat.S_IMODE(os.stat(root).st_mode) == 0o755


def test_fix1_l6_exact_boundaries_pass_despite_float_error():
    C = cen("d0", "d1")
    # 0.65 reached by float arithmetic that lands just under it
    c = 0.65 - 5e-11
    per, old, _ = R.voiceprint({"speaker_0": with_cos(C["d0"], c, 7)}, ["speaker_0"], C, "d0")
    assert per["speaker_0"]["armc"] is True and per["speaker_0"]["n1_candidate"] is True and old["treating_reason"] == "ok"
    per, old, _ = R.voiceprint({"speaker_0": with_cos(C["d0"], 0.65 - 1e-6, 7)}, ["speaker_0"], C, "d0")
    assert per["speaker_0"]["armc"] is False and old["treating_reason"] == "below_cos_min"
    assert R.margin_ok(0.05 - 5e-11) is True and R.margin_ok(0.05 - 1e-6) is False


# mutant m01: n1 cos threshold must be inclusive at 0.65, not "> 0.651"
def test_fix1_l7_m01_n1_candidate_at_cos_0650_and_0651():
    C = cen("d0", "d1", "d2")
    for c in (0.65, 0.6505):
        vecs = {"speaker_0": with_cos(C["d0"], 0.90, 7), "speaker_1": with_cos(C["d0"], c, 6)}
        L = build(vecs=vecs, centroids=C)
        assert L["n1_candidates"] == ["speaker_0", "speaker_1"], c
        assert L["order_capable_labels"] == [], c


# mutant m04: D2 is inclusive at P_BLOCK
@pytest.mark.parametrize("which", ["clef", "jev"])
def test_fix1_l7_m04_non_doctor_p_exactly_at_p_block_blocks(which):
    role = [dict(r, role="undecided") for r in ROLE]
    mk = lambda p: {"consult_id": "c", "t0_ms": 0, "t1_ms": 10000, "slot": "speaker_0", "p_doctor": None, "p_patient": p,
                    "p_attender": None, "p_staff": None}
    assert build(role=role, **{"extra_" + which: [mk(R.P_BLOCK - 1e-6)]})["order_capable_labels"] == ["speaker_0"]
    L = build(role=role, **{"extra_" + which: [mk(R.P_BLOCK)]})
    assert R.P_BLOCK == 0.6 and L["order_capable_labels"] == [] and "doctor_conflict" in L["conflicts"]


# mutant m10: the temp file is removed when the write fails
def test_fix1_l7_m10_temp_file_removed_when_the_write_fails(tmp_path, monkeypatch):
    b = tmp_path / "eta" / "bundle"
    b.mkdir(parents=True)

    def boom(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(R.json, "dump", boom)
    with pytest.raises(OSError):
        R.write_layer({"layer": "role_votes"}, str(b), str(tmp_path / "eta"), str(tmp_path / "fb"))
    assert os.listdir(b) == []


# mutant m12: a label with exactly 2000 ms of speech must be covered
def test_fix1_l7_m12_coverage_required_at_exactly_2000_ms():
    votes = [{"slot": "a", "t0_ms": 0, "t1_ms": 10000}, {"slot": "b", "t0_ms": 10000, "t1_ms": 20000}]
    for dur_ms, status in ((1999, "clean"), (2000, "ambiguous"), (2001, "ambiguous")):
        bundle = segs(("speaker_0", 0, 10), ("speaker_1", 10, 20))
        bundle.append({"speaker": "speaker_2", "t0_ms": 20000, "t1_ms": 20000 + dur_ms})
        assert R.map_labels(votes, bundle)["status"] == status, dur_ms


# ---- fix2 (LOW-8, LOW-9, LOW-10): non-finite and None fail closed
_NAN = float("nan")


def test_low8_nan_p_doctor_does_not_name_a_doctor():
    ps = {"speaker_0": [_NAN, 0.1, 0.1, 0.1], "speaker_1": [0.1, 0.8, 0.05, 0.05]}
    doc, _, code = R.choose_slots(ps, ["speaker_0", "speaker_1"])
    assert doc is None, code


def test_low8_nan_runner_up_p_doctor_does_not_bypass_margin():
    ps = {"speaker_0": [0.7, 0.1, 0.1, 0.1], "speaker_1": [_NAN, 0.8, 0.05, 0.05]}
    doc, _, code = R.choose_slots(ps, ["speaker_0", "speaker_1"])
    assert doc is None, code


@pytest.mark.parametrize("nanlab", ["speaker_1", "speaker_2"])
def test_low9_nan_vector_next_label_order_independent(nanlab):
    C = cen("d0", "d1", "d2")
    vecs = {"speaker_0": with_cos(C["d0"], 0.9, 7), "speaker_1": with_cos(C["d0"], 0.3, 6),
            "speaker_2": with_cos(C["d0"], 0.3, 5)}
    vecs[nanlab] = np.full(DIM, _NAN)
    per, old, _ = R.voiceprint(vecs, sorted(vecs), C, "d0")
    assert all(p["armc"] is False for p in per.values())
    assert old["treating_label"] is None


def test_low10_role_none_tie_does_not_crash_and_fails_closed():
    role = [{"role": None, "t0_ms": 0, "t1_ms": 5000}, {"role": "doctor", "t0_ms": 5000, "t1_ms": 10000}]
    r, _ = R.role_majority([{"t0_ms": 0, "t1_ms": 10000}], role)
    assert r == "undecided"


def test_low10_role_none_majority_is_undecided_not_a_role():
    role = [{"role": None, "t0_ms": 0, "t1_ms": 6000}, {"role": "doctor", "t0_ms": 6000, "t1_ms": 10000}]
    r, _ = R.role_majority([{"t0_ms": 0, "t1_ms": 10000}], role)
    assert r == "undecided"


# ---------------------------------------------------------------- fix3 (MEDIUM-A, MEDIUM-B, LOW-11, LOW-12)
_SEG = [{"t0_ms": 0, "t1_ms": 10000}]


def _rr(*spec):
    t, out = 0, []
    for role, ms in spec:
        out.append({"role": role, "t0_ms": t, "t1_ms": t + ms})
        t += ms
    return out


def _m1_setup(nan_on_third, bad=_NAN):
    C = cen("d0", "d1", "d2")
    bundle = segs(("speaker_0", 0, 10), ("speaker_1", 10, 20), ("speaker_2", 20, 30), ("speaker_0", 30, 40))
    role = [{"role": "doctor", "t0_ms": 0, "t1_ms": 10000}, {"role": "patient", "t0_ms": 10000, "t1_ms": 30000},
            {"role": "doctor", "t0_ms": 30000, "t1_ms": 40000}]
    ps = {"speaker_0": [0.9, 0.05, 0.03, 0.02], "speaker_1": [0.1, 0.8, 0.05, 0.05], "speaker_2": [0.1, 0.3, 0.3, 0.3]}
    vecs = {"speaker_0": with_cos(C["d0"], 0.88, 7), "speaker_1": with_cos(C["d0"], 0.85, 6),
            "speaker_2": np.full(DIM, bad) if nan_on_third else with_cos(C["d0"], 0.2, 5)}
    return build(bundle=bundle, role=role, clef=ps, jev=ps, vecs=vecs, centroids=C)


def test_fix3_a_control_n1_blocks_without_nan():
    L = _m1_setup(False)
    assert L["rule_a_labels"] == ["speaker_0"] and "speaker_1" in L["n1_candidates"] and L["order_capable_labels"] == []


@pytest.mark.parametrize("bad", [_NAN, float("inf"), -float("inf")])
def test_fix3_a_nan_on_a_third_label_orders_nothing_and_records_the_code(bad):
    L = _m1_setup(True, bad)
    assert L["rule_a_labels"] == ["speaker_0"]  # rule A is untouched; only order capability is withdrawn
    assert L["order_capable_labels"] == []
    assert "non_finite_vector" in L["degraded"]
    assert all(not x["order_capable"] for x in L["labels"])
    assert L["armc_on"] is True  # not routed through vp_degraded


def test_fix3_a_finite_consult_has_no_non_finite_code():
    assert "non_finite_vector" not in _m1_setup(False)["degraded"]
    assert "non_finite_vector" not in build()["degraded"]


@pytest.mark.parametrize("who", ["jev", "clef"])
def test_fix3_low11_nan_p_doctor_in_a_vote_blocks_rule_b(who):
    bad = {"speaker_0": [_NAN, 0.05, 0.03, 0.02], "speaker_1": [0.1, 0.8, 0.05, 0.05]}
    bad_other = {"speaker_0": [0.9, 0.05, 0.03, 0.02], "speaker_1": [_NAN, 0.8, 0.05, 0.05]}
    for ps in (bad, bad_other):
        L = build(**{who: ps})
        assert L["order_capable_labels"] == [] and L["rule_b_label"] is None


def test_fix3_low11_doctor_ranks_puts_non_finite_last():
    r = R.doctor_ranks({"a": [_NAN, 0, 0, 0], "b": [0.2, 0, 0, 0], "c": [0.9, 0, 0, 0]}, ["a", "b", "c"])
    assert r == {"c": 1, "b": 2, "a": 3}
    r = R.doctor_ranks({"a": [0.9, 0, 0, 0], "b": [float("inf"), 0, 0, 0]}, ["a", "b"])
    assert r["b"] == 2 and r["a"] == 1


def test_fix3_low12_nan_runner_up_centroid_abstains_in_any_order():
    for names in (("d0", "d1", "d2"), ("d2", "d1", "d0")):
        C = cen(*names)
        C["d2"] = np.full(DIM, _NAN)
        v = {"speaker_0": with_cos(C["d0"], 0.9, 7), "speaker_1": with_cos(C["d0"], 0.3, 6)}
        per, _, _ = R.voiceprint(v, ["speaker_0", "speaker_1"], C, "d0")
        assert not any(p["armc"] for p in per.values())


@pytest.mark.parametrize("x,y", [("patient", None), ("unknown", None), ("staff", None), ("patient", ""), ("other", None),
                                 ("attender", None)])
@pytest.mark.parametrize("flip", [False, True])
def test_fix3_b_unknown_tie_with_decided_non_doctor_blocks_arm_c(x, y, flip):
    spec = ((y, 5000), (x, 5000)) if flip else ((x, 5000), (y, 5000))
    role, _ = R.role_majority(_SEG, _rr(*spec))
    assert role not in (None, "", "undecided") and R.blocks_arm_c(role)
    rl = []
    for t0 in (0, 20000):
        rl += [{"role": x, "t0_ms": t0, "t1_ms": t0 + 5000}, {"role": y, "t0_ms": t0 + 5000, "t1_ms": t0 + 10000}]
    rl += [{"role": "patient", "t0_ms": 10000, "t1_ms": 20000}, {"role": "patient", "t0_ms": 30000, "t1_ms": 40000}]
    assert build(role=rl)["order_capable_labels"] == []


@pytest.mark.parametrize("y", [None, "", "undecided"])
def test_fix3_b_none_never_wins_a_tie_with_a_decided_non_doctor(y):
    assert R.role_majority(_SEG, _rr((y, 5000), ("patient", 5000)))[0] == "patient"


@pytest.mark.parametrize("y", [None, "", "undecided"])
def test_fix3_b_none_with_doctor_only_is_undecided(y):
    assert R.role_majority(_SEG, _rr((y, 5000), ("doctor", 5000)))[0] == "undecided"
    assert R.role_majority(_SEG, _rr(("doctor", 5000), (y, 5000)))[0] == "undecided"


def test_fix3_b_three_way_tie_doctor_patient_none_is_patient():
    r = R.role_majority([{"t0_ms": 0, "t1_ms": 9000}], _rr(("doctor", 3000), ("patient", 3000), (None, 3000)))[0]
    assert r == "patient"


def test_fix3_b_a_non_tied_none_does_not_override():
    assert R.role_majority(_SEG, _rr(("doctor", 6000), (None, 2000), ("patient", 2000)))[0] == "doctor"
    assert R.role_majority(_SEG, _rr((None, 6000), ("patient", 4000)))[0] == "undecided"
