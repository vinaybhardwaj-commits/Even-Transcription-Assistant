"""Synthetic tests for the T28b harness. No patient data; every vector is constructed here."""
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
    return c * base + np.sqrt(1 - c * c) * ortho


def b64(v):
    return base64.b64encode(np.asarray(v, dtype="<f4").tobytes()).decode()


def jl(rows):
    return "".join(json.dumps(r) + "\n" for r in rows)


# ---------------------------------------------------------------- fixtures

def write_world(p, cents, vecs, manifest, truth=None, exclude="", source="role_votes_3of3"):
    p.mkdir(parents=True, exist_ok=True)
    (p / "manifest.jsonl").write_text(jl(manifest))
    (p / "vecs.json").write_text(json.dumps(vecs))
    (p / "centroids.json").write_text(json.dumps(
        [{"pulse_doctor_uid": d, "b64": b64(v), "enrolled_at": "synthetic"} for d, v in cents.items()]))
    if truth is None:
        truth = [{"consult_uid": r["consult_uid"], "label": "speaker_0", "source": source} for r in manifest]
    (p / "truth.jsonl").write_text(jl(truth))
    (p / "exclude.txt").write_text(exclude)
    return p


def make_world(tmp_path, n_consults=60, n_docs=12, seed=0, **kw):
    rng = np.random.default_rng(seed)
    docs = [f"doc{i:02d}" for i in range(n_docs)]
    cents = {d: core._unit(rng.normal(size=64)) for d in docs}
    manifest, vecs = [], {}
    for i in range(n_consults):
        d = docs[i % n_docs]
        cu = f"c{i:04d}"
        manifest.append({"consult_uid": cu, "doctor_uid": d, "logged_in_doctor_uid": d})
        vecs[cu] = {"speaker_0": core._unit(cents[d] + 0.02 * rng.normal(size=64)).tolist(),
                    "speaker_1": core._unit(rng.normal(size=64)).tolist()}
    return write_world(tmp_path, cents, vecs, manifest, **kw)


def argv(p, cmd, **kw):
    a = [cmd, "--manifest", str(p / "manifest.jsonl"), "--vecs", str(p / "vecs.json"),
         "--centroids", str(p / "centroids.json"), "--truth", str(p / "truth.jsonl"),
         "--exclude", str(p / "exclude.txt"), "--out-dir", str(p / "out"), "--seed", "7"]
    opts = {"prereg": {"--target-trials": "500", "--min-trials": "100"},
            "score": {"--boot-reps": "500", "--sim-reps": "0", "--armc-fire-rate": "0.3",
                      "--consults-per-month": "1000"}}[cmd]
    for k, v in {**opts, **kw}.items():
        a += [k] if v is True else [k, str(v)]
    return a


def do_prereg(p, **kw):
    out = io.StringIO()
    return run.prereg(run.parser().parse_args(argv(p, "prereg", **kw)), out=out), out.getvalue()


def do_score(p, **kw):
    out = io.StringIO()
    return run.score(run.parser().parse_args(argv(p, "score", **kw)), out=out), out.getvalue()


def full(p, prereg_kw=None, score_kw=None):
    do_prereg(p, **(prereg_kw or {}))
    return do_score(p, **(score_kw or {}))


# ---------------------------------------------------------------- arm (c) thresholds

def _arm(label_cos, other_label_cos=None, other_cent_cos=None):
    C = e(0)
    L = with_cos(C, label_cos, e(1))
    labels = [L] + ([with_cos(C, other_label_cos, e(2))] if other_label_cos is not None else [])
    cents = [C] + ([other_cent_cos * L + np.sqrt(1 - other_cent_cos ** 2) * e(3)] if other_cent_cos is not None else [])
    S = np.array(labels) @ np.array(cents).T
    mn, mr = core.arm_c_matrix(S, np.ones(len(cents), dtype=bool), one_label_pass=True)
    return bool(core.passes(S[0, 0], mn[0, 0], mr[0, 0]))


