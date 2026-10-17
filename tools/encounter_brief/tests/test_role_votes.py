"""Synthetic-only tests for role_votes.py. Random vectors are seeded and normalised; no real data."""
import ast
import base64
import importlib.util
import json
import os
import stat
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve()
SRC = HERE.parent.parent / "role_votes.py"
spec = importlib.util.spec_from_file_location("role_votes", SRC)
rv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rv)

DIM = 8
E = np.eye(DIM)
DOC, OTHER = "doc-uid", "other-uid"
CEN = {DOC: E[0], OTHER: E[1], "u3": E[3], "u4": E[4]}
LABS = ["speaker_0", "speaker_1", "speaker_2"]


def vec(cos_d, cos_c=0.0, far=5):
    """Unit vector with cosine cos_d to centroid DOC (e0) and cos_c to OTHER (e1)."""
    rest = 1 - cos_d ** 2 - cos_c ** 2
    return cos_d * E[0] + cos_c * E[1] + np.sqrt(rest) * E[far]


def p4(doc=0.0, pat=0.0, att=0.0, staff=0.0):
    return [doc, pat, att, staff]


def cin(vecs=None, uid=DOC, slot=None, jev=None, clef=None, roles=None, with_data=True):
    """Three labels, 10 s each. jev/clef: {label: p4}. roles: {label: role}."""
    c = rv.ConsultIn()
    c.vecs = {k: rv.unit(v) for k, v in (vecs or {}).items()}
    c.vecs_present = c.uid_present = True
    c.doctor_uid = uid
    if with_data:
        c.clef_slot_present, c.clef_slot = True, slot
        c.jev_rows = 1
        for i, lab in enumerate(LABS):
            c.timeline.append((lab, i * 10000, (i + 1) * 10000))
            if roles and lab in roles:
                c.role_segments.append((i * 10000, (i + 1) * 10000, roles[lab], None))
    c.jev_p = dict(jev or {})
    c.clef_p = dict(clef or {})
    return c


def far_vecs(**over):
    base = {lab: E[5 + i] for i, lab in enumerate(LABS)}
    base.update(over)
    return base


def run(c):
    return rv.compute_consult(c, CEN)


def lab(d, name):
    return next(l for l in d["labels"] if l["label"] == name)


DOC_ROLES = {"speaker_0": "doctor", "speaker_1": "patient", "speaker_2": "attender"}
ALL_DOCTOR_ROLES = {l: "doctor" for l in LABS}  # role layer silent on non-doctors, so nothing blocks arm (c)
DOC_JEV = {"speaker_0": p4(doc=0.9), "speaker_1": p4(pat=0.9), "speaker_2": p4(att=0.9)}


# ---- thresholds

