"""Synthetic tests for the T28b harness. No patient data; every vector is constructed here."""
import argparse
import ast
import base64
import io
import json
import os
import pathlib
import stat

import numpy as np
import pytest

from eval.pdqi9.t28b import core, run, stats

PKG = pathlib.Path(core.__file__).parent
D = 8


def e(i):
    v = np.zeros(D)
    v[i] = 1.0
    return v


def with_cos(base, c, ortho):
    """Unit vector with cosine c to base, using an orthogonal unit vector."""
    return c * base + np.sqrt(1 - c * c) * ortho


def b64(v):
    return base64.b64encode(np.asarray(v, dtype="<f4").tobytes()).decode()


# ---------------------------------------------------------------- arm (c) thresholds

def _arm(label_cos, other_label_cos=None, other_cent_cos=None):
    """One label vs centroid C=e0, optional second label / second centroid at set cosines to it."""
    C = e(0)
    L = with_cos(C, label_cos, e(1))
    labels = [L]
    if other_label_cos is not None:
        labels.append(with_cos(C, other_label_cos, e(2)))
    cents = [C]
    if other_cent_cos is not None:
        # centroid whose cosine to L is other_cent_cos: solve in the (e0,e1,e3) space
        # C2 = a*L + b*e3  => cos(L,C2)=a
        cents.append(other_cent_cos * L + np.sqrt(1 - other_cent_cos ** 2) * e(3))
    S = np.array(labels) @ np.array(cents).T
    mn, mr = core.arm_c_matrix(S, np.ones(len(cents), dtype=bool))
    return bool(core.passes(S[0, 0], mn[0, 0], mr[0, 0])), S, mn, mr


@pytest.mark.parametrize("cos,ok", [(0.649, False), (0.65, True), (0.66, True)])
def test_cosine_threshold(cos, ok):
    assert _arm(cos)[0] is ok


@pytest.mark.parametrize("gap,ok", [(0.049, False), (0.05, True), (0.06, True)])
def test_margin_next_label_threshold(gap, ok):
    assert _arm(0.80, other_label_cos=0.80 - gap)[0] is ok


@pytest.mark.parametrize("gap,ok", [(0.049, False), (0.05, True), (0.06, True)])
def test_margin_runner_up_centroid_threshold(gap, ok):
    assert _arm(0.80, other_cent_cos=0.80 - gap)[0] is ok


def test_planted_thresholds_survive_float32_centroids():
    """Centroids arrive as float32; a centroid sitting exactly on 0.65 must still pass."""
    C = e(0)
    L = with_cos(C, 0.65, e(1))
    cent = core.decode_centroid(b64(C))
    S = (np.array([L]) @ np.array([cent]).T)
    mn, mr = core.arm_c_matrix(S, np.ones(1, dtype=bool))
    assert core.passes(S[0, 0], mn[0, 0], mr[0, 0])


# ---------------------------------------------------------------- end-to-end fixtures

def make_world(tmp_path, n_consults=60, n_docs=12, seed=0, plant=None):
    """Doctors have random centroids; each consult has one true-speaker label and one noise label."""
    rng = np.random.default_rng(seed)
    docs = [f"doc{i:02d}" for i in range(n_docs)]
    cents = {d: core._unit(rng.normal(size=64)) for d in docs}
    manifest, vecs = [], {}
    for i in range(n_consults):
        d = docs[i % n_docs]
        true = core._unit(cents[d] + 0.15 * rng.normal(size=64) / 8)
        noise = core._unit(rng.normal(size=64))
        cu = f"c{i:04d}"
        manifest.append({"consult_uid": cu, "doctor_uid": d, "logged_in_doctor_uid": d})
        vecs[cu] = {"speaker_0": true.tolist(), "speaker_1": noise.tolist()}
    if plant:
        plant(cents, vecs, manifest)
    p = tmp_path
    (p / "manifest.jsonl").write_text("".join(json.dumps(r) + "\n" for r in manifest))
    (p / "vecs.json").write_text(json.dumps(vecs))
    (p / "centroids.json").write_text(json.dumps(
        [{"pulse_doctor_uid": d, "b64": b64(v)} for d, v in cents.items()]))
    (p / "exclude.txt").write_text("")
    return p


def args_for(p, **kw):
    ns = dict(manifest=str(p / "manifest.jsonl"), vecs=str(p / "vecs.json"),
              centroids=str(p / "centroids.json"), exclude=str(p / "exclude.txt"), truth=None,
              out_dir=str(p / "out"), seed=7, target_trials=500, min_trials=100, boot_reps=500,
              sim_reps=0, sim_boot_reps=100, armc_fire_rate=0.3, consults_per_month=1000)
    ns.update(kw)
    return argparse.Namespace(**ns)