@pytest.mark.parametrize("cos,ok", [(0.649, False), (0.65, True), (0.66, True)])
def test_cosine_threshold(cos, ok):
    assert _arm(cos) is ok


@pytest.mark.parametrize("gap,ok", [(0.049, False), (0.05, True), (0.06, True)])
def test_margin_next_label_threshold(gap, ok):
    assert _arm(0.80, other_label_cos=0.80 - gap) is ok


@pytest.mark.parametrize("gap,ok", [(0.049, False), (0.05, True), (0.06, True)])
def test_margin_runner_up_centroid_threshold(gap, ok):
    assert _arm(0.80, other_cent_cos=0.80 - gap) is ok


def test_planted_thresholds_survive_float32_centroids():
    L = with_cos(e(0), 0.65, e(1))
    cent = core._unit(core.decode_centroid(b64(e(0))))
    S = np.array([L]) @ np.array([cent]).T
    mn, mr = core.arm_c_matrix(S, np.ones(1, dtype=bool), one_label_pass=True)
    assert core.passes(S[0, 0], mn[0, 0], mr[0, 0])


# ---------------------------------------------------------------- end to end

def test_end_to_end_counts_only_and_modes(tmp_path):
    p = make_world(tmp_path)
    s, text = full(p)
    assert "S2c T28b point" in text and "T28b-nd" in text and "C8:" in text
    assert "doc0" not in text and "c00" not in text
    out = p / "out"
    assert stat.S_IMODE(os.stat(out).st_mode) == 0o700
    for f in ("prereg_trials.jsonl", "prereg_nd_trials.jsonl", "trials_scored.jsonl", "trials_nd_scored.jsonl",
              "prereg.json", "summary.json"):
        assert stat.S_IMODE(os.stat(out / f).st_mode) == 0o600
    assert "doc0" not in (out / "summary.json").read_text()
    assert s["T28b-nd"]["n"] == 60 and s["T28b"]["n"] == 500


def test_determinism(tmp_path):
    p = make_world(tmp_path)
    m1, _ = do_prereg(p)
    first = (p / "out" / "prereg_trials.jsonl").read_bytes()
    s1 = do_score(p)[0]
    # second run in a fresh output dir
    import shutil
    shutil.rmtree(p / "out")
    m2, _ = do_prereg(p)
    assert (p / "out" / "prereg_trials.jsonl").read_bytes() == first
    assert m1["trial_list_sha256"] == m2["trial_list_sha256"] and do_score(p)[0] == s1
    shutil.rmtree(p / "out")
    assert do_prereg(p, **{"--seed": 8})[0]["trial_list_sha256"] != m1["trial_list_sha256"]


def test_insufficient_trials_aborts(tmp_path):
    p = make_world(tmp_path, n_consults=10)
    with pytest.raises(core.InsufficientTrials):
        do_prereg(p, **{"--min-trials": 2736})


# ---------------------------------------------------------------- R1 truth

def test_truth_and_exclude_flags_are_required():
    for drop in ("--truth", "--exclude"):
        a = argv(pathlib.Path("/x"), "prereg")
        i = a.index(drop)
        del a[i:i + 2]
        with pytest.raises(SystemExit) as ex:
            run.parser().parse_args(a)
        assert ex.value.code == 2


def test_bad_truth_source_rejected_exit_2(tmp_path, capsys):
    p = make_world(tmp_path, source="arm_c_voiceprint")
    assert run.main(argv(p, "prereg")) == 2
    assert "source outside" in capsys.readouterr().err


def test_truth_by_source_and_no_truth_counted(tmp_path):
    truth = [{"consult_uid": f"c{i:04d}", "label": "speaker_0",
              "source": "manual" if i % 2 else "role_votes_3of3"} for i in range(40)]  # 20 consults lack truth
    p = make_world(tmp_path, truth=truth)
    meta, text = do_prereg(p)
    c = meta["counts"]
    assert c["truth_by_source"] == {"role_votes_3of3": 20, "manual": 20} and c["no_truth"] == 20
    assert "truth by source" in text


