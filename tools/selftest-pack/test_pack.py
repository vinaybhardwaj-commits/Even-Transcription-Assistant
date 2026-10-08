"""pytest for the self-test pack builder: python3 -m pytest tools/selftest-pack. No network, no key, no ffmpeg needed (dry-run fake TTS)."""
import datetime
import hashlib
import json
import os
import shutil
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_pack as B  # noqa: E402
import selftest_gw as G  # noqa: E402
import validate_pack as V  # noqa: E402

PHRASES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "phrases.json")


@pytest.fixture
def built(tmp_path):
    out = str(tmp_path / "pack")
    r = B.build(out, PHRASES, dry_run=True)
    return out, r


def sha(b):
    return hashlib.sha256(b).hexdigest()


def swift_fixture(tmp_path, mutate=lambda entries, d: None):
    """The shape RoomSelfTestTests.makePack writes: four tiny NON-wav files with correct hashes, duration_s 2.0."""
    d = tmp_path / "fx"
    d.mkdir()
    entries = []
    for i, k in [("tone-1k", "tone"), ("sweep", "sweep"), ("canary-1", "canary"), ("phrase-en-1", "phrase")]:
        b = f"wav-bytes-{i}".encode()
        (d / f"{i}.wav").write_bytes(b)
        e = {"id": i, "kind": k, "file": f"{i}.wav", "sha256": sha(b), "duration_s": 2.0}
        if k in ("canary", "phrase"):
            e.update(lang="en", truth="invented text")
        entries.append(e)
    mutate(entries, d)
    (d / "pack.json").write_text(json.dumps({"pack_version": 1, "stimuli": entries}))
    return str(d)


# ---- the pack we build --------------------------------------------------------------------------------------------------------------------------
def test_dry_run_pack_passes_the_loader_and_the_limits(built):
    out, r = built
    errs, stim = V.validate(out)
    assert errs == []
    assert [s["kind"] for s in stim] == ["tone", "sweep", "canary"] + ["phrase"] * 8
    assert r["total_s"] <= 90 and r["stimuli"] == 11
    for s in stim:
        w = V.read_wav(open(os.path.join(out, s["file"]), "rb").read())
        assert w[:3] == (1, 16000, 16)  # mono s16 16 kHz
    assert {s["lang"] for s in stim if s["kind"] == "phrase"} == {"en-IN", "hi-IN", "kn-IN", "ta-IN", "te-IN"}
    assert all(s["truth"] for s in stim if s["kind"] in ("canary", "phrase"))
    m = json.load(open(os.path.join(out, "pack.json"), encoding="utf-8"))
    assert m["pack_version"] == 1 and m["pack_name"] == "selftest-room-v3" and len(m["stimuli"]) == 11


def test_phrases_json_shape():
    cfg, items = B.load_phrases(PHRASES)
    ph = [i for i in items if i["kind"] == "phrase"]
    assert len(ph) == 8
    langs = sorted(p["lang"] for p in ph)
    assert langs == sorted(["en-IN"] * 2 + ["hi-IN"] * 2 + ["kn-IN"] * 2 + ["ta-IN", "te-IN"])
    assert {p["voice"] for p in ph} == {"female", "male"}
    for p in ph:  # a drug name, a dose and a number in every phrase
        assert any(ch.isdigit() for ch in p["text"]), p["id"]
    assert cfg["model"] == "bulbul:v3" and "UNVERIFIED" in cfg["speakers_status"]


def test_truth_is_the_exact_text_sent_to_tts(tmp_path):
    sent = []

    def spy(text, lang, speaker, model, pace):
        sent.append((text, lang, speaker, model))
        return B.fake_tts(text, lang, speaker)

    out = str(tmp_path / "p")
    B.build(out, PHRASES, dry_run=True, tts=spy)
    m = json.load(open(os.path.join(out, "pack.json"), encoding="utf-8"))
    truth = {s["id"]: s["truth"] for s in m["stimuli"] if "truth" in s}
    assert sorted(t[0] for t in sent) == sorted(truth.values())
    assert all(t[3] == "bulbul:v3" for t in sent)