def test_end_to_end_counts_only_stdout(tmp_path):
    p = make_world(tmp_path)
    buf = io.StringIO()
    s = run.run(args_for(p), out=buf)
    text = buf.getvalue()
    assert "S2c T28b point" in text and "C8:" in text
    assert "doc0" not in text and "c00" not in text  # no uids in stdout
    assert s["trials"] == 500
    out = p / "out"
    for f in ("prereg_trials.jsonl", "trials_scored.jsonl", "prereg.json", "summary.json"):
        assert stat.S_IMODE(os.stat(out / f).st_mode) == 0o600
    assert "doc0" not in (out / "summary.json").read_text()


def test_determinism(tmp_path):
    p = make_world(tmp_path)
    a = run.run(args_for(p, out_dir=str(p / "a")), out=io.StringIO())
    b = run.run(args_for(p, out_dir=str(p / "b")), out=io.StringIO())
    assert a == b
    assert (p / "a" / "prereg_trials.jsonl").read_bytes() == (p / "b" / "prereg_trials.jsonl").read_bytes()
    c = run.run(args_for(p, out_dir=str(p / "c"), seed=8), out=io.StringIO())
    assert c["trial_list_sha256"] != a["trial_list_sha256"]


def test_exclude_list_excludes_and_counts(tmp_path):
    p = make_world(tmp_path)
    (p / "exclude.txt").write_text("\n".join(f"c{i:04d}" for i in range(10)) + "\n")
    buf = io.StringIO()
    run.run(args_for(p), out=buf)
    assert "dropped as excluded 10" in buf.getvalue()
    used = {json.loads(l)["consult_uid"] for l in (p / "out" / "prereg_trials.jsonl").read_text().splitlines()}
    assert not used & {f"c{i:04d}" for i in range(10)}


def test_disjointness_violation_raises():
    with pytest.raises(core.DisjointnessError):
        core.assert_disjoint(["a", "b"], {"b", "z"})
    core.assert_disjoint(["a"], {"b"})


def test_prereg_sha_written_before_scoring(tmp_path, monkeypatch):
    p = make_world(tmp_path)
    seen = {}
    orig = core.score_trials

    def spy(trials_path, expected_sha, *a, **k):
        out = pathlib.Path(trials_path).parent
        seen["sha_file"] = (out / "prereg.sha256").read_text()
        seen["meta"] = json.loads((out / "prereg.json").read_text())
        return orig(trials_path, expected_sha, *a, **k)

    monkeypatch.setattr(core, "score_trials", spy)
    run.run(args_for(p), out=io.StringIO())
    assert seen["meta"]["seed"] == 7 and seen["meta"]["trial_list_sha256"] in seen["sha_file"]


def test_tampered_trial_list_refused(tmp_path):
    p = make_world(tmp_path)
    s = run.run(args_for(p), out=io.StringIO())
    tp = p / "out" / "prereg_trials.jsonl"
    tp.write_text(tp.read_text() + "\n")
    cents = core.load_centroids(str(p / "centroids.json"))
    manifest = core.load_json_lines(str(p / "manifest.jsonl"))
    with pytest.raises(RuntimeError):
        core.score_trials(str(tp), s["trial_list_sha256"], core.VecsLoader(str(p / "vecs.json")), manifest, cents)


def test_insufficient_trials_aborts(tmp_path):
    p = make_world(tmp_path, n_consults=10)
    with pytest.raises(core.InsufficientTrials):
        run.run(args_for(p, min_trials=2736), out=io.StringIO())


def test_no_truth_consults_counted_and_yield_no_trials(tmp_path):
    def plant(cents, vecs, manifest):
        vecs["c0000"] = {"speaker_0": core._unit(np.ones(64)).tolist()}  # matches nobody
    p = make_world(tmp_path, plant=plant)
    buf = io.StringIO()
    run.run(args_for(p), out=buf)
    assert "no truth label 1;" in buf.getvalue()
    used = {json.loads(l)["consult_uid"] for l in (p / "out" / "prereg_trials.jsonl").read_text().splitlines()}
    assert "c0000" not in used


def test_truth_file_overrides_derivation(tmp_path):
    p = make_world(tmp_path, n_consults=12, n_docs=4)
    (p / "truth.jsonl").write_text(json.dumps({"consult_uid": "c0000", "label": "speaker_1"}) + "\n")
    buf = io.StringIO()
    run.run(args_for(p, truth=str(p / "truth.jsonl"), min_trials=1), out=buf)
    assert "consults with truth 1;" in buf.getvalue()