def test_truth_is_never_derived_from_voiceprints(tmp_path):
    """A consult whose label matches its doctor's centroid perfectly still yields no trial without a truth row."""
    truth = [{"consult_uid": f"c{i:04d}", "label": "speaker_0", "source": "manual"} for i in range(1, 60)]
    p = make_world(tmp_path, truth=truth)
    do_prereg(p)
    used = {json.loads(l)["consult_uid"] for l in (p / "out" / "prereg_trials.jsonl").read_text().splitlines()}
    assert "c0000" not in used


def test_truth_label_missing_from_vectors_counted(tmp_path):
    truth = [{"consult_uid": "c0000", "label": "speaker_9", "source": "manual"}] + \
            [{"consult_uid": f"c{i:04d}", "label": "speaker_0", "source": "manual"} for i in range(1, 60)]
    p = make_world(tmp_path, truth=truth)
    meta, _ = do_prereg(p)
    assert meta["counts"]["truth_label_not_in_vectors"] == 1


# ---------------------------------------------------------------- R2 non-doctor arm

def two_centroid_world(p, truth_cos, other_cos, **kw):
    """Doctor T (centroid e0), far doctor X. Consult labels: truth at truth_cos, other at other_cos to T."""
    lab0, lab1 = with_cos(e(0), truth_cos, e(1)), with_cos(e(0), other_cos, e(2))
    return write_world(
        p, {"T": e(0), "X": e(5)}, {"cx": {"speaker_0": lab0.tolist(), "speaker_1": lab1.tolist()}},
        [{"consult_uid": "cx", "doctor_uid": "T", "logged_in_doctor_uid": "T"}],
        truth=[{"consult_uid": "cx", "label": "speaker_0", "source": "manual"}], **kw)


def test_non_doctor_label_fires_against_doctor_centroid(tmp_path):
    p = two_centroid_world(tmp_path, 0.55, 0.70)
    s, text = full(p, {"--min-trials": 1})
    assert s["T28b-nd"]["k"] == 1 and s["T28b-nd"]["n"] == 1 and s["T28b"]["k"] == 0
    assert "S2c T28b-nd point 100.000% <= 0.2%: FAIL" in text


def test_non_doctor_label_that_loses_to_the_doctor_label_does_not_fire(tmp_path):
    p = two_centroid_world(tmp_path, 0.90, 0.70)
    s, _ = full(p, {"--min-trials": 1})
    assert s["T28b-nd"]["k"] == 0 and s["T28b-nd"]["n"] == 1


def test_headline_uses_worse_of_the_two_bounds():
    blk = lambda pt, up, n=3000: {"point": pt, "n": n, "larger_upper_975": up, "underpowered": False,
                                   "exact_info_975": up, "clusterings": {"true_doctor": {"flags": []}}}
    s = {"T28b": blk(0.0, 0.001), "T28b-LOO": blk(0.001, 0.004), "T28b-nd": blk(0.001, 0.006)}
    lines = run.readout(s, 0.5, 2000)
    assert "= 0.600% <= 0.5%: FAIL" in lines[3]
    assert "= 6.0000" in lines[5]  # C8 uses the worse bound: 0.006 x 0.5 x 2000


# ---------------------------------------------------------------- R3 uid normalisation

def test_norm_uid_strips_bom_whitespace_and_case():
    assert core.norm_uid("﻿  AbC-1 \n") == "abc-1"


@pytest.mark.parametrize("variant", ["C0001", " c0001 ", "﻿c0001", "﻿ C0001\t"])
def test_tuning_uid_variants_are_excluded(tmp_path, variant):
    p = make_world(tmp_path, exclude=variant + "\n")
    meta, text = do_prereg(p)
    assert meta["counts"]["dropped_excluded"] == 1
    used = {json.loads(l)["consult_uid"] for l in (p / "out" / "prereg_trials.jsonl").read_text().splitlines()}
    assert "c0001" not in used