@pytest.mark.parametrize("cos_c,expect", [(0.651, False), (0.65, True)])
def test_margin_runner_up_centroid_boundary(cos_c, expect):
    d = run(cin(far_vecs(speaker_0=vec(0.70, cos_c)), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0"))
    assert lab(d, "speaker_0")["armc_new"] is expect
    assert (d["voiceprint_match_label"] == "speaker_0") is expect


@pytest.mark.parametrize("m_cos,expect", [(0.751, False), (0.75, True)])
def test_margin_next_label_boundary(m_cos, expect):
    d = run(cin(far_vecs(speaker_0=vec(0.80), speaker_1=vec(m_cos)), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0"))
    assert lab(d, "speaker_0")["armc_new"] is expect
    assert lab(d, "speaker_0")["voiceprint"]["margin_next_label"] == pytest.approx(0.80 - m_cos)


@pytest.mark.parametrize("cos_d,expect", [(0.649, False), (0.65, True)])
def test_cos_threshold(cos_d, expect):
    d = run(cin(far_vecs(speaker_0=vec(cos_d)), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0"))
    assert lab(d, "speaker_0")["armc_new"] is expect
    if cos_d < 0.65:
        assert d["armc_old_label"] is None


def test_one_centroid_set_abstains():
    one = {DOC: E[0]}
    d = rv.compute_consult(cin(far_vecs(speaker_0=vec(0.9))), one)
    assert d["voiceprint_match_label"] is None and d["armc_new_label"] is None
    assert d["armc_old_label"] == "speaker_0"  # merge_c has no runner-up-centroid rule


# ---- voters

def test_clef_doctor_only_on_slot_label():
    d = run(cin(far_vecs(), slot="speaker_1", roles=DOC_ROLES, jev=DOC_JEV))
    assert lab(d, "speaker_1")["clef_omni"]["role"] == "doctor" and lab(d, "speaker_1")["clef_omni"]["doctor_rank"] == 1
    for n in ("speaker_0", "speaker_2"):
        assert lab(d, n)["clef_omni"]["role"] is None and lab(d, n)["clef_omni"]["doctor_rank"] is None


def test_clef_no_slot_is_undecided_not_failed():
    d = run(cin(far_vecs(), slot=None, roles=DOC_ROLES, jev=DOC_JEV))
    assert d["mapping"]["status"] == "clean"
    assert all(l["clef_omni"]["status"] == "undecided" for l in d["labels"])


@pytest.mark.parametrize("who", ["jev", "clef", "role"])
def test_d2_contradiction_blocks_arm_c(who):
    jev, clef, roles = dict(DOC_JEV), {}, dict(DOC_ROLES)
    if who == "jev":
        jev["speaker_0"] = p4(doc=0.2, pat=0.7)
    elif who == "clef":
        clef["speaker_0"] = p4(doc=0.2, staff=0.7)
    else:
        roles["speaker_0"] = "staff"
    d = run(cin(far_vecs(speaker_0=vec(0.9)), roles=roles, jev=jev, clef=clef, slot="speaker_1"))
    l0 = lab(d, "speaker_0")
    assert l0["armc_new"] is False and l0["armc_contradiction"] == [who]
    assert d["voiceprint_match_label"] == "speaker_0"  # N1 match has no rank
    assert d["order_capable"] == [] and "armc_contradiction" in d["case_flags"]
    assert d["armc_old_label"] == "speaker_0"  # merge_c rule unchanged


def test_d2_below_threshold_does_not_block():
    jev = dict(DOC_JEV, speaker_0=p4(doc=0.3, pat=0.59))
    d = run(cin(far_vecs(speaker_0=vec(0.9)), roles=DOC_ROLES, jev=jev, slot="speaker_1"))
    assert lab(d, "speaker_0")["armc_new"] is True and d["order_capable"] == ["speaker_0"] and d["case"] == 3


# ---- order-capable rules

def test_n1_voiceprint_on_other_label_blocks_all():
    d = run(cin(far_vecs(speaker_1=vec(0.9)), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0"))
    assert d["three_of_three"] == ["speaker_0"] and d["voiceprint_match_label"] == "speaker_1"
    assert d["order_capable"] == [] and d["case"] == 5 and "doctor_conflict" in d["case_flags"]


def test_three_of_three_and_arm_c_same_label_case4():
    d = run(cin(far_vecs(speaker_0=vec(0.9)), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0"))
    assert d["order_capable"] == ["speaker_0"] and d["case"] == 4 and "both" in d["case_flags"]


def test_rule_a_only_when_no_voiceprint_match():
    d = run(cin(far_vecs(), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0"))
    assert d["order_capable"] == ["speaker_0"] and d["case"] == 6 and "rule_a_only" in d["case_flags"]


def test_voiceprint_unconfirmed_case2():
    d = run(cin(far_vecs(speaker_2=vec(0.9)), roles=DOC_ROLES, jev=DOC_JEV, slot=None))
    # arm (c) is NOT blocked here (attender p 0.9 on speaker_2 contradicts) -> blocked, v present, no 3/3
    assert d["order_capable"] == [] and d["case"] == 2 and "voiceprint_unconfirmed" in d["case_flags"]


def test_arm_c_only_case3():
    jev = {k: p4(att=0.3, doc=0.4) for k in LABS}
    d = run(cin(far_vecs(speaker_1=vec(0.9)), roles=ALL_DOCTOR_ROLES, jev=jev, slot=None))
    assert d["order_capable"] == ["speaker_1"] and d["case"] == 3


def test_no_signal_case1():
    d = run(cin(far_vecs(), roles=DOC_ROLES, jev=DOC_JEV, slot=None))
    assert d["order_capable"] == [] and d["case"] == 1


@pytest.mark.parametrize("armc,expected", [("a", ["a"]), (None, []), ("c", [])])
def test_two_three_of_three_labels(armc, expected):
    # voiceprint available; 3/3 labels a and b. arm (c) on a / on neither / on a third label c.
    v = armc
    order, case, flags = rv.resolve_order(["a", "b"], armc, v, "ok")
    assert order == expected and "multiple_3of3" in flags


def test_two_three_of_three_without_voiceprint_orders_nothing():
    order, case, flags = rv.resolve_order(["a", "b"], None, None, "unavailable")
    assert order == [] and "multiple_3of3" in flags


@pytest.mark.parametrize("kw,deg", [
    (dict(uid=None), "no_doctor_uid"),
    (dict(uid="not-enrolled"), "no_enrolment"),
    (dict(vecs={}), "no_vectors"),
])
def test_case7_no_voiceprint(kw, deg):
    kw = dict(kw)
    vecs = kw.pop("vecs", far_vecs(speaker_0=vec(0.9)))
    d = run(cin(vecs, roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0", **kw))
    assert deg in d["degraded"]
    assert d["order_capable"] == ["speaker_0"] and d["case"] == 7 and "case7_no_voiceprint" in d["case_flags"]
    assert d["voiceprint_match_label"] is None and d["armc_new_label"] is None and d["armc_old_label"] is None
    assert lab(d, "speaker_0")["voiceprint"]["status"] == deg


def test_no_enrolment_without_three_of_three_orders_nothing():
    d = run(cin(far_vecs(), uid="nobody", roles=DOC_ROLES, jev=DOC_JEV, slot=None))
    assert "no_enrolment" in d["degraded"] and d["order_capable"] == [] and "case7_no_voiceprint" not in d["case_flags"]


# ---- mapping

def test_mapping_ambiguous_drops_voters_2_and_3():
    c = cin(far_vecs(speaker_0=vec(0.9)), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0")
    c.role_segments.append((9000, 11000, "doctor", None))  # 1 s on speaker_0, 1 s on speaker_1: a tie
    d = run(c)
    assert d["mapping"]["status"] == "ambiguous" and "mapping_ambiguous" in d["degraded"]
    for l in d["labels"]:
        assert l["jev"]["status"] == "absent" and l["clef_omni"]["status"] == "absent"
    assert d["three_of_three"] == [] and d["order_capable"] == [] and d["armc_new_label"] is None


def test_mapping_failed_when_a_voter_has_no_data():
    c = cin(far_vecs(speaker_0=vec(0.9)), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0")
    c.jev_rows = 0
    d = run(c)
    assert d["mapping"]["status"] == "failed" and d["mapping"]["reason"] == "voter_no_data:jev"
    assert "mapping_failed" in d["degraded"] and d["order_capable"] == []


def test_mapping_failed_when_role_track_empty():
    d = run(cin(far_vecs(), roles=None, jev=DOC_JEV, slot="speaker_0"))
    assert d["mapping"]["status"] == "failed" and d["order_capable"] == []


# ---- CLI end to end

def b64(v):
    return base64.b64encode(np.asarray(v, dtype=np.float32).tobytes()).decode()


def write_inputs(tmp, consults):
    """consults: {cid: ConsultIn-like dict}. Writes every input file; returns CLI flag list."""
    tmp = Path(tmp)
    (tmp / "centroids.json").write_text(json.dumps([{"pulse_doctor_uid": u, "b64": b64(v)} for u, v in CEN.items()]))
    vecs, uids, slots, jrows, crows, rseg = {}, {}, {}, [], [], []
    for cid, c in consults.items():
        vecs[cid] = {l: [float(x) for x in v] for l, v in c.vecs.items()}
        uids[cid] = c.doctor_uid
        slots[cid] = c.clef_slot
        for l, a, b in c.timeline:
            for lst, voter, ps in ((jrows, "jev_cue", c.jev_p), (crows, "clef_omni", c.clef_p)):
                row = {"consult_id": cid, "t0_ms": a, "t1_ms": b, "slot": l, "voter": voter}
                p = ps.get(l)
                row.update({k: (p[i] if p else None) for i, k in enumerate(rv.KEYS)})
                lst.append(row)
        for a, b, role, p in c.role_segments:
            rseg.append({"consult_id": cid, "t0_ms": a, "t1_ms": b, "role": role, **({} if p is None else {"p": p})})
    (tmp / "vecs.json").write_text(json.dumps(vecs))
    (tmp / "uids.json").write_text(json.dumps(uids))
    (tmp / "slots.json").write_text(json.dumps(slots))
    for name, rows in (("jev.jsonl", jrows), ("clef.jsonl", crows), ("roles.jsonl", rseg)):
        (tmp / name).write_text("".join(json.dumps(r) + "\n" for r in rows))
    return ["--vecs", str(tmp / "vecs.json"), "--centroids", str(tmp / "centroids.json"), "--doctor-uids", str(tmp / "uids.json"),
            "--clef-votes", str(tmp / "clef.jsonl"), "--jev-votes", str(tmp / "jev.jsonl"), "--clef-doctor-slot", str(tmp / "slots.json"),
            "--role-segments", str(tmp / "roles.jsonl"), "--jev-set-id", "synthetic-set", "--created-at", "2026-10-17T00:00:00Z"]


def synthetic_consults():
    rng = np.random.default_rng(7)
    out = {}
    for i in range(5):
        # non-enrolled voices; the Clef slot is null, so no label reaches 3/3 (a 3/3 label with no voiceprint match is order-capable by ruling 6)
        vecs = {l: np.concatenate([np.zeros(5), rng.normal(size=3)]) for l in LABS}  # orthogonal to every centroid
        out[f"c{i}"] = cin(vecs, slot=None, roles=DOC_ROLES, jev=DOC_JEV)
    return out


def test_build_reproduce_mode_bytes_layout(tmp_path, capsys):
    cons = {
        "c_both": cin(far_vecs(speaker_0=vec(0.9)), slot="speaker_0", roles=DOC_ROLES, jev=DOC_JEV),
        "c_none": cin(far_vecs(), slot=None, roles=DOC_ROLES, jev=DOC_JEV),
        "c_armc": cin(far_vecs(speaker_1=vec(0.9)), slot=None, roles=ALL_DOCTOR_ROLES, jev={k: p4(att=0.3, doc=0.4) for k in LABS}),
    }
    flags = write_inputs(tmp_path, cons)
    out1, out2 = tmp_path / "o1", tmp_path / "o2"
    assert rv.main(["build"] + flags + ["--out-dir", str(out1)]) == 0
    assert rv.main(["build"] + flags + ["--out-dir", str(out2)]) == 0
    counts = json.loads(capsys.readouterr().out.strip().splitlines()[0])
    assert counts["consults"] == 3 and counts["mapping"] == {"clean": 3}
    for cid in cons:
        p1, p2 = out1 / cid / "role_votes.v1.json", out2 / cid / "role_votes.v1.json"
        assert stat.S_IMODE(os.stat(p1).st_mode) == 0o600
        assert p1.read_bytes() == p2.read_bytes()
    d = json.loads((out1 / "c_both" / "role_votes.v1.json").read_text())
    meta = d["metadata"]
    assert meta["jev_question_set"] == "synthetic-set" and meta["created_at"] == "2026-10-17T00:00:00Z"
    assert len(meta["centroids_sha256"]) == 64 and len(meta["code_sha256"]) == 64 and meta["thresholds"]["cos_min"] == 0.65
    assert d["label_space"] == "diar_nemotron" and d["order_capable"] == ["speaker_0"]
    assert rv.main(["reproduce", "--in-dir", str(out1)]) == 0
    rep = json.loads(capsys.readouterr().out)
    # c_none: no 3/3 (clef null) and no arm (c): zero everywhere. c_armc: arm (c) only. c_both: 3/3.
    assert rep["consults"] == 3 and rep["zero_order_3of3_alone"] == 2
    assert rep["zero_order_with_armc_one_margin"] == 1 and rep["zero_order_with_armc_both_margins"] == 1
    assert rep["case7_consults"] == 0 and rep["voiceprint_missing"] == 0


def test_layout_file_mirrors_and_rejects_escape(tmp_path):
    res = {"c": rv.compute_consult(cin(far_vecs(), slot="speaker_0", roles=DOC_ROLES, jev=DOC_JEV), CEN)}
    rv.write_all(res, str(tmp_path / "o"), {"c": "bundles/x"})
    assert (tmp_path / "o" / "bundles" / "x" / "role_votes.v1.json").exists()
    with pytest.raises(ValueError):
        rv.write_all(res, str(tmp_path / "o"), {"c": "../escape"})


def test_file_overwrite_keeps_0600_under_permissive_umask(tmp_path):
    old = os.umask(0)
    try:
        p = tmp_path / "d" / "role_votes.v1.json"
        rv.write_private(str(p), "{}")
        os.chmod(p, 0o644)
        rv.write_private(str(p), "{}")
        assert stat.S_IMODE(os.stat(p).st_mode) == 0o600
    finally:
        os.umask(old)


# ---- import ban

BANNED = {"http", "requests", "socket", "psycopg", "psycopg2", "psycopg3", "sqlalchemy", "urllib", "urllib3", "httpx", "aiohttp"}


def test_import_ban():
    tree = ast.parse(SRC.read_text())
    mods = []
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            mods += [a.name for a in n.names]
        elif isinstance(n, ast.ImportFrom):
            mods.append(("." * n.level) + (n.module or ""))
    tops = {m.lstrip(".").split(".")[0] for m in mods}
    assert not (tops & BANNED), tops & BANNED
    assert not any(t in ("lib", "app") for t in tops)
    assert not any(m.startswith(".") for m in mods)
    assert "tools" not in tops


# ================================================================ fix round 1

def armc_case(roles, jev=None, clef=None, **kw):
    """speaker_0 matches the voiceprint; returns the output dict."""
    return run(cin(far_vecs(speaker_0=vec(0.9)), roles=roles, jev=jev or DOC_JEV, clef=clef, slot="speaker_1", **kw))


# ---- F1
@pytest.mark.parametrize("word", ["attendant", "nurse", "translator", "relative", "family", "caregiver", "patient ", "PATIENT", "bystander"])
def test_f1_any_non_doctor_role_word_blocks_arm_c(word):
    d = armc_case(dict(DOC_ROLES, speaker_0=word))
    assert lab(d, "speaker_0")["armc_new"] is False and lab(d, "speaker_0")["armc_contradiction"] == ["role"]
    assert d["order_capable"] == []


@pytest.mark.parametrize("word,flagged", [("nurse", True), ("bystander", True), ("translator", False), ("patient ", False)])
def test_f1_unknown_role_word_sets_flag(word, flagged):
    d = armc_case(dict(DOC_ROLES, speaker_0=word))
    assert ("unknown_role_word" in d["case_flags"]) is flagged


def test_f1_doctor_word_is_normalised_and_exact():
    d = run(cin(far_vecs(), roles=dict(DOC_ROLES, speaker_0=" Doctor "), jev=DOC_JEV, slot="speaker_0"))
    assert lab(d, "speaker_0")["role_track"]["role"] == "doctor" and d["three_of_three"] == ["speaker_0"]
    d = run(cin(far_vecs(), roles=dict(DOC_ROLES, speaker_0="doctors"), jev=DOC_JEV, slot="speaker_0"))
    assert d["three_of_three"] == [] and "unknown_role_word" in d["case_flags"]


def test_f1_empty_role_is_dropped_by_loader(tmp_path):
    c = cin(far_vecs(), roles=DOC_ROLES, jev=DOC_JEV, slot=None)
    c.role_segments.append((0, 1000, "  ", None))
    flags = write_inputs(tmp_path, {"c": c})
    ins = rv.load_inputs(*[flags[i] for i in (1, 7, 9, 11, 13, 15)][:0] or [str(tmp_path / n) for n in ("vecs.json", "uids.json", "clef.jsonl", "jev.jsonl", "slots.json", "roles.jsonl")])
    assert all(r[2] for r in ins["c"].role_segments)


# ---- F2
def test_f2_consult_missing_from_files_orders_nothing_and_is_not_case7():
    for field in ("uid_present", "vecs_present"):
        c = cin(far_vecs(), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0")
        setattr(c, field, False)
        d = run(c)
        assert d["order_capable"] == [] and d["case"] is None and "case7_no_voiceprint" not in d["case_flags"]
        assert "voiceprint_missing" in d["degraded"] and "voiceprint_missing" in d["case_flags"]
        assert lab(d, "speaker_0")["voiceprint"]["status"] == "voiceprint_missing"


def test_f2_loader_and_exit_report_count_missing(tmp_path, capsys):
    cons = {"c_ok": cin(far_vecs(), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0"),
            "c_nouid": cin(far_vecs(), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0"),
            "c_novec": cin(far_vecs(), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0")}
    flags = write_inputs(tmp_path, cons)
    u = json.loads((tmp_path / "uids.json").read_text()); u.pop("c_nouid"); (tmp_path / "uids.json").write_text(json.dumps(u))
    v = json.loads((tmp_path / "vecs.json").read_text()); v.pop("c_novec"); (tmp_path / "vecs.json").write_text(json.dumps(v))
    out = tmp_path / "o"
    assert rv.main(["build"] + flags + ["--out-dir", str(out)]) == 0
    capsys.readouterr()
    ids = tmp_path / "ids.json"
    assert rv.main(["reproduce", "--in-dir", str(out), "--ids-out", str(ids)]) == 0
    stdout = capsys.readouterr().out
    rep = json.loads(stdout)
    assert rep["voiceprint_missing"] == 2 and rep["case7_consults"] == 0
    assert "c_nouid" not in stdout and "c_ok" not in stdout  # ids never on stdout
    assert stat.S_IMODE(os.stat(ids).st_mode) == 0o600
    assert sorted(json.loads(ids.read_text())["voiceprint_missing"]) == ["c_nouid", "c_novec"]


# ---- F3
def test_f3_nested_output_dirs_are_0700_under_umask_0(tmp_path):
    old = os.umask(0)
    try:
        res = {"c": rv.compute_consult(cin(far_vecs(), slot="speaker_0", roles=DOC_ROLES, jev=DOC_JEV), CEN, "c")}
        out = tmp_path / "a" / "b" / "out"
        rv.write_all(res, str(out), {"c": "x/y"})
        for d in (out.parent, out, out / "x", out / "x" / "y"):
            assert stat.S_IMODE(os.stat(d).st_mode) == 0o700, d
        assert stat.S_IMODE(os.stat(out / "x" / "y" / "role_votes.v1.json").st_mode) == 0o600
    finally:
        os.umask(old)


def test_f3_existing_wide_directory_is_an_error(tmp_path):
    res = {"c": rv.compute_consult(cin(far_vecs(), slot="speaker_0", roles=DOC_ROLES, jev=DOC_JEV), CEN, "c")}
    out = tmp_path / "wide"
    out.mkdir(); os.chmod(out, 0o755)
    with pytest.raises(PermissionError):
        rv.write_all(res, str(out))
    out2 = tmp_path / "ok"
    out2.mkdir(); os.chmod(out2, 0o700)
    (out2 / "c").mkdir(); os.chmod(out2 / "c", 0o750)
    with pytest.raises(PermissionError):
        rv.write_all(res, str(out2))


# ---- F4
def truth_file(tmp_path, rows):
    p = tmp_path / "truth.jsonl"
    p.write_text("".join(json.dumps({"consult_id": c, "label": l, "true_role": r}) + "\n" for c, l, r in rows))
    return str(p)


def test_f4_fa_check_refuses_without_truth(tmp_path):
    flags = write_inputs(tmp_path, {"c": cin(far_vecs(), roles=DOC_ROLES, jev=DOC_JEV, slot=None)})
    assert rv.main(["fa-check"] + flags) == 2


def test_f4_bad_true_role_refuses(tmp_path):
    flags = write_inputs(tmp_path, {"c": cin(far_vecs(), roles=DOC_ROLES, jev=DOC_JEV, slot=None)})
    assert rv.main(["fa-check"] + flags + ["--truth", truth_file(tmp_path, [("c", "speaker_0", "surgeon")])]) == 2


def test_f4_clean_run_and_yield(tmp_path, capsys):
    cons = {"c": cin(far_vecs(speaker_0=vec(0.9)), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0")}
    flags = write_inputs(tmp_path, cons)
    truth = truth_file(tmp_path, [("c", "speaker_0", "doctor"), ("c", "speaker_1", "patient"), ("c", "speaker_2", "attender")])
    assert rv.main(["fa-check"] + flags + ["--truth", truth]) == 0
    t = json.loads(capsys.readouterr().out)
    assert t["voiceprint_match_not_doctor"] == 0 and t["order_capable_not_doctor"]["total"] == 0
    assert t["order_capable_yield_on_true_doctor"] == 1 and t["unlabelled_labels"] == 0


def test_f4_wrong_voiceprint_match_and_route_split(tmp_path, capsys):
    cons = {
        # arm (c) route: voiceprint on speaker_1, no 3/3; truth says speaker_1 is a staff member
        "c_arm": cin(far_vecs(speaker_1=vec(0.9)), roles=ALL_DOCTOR_ROLES, jev={k: p4(att=0.3, doc=0.4) for k in LABS}, slot=None),
        # 3/3 route (case 6): voiceprint matches nothing, 3/3 label is truly a translator
        "c_3of3": cin(far_vecs(), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0"),
        # case 7: no doctor_uid, 3/3 label truly a patient
        "c_7": cin(far_vecs(), uid=None, roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0"),
    }
    flags = write_inputs(tmp_path, cons)
    truth = truth_file(tmp_path, [("c_arm", "speaker_1", "staff"), ("c_3of3", "speaker_0", "translator"), ("c_7", "speaker_0", "patient")])
    assert rv.main(["fa-check"] + flags + ["--truth", truth]) == 1
    t = json.loads(capsys.readouterr().out)
    assert t["voiceprint_match_not_doctor"] == 1
    assert t["order_capable_not_doctor"] == {"3of3": 1, "arm_c": 1, "case7": 1, "total": 3}
    assert t["unlabelled_labels"] == 6  # labels without a truth row count as not the doctor


def test_f4_reproduce_prints_truth_counts(tmp_path, capsys):
    cons = {"c": cin(far_vecs(speaker_0=vec(0.9)), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0")}
    flags = write_inputs(tmp_path, cons)
    rv.main(["build"] + flags + ["--out-dir", str(tmp_path / "o")]); capsys.readouterr()
    truth = truth_file(tmp_path, [("c", "speaker_0", "patient")])
    assert rv.main(["reproduce", "--in-dir", str(tmp_path / "o"), "--truth", truth]) == 0
    t = json.loads(capsys.readouterr().out)["truth"]
    assert t["voiceprint_match_not_doctor"] == 1 and t["order_capable_not_doctor"]["3of3"] == 1


# ---- F5
def test_f5_build_refuses_without_created_at(tmp_path, monkeypatch):
    monkeypatch.delenv("SOURCE_DATE_EPOCH", raising=False)
    flags = write_inputs(tmp_path, {"c": cin(far_vecs(), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0")})
    i = flags.index("--created-at")
    bare = flags[:i] + flags[i + 2:]
    assert rv.main(["build"] + bare + ["--out-dir", str(tmp_path / "o")]) == 2
    assert not (tmp_path / "o").exists()
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "not-a-number")
    assert rv.main(["build"] + bare + ["--out-dir", str(tmp_path / "o")]) == 2
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1792195200")
    assert rv.main(["build"] + bare + ["--out-dir", str(tmp_path / "o")]) == 0
    d = json.loads((tmp_path / "o" / "c" / "role_votes.v1.json").read_text())
    assert d["metadata"]["created_at"] == "2026-10-17T00:00:00Z"


def test_f5_no_wall_clock_in_source():
    src = SRC.read_text()
    import re
    assert not re.search(r"datetime\.now|utcnow|\btime\.time\b|\btime\.localtime", src)


# ---- F6
def test_f6_jev_tie_is_not_doctor():
    assert rv.jev_vote([0.6, 0.6, 0.0, 0.0]) is None
    assert rv.jev_vote([0.6, 0.4, 0.0, 0.0]) == "doctor"
    assert rv.jev_vote([0.59, 0.1, 0.1, 0.1]) is None
    assert rv.jev_vote([0.7, 0.7, 0.0, 0.0]) is None
    d = run(cin(far_vecs(), roles=DOC_ROLES, jev=dict(DOC_JEV, speaker_0=p4(doc=0.6, pat=0.6)), slot="speaker_0"))
    assert d["three_of_three"] == []


# ---- F7
def test_f7_missing_vector_on_another_label_abstains():
    vecs = {"speaker_0": vec(0.9), "speaker_1": E[5]}  # speaker_2 has speech but no vector
    d = run(cin(vecs, roles=DOC_ROLES, jev=DOC_JEV, slot=None))
    assert d["armc_new_label"] is None and d["voiceprint_match_label"] is None
    assert "next_label_margin_incomplete" in d["case_flags"]
    assert d["armc_old_label"] == "speaker_0"  # merge_c unchanged


def test_f7_true_single_label_consult_may_skip_next_margin():
    c = rv.ConsultIn()
    c.vecs, c.vecs_present, c.uid_present, c.doctor_uid = {"speaker_0": rv.unit(vec(0.9))}, True, True, DOC
    c.timeline, c.jev_rows, c.clef_slot_present, c.clef_slot = [("speaker_0", 0, 10000)], 1, True, "speaker_0"
    c.role_segments, c.jev_p = [(0, 10000, "doctor", None)], {"speaker_0": p4(doc=0.9)}
    d = run(c)
    assert d["armc_new_label"] == "speaker_0" and "next_label_margin_incomplete" not in d["case_flags"]
    assert d["order_capable"] == ["speaker_0"]


# ---- F8
def f8_roles(segs):
    c = cin(far_vecs(speaker_0=vec(0.9)), roles={k: v for k, v in DOC_ROLES.items() if k != "speaker_0"}, jev=DOC_JEV, slot="speaker_1")
    c.role_segments += segs
    return run(c)


@pytest.mark.parametrize("dur,p,blocked", [(3000, 0.9, True), (2000, 0.6, True), (1999, 0.9, False), (3000, 0.59, False), (3000, None, False)])
def test_f8_single_long_non_doctor_role_segment_blocks(dur, p, blocked):
    d = f8_roles([(0, 10000 - dur, "doctor", None), (10000 - dur, 10000, "nurse", p)])
    l0 = lab(d, "speaker_0")
    assert l0["role_track"]["role"] == "doctor"  # majority rule alone would not block
    assert (l0["armc_new"] is False) is blocked


def test_f8_max_over_all_rows_for_clef_and_jev():
    c = cin(far_vecs(speaker_0=vec(0.9)), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_1")
    c.jev_nd = {"speaker_0": 0.8}
    assert lab(run(c), "speaker_0")["armc_contradiction"] == ["jev"]
    c = cin(far_vecs(speaker_0=vec(0.9)), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_1")
    c.clef_nd = {"speaker_0": 0.8}
    assert lab(run(c), "speaker_0")["armc_contradiction"] == ["clef"]


def test_f8_loader_takes_max_over_rows_not_first_row(tmp_path, capsys):
    c = cin(far_vecs(speaker_0=vec(0.9)), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_1")
    flags = write_inputs(tmp_path, {"c": c})
    extra = {"consult_id": "c", "t0_ms": 0, "t1_ms": 500, "slot": "speaker_0", "voter": "jev_cue", "p_doctor": 0.1, "p_patient": 0.8, "p_attender": 0.05, "p_staff": 0.05}
    with open(tmp_path / "jev.jsonl", "a") as f:
        f.write(json.dumps(extra) + "\n")
    assert rv.main(["build"] + flags + ["--out-dir", str(tmp_path / "o")]) == 0
    d = json.loads((tmp_path / "o" / "c" / "role_votes.v1.json").read_text())
    l0 = next(l for l in d["labels"] if l["label"] == "speaker_0")
    assert l0["armc_contradiction"] == ["jev"] and d["order_capable"] == []


# ---- F9 and the lead's metadata flags
MC_COS_MIN, MC_MARGIN = 0.65, 0.05


def mc_unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / (np.linalg.norm(v) + 1e-12)


def mc_treating(cid, vecs, cen, duid):
    """Verbatim copy of merge_c.treating() from the brief (names prefixed, constants inlined as globals)."""
    unit = mc_unit
    COS_MIN, MARGIN = MC_COS_MIN, MC_MARGIN
    if not duid or duid not in cen:
        return None, "no_centroid", None, None
    labs = vecs.get(cid, {})
    if not labs:
        return None, "no_label_vector", None, None
    sims = sorted(((float(unit(v) @ cen[duid]), lab) for lab, v in labs.items()), reverse=True)
    b, lab = sims[0]
    r = sims[1][0] if len(sims) > 1 else None
    if b < COS_MIN:
        return None, "below_cos_min", b, r
    if r is not None and b - r < MARGIN:
        return None, "inside_margin", b, r
    return lab, "ok", b, r


def test_f9_armc_old_parity_with_verbatim_merge_c_on_1000_consults():
    rng = np.random.default_rng(1017)
    dim = 16
    cen = {f"d{i}": mc_unit(rng.normal(size=dim)) for i in range(20)}
    uids = list(cen)
    mism = hits = 0
    for n in range(1000):
        uid = uids[rng.integers(20)] if n % 10 else (None if n % 20 == 0 else "ghost")
        k = int(rng.integers(0, 6))
        vecs = {}
        for i in range(k):
            v = rng.normal(size=dim)
            if uid in cen and rng.random() < 0.5:
                v = cen[uid] * rng.uniform(0.8, 4.0) + 0.5 * v / np.linalg.norm(v)
            vecs[f"speaker_{i}"] = v * rng.uniform(0.5, 3.0)
        expect = mc_treating("c", {"c": vecs}, cen, uid)[0]
        c = rv.ConsultIn()
        c.vecs, c.vecs_present, c.uid_present, c.doctor_uid = vecs, True, True, uid
        d = rv.compute_consult(c, cen)
        got = [l["label"] for l in d["labels"] if l["armc_old"]]
        mism += got != ([expect] if expect else []) or d["armc_old_label"] != expect or rv.treating_old(vecs, cen, uid) != expect
        hits += expect is not None
    assert mism == 0
    assert 100 < hits < 900  # not trivially all-None


def test_metadata_flags_for_missing_jev_ids(tmp_path):
    flags = write_inputs(tmp_path, {"c": cin(far_vecs(), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0")})
    rv.main(["build"] + flags + ["--out-dir", str(tmp_path / "o1")])
    d = json.loads((tmp_path / "o1" / "c" / "role_votes.v1.json").read_text())
    assert d["metadata"]["jev_question_id"] is None and "jev_question_id_missing" in d["case_flags"] and "jev_model_missing" in d["case_flags"]
    rv.main(["build"] + flags + ["--jev-question-id", "q7", "--jev-model", "m1", "--out-dir", str(tmp_path / "o2")])
    d = json.loads((tmp_path / "o2" / "c" / "role_votes.v1.json").read_text())
    assert d["metadata"]["jev_question_id"] == "q7" and d["metadata"]["jev_model"] == "m1"
    assert not [f for f in d["case_flags"] if f.endswith("_missing")]


def test_exit_report_lists_case7_and_ambiguous_separately(tmp_path, capsys):
    amb = cin(far_vecs(), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0")
    amb.role_segments.append((9000, 11000, "doctor", None))
    cons = {"c7": cin(far_vecs(), uid=None, roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0"), "camb": amb,
            "cok": cin(far_vecs(), roles=DOC_ROLES, jev=DOC_JEV, slot="speaker_0")}
    flags = write_inputs(tmp_path, cons)
    rv.main(["build"] + flags + ["--out-dir", str(tmp_path / "o")]); capsys.readouterr()
    ids = tmp_path / "ids.json"
    assert rv.main(["reproduce", "--in-dir", str(tmp_path / "o"), "--ids-out", str(ids)]) == 0
    out = capsys.readouterr().out
    rep = json.loads(out)
    assert rep["case7_consults"] == 1 and rep["mapping_ambiguous_consults"] == 1 and "c7" not in out and "camb" not in out
    j = json.loads(ids.read_text())
    assert j["case7"] == ["c7"] and j["mapping_ambiguous"] == ["camb"]
