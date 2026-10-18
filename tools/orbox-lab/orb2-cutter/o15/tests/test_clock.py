# Synthetic tests for cutter_v2.py v2.3 clock block. No real tape, room or case ids. Needs /usr/bin/ffmpeg.
import os, sys, json, subprocess, argparse, importlib.util, pytest
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("cutter_v2", os.path.join(HERE, "..", "cutter_v2.py")); C = importlib.util.module_from_spec(spec); spec.loader.exec_module(C)
T0 = 1_800_000_000            # synthetic wall-clock start of the tape (epoch s)
PRE_S, WIN_S, POST_S = 600, 7200, 600
CHUNK = 8000                  # samples per idx row

def make_tape(tmp, ppm):
    rate = 16000 * (1 + ppm * 1e-6); n_rows = (PRE_S + WIN_S + POST_S) * 16000 // CHUNK + 1; R = []
    for i in range(n_rows):
        n = i * CHUNK; R.append(dict(wall_ns=T0 * 10 ** 9 + round(n / rate * 1e9), samples=n, byte_offset=2 * n, rms=0.0, input_sample_rate=48000))
    tape = str(tmp / "tape.pcm")
    with open(tape, "wb") as f: f.truncate(2 * R[-1]["samples"])     # sparse zeros
    return R, [r["wall_ns"] for r in R], rate, tape

def case(ws, we):
    return dict(case_id="CASE-SYN-1", booked_start=ws, booked_end=we, segment=(ws, we), boundary_prev=None, boundary_next=None, onset=None, offset=None, t0=ws, t0_method="booked_start", t0_flag=None,
                binding_method="booked_slot", window_start=ws, window_end=we, pre_roll_s=0, post_roll_s=0, provisional=False, provisional_reason=None, notes=[], gaps=[], bin_rows=[], runs_considered=[],
                sessions=[dict(id=None, start_utc="x", end_utc="y", source="unknown")])

@pytest.fixture
def run_cut(tmp_path, monkeypatch):
    def go(ppm):
        R, W, rate, tape = make_tape(tmp_path, ppm); out = tmp_path / "cases"
        monkeypatch.setattr(C, "OUT", str(out)); monkeypatch.setattr(C, "TAPE", tape); monkeypatch.setitem(C.ROOMS, "OT-2", "synthetic-room")
        real = subprocess.Popen
        monkeypatch.setattr(C.subprocess, "Popen", lambda args, **kw: real(args[args.index("dd"):] if "dd" in args else args, **kw))   # no sudo/ionice/nice in the test
        ws, we = T0 + PRE_S, T0 + PRE_S + WIN_S; C.write_package(case(ws, we), R, W, "OT-2", "synthetic.csv", None, "0" * 64)
        return R, W, rate, str(out / "CASE-SYN-1"), ws, we
    return go

def check(date_ist_prefix):
    a = argparse.Namespace(date=date_ist_prefix, room="OT-2")
    try: C.cmd_check(a)
    except SystemExit as e: return e.code

def ist_date(ws): return C.iso(ws, C.IST)[:10]

def test_version(): assert C.VERSION == "o15-cutter-v2.3"