def test_dirty_manifest_uid_matches_clean_exclude(tmp_path):
    p = make_world(tmp_path, exclude="c0002\n")
    rows = core.load_json_lines(str(p / "manifest.jsonl"))
    rows[2]["consult_uid"] = " ﻿C0002 "
    (p / "manifest.jsonl").write_text(jl(rows))
    vecs = json.loads((p / "vecs.json").read_text())
    vecs["C0002 "] = vecs.pop("c0002")
    (p / "vecs.json").write_text(json.dumps(vecs))
    t = core.load_json_lines(str(p / "truth.jsonl"))
    t[2]["consult_uid"] = "C0002"
    (p / "truth.jsonl").write_text(jl(t))
    meta, _ = do_prereg(p)
    assert meta["counts"]["dropped_excluded"] == 1


def test_unmatched_exclusion_exits_2_unless_ok(tmp_path, capsys):
    p = make_world(tmp_path, exclude="c0001\nnot-in-manifest\n")
    assert run.main(argv(p, "prereg")) == 2
    assert "matched no manifest consult" in capsys.readouterr().err
    meta, _ = do_prereg(p, **{"--exclude-unmatched-ok": True})
    assert meta["exclude_unmatched_count"] == 1 and meta["exclude_unmatched_ok"] is True


def test_duplicate_manifest_rows_exit_2(tmp_path, capsys):
    p = make_world(tmp_path)
    rows = core.load_json_lines(str(p / "manifest.jsonl"))
    rows.append({**rows[3], "consult_uid": " " + rows[3]["consult_uid"].upper()})
    (p / "manifest.jsonl").write_text(jl(rows))
    assert run.main(argv(p, "prereg")) == 2
    assert "duplicate manifest rows" in capsys.readouterr().err


def test_disjointness_on_normalised_uids():
    with pytest.raises(core.DisjointnessError):
        core.assert_disjoint(["C1 "], {"c1"})
    core.assert_disjoint(["a"], {"b"})


# ---------------------------------------------------------------- R4 underpowered

def test_single_cluster_is_underpowered_even_with_floor_one():
    r = stats.cluster_bound([0] * 500, [1] + [0] * 499, reps=200, seed=1, floor=1)
    assert r["underpowered"] and r["upper_975"] is None and "cluster_underpowered" in r["flags"]
    assert r["exact_info_975"] == pytest.approx(stats.exact_upper_one_sided(1, 500))


def test_underpowered_readout_prints_no_pass_and_no_bound(tmp_path):
    p = make_world(tmp_path, n_docs=3, n_consults=30)  # 3 doctor clusters
    s, text = full(p, {"--min-trials": 10, "--target-trials": 80}, {"--doctor-floor": 15})
    head = next(l for l in text.splitlines() if l.startswith("S2c headline"))
    assert "UNDERPOWERED" in head and "PASS" not in head.replace("no PASS", "")
    assert s["T28b-LOO"]["larger_upper_975"] is None
    assert "C8: not computed (UNDERPOWERED)" in text


def test_powered_degenerate_uses_exact_bound():
    ids = [i % 20 for i in range(2000)]
    r = stats.cluster_bound(ids, [0] * 2000, reps=200, seed=1, floor=15)
    assert r["flags"] == ["cluster_degenerate"] and r["method"] == "exact"
    assert r["upper_975"] == pytest.approx(stats.exact_upper_one_sided(0, 2000))


def test_powered_nondegenerate_is_bca_and_all_trials_enter():
    ids = [i % 20 for i in range(2000)] + [99] * 3  # a tiny extra cluster still counts
    fa = [1 if i % 200 == 0 else 0 for i in range(2000)] + [0] * 3
    r = stats.cluster_bound(ids, fa, reps=500, seed=1, floor=15)
    assert r["method"] == "bca" and r["n"] == 2003 and r["k"] == 10 and r["flags"] == []


# ---------------------------------------------------------------- R5 floor

def fake_sim(low_below):
    def sim(*, p, K, n_per, rhos, sims, reps, seed):
        return [{"rho": r, "coverage": 0.95 if K >= low_below else 0.80, "sims": sims} for r in rhos]
    return sim