def test_idempotent_second_run_makes_no_paid_call_and_changes_nothing(tmp_path):
    out = str(tmp_path / "p")
    calls = []
    tts = lambda *a: (calls.append(a), B.fake_tts(*a[:3]))[1]  # noqa: E731
    r1 = B.build(out, PHRASES, dry_run=True, tts=tts)
    assert len(calls) == 9
    calls.clear()
    r2 = B.build(out, PHRASES, dry_run=True, tts=tts)
    assert calls == [] and r2["paid_calls"] == 0
    assert r1["pack_sha256"] == r2["pack_sha256"]


def test_one_changed_phrase_pays_for_exactly_that_one(tmp_path):
    out = str(tmp_path / "p")
    calls = []
    tts = lambda *a: (calls.append(a[0]), B.fake_tts(*a[:3]))[1]  # noqa: E731
    B.build(out, PHRASES, dry_run=True, tts=tts)
    calls.clear()
    cfg = json.load(open(PHRASES, encoding="utf-8"))
    cfg["phrases"][0]["text"] = "Take ibuprofen 400 milligrams twice a day for three days."
    p2 = str(tmp_path / "ph.json")
    json.dump(cfg, open(p2, "w", encoding="utf-8"), ensure_ascii=False)
    B.build(out, p2, dry_run=True, tts=tts)
    assert calls == ["Take ibuprofen 400 milligrams twice a day for three days."]


def test_a_damaged_converted_file_is_rebuilt_from_the_saved_raw_audio_without_paying(tmp_path):
    out = str(tmp_path / "p")
    B.build(out, PHRASES, dry_run=True)
    open(os.path.join(out, "phrase-hi-1.wav"), "wb").write(b"junk")
    calls = []
    B.build(out, PHRASES, dry_run=True, tts=lambda *a: (calls.append(1), B.fake_tts(*a[:3]))[1])
    assert calls == [] and V.validate(out)[0] == []
    # only if the raw copy is gone too does it pay again, and for that one phrase only
    open(os.path.join(out, "phrase-hi-1.wav"), "wb").write(b"junk")
    for f in os.listdir(os.path.join(out, ".raw")):
        if f.startswith("phrase-hi-1."):
            os.remove(os.path.join(out, ".raw", f))
    B.build(out, PHRASES, dry_run=True, tts=lambda *a: (calls.append(1), B.fake_tts(*a[:3]))[1])
    assert len(calls) == 1 and V.validate(out)[0] == []


def test_stale_wav_of_this_pack_is_removed_but_a_foreign_wav_is_never_deleted(tmp_path):
    out = str(tmp_path / "p")
    B.build(out, PHRASES, dry_run=True)
    cfg = json.load(open(PHRASES, encoding="utf-8"))
    dropped = cfg["phrases"].pop()["id"]
    p2 = str(tmp_path / "ph.json")
    json.dump(cfg, open(p2, "w", encoding="utf-8"), ensure_ascii=False)
    B.build(out, p2, dry_run=True)
    assert not os.path.exists(os.path.join(out, dropped + ".wav")) and V.validate(out)[0] == []
    shutil.copy(os.path.join(out, "tone-1k.wav"), os.path.join(out, "somebody-elses.wav"))
    with pytest.raises(SystemExit) as e:
        B.build(out, p2, dry_run=True)
    assert "not in pack.json" in str(e.value)
    assert os.path.exists(os.path.join(out, "somebody-elses.wav"))  # the builder did not delete it


