"""Bundle ingest: load_bundle, inputs[] hashes, nightly bundle mode with a fake command. Synthetic only; no model call."""
import copy
import json
import sys
from pathlib import Path

import pytest

from tools.eta2freescript import nightly
from tools.eta2freescript.ingest import ROLE_SLOTS, load_bundle, track_sha256
from tools.eta2freescript.nightly import NightlyError, load_config, parse_bundle_config, run

FIX = Path(__file__).resolve().parent / "fixtures"
FAKE = FIX / "fake_bundle_cmd.py"
T0 = 1_791_174_600_000  # 2026-10-05 10:00 IST
DAY = "2026-10-05"
MARKER = "SYNTH_MARKER_NOT_A_NAME"


def bundle(name):
    return json.loads((FIX / "bundle" / f"{name}.json").read_text(encoding="utf-8"))


def test_all_slots_builds_the_folder_shaped_consult():
    c = load_bundle(bundle("synth-all"))
    assert c.uid == "synth-all" and c.room == "room_aaaaaaaa"
    assert (c.clip_t0_ms, c.clip_t1_ms) == (T0, T0 + 150_000)
    assert c.english_source == "mt:sarvam-saaras-v3" and c.language_code == "hi-IN" and c.lang == "hi"
    assert len(c.turns) == 3  # the blank stt segment is not a turn
    assert c.turns[0].text == f"{MARKER} english one" and c.turns[0].native_text == f"{MARKER} native one"
    assert c.turns[0].t0_ms == T0  # absolute axis, like the folder reader
    assert c.turns[-1].t1_ms == T0 + 150_000  # 150560 clamped to the clip
    assert c.role_track and [t.role for t in c.turns] == ["doctor", "patient", "doctor"]
    assert c.role_flags.attender_present is False and c.role_flags.two_consults is False and c.role_flags.config_hash == "abcd1234"
    assert [i["layer"] for i in c.inputs] == ["translate", "stt", "role_llm"]  # parts / acoustics / diar_nemotron are not read
    assert all(len(i["sha256"]) == 64 and i["track_path"].startswith("tracks/") for i in c.inputs)


def test_role_fallback_order():
    judge = load_bundle(bundle("synth-judge"))
    assert [t.role for t in judge.turns] == ["doctor", "attendant", "doctor"]  # text-judge map; attender -> attendant
    assert judge.inputs[-1]["layer"] == "role_judge"
    caa = load_bundle(bundle("synth-caa"))
    assert [t.role for t in caa.turns] == ["doctor", "attendant", "doctor"]  # same-speaker join; "attendant" survives (REB_ROLES)
    assert caa.inputs[-1]["layer"] == "role_caa"
    none = load_bundle(bundle("synth-norole"))
    assert not none.role_track and none.speaker_source == "model_inferred" and [i["layer"] for i in none.inputs] == ["translate", "stt"]
    assert not load_bundle(bundle("synth-all"), use_role_track=False).role_track


def test_translate_missing_is_native_only():
    c = load_bundle(bundle("synth-native"))
    assert c.english_source == "none:native-hi" and c.turns[0].text == f"{MARKER} native one" and c.turns[0].native_text is None
    assert [i["layer"] for i in c.inputs] == ["stt", "role_llm"]
    with pytest.raises(ValueError):
        load_bundle(bundle("synth-native"), english="on")


def test_no_text_layer_raises():
    with pytest.raises(ValueError):
        load_bundle(bundle("synth-notext"))
    b = bundle("synth-all")
    for k in ("translate", "stt"):
        b["tracks"][k]["track"]["segments"] = [{"t0_ms": 0, "t1_ms": 5, "text": "  ", "speaker": "0"}]
    with pytest.raises(ValueError):
        load_bundle(b)


def test_caa_source_uses_the_manifest_window():
    c = load_bundle(bundle("synth-caasrc"))
    assert (c.clip_t0_ms, c.clip_t1_ms, c.room) == (T0, T0 + 150_000, "room_aaaaaaaa")


