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
    c.doctor_uid = uid
    if with_data:
        c.clef_slot_present, c.clef_slot = True, slot
        c.jev_rows = 1
        for i, lab in enumerate(LABS):
            c.timeline.append((lab, i * 10000, (i + 1) * 10000))
            if roles and lab in roles:
                c.role_segments.append((i * 10000, (i + 1) * 10000, roles[lab]))
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
UNKNOWN_ROLES = {l: "unknown" for l in LABS}
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
    d = run(cin(far_vecs(speaker_1=vec(0.9)), roles=UNKNOWN_ROLES, jev=jev, slot=None))
    assert d["order_capable"] == ["speaker_1"] and d["case"] == 3


def test_no_signal_case1():
    d = run(cin(far_vecs(), roles=DOC_ROLES, jev=DOC_JEV, slot=None))
    assert d["order_capable"] == [] and d["case"] == 1


@pytest.mark.parametrize("armc,expected", [("a", ["a"]), (None, []), ("c", [])])
def test_two_three_of_three_labels(armc, expected):
    # voiceprint available; 3/3 labels a and b. arm (c) on a / on neither / on a third label c.
    v = armc
    order, case, flags = rv.resolve_order(["a", "b"], armc, v, True)
    assert order == expected and "multiple_3of3" in flags


def test_two_three_of_three_without_voiceprint_orders_nothing():
    order, case, flags = rv.resolve_order(["a", "b"], None, None, False)
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
    c.role_segments.append((9000, 11000, "doctor"))  # 1 s on speaker_0, 1 s on speaker_1: a tie
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


# ---- property: armc_old equals merge_c's treating()

def merge_c_vote(vecs, cen, duid):
    """Re-implementation of merge_c.treating(), written from the merge_c source."""
    def unit(v):
        v = np.asarray(v, dtype=np.float64)
        return v / (np.linalg.norm(v) + 1e-12)
    if not duid or duid not in cen:
        return None
    if not vecs:
        return None
    sims = sorted(((float(unit(v) @ cen[duid]), l) for l, v in vecs.items()), reverse=True)
    b, label = sims[0]
    r = sims[1][0] if len(sims) > 1 else None
    if b < 0.65:
        return None
    if r is not None and b - r < 0.05:
        return None
    return label


def test_armc_old_matches_merge_c_on_200_random_consults():
    rng = np.random.default_rng(20261017)
    dim = 16
    cen = {f"d{i}": rv.unit(rng.normal(size=dim)) for i in range(20)}
    uids = list(cen)
    hits = 0
    for n in range(200):
        uid = uids[rng.integers(20)] if n % 10 else (None if n % 20 == 0 else "ghost")
        k = int(rng.integers(1, 6))
        vecs = {}
        for i in range(k):
            v = rng.normal(size=dim)
            if uid in cen and rng.random() < 0.5:
                v = cen[uid] * rng.uniform(1.5, 4.0) + 0.5 * v / np.linalg.norm(v)
            vecs[f"speaker_{i}"] = v * rng.uniform(0.5, 3.0)
        c = rv.ConsultIn()
        c.vecs, c.doctor_uid = vecs, uid
        d = rv.compute_consult(c, cen)
        expect = merge_c_vote(vecs, cen, uid)
        got = [l["label"] for l in d["labels"] if l["armc_old"]]
        assert got == ([expect] if expect else [])
        assert d["armc_old_label"] == expect
        hits += expect is not None
    assert 20 < hits < 180  # the property is not trivially all-None


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
        for a, b, role in c.role_segments:
            rseg.append({"consult_id": cid, "t0_ms": a, "t1_ms": b, "role": role})
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


def test_fa_check_zero_on_non_enrolled_voices(tmp_path, capsys):
    # voices live outside the span of every enrolled centroid, so none is an enrolled doctor
    cons = synthetic_consults()
    for c in cons.values():
        for v in c.vecs.values():
            assert max(abs(float(rv.unit(v) @ u)) for u in CEN.values()) < 1e-9
    flags = write_inputs(tmp_path, cons)
    assert rv.main(["fa-check"] + flags) == 0
    assert json.loads(capsys.readouterr().out)["false_accept_order_capable_or_voiceprint_match"] == 0


def test_fa_check_catches_planted_false_accept(tmp_path, capsys):
    cons = synthetic_consults()
    cons["c1"].vecs["speaker_1"] = rv.unit(vec(0.95))  # planted: a voice that matches the logged-in doctor
    flags = write_inputs(tmp_path, cons)
    assert rv.main(["fa-check"] + flags) == 1
    assert json.loads(capsys.readouterr().out)["false_accept_order_capable_or_voiceprint_match"] >= 1


def test_build_reproduce_mode_bytes_layout(tmp_path, capsys):
    cons = {
        "c_both": cin(far_vecs(speaker_0=vec(0.9)), slot="speaker_0", roles=DOC_ROLES, jev=DOC_JEV),
        "c_none": cin(far_vecs(), slot=None, roles=DOC_ROLES, jev=DOC_JEV),
        "c_armc": cin(far_vecs(speaker_1=vec(0.9)), slot=None, roles=UNKNOWN_ROLES, jev={k: p4(att=0.3, doc=0.4) for k in LABS}),
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
    assert rep == {"consults": 3, "zero_order_3of3_alone": 2, "zero_order_armc_old": 1, "zero_order_armc_new": 1}


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