def test_g33_refuses_a_folder_that_holds_another_pack(tmp_path):
    out = tmp_path / "old"
    out.mkdir()
    (out / "pack.json").write_text(json.dumps({"pack_version": 1, "pack_name": "selftest-room-v2", "stimuli": []}))
    (out / "old.wav").write_bytes(b"x")
    with pytest.raises(SystemExit) as e:
        B.build(str(out), PHRASES, dry_run=True)
    assert "different pack" in str(e.value) and (out / "old.wav").exists()


def test_g29_a_failure_on_phrase_4_then_a_rerun_pays_only_for_the_missing(tmp_path):
    out, led = str(tmp_path / "p"), str(tmp_path / "led")
    calls = []

    def dies_on_4(t, l, s, m, p):
        calls.append(t)
        if len(calls) == 4:
            raise G.GatewayError("tts", 400, False)
        return B.fake_tts(t, l, s)

    with pytest.raises(SystemExit):
        B.build(out, PHRASES, dry_run=True, ledger_dir=led, tts=dies_on_4)
    assert len(calls) == 4
    assert len([f for f in os.listdir(out) if f.endswith(".wav")]) == 2 + 3  # tone, sweep and the 3 paid phrases are on disk
    calls.clear()
    r = B.build(out, PHRASES, dry_run=True, ledger_dir=led, tts=lambda t, l, s, m, p: (calls.append(t), B.fake_tts(t, l, s))[1])
    assert len(calls) == 9 - 3 and r["stimuli"] == 11  # the three paid phrases are NOT paid for again


def test_g29_a_failed_90s_check_saves_everything_and_a_rerun_pays_nothing(tmp_path):
    out = str(tmp_path / "p")
    calls = []
    long_wav = lambda t, l, s, m, p: (calls.append(t), (B.to_wav([0.1] * 16000 * 11), "r", 200))[1]  # noqa: E731  9 x 11 s = 99 s
    with pytest.raises(SystemExit) as e:
        B.build(out, PHRASES, dry_run=True, tts=long_wav)
    assert "over the 90 s limit" in str(e.value) and len(calls) == 9
    assert not os.path.exists(os.path.join(out, "pack.json"))
    calls.clear()
    with pytest.raises(SystemExit):
        B.build(out, PHRASES, dry_run=True, tts=long_wav)
    assert calls == []  # the second run paid for NOTHING (all nine were saved)


def test_too_long_a_pack_is_refused_before_pack_json_is_written(tmp_path):
    long_wav = lambda t, l, s, m, p: (B.to_wav([0.1] * 16000 * 30), "r", 200)  # noqa: E731  30 s per TTS file -> 270 s in all
    out = str(tmp_path / "o")
    with pytest.raises(SystemExit) as e:
        B.build(out, PHRASES, dry_run=True, tts=lambda t, l, s, m, p: (long_wav(t, l, s, m, p)[0], "r", 200))
    assert "over the 90 s limit" in str(e.value)
    assert not os.path.exists(os.path.join(out, "pack.json"))


# ---- the ledger ---------------------------------------------------------------------------------------------------------------------------------
def test_one_ledger_line_per_paid_call_with_the_contract_fields_and_no_text(tmp_path):
    out = str(tmp_path / "p")
    led = str(tmp_path / "led")
    B.build(out, PHRASES, dry_run=True, ledger_dir=led)
    files = [f for f in os.listdir(led) if f.endswith(".jsonl")]
    assert len(files) == 1 and files[0].endswith(".jsonl")
    day = datetime.datetime.now(B.IST).strftime("%Y-%m-%d")
    assert files[0] == day + ".jsonl"  # <ist_date>.jsonl
    lines = [json.loads(l) for l in open(os.path.join(led, files[0]), encoding="utf-8")]
    assert len(lines) == 9
    need = {"caller", "machine", "job_id", "request_id", "route", "mode", "task", "model", "audio_s", "chars", "started_at", "finished_at", "status", "http_status", "throttled", "scope", "ref"}
    for l in lines:
        assert need <= set(l)
        assert (l["caller"], l["task"], l["model"], l["scope"], l["status"], l["audio_s"]) == ("scribe-mcp", "tts", "bulbul:v3", "synthetic", "ok", 0)
        assert l["chars"] > 0 and l["ref"].startswith("selftest-room-v3:")
    raw = open(os.path.join(led, files[0]), encoding="utf-8").read()
    for it in B.load_phrases(PHRASES)[1]:
        assert it["text"] not in raw  # no transcript text in the ledger