@pytest.mark.parametrize("ppm", [6.0, 0.0])
def test_clock_and_check_pass(run_cut, capsys, ppm):
    R, W, rate, d, ws, we = run_cut(ppm); m = json.load(open(d + "/manifest.json")); ck = m["clock"]
    assert abs(ck["samples_per_wall_s"] / rate - 1) < 1e-8                  # within 0.01 ppm of truth
    assert abs(ck["ppm_vs_wall"] - ppm) <= 0.01 and ck["method"] == "idx_least_squares"
    b0 = m["sources"][0]["byte_offset_start"]
    for n, w in ck["anchors"]:                                              # anchor wall time equals the true wall time of that sample
        assert abs(w - (T0 * 10 ** 9 + round((n + b0 // 2) / rate * 1e9))) < 1e6
        assert abs(C.utc_ep(m["window_start_utc"]) * 1e9 + n / ck["samples_per_wall_s"] * 1e9 - w) < 1e6     # and so does the fitted line
    assert len(ck["anchors"]) in (WIN_S // 60 + 1, WIN_S // 60 + 2) and 0 <= ck["anchors"][0][0] < CHUNK
    frames = C.flac_frames(d + "/media/room_orb2.flac"); assert frames == (m["sources"][0]["byte_offset_end"] - b0) // 2
    assert abs(frames - WIN_S * rate) <= 2                                  # flac holds the true tape samples, longer than window x 16000 by the drift
    assert (frames - WIN_S * 16000) > 600 if ppm else abs(frames - WIN_S * 16000) <= 2
    assert check(ist_date(ws)) == 0; assert "clock_frames" in capsys.readouterr().out

def test_check_fails_when_trimmed(run_cut, capsys, tmp_path):
    R, W, rate, d, ws, we = run_cut(6.0); fl = d + "/media/room_orb2.flac"; m = json.load(open(d + "/manifest.json")); n = C.flac_frames(fl)
    subprocess.run(["/usr/bin/ffmpeg", "-y", "-loglevel", "error", "-i", fl, "-af", "atrim=end_sample=%d" % (n - 100), "-c:a", "flac", str(tmp_path / "t.flac")], check=True)
    os.replace(str(tmp_path / "t.flac"), fl); assert C.flac_frames(fl) == n - 100
    m["media_sha256"] = C.sha(fl); m["sources"][0]["byte_offset_end"] -= 200; json.dump(m, open(d + "/manifest.json", "w"))   # only the clock check can object now
    assert check(ist_date(ws)) == 1; out = capsys.readouterr().out; assert "FAIL" in out and "BAD" in out and "sha256_match True" in out

def rows_of(*pairs): return [dict(wall_ns=w, samples=n, byte_offset=2 * n) for w, n in pairs]

def test_two_rows_use_endpoints():
    rate = 16000 * (1 + 6e-6); R = rows_of(*[(10 ** 18 + i * 1000 * 10 ** 9, round(i * 1000 * rate)) for i in range(5)]); W = [r["wall_ns"] for r in R]
    ck = C.clock_of(R, W, 1e9 + 500, 1e9 + 2500, R[1]["byte_offset"])      # window holds exactly rows 1 and 2
    assert ck["method"] == "idx_endpoints" and len(ck["anchors"]) == 2 and abs(ck["samples_per_wall_s"] - rate) < 1e-3

def test_same_wall_ns_gives_null_clock():
    R = rows_of((10 ** 18, 0), (10 ** 18, 16000)); assert C.clock_of(R, [r["wall_ns"] for r in R], 1e9 - 1, 1e9 + 1, 0) is None
    R = rows_of(*[(10 ** 18, 16000 * i) for i in range(5)]); assert C.clock_of(R, [r["wall_ns"] for r in R], 1e9 - 1, 1e9 + 1, 0) is None

# ---- fast checks: jittered idx with irregular chunks, a stub flac that carries only the STREAMINFO frame count
def jittered(ppm, hours, seed):
    import random; rnd = random.Random(seed); rate = 16000 * (1 + ppm * 1e-6); R = []; n = 0; end = (hours * 3600 + 1200) * 16000
    while n <= end:
        R.append(dict(wall_ns=T0 * 10 ** 9 + round(n / rate * 1e9) + rnd.randint(-150_000, 150_000), samples=n, byte_offset=2 * n, rms=0.0)); n += rnd.randint(4000, 12000)
    return R, [r["wall_ns"] for r in R]

def stub_package(tmp, monkeypatch, R, W, ws, we, trim=0):
    out = tmp / "cases"; d = out / "CASE-SYN-1"; (d / "media").mkdir(parents=True); (d / "tracks").mkdir()
    b0, b1 = C.byte_at(R, W, ws), C.byte_at(R, W, we); frames = (b1 - b0) // 2 - trim
    info = (4096).to_bytes(2, "big") * 2 + bytes(6) + ((16000 << 44) | (0 << 41) | (15 << 36) | frames).to_bytes(8, "big") + bytes(16)
    (d / "media" / "room_orb2.flac").write_bytes(b"fLaC" + bytes([0x80, 0, 0, 34]) + info)
    (d / "tracks" / "activity.jsonl").write_text(json.dumps(dict(t_rel_ms=0, t_abs="x")) + "\n"); (d / "meta.json").write_text("{}")
    m = dict(case_id="CASE-SYN-1", ot_room="OT-2", rule_version=C.RULE, booked_start_ist=C.iso(ws, C.IST), sources=[dict(byte_offset_start=b0, byte_offset_end=b1)], gaps=[], provisional=False,
             media_sha256=C.sha(str(d / "media" / "room_orb2.flac")), clock=C.clock_of(R, W, ws, we, b0), window_start_utc=C.iso(ws, C.UTC), window_end_utc=C.iso(we, C.UTC))
    json.dump(m, open(d / "manifest.json", "w")); monkeypatch.setattr(C, "OUT", str(out)); monkeypatch.setattr(C, "ffdur", lambda p: frames / 16000)
    return m

@pytest.mark.parametrize("hours", [1, 3])
@pytest.mark.parametrize("ppm", [6.0, -6.0])
def test_jittered_correct_passes_and_short_fails(tmp_path, monkeypatch, capsys, hours, ppm):
    R, W = jittered(ppm, hours, seed=hours * 100 + int(ppm)); ws, we = T0 + 600, T0 + 600 + hours * 3600
    m = stub_package(tmp_path, monkeypatch, R, W, ws, we); assert abs(m["clock"]["ppm_vs_wall"] - ppm) < 0.1
    assert check(ist_date(ws)) == 0; assert "ok" in capsys.readouterr().out
    import shutil; shutil.rmtree(tmp_path / "cases"); stub_package(tmp_path, monkeypatch, R, W, ws, we, trim=100)
    assert check(ist_date(ws)) == 1; assert "BAD" in capsys.readouterr().out

def test_fractional_window_end_passes(tmp_path, monkeypatch):
    R, W = jittered(6.0, 1, seed=7); ws = T0 + 600; we = ws + 3600.6
    m = stub_package(tmp_path, monkeypatch, R, W, ws, we); assert m["clock"]["window_end_ns"] - m["clock"]["window_start_ns"] == 3600_600_000_000 and check(ist_date(ws)) == 0

def test_null_clock_and_absent_clock_messages(tmp_path, monkeypatch, capsys):
    R, W = jittered(6.0, 1, seed=8); ws, we = T0 + 600, T0 + 4200; stub_package(tmp_path, monkeypatch, R, W, ws, we); mp = str(tmp_path / "cases/CASE-SYN-1/manifest.json"); m = json.load(open(mp))
    m["clock"] = None; json.dump(m, open(mp, "w")); assert check(ist_date(ws)) == 0; assert "clock null (fewer than 2 idx rows in window)" in capsys.readouterr().out
    del m["clock"]; json.dump(m, open(mp, "w")); assert check(ist_date(ws)) == 0; assert "clock block absent (pre-v2.3 package, not checked)" in capsys.readouterr().out