def test_floor_raised_in_steps_of_five(monkeypatch):
    monkeypatch.setattr(stats, "coverage_sim", fake_sim(25))
    r = stats.choose_floor(k_data=40, configured=15, n_per=60, p=0.005, rhos=[0.01, 0.05, 0.1],
                           sims=10, reps=10, seed=1)
    assert r["chosen_floor"] == 25 and r["status"] == "raised"
    assert {x["K"] for x in r["table"]} >= {15, 20, 25, 40}


def test_floor_unattainable(monkeypatch):
    monkeypatch.setattr(stats, "coverage_sim", fake_sim(10 ** 6))
    r = stats.choose_floor(k_data=40, configured=15, n_per=60, p=0.005, rhos=[0.05], sims=10, reps=10, seed=1)
    assert r["chosen_floor"] is None and r["status"] == "floor unattainable"


def test_floor_unattainable_means_no_pass_in_score(tmp_path, monkeypatch):
    monkeypatch.setattr(stats, "coverage_sim", fake_sim(10 ** 6))
    p = make_world(tmp_path, n_consults=240, n_docs=20)
    s, text = full(p, {"--min-trials": 100, "--target-trials": 2000}, {"--sim-reps": 5, "--sim-boot-reps": 10})
    assert s["floor"]["chosen_floor"] is None and "unattainable" in text
    assert next(l for l in text.splitlines() if l.startswith("S2c headline")).count("UNDERPOWERED") == 1
    assert "floor" in json.loads((p / "out" / "summary.json").read_text())


def test_coverage_table_in_summary_json(tmp_path, monkeypatch):
    monkeypatch.setattr(stats, "coverage_sim", fake_sim(0))
    p = make_world(tmp_path, n_consults=240, n_docs=20)
    s, _ = full(p, {"--min-trials": 100, "--target-trials": 2000}, {"--sim-reps": 5, "--sim-boot-reps": 10})
    sj = json.loads((p / "out" / "summary.json").read_text())
    assert sj["floor"]["chosen_floor"] == 15 and sj["floor"]["table"]


# ---------------------------------------------------------------- R6 prereg hashes

def test_score_requires_prereg(tmp_path):
    p = make_world(tmp_path)
    (p / "out").mkdir(mode=0o700)
    with pytest.raises(core.InputError):
        do_score(p)


def test_prereg_cannot_be_rerun(tmp_path):
    p = make_world(tmp_path)
    do_prereg(p)
    with pytest.raises(core.InputError):
        do_prereg(p)


def test_prereg_records_hashes_thresholds_seed_code(tmp_path):
    p = make_world(tmp_path)
    meta, _ = do_prereg(p)
    h = meta["inputs_sha256"]
    assert set(h) == {"manifest", "centroids", "truth", "exclude", "vectors"} and h["vectors"]
    assert meta["seed"] == 7 and meta["thresholds"]["cos_min"] == 0.65
    assert len(meta["code"]["code_sha256"]) == 64 and "git_commit" in meta["code"]
    assert (p / "out" / "prereg.sha256").read_text().split()[0] == core.sha256_file(str(p / "out" / "prereg.json"))


@pytest.mark.parametrize("victim", ["manifest.jsonl", "vecs.json", "centroids.json", "truth.jsonl", "exclude.txt"])
def test_score_refuses_any_changed_input(tmp_path, victim):
    p = make_world(tmp_path, exclude="c0001\n")
    do_prereg(p)
    f = p / victim
    f.write_text(f.read_text() + ("\n" if victim.endswith((".jsonl", ".txt")) else " "))
    with pytest.raises(core.InputError, match="MISMATCH"):
        do_score(p)


def test_score_refuses_changed_trial_list_prereg_and_code(tmp_path, monkeypatch):
    p = make_world(tmp_path)
    do_prereg(p)
    monkeypatch.setattr(core, "code_identity", lambda: {"code_sha256": "0" * 64, "git_commit": None})
    with pytest.raises(core.InputError, match="code"):
        do_score(p)
    monkeypatch.undo()
    tp = p / "out" / "prereg_trials.jsonl"
    tp.write_text(tp.read_text() + "\n")
    with pytest.raises(core.InputError, match="trial_list"):
        do_score(p)