def test_second_run_adds_no_ledger_lines(tmp_path):
    out, led = str(tmp_path / "p"), str(tmp_path / "led")
    B.build(out, PHRASES, dry_run=True, ledger_dir=led)
    n = sum(1 for _ in open(os.path.join(led, [f for f in os.listdir(led) if f.endswith(".jsonl")][0])))
    B.build(out, PHRASES, dry_run=True, ledger_dir=led)
    assert sum(1 for _ in open(os.path.join(led, [f for f in os.listdir(led) if f.endswith(".jsonl")][0]))) == n


def test_g31_only_429_and_503_are_retried_and_every_attempt_is_its_own_ledger_line(tmp_path):
    attempts = []

    def flaky(t, l, s, m, p):
        attempts.append(1)
        if len(attempts) == 1:
            raise G.GatewayError("tts", 429, True)
        if len(attempts) == 2:
            raise G.GatewayError("tts", 503, True)
        return B.fake_tts(t, l, s)

    led = str(tmp_path / "led")
    B.build(str(tmp_path / "p"), PHRASES, dry_run=True, ledger_dir=led, tts=flaky, sleep=lambda s: None)
    f = [x for x in os.listdir(led) if x.endswith(".jsonl")][0]
    lines = [json.loads(x) for x in open(os.path.join(led, f))]
    assert [l["status"] for l in lines[:3]] == ["failed", "failed", "ok"]
    assert lines[0]["http_status"] == 429 and lines[0]["throttled"] is True
    assert len({l["job_id"] for l in lines}) == len(lines)  # one line per request id: no two lines share a job id
    assert lines[0]["job_id"].endswith(":canary-1:a1") and lines[2]["job_id"].endswith(":canary-1:a3")


@pytest.mark.parametrize("err", [G.GatewayError("tts_network", None, True), G.GatewayError("tts", 500, True), G.GatewayError("tts", 502, True), G.GatewayError("tts", 400, False)])
def test_g31_a_timeout_network_error_or_other_failure_is_not_retried_blindly(tmp_path, err):
    calls = []
    led = str(tmp_path / "led")

    def boom(*a):
        calls.append(1)
        raise err

    with pytest.raises(SystemExit) as e:
        B.build(str(tmp_path / "p"), PHRASES, dry_run=True, ledger_dir=led, tts=boom, sleep=lambda s: None)
    assert len(calls) == 1  # one request, one ledger line
    f = [x for x in os.listdir(led) if x.endswith(".jsonl")][0]
    assert len(open(os.path.join(led, f)).readlines()) == 1
    if err.status is None:
        assert "may have been billed" in str(e.value)


def test_g31_a_429_that_never_clears_stops_after_the_retries(tmp_path):
    led = str(tmp_path / "led")
    with pytest.raises(SystemExit):
        B.build(str(tmp_path / "p"), PHRASES, dry_run=True, ledger_dir=led, tts=lambda *a: (_ for _ in ()).throw(G.GatewayError("tts", 429, True)), sleep=lambda s: None)
    f = [x for x in os.listdir(led) if x.endswith(".jsonl")][0]
    assert len(open(os.path.join(led, f)).readlines()) == 4  # first try + 3 retries