def test_inputs_hash_is_stable_across_key_order():
    a = bundle("synth-all")
    b = copy.deepcopy(a)
    b["tracks"]["translate"]["track"] = {k: v for k, v in reversed(list(b["tracks"]["translate"]["track"].items()))}
    b["tracks"]["translate"]["track"]["segments"] = [dict(reversed(list(s.items()))) for s in b["tracks"]["translate"]["track"]["segments"]]
    assert load_bundle(a).inputs == load_bundle(b).inputs
    expect = track_sha256({"b": 1, "a": "é"})
    assert expect == track_sha256({"a": "é", "b": 1})
    b["tracks"]["translate"]["track"]["segments"][0]["text"] = "changed"
    assert load_bundle(a).inputs[0]["sha256"] != load_bundle(b).inputs[0]["sha256"]


# ---- nightly bundle mode

def cmd_env(tmp_path):
    return {"FREESCRIPT_BUNDLE_CMD": json.dumps([sys.executable, str(FAKE), "{uid}", "{out}"]), "FREESCRIPT_BUNDLE_CWD": str(tmp_path)}


def bcfg(tmp_path, **kw):
    cfg = load_config(None, cmd_env(tmp_path))
    cfg.update(app_url="https://app.test", **kw)
    return cfg


def fake_run_one(seen):
    def run_one(uid):
        seen.append(uid)
        return {"final_valid": True, "final_errors": [], "artifact": {"encounter": {"eta_encounter_id": uid}, "pulse_link": {"consult_uid": uid}}}
    return run_one


def go(tmp_path, uids, capsys, jobs=None, **kw):
    posted, ran = [], []
    cfg = bcfg(tmp_path)
    rc = run(cfg, DAY, run_one=fake_run_one(ran), post=lambda body: posted.append(body) or {"ok": True, "inserted": 1},
             sealed=uids, pending=(lambda _u, _s: jobs) if jobs is not None else False, **kw)
    out = capsys.readouterr().out
    summary = json.loads([l for l in out.splitlines() if l.startswith("{")][-1]) if "{" in out else None
    return rc, summary, ran, posted, out