def test_prereg_is_written_before_scoring(tmp_path, monkeypatch):
    p = make_world(tmp_path)
    seen = {}
    orig = core.score_trials

    def spy(*a, **k):
        seen["prereg"] = json.loads((p / "out" / "prereg.json").read_text())
        return orig(*a, **k)

    monkeypatch.setattr(core, "score_trials", spy)
    full(p)
    assert seen["prereg"]["seed"] == 7


# ---------------------------------------------------------------- R7 bad vectors, modes, no uid leaks

def test_nan_vector_exits_2_with_count(tmp_path, capsys):
    p = make_world(tmp_path)
    vecs = json.loads((p / "vecs.json").read_text())
    vecs["c0003"]["speaker_1"][0] = float("nan")
    (p / "vecs.json").write_text(json.dumps(vecs))
    assert run.main(argv(p, "prereg")) == 2
    assert "1 non-finite, zero-norm or wrong-dimension vectors" in capsys.readouterr().err


def test_zero_norm_label_and_centroid_exit_2(tmp_path, capsys):
    p = make_world(tmp_path)
    vecs = json.loads((p / "vecs.json").read_text())
    vecs["c0003"]["speaker_1"] = [0.0] * 64
    (p / "vecs.json").write_text(json.dumps(vecs))
    cents = json.loads((p / "centroids.json").read_text())
    cents[0]["b64"] = b64(np.zeros(64))
    (p / "centroids.json").write_text(json.dumps(cents))
    assert run.main(argv(p, "prereg")) == 2
    assert "2 non-finite, zero-norm" in capsys.readouterr().err


def test_wide_out_dir_refused_and_new_dir_is_0700(tmp_path):
    p = make_world(tmp_path)
    (p / "out").mkdir()
    os.chmod(p / "out", 0o755)
    with pytest.raises(core.InputError):
        do_prereg(p)
    os.chmod(p / "out", 0o700)
    do_prereg(p)
    q = make_world(tmp_path / "q")
    do_prereg(q)
    assert stat.S_IMODE(os.stat(q / "out").st_mode) == 0o700


def test_main_prints_only_exception_type(tmp_path, monkeypatch, capsys):
    p = make_world(tmp_path)

    def boom(*a, **k):
        raise ValueError("secret-uid-123")

    monkeypatch.setattr(run, "prereg", boom)
    assert run.main(argv(p, "prereg")) == 2
    cap = capsys.readouterr()
    assert "ValueError" in cap.err and "secret-uid-123" not in cap.err + cap.out


def test_error_messages_never_carry_uids(tmp_path, capsys):
    p = make_world(tmp_path, exclude="secret-tuning-uid\n")
    assert run.main(argv(p, "prereg")) == 2
    cap = capsys.readouterr()
    assert "secret-tuning-uid" not in cap.err + cap.out


# ---------------------------------------------------------------- R8 one-label consults

def one_label_world(p, **kw):
    lab = with_cos(e(0), 0.66, e(1))
    rows = [{"consult_uid": f"c{i}", "doctor_uid": "T", "logged_in_doctor_uid": "T"} for i in range(2)]
    return write_world(p, {"T": e(0), "X": with_cos(e(1), 0.99, e(4)), "Y": e(5)},
                       {r["consult_uid"]: {"speaker_0": lab.tolist()} for r in rows}, rows,
                       truth=[{"consult_uid": r["consult_uid"], "label": "speaker_0", "source": "manual"}
                              for r in rows], **kw)


def test_one_label_consults_abstain_by_default(tmp_path):
    p = one_label_world(tmp_path)
    with pytest.raises(core.InsufficientTrials):  # both consults abstain, nothing left to score
        do_prereg(p, **{"--min-trials": 1})
    _, _, _, _, loader = run._load(run.parser().parse_args(argv(p, "prereg")))
    cents, _ = core.load_centroids(str(p / "centroids.json"))
    manifest = core.load_manifest(str(p / "manifest.jsonl"))
    truth = core.load_truth(str(p / "truth.jsonl"))
    _, _, counts = core.build_universe(manifest, set(), truth, loader, cents)
    assert counts["one_label_consults"] == 2 and counts["consults_scored"] == 0