def test_planted_impostor_fires_standard_and_loo_differs(tmp_path):
    """Impostor X sits at 0.66 to the label; the true centroid sits at 0.70 and is the runner-up.
    Standard: margin to the runner-up (true centroid) is negative, so no false accept.
    LOO: true centroid removed, the margin disappears, so it is a false accept."""
    def build():
        lab = e(0)
        imp = with_cos(lab, 0.66, e(1))
        true_c = with_cos(lab, 0.70, e(2))
        return lab, imp, true_c

    lab, imp, true_c = build()
    (tmp_path / "manifest.jsonl").write_text(json.dumps(
        {"consult_uid": "cx", "doctor_uid": "T", "logged_in_doctor_uid": "T"}) + "\n")
    (tmp_path / "vecs.json").write_text(json.dumps({"cx": {"speaker_0": lab.tolist()}}))
    (tmp_path / "centroids.json").write_text(json.dumps(
        [{"pulse_doctor_uid": "T", "b64": b64(true_c)}, {"pulse_doctor_uid": "X", "b64": b64(imp)}]))
    (tmp_path / "exclude.txt").write_text("")
    args = args_for(tmp_path, min_trials=1, target_trials=10,
                    truth=str(tmp_path / "truth.jsonl"))
    (tmp_path / "truth.jsonl").write_text(json.dumps({"consult_uid": "cx", "label": "speaker_0"}) + "\n")
    s = run.run(args, out=io.StringIO())
    assert s["T28b"]["k"] == 0 and s["T28b-LOO"]["k"] == 1 and s["trials"] == 1


# ---------------------------------------------------------------- statistics

def test_exact_bounds_known_values():
    z = stats.summarise(0, 1843)
    assert z["point"] == 0 and z["exact_upper_975_one_sided"] < 0.002
    t = stats.summarise(3, 2736)
    assert round(100 * t["point"], 2) == 0.11
    assert round(100 * t["cp95_lo"], 2) == 0.02 and round(100 * t["cp95_hi"], 2) == 0.32
    u = stats.summarise(3, 4381)
    assert u["exact_upper_975_one_sided"] < 0.002 < stats.summarise(3, 4300)["exact_upper_975_one_sided"]


def test_flags_underpowered_and_degenerate():
    ids = [i % 5 for i in range(500)]  # 5 clusters
    r = stats.cluster_bound(ids, [0] * 500, reps=200, seed=1)
    assert "cluster_underpowered" in r["flags"] and "cluster_degenerate" in r["flags"]
    assert r["method"] == "exact" and r["upper_975"] == pytest.approx(stats.exact_upper_one_sided(0, 500))
    ids = [i % 20 for i in range(2000)]  # 20 clusters x 100
    fa = [1 if i % 200 == 0 else 0 for i in range(2000)]
    r = stats.cluster_bound(ids, fa, reps=500, seed=1)
    assert r["flags"] == [] and r["method"] == "bca" and r["n"] == 2000 and r["k"] == 10


def test_all_trials_enter_when_clusters_small():
    ids = [0] * 60 + [1] * 10  # one cluster below the 50 floor still counts
    r = stats.cluster_bound(ids, [1] + [0] * 69, reps=200, seed=1)
    assert r["n"] == 70 and r["clusters_ge_min_trials"] == 1


def test_bca_coverage_roughly_nominal():
    sims = stats.coverage_sim(p=0.05, K=40, n_per=50, rhos=[0.0, 0.05], sims=300, reps=400, seed=11)
    for s in sims:
        assert 0.90 <= s["coverage"] <= 1.0, s


def test_bca_deterministic():
    n, f = np.full(30, 50), np.arange(30) % 3
    a = stats.bca_upper(n, f, reps=500, seed=3)
    assert a == stats.bca_upper(n, f, reps=500, seed=3)


# ---------------------------------------------------------------- readout

def test_readout_pass_fail_and_c8():
    blk = lambda pt, up: {"point": pt, "larger_upper_975": up, "clusterings": {"true_doctor": {"flags": ["cluster_underpowered"]}}}
    lines = run.readout({"T28b": blk(0.001, 0.003), "T28b-LOO": blk(0.0021, 0.004)}, 0.5, 2000)
    assert "T28b point 0.100% <= 0.2%: PASS" in lines[0]
    assert "T28b-LOO point 0.210% <= 0.2%: FAIL" in lines[1]
    assert "<= 0.5%: PASS" in lines[2]
    assert "cluster_underpowered" in lines[3]
    assert "= 4.0000" in lines[4]


# ---------------------------------------------------------------- import ban

BANNED = {"http", "urllib", "urllib3", "requests", "httpx", "aiohttp", "socket", "ssl", "ftplib", "smtplib",
          "xmlrpc", "websocket", "websockets", "sqlite3", "psycopg", "psycopg2", "asyncpg", "pymysql",
          "mysql", "sqlalchemy", "pymongo", "redis", "boto3", "subprocess"}


def test_import_ban():
    for f in PKG.glob("*.py"):
        for node in ast.walk(ast.parse(f.read_text())):
            names = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                names = [node.module]
            for n in names:
                assert n.split(".")[0] not in BANNED, (f.name, n)