def test_g32_a_lane_file_is_written_beside_the_ledger(tmp_path):
    out, led = str(tmp_path / "p"), str(tmp_path / "led")
    B.build(out, PHRASES, dry_run=True, ledger_dir=led)
    lane = json.load(open(os.path.join(led, "lanes", "sarvam-scribe-mcp.json")))
    assert set(lane) == {"caller", "machine", "updated_at", "active", "today", "all_time"}
    assert lane["caller"] == "scribe-mcp" and lane["active"] == []
    assert lane["today"] == {"jobs": 9, "audio_min": 0.0, "failed": 0, "throttled": 0} and lane["all_time"]["jobs"] == 9
    assert not any(p.endswith(".wav") for p in os.listdir(os.path.join(led, "lanes")))


def test_swift_fixture_shape_parses_in_the_loader_only_mode(tmp_path):
    d = swift_fixture(tmp_path)
    errs, stim = V.validate(d, policy=False)
    assert errs == [] and [s["id"] for s in stim] == ["tone-1k", "sweep", "canary-1", "phrase-en-1"]
    assert V.validate(d)[0] != []  # tiny non-wav files fail OUR limits, not the loader's
    assert len(V.pack_sha256(d)) == 64


@pytest.mark.parametrize("name,mutate,expect", [
    ("hash mismatch", lambda e, d: (d / "sweep.wav").write_bytes(b"changed"), "hashMismatch(sweep)"),
    ("unknown kind", lambda e, d: e[1].update(kind="noise"), "badEntry(sweep)"),
    ("slash in file", lambda e, d: e[0].update(file="sub/tone.wav"), "badEntry(tone-1k)"),
    ("dotdot in file", lambda e, d: e[0].update(file="..tone.wav"), "badEntry(tone-1k)"),
    ("duplicate id", lambda e, d: e[1].update(id="tone-1k"), "badEntry(tone-1k)"),
    ("short sha", lambda e, d: e[0].update(sha256="abc"), "badEntry(tone-1k)"),
    ("non-hex sha", lambda e, d: e[0].update(sha256="z" * 64), "badEntry(tone-1k)"),
    ("empty id", lambda e, d: e[0].update(id=""), "badEntry(?)"),
    ("missing file", lambda e, d: os.remove(d / "tone-1k.wav"), "hashMismatch(tone-1k)"),
])
def test_loader_refusals(tmp_path, name, mutate, expect):
    errs, _ = V.validate(swift_fixture(tmp_path, mutate), policy=False)
    assert errs == [expect], name


def test_loader_accepts_an_uppercase_sha(tmp_path):
    d = swift_fixture(tmp_path, lambda e, _: e[0].update(sha256=e[0]["sha256"].upper()))
    assert V.validate(d, policy=False)[0] == []


def test_manifest_level_refusals(tmp_path):
    d = tmp_path / "m"
    d.mkdir()
    assert V.validate(str(d))[0] == ["missingPack"]
    (d / "pack.json").write_text("not json")
    assert V.validate(str(d))[0] == ["unreadablePack"]
    (d / "pack.json").write_text('{"pack_version":2,"stimuli":[{}]}')
    assert V.validate(str(d))[0] == ["unknownPackVersion(2)"]
    (d / "pack.json").write_text('{"pack_version":"1","stimuli":[{}]}')
    assert V.validate(str(d))[0] == ["unknownPackVersion(-1)"]
    (d / "pack.json").write_text('{"pack_version":1,"stimuli":[]}')
    assert V.validate(str(d))[0] == ["emptyPack"]
    (d / "pack.json").write_text('{"pack_version":1}')
    assert V.validate(str(d))[0] == ["emptyPack"]


def test_policy_limits(built, tmp_path):
    out, _ = built
    m = json.load(open(os.path.join(out, "pack.json"), encoding="utf-8"))
    m["stimuli"][0]["duration_s"] = 99
    json.dump(m, open(os.path.join(out, "pack.json"), "w"))
    assert any("duration_s" in e for e in V.validate(out)[0])
    m["stimuli"][0].pop("duration_s")
    m["stimuli"][-1].pop("truth")
    json.dump(m, open(os.path.join(out, "pack.json"), "w"))
    assert any("needs lang and truth" in e for e in V.validate(out)[0])
    m["stimuli"] = [s for s in m["stimuli"] if s["kind"] != "sweep"]
    json.dump(m, open(os.path.join(out, "pack.json"), "w"))
    assert any("no sweep stimulus" in e for e in V.validate(out)[0])