def test_bundle_mode_counts_and_runs_only_eligible(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("FREESCRIPT_INGEST_SECRET", "s")
    rc, s, ran, posted, out = go(tmp_path, ["synth-all", "synth-judge", "synth-norole", "synth-otherday", "synth-fail", "synth-notext", "synth-all"], capsys)
    assert ran == ["synth-all", "synth-judge"]
    assert (s["mode"], s["bundle_failed"], s["missing_layers"], s["not_this_day"], s["posted"]) == ("bundle", 1, 2, 1, 2)
    assert rc == 2
    assert [p["room_slug"] for p in posted] == ["room_aaaaaaaa"] * 2 and posted[0]["doctor_uid8"] == "DOCSYN01"
    assert MARKER not in out and "SYNTH_STDOUT_NOT_LOGGED" not in out
    line = [l for l in out.splitlines() if "bundle-stderr" in l][0]
    assert line.count("\n") == 0 and len(line.split("bundle-stderr ", 1)[1]) == 500


def test_bundle_mode_never_calls_the_roles_api_and_keeps_no_files(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("FREESCRIPT_INGEST_SECRET", "s")
    monkeypatch.setenv("REB_INDEX_READ_TOKEN", "t")

    def boom(*a, **k):
        raise AssertionError("/api/reb/roles must not be called in bundle mode")
    monkeypatch.setattr(nightly, "fetch_role_doc", boom)
    monkeypatch.setattr(nightly, "fetch_sealed_uids", lambda *a, **k: ["synth-all"])
    seen = []
    kept = []
    real = nightly.tempfile.TemporaryDirectory

    class Spy(real):
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            kept.append(Path(self.name))
    monkeypatch.setattr(nightly.tempfile, "TemporaryDirectory", Spy)
    cfg = bcfg(tmp_path)
    rc = run(cfg, DAY, run_one=fake_run_one(seen), post=lambda b: {"ok": True, "inserted": 1}, pending=False)
    assert rc == 0 and seen == ["synth-all"]
    assert kept and not kept[0].exists()
    assert list(tmp_path.iterdir()) == []  # cwd untouched


def test_pending_jobs_join_the_uid_list(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("FREESCRIPT_INGEST_SECRET", "s")
    jobs = [{"job_id": "job_1", "consult_uid": "synth-all"}, {"job_id": "job_2", "consult_uid": "synth-judge"}, {"job_id": "job_3", "room": "r", "ist_date": DAY}]
    rc, s, ran, posted, _ = go(tmp_path, ["synth-all"], capsys, jobs=jobs)
    assert ran == ["synth-all", "synth-judge"] and [p["job_id"] for p in posted] == ["job_1", "job_2"]
    assert s["missing"] == 1 and rc == 2


def test_bundle_command_timeout_counts_as_failed(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("FREESCRIPT_INGEST_SECRET", "s")
    monkeypatch.setattr(nightly, "BUNDLE_TIMEOUT_S", 1)
    rc, s, ran, _, _ = go(tmp_path, ["synth-slow"], capsys)
    assert s["bundle_failed"] == 1 and ran == [] and rc == 1


@pytest.mark.parametrize("env, why", [
    ({"FREESCRIPT_BUNDLE_CMD": "not json"}, "json"),
    ({"FREESCRIPT_BUNDLE_CMD": '["x", "{uid}"]'}, "out"),
    ({"FREESCRIPT_BUNDLE_CMD": '["x", "{out}"]'}, "uid"),
    ({"FREESCRIPT_BUNDLE_CMD": '{"a": 1}'}, "shape"),
    ({"FREESCRIPT_BUNDLE_CMD": '["x", "{uid}", "{out}"]'}, "nocwd"),
    ({"FREESCRIPT_BUNDLE_CMD": '["x", "{uid}", "{out}"]', "FREESCRIPT_BUNDLE_CWD": "/nonexistent-dir-synth"}, "badcwd"),
])
def test_config_errors_are_errors(env, why):
    with pytest.raises(NightlyError):
        parse_bundle_config(env)
    with pytest.raises(NightlyError):
        load_config(None, env)


def test_config_error_exits_one_not_a_folder_fallback(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("FREESCRIPT_BUNDLE_CMD", "not json")
    monkeypatch.delenv("FREESCRIPT_BUNDLE_CWD", raising=False)
    assert nightly.main(["run", "--data", str(tmp_path)]) == 1
    assert "config error" in capsys.readouterr().out


def test_unset_is_folder_mode_and_the_summary_says_so(tmp_path, capsys):
    assert parse_bundle_config({}) is None and parse_bundle_config({"FREESCRIPT_BUNDLE_CMD": "  "}) is None
    d = tmp_path / "synth-a"
    d.mkdir()
    (d / "transcript.json").write_text(json.dumps({"consult_uid": "synth-a", "clip": {"t0_ms": T0, "t1_ms": T0 + 1000, "room_slug": "r"}, "english_segments": []}))
    (d / "role.json").write_text(json.dumps({"status": "ok", "segments": [{"t0_ms": 0, "t1_ms": 1, "speaker": "0", "role": "doctor"}]}))
    cfg = {"enabled": True, "data": str(tmp_path), "app_url": "https://app.test", "max_consults": 40}
    assert "bundle_cmd" not in load_config(None, {})
    rc = run(cfg, DAY, run_one=lambda u: {"final_valid": True, "artifact": {"encounter": {}, "pulse_link": {}}}, post=lambda b: {"ok": True, "inserted": 1}, pending=False, sealed=False)
    s = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert rc == 0 and (s["mode"], s["bundle_failed"], s["missing_layers"], s["not_this_day"], s["posted"]) == ("folder", 0, 0, 0, 1)


def test_pending_job_skips_the_day_check_but_the_sealed_feed_does_not(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("FREESCRIPT_INGEST_SECRET", "s")
    rc, s, ran, posted, _ = go(tmp_path, ["synth-otherday"], capsys, jobs=[{"job_id": "job_9", "consult_uid": "synth-otherday"}])
    assert ran == ["synth-otherday"] and s["not_this_day"] == 0 and posted[0]["job_id"] == "job_9"
    monkeypatch.setenv("FREESCRIPT_INGEST_SECRET", "s")
    rc, s, ran, _, out = go(tmp_path, ["synth-otherday"], capsys)
    assert ran == [] and rc == 0 and "nothing" in out  # counted not_this_day, nothing left to run
    assert s["not_this_day"] == 1 and s["mode"] == "bundle"


def test_max_consults_applies_before_any_fetch(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("FREESCRIPT_INGEST_SECRET", "s")
    calls = []
    real = nightly.fetch_bundle
    monkeypatch.setattr(nightly, "fetch_bundle", lambda cmd, cwd, uid, tmp: calls.append(uid) or real(cmd, cwd, uid, tmp))
    cfg = bcfg(tmp_path, max_consults=2)
    ran = []
    rc = run(cfg, DAY, run_one=fake_run_one(ran), post=lambda b: {"ok": True, "inserted": 1}, sealed=["synth-all", "synth-judge", "synth-caa"], pending=False)
    s = json.loads([l for l in capsys.readouterr().out.splitlines() if l.startswith("{")][-1])
    assert calls == ["synth-all", "synth-judge"] and s["skipped"] == 1 and rc == 2


def test_stderr_is_logged_only_when_the_command_fails(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("FREESCRIPT_INGEST_SECRET", "s")
    monkeypatch.setenv("FAKE_BUNDLE_STDERR", "1")
    rc, s, ran, _, out = go(tmp_path, ["synth-all"], capsys)
    assert ran == ["synth-all"] and "bundle-stderr" not in out and "noise" not in out


def test_off_day_only_feed_prints_one_summary_line(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("FREESCRIPT_INGEST_SECRET", "s")
    rc, s, ran, _, out = go(tmp_path, ["synth-otherday"], capsys)
    lines = [l for l in out.splitlines() if l.startswith("{")]
    assert rc == 0 and len(lines) == 1 and ran == []
    assert (s["mode"], s["not_this_day"], s["posted"], s["n"]) == ("bundle", 1, 0, 0)


@pytest.mark.parametrize("uid", ["x\n", "x\r", " x", "-x", "x y", ""])
def test_unsafe_uids_are_rejected_and_logged_as_repr(tmp_path, uid, capsys):
    with pytest.raises(NightlyError):
        nightly.fetch_bundle(json.loads(cmd_env(tmp_path)["FREESCRIPT_BUNDLE_CMD"]), str(tmp_path), uid, tmp_path)
    assert nightly._SAFE_UID.fullmatch("x") and nightly._SAFE_UID.fullmatch("a.b_c-1")


def test_unsafe_uid_in_the_feed_is_failed_and_not_printed_raw(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("FREESCRIPT_INGEST_SECRET", "s")
    rc, s, ran, _, out = go(tmp_path, ["x\n"], capsys)
    assert s["bundle_failed"] == 1 and ran == [] and "'x\\n'" in out and "x\n " not in out


def test_derived_outputs_only_persist(tmp_path, capsys, monkeypatch):
    from types import SimpleNamespace
    from tools.eta2freescript import models, phi_guard, pipeline
    monkeypatch.setenv("FREESCRIPT_INGEST_SECRET", "s")
    keep = tmp_path / "keep"
    seen_dirs = []

    class Client(SimpleNamespace):
        def resolve(self, _a):
            return ("m", "converse")

    def fake_make_client(_kind, ledger, _x):
        c = Client(ledger=ledger)
        return c

    def fake_run_consult(c, client, out_dir, opts=None, specialty=None):
        od = Path(out_dir) / c.uid
        od.mkdir(parents=True, exist_ok=True)
        seen_dirs.append(od)
        (od / "stageA.raw.txt").write_text("RAW")
        (od / "encounter.json").write_text("{}")
        (od / "note_text.llm.txt").write_text("note")
        (od / "artifact.json").write_text('{"ok": 1}')
        (od / "artifact.validation.json").write_text('{"final_valid": true}')
        client.ledger.path.write_text('{"tag": "t", "usd": 0.1}\n')
        return {"final_valid": True, "final_errors": [], "cost_usd": 0.1,
                "artifact": {"encounter": {"eta_encounter_id": c.uid}, "pulse_link": {"consult_uid": c.uid}}}
    monkeypatch.setattr(models, "make_client", fake_make_client)
    monkeypatch.setattr(phi_guard, "assert_phi_safe", lambda *a: None)
    monkeypatch.setattr(pipeline, "run_consult", fake_run_consult)
    cfg = bcfg(tmp_path, out=str(keep))
    rc = run(cfg, DAY, post=lambda b: {"ok": True, "inserted": 1}, sealed=["synth-all"], pending=False)
    assert rc == 0 and seen_dirs and not seen_dirs[0].exists()
    kept = sorted(p.relative_to(keep).as_posix() for p in keep.rglob("*") if p.is_file())
    assert kept == ["consult-state.jsonl", "runs.jsonl", "synth-all/artifact.json", "synth-all/artifact.validation.json", "usage.jsonl"]
    for p in keep.rglob("*"):
        assert (p.stat().st_mode & 0o777) == (0o700 if p.is_dir() else 0o600)
    assert json.loads((keep / "runs.jsonl").read_text().splitlines()[0])["uid"] == "synth-all"
    assert (keep / "usage.jsonl").read_text().count("\n") == 1


@pytest.mark.parametrize("cmd", [
    '["x", "{uid}", "{out}", "{bogus}"]', '["", "{uid}", "{out}"]', '["  ", "{uid}", "{out}"]', '["x", "{uid}", "{out}", "{}"]',
])
def test_bad_placeholders_or_empty_program_are_config_errors(cmd, tmp_path):
    with pytest.raises(NightlyError):
        parse_bundle_config({"FREESCRIPT_BUNDLE_CMD": cmd, "FREESCRIPT_BUNDLE_CWD": str(tmp_path)})


def test_non_null_slot_with_null_track_is_missing_layers(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("FREESCRIPT_INGEST_SECRET", "s")
    b = bundle("synth-all")
    for k in ROLE_SLOTS:
        b["tracks"][k] = {"engine": "llm-roles", "path": "tracks/x.json", "track": None}
    monkeypatch.setattr(nightly, "fetch_bundle", lambda *a, **k: b)
    rc, s, ran, _, _ = go(tmp_path, ["synth-all"], capsys)
    assert (s["missing_layers"], s["bundle_failed"]) == (1, 0) and ran == []
    b = bundle("synth-all")
    for k in ("translate", "stt"):
        b["tracks"][k] = {"engine": "e", "path": "p", "track": None}
    monkeypatch.setattr(nightly, "fetch_bundle", lambda *a, **k: b)
    rc, s, ran, _, _ = go(tmp_path, ["synth-all"], capsys)
    assert (s["missing_layers"], s["bundle_failed"]) == (1, 0)


def test_timeout_kills_the_whole_process_group(tmp_path, monkeypatch):
    import os, time
    pidfile = tmp_path / "gc.pid"
    script = tmp_path / "spawn.py"
    script.write_text("import subprocess, sys, time\n"
                      f"p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
                      f"open({str(pidfile)!r}, 'w').write(str(p.pid))\n"
                      "time.sleep(60)\n")
    monkeypatch.setattr(nightly, "BUNDLE_TIMEOUT_S", 2)
    with pytest.raises(NightlyError, match="timed out"):
        nightly.fetch_bundle([sys.executable, str(script), "{uid}", "{out}"], str(tmp_path), "u1", tmp_path)
    pid = int(pidfile.read_text())
    for _ in range(20):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.1)
    else:
        pytest.fail("grandchild survived")


def test_stderr_read_is_bounded(tmp_path, capsys):
    script = tmp_path / "noisy.py"
    script.write_text("import sys\nsys.stderr.write('e' * 5_000_000)\nsys.exit(4)\n")
    with pytest.raises(NightlyError):
        nightly.fetch_bundle([sys.executable, str(script), "{uid}", "{out}"], str(tmp_path), "u1", tmp_path)
    line = capsys.readouterr().out.strip()
    assert len(line.split("bundle-stderr ", 1)[1]) == 500


def test_no_grandchild_survives_a_clean_exit(tmp_path):
    import os, time
    pidfile, late = tmp_path / "gc.pid", tmp_path / "work" / "late.txt"
    work = tmp_path / "work"
    work.mkdir()
    script = tmp_path / "spawn.py"
    script.write_text("import subprocess, sys\n"
                      f"code = 'import time; time.sleep(1.5); open(' + repr({str(late)!r}) + ', ' + repr('w') + ').write(' + repr('x') + ')'\n"
                      "p = subprocess.Popen([sys.executable, '-c', code], stdin=subprocess.DEVNULL)\n"
                      f"open({str(pidfile)!r}, 'w').write(str(p.pid))\n"
                      "open(sys.argv[2], 'w').write('{}')\n")
    nightly.fetch_bundle([sys.executable, str(script), "{uid}", "{out}"], str(tmp_path), "u1", work)
    pid = int(pidfile.read_text())
    for _ in range(20):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.1)
    else:
        pytest.fail("grandchild survived")
    time.sleep(2)
    assert not late.exists() and list(work.iterdir()) == []


def _raising_consult(monkeypatch, fail_uids):
    from types import SimpleNamespace
    from tools.eta2freescript import models, phi_guard, pipeline

    class Client(SimpleNamespace):
        def resolve(self, _a):
            return ("m", "converse")

    def fake_run_consult(c, client, out_dir, opts=None, specialty=None):
        with client.ledger.path.open("a") as f:
            f.write('{"tag": "t", "usd": 0.1}\n')
        if c.uid in fail_uids:
            raise RuntimeError("SYNTH_SECRET_MESSAGE")
        return {"final_valid": True, "final_errors": [], "cost_usd": 0.1,
                "artifact": {"encounter": {"eta_encounter_id": c.uid}, "pulse_link": {"consult_uid": c.uid}}}
    monkeypatch.setattr(models, "make_client", lambda _k, ledger, _x: Client(ledger=ledger))
    monkeypatch.setattr(phi_guard, "assert_phi_safe", lambda *a: None)
    monkeypatch.setattr(pipeline, "run_consult", fake_run_consult)


@pytest.mark.parametrize("order", [["synth-all", "synth-judge"], ["synth-judge", "synth-all"]])
def test_a_raising_consult_still_flushes_usage_and_logs_the_class(tmp_path, capsys, monkeypatch, order):
    monkeypatch.setenv("FREESCRIPT_INGEST_SECRET", "s")
    keep = tmp_path / "keep"
    _raising_consult(monkeypatch, {"synth-judge"})  # fails first or last, depending on the order
    cfg = bcfg(tmp_path, out=str(keep))
    run(cfg, DAY, post=lambda b: {"ok": True, "inserted": 1}, sealed=order, pending=False)
    out = capsys.readouterr().out
    assert "SYNTH_SECRET_MESSAGE" not in out
    assert (keep / "usage.jsonl").read_text().count("\n") == 2
    runs = {json.loads(l)["uid"]: json.loads(l) for l in (keep / "runs.jsonl").read_text().splitlines()}
    assert runs["synth-judge"] == {"uid": "synth-judge", "final_valid": False, "error_type": "RuntimeError"}
    assert runs["synth-all"]["final_valid"] is True


@pytest.mark.parametrize("which", ["run", "drain"])
def test_no_ingest_target_in_bundle_mode_prints_one_summary(tmp_path, capsys, monkeypatch, which):
    monkeypatch.delenv("FREESCRIPT_INGEST_SECRET", raising=False)
    cfg = bcfg(tmp_path)
    rc = run(cfg, DAY, sealed=["synth-all"], pending=False) if which == "run" else nightly._drain(cfg, False)
    out = capsys.readouterr().out
    lines = [l for l in out.splitlines() if l.startswith("{")]
    assert rc == 1 and len(lines) == 1
    s = json.loads(lines[0])
    assert s["mode"] == "bundle" and s["config_error"] is True


def test_placeholder_program_is_a_config_error(tmp_path):
    with pytest.raises(NightlyError):
        parse_bundle_config({"FREESCRIPT_BUNDLE_CMD": '["{uid}", "{out}"]', "FREESCRIPT_BUNDLE_CWD": str(tmp_path)})
    with pytest.raises(NightlyError):
        parse_bundle_config({"FREESCRIPT_BUNDLE_CMD": '["py{uid}", "x", "{out}"]', "FREESCRIPT_BUNDLE_CWD": str(tmp_path)})