def test_one_label_pass_flag_scores_them_and_counts(tmp_path):
    p = one_label_world(tmp_path)
    meta, text = do_prereg(p, **{"--min-trials": 1, "--one-label-pass": True})
    assert meta["counts"]["one_label_consults"] == 2 and meta["thresholds"]["one_label_pass"] is True
    assert meta["achieved_trials"] == 4  # 2 consults x impostors {X, Y}
    assert "one-label consults 2 (scored)" in text


# ---------------------------------------------------------------- voice-alike doctors, manual truth

@pytest.mark.parametrize("alike", [0.95, 0.98])
def test_voice_alike_doctor_fires_only_when_true_centroid_leaves_runner_up_set(tmp_path, alike):
    """Label is the true doctor's voice. A near-twin doctor B (centroid cosine 0.95/0.98 to A) matches it
    above 0.65. Standard: A is the runner-up and beats B, so no fire. LOO: A is removed, so B fires."""
    A, B = e(0), with_cos(e(0), alike, e(1))
    vecs = {"cx": {"speaker_0": e(0).tolist(), "speaker_1": e(6).tolist()}}
    p = write_world(tmp_path, {"A": A, "B": B}, vecs,
                    [{"consult_uid": "cx", "doctor_uid": "A", "logged_in_doctor_uid": "A"}],
                    truth=[{"consult_uid": "cx", "label": "speaker_0", "source": "manual"}])
    s, _ = full(p, {"--min-trials": 1})
    assert s["T28b"]["k"] == 0 and s["T28b-LOO"]["k"] == 1 and s["T28b-nd"]["k"] == 0


# ---------------------------------------------------------------- statistics

def test_exact_bounds_known_values():
    z = stats.summarise(0, 1843)
    assert z["point"] == 0 and z["exact_upper_975_one_sided"] < 0.002
    t = stats.summarise(3, 2736)
    assert round(100 * t["point"], 2) == 0.11
    assert round(100 * t["cp95_lo"], 2) == 0.02 and round(100 * t["cp95_hi"], 2) == 0.32
    u = stats.summarise(3, 4381)
    assert u["exact_upper_975_one_sided"] < 0.002 < stats.summarise(3, 4300)["exact_upper_975_one_sided"]


def test_bca_coverage_roughly_nominal():
    sims = stats.coverage_sim(p=0.05, K=40, n_per=50, rhos=[0.0, 0.05], sims=300, reps=400, seed=11)
    for s in sims:
        assert 0.90 <= s["coverage"] <= 1.0, s


def test_bca_deterministic():
    n, f = np.full(30, 50), np.arange(30) % 3
    assert stats.bca_upper(n, f, reps=500, seed=3) == stats.bca_upper(n, f, reps=500, seed=3)


def test_readout_pass_fail_and_c8():
    blk = lambda pt, up: {"point": pt, "n": 3000, "larger_upper_975": up, "underpowered": False,
                          "exact_info_975": up, "clusterings": {"true_doctor": {"flags": ["cluster_degenerate"]}}}
    lines = run.readout({"T28b": blk(0.001, 0.003), "T28b-LOO": blk(0.0021, 0.004),
                         "T28b-nd": blk(0.0, 0.002)}, 0.5, 2000)
    assert "T28b point 0.100% <= 0.2%: PASS" in lines[0]
    assert "T28b-LOO point 0.210% <= 0.2%: FAIL" in lines[1]
    assert "T28b-nd point 0.000% <= 0.2%: PASS" in lines[2]
    assert "= 0.400% <= 0.5%: PASS" in lines[3]
    assert "cluster_degenerate" in lines[4]
    assert "= 4.0000" in lines[5]


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
