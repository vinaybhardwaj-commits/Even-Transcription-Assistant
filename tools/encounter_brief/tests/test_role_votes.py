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


def build(bundle=BUNDLE, role=ROLE, clef=None, jev=None, duid="d0", vecs=None, centroids=None, rename=None):
    C = centroids if centroids is not None else cen("d0", "d1", "d2")
    if vecs is None:
        vecs = {"speaker_0": with_cos(C["d0"], 0.80, 7), "speaker_1": with_cos(C["d0"], 0.30, 6)}
    return R.build_layer(bundle_segs=bundle, role_segs=role,
                         clef_rows=vote_rows(bundle, PS if clef is None else clef, rename),
                         jev_rows=slot_rows(PS if jev is None else jev, rename),
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


@pytest.mark.parametrize("d3,c,vp,want,conf", [
    (set(), None, None, set(), []),
    (set(), "x", "x", {"x"}, []),
    ({"a"}, None, None, {"a"}, []),
    ({"a"}, "a", "a", {"a"}, []),
    ({"a"}, "x", "x", set(), ["doctor_conflict"]),
    ({"a", "b"}, None, None, set(), ["second_doctor"]),
    ({"a", "b"}, "a", "a", {"a"}, ["second_doctor"]),
    ({"a", "b"}, "x", "x", set(), ["doctor_conflict", "second_doctor"]),
    ({"a"}, None, "x", set(), ["doctor_conflict"]),
])
def test_order_capable_table(d3, c, vp, want, conf):
    got, conflicts = R.order_capable(d3, c, vp)
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
