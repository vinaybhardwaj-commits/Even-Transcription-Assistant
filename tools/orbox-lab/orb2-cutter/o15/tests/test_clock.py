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

def test_two_rows_use_endpoints():
    R = [dict(wall_ns=10 ** 18 + i * 10 ** 9, samples=16000 * i, byte_offset=32000 * i) for i in range(3)]
    ck = C.clock_of(R, [r["wall_ns"] for r in R], 10 ** 9, 2 * 10 ** 9, 0); assert ck is None or ck["method"] in ("idx_endpoints", "idx_least_squares")