def test_wrong_audio_format_is_a_policy_error(tmp_path):
    out = str(tmp_path / "p")
    B.build(out, PHRASES, dry_run=True)
    import wave
    with wave.open(os.path.join(out, "tone-1k.wav"), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(44100); w.writeframes(b"\0\0" * 2 * 44100)
    m = json.load(open(os.path.join(out, "pack.json"), encoding="utf-8"))
    m["stimuli"][0]["sha256"] = sha(open(os.path.join(out, "tone-1k.wav"), "rb").read())
    json.dump(m, open(os.path.join(out, "pack.json"), "w"))
    errs = V.validate(out)[0]
    assert any("not PCM s16 mono 16000" in e for e in errs)
    assert V.validate(out, policy=False)[0] == []  # the app's loader would still accept it: the limit is ours


# ---- signals and the gateway client -------------------------------------------------------------------------------------------------------------
def test_tone_is_1khz_and_sweep_is_monotonic():
    t = B.tone_samples(seconds=1.0)
    crossings = sum(1 for a, b in zip(t, t[1:]) if a < 0 <= b)
    assert 995 <= crossings <= 1005
    s = B.sweep_samples(seconds=4.0)
    half = lambda x: sum(1 for a, b in zip(x, x[1:]) if a < 0 <= b)  # noqa: E731
    assert half(s[len(s) // 2:]) > 3 * half(s[:len(s) // 2])  # rising frequency
    assert max(abs(x) for x in s) <= 0.5 + 1e-9


def test_sigv4_matches_the_typescript_signer_byte_for_byte():
    h = G.sign_sigv4("POST", "https://gateway.example.test/prod/text-to-speech", {"Content-Type": "application/json"}, b'{"a":1}',
                     "ap-south-1", "execute-api", {"ak": "AKIDEXAMPLE", "sk": "SECRETEXAMPLE", "st": "TOKENEXAMPLE"},
                     datetime.datetime(2026, 10, 8, 6, 0, 0, tzinfo=datetime.timezone.utc))
    # the value lib/sarvam-gateway.ts signSigV4 produces for the same inputs (fake credentials, made-up host)
    assert h["Authorization"].endswith("Signature=4a3bbf0488150890b88e3edb385c68ba653aa14d4caccb36db096f34fa57526c")
    assert "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token" in h["Authorization"]


def test_missing_env_is_named_never_valued(monkeypatch):
    for n in G.ENV_NAMES:
        monkeypatch.delenv(n, raising=False)
    assert G.missing_env() == list(G.ENV_NAMES)
    monkeypatch.setenv("SARVAM_GW_REGION", "ap-south-1")
    assert "SARVAM_GW_REGION" not in G.missing_env()


def test_real_run_without_env_stops_before_any_call(tmp_path, monkeypatch):
    for n in G.ENV_NAMES:
        monkeypatch.delenv(n, raising=False)
    with pytest.raises(SystemExit) as e:
        B.build(str(tmp_path / "p"), PHRASES)
    assert "missing env" in str(e.value) and "SARVAM_GW_AUDIENCE" in str(e.value)


def test_no_identifier_literals_in_the_tool():
    here = os.path.dirname(os.path.abspath(__file__))
    import re
    for f in ("build_pack.py", "selftest_gw.py", "validate_pack.py", "phrases.json"):
        src = open(os.path.join(here, f), encoding="utf-8").read()
        assert not re.search(r"\b\d{12}\b", src), f
        assert "arn:aws" not in src and "execute-api.amazonaws" not in src and "iam.gserviceaccount" not in src, f
