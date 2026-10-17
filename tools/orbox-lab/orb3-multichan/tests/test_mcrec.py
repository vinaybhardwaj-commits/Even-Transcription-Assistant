import os, sys, json, math, subprocess
import numpy as np, pytest
sys.path.insert(0, os.path.dirname(__file__))
from sim import *
import mcrec

def rms(x): x = np.asarray(x, float); return math.sqrt(float(np.mean(x * x)))


def test_T1_two_mics_48k_and_clap_alignment(tmp_path):
    n = 3 * RATE; rng = np.random.default_rng(1)
    base = 0.1 * np.sin(2 * np.pi * 440 * t_arr(n))
    a = clap(base + 0.01 * rng.standard_normal(n), 72000)
    b = clap(base + 0.01 * rng.standard_normal(n), 72000 + 24)          # 0.5 ms later at the second mic
    s = Sim(tmp_path, [FakeDevice(to_i16(a), "usb3/3-4/3-4:1.0", 0), FakeDevice(to_i16(b), "usb3/3-6/3-6:1.0", 1)])
    s.run(3)
    for p in ("p0", "p1"):
        assert len(s.pcm(p)) == n                                        # 48 kHz s16le mono, 3 s, no resample
        assert all(r["rate_hz"] == 48000 for r in s.idx(p))
    marks = [m for m in s.jl("marks.jsonl") if m["label"] == "clap"]
    assert len(marks) == 1
    so = marks[0]["sample_offset"]
    assert abs(so["p0"] - 72000) <= 1 and abs(so["p1"] - (72000 + 24)) <= 1
    assert marks[0]["byte_offset"]["p0"] == so["p0"] * 2


def test_T2_highpass(tmp_path):
    n = 2 * RATE
    for f, check in ((40, lambda db: db <= -10), (1000, lambda db: abs(db) <= 0.5)):
        sub = tmp_path / str(f); sub.mkdir()
        x = 0.2 * np.sin(2 * np.pi * f * t_arr(n))
        s = Sim(sub, [FakeDevice(to_i16(x), "usb3/3-4/3-4:1.0", 0)]); s.run(2)
        y = s.pcm("p0")[RATE // 2:]
        db = 20 * math.log10(rms(y) / rms(to_i16(x)[RATE // 2:]))
        assert check(db), (f, db)


def test_T3_infra_meter(tmp_path):
    x = 0.3 * np.sin(2 * np.pi * 10 * t_arr(4 * RATE))
    s = Sim(tmp_path, [FakeDevice(to_i16(x), "usb3/3-4/3-4:1.0", 0)]); s.run(4)
    r = s.idx("p0")[-1]
    assert r["infra_rms"] > 0.15 and r["rms"] < 0.02, r


def test_T4_drift_reported_within_2ppm(tmp_path):
    n = 80 * RATE
    s = Sim(tmp_path, [FakeDevice(to_i16(np.zeros(n)), "usb3/3-4/3-4:1.0", 0, ppm=40.0), FakeDevice(to_i16(np.zeros(n)), "usb3/3-6/3-6:1.0", 1, ppm=0.0)], hpf=False)
    s.run(78)
    assert abs(s.idx("p0")[-1]["drift_ppm"] - 40) <= 2
    assert abs(s.idx("p1")[-1]["drift_ppm"]) <= 2
    ev = [e for e in s.jl("events.jsonl") if e["kind"] == "drift" and e["place"] == "p0"]
    assert len(ev) == 1 and abs(ev[0]["ppm"] - 40) <= 2                  # logged every 60 s


def test_T5_device_drop_and_resume(tmp_path):
    n = 30 * RATE; z = to_i16(np.zeros(n))
    s = Sim(tmp_path, [FakeDevice(z, "usb3/3-4/3-4:1.0", 0), FakeDevice(z, "usb3/3-6/3-6:1.0", 1, down=(5.0, 15.0))], hpf=False)
    s.run(29)
    ok = s.idx("p0")
    assert len(s.pcm("p0")) == 29 * RATE and all(r["frames"] == RATE for r in ok)
    assert all(abs((b["wall_ns"] - a["wall_ns"]) / 1e9 - 1) < 1e-6 for a, b in zip(ok, ok[1:]))
    gaps = [e for e in s.jl("events.jsonl") if e["kind"] == "gap"]
    assert [g["place"] for g in gaps] == ["p1"]
    assert 9.9 <= gaps[0]["gap_s"] <= 12.3
    assert abs(len(s.pcm("p1")) - (29 * RATE - gaps[0]["gap_s"] * RATE)) <= 1
    assert s.idx("p1")[-1]["wall_ns"] > BASE_WALL + 20e9                  # resumed
    assert [e["kind"] for e in s.jl("events.jsonl") if e.get("place") == "p1" and e["kind"] in ("drop", "reopen")] == ["drop", "reopen"]


def test_T6_gain_refused_above_41_and_read_back(tmp_path):
    with pytest.raises(mcrec.ConfigError):
        mcrec.load_config(dict(out_dir=str(tmp_path), mics=[dict(place="corner", port="x", gain=50)]))
    fm = FakeMixer()
    with pytest.raises(mcrec.ConfigError): mcrec.Mixer(fm.run).set(0, 50)
    assert fm.calls == []                                                 # nothing sent to the device
    s = Sim(tmp_path, [FakeDevice(to_i16(np.zeros(RATE)), "usb3/3-4/3-4:1.0", 3)]); s.run(1)
    assert s.mixer.calls == [(3, 41)]
    g = [e for e in s.jl("events.jsonl") if e["kind"] == "gain"][0]
    assert g["set"] == 41 and g["read_back"] == 41


def test_resolve_port_by_usb_path(tmp_path):
    usb = tmp_path / "devices/pci/usb3/3-4/3-4:1.0"; usb2 = tmp_path / "devices/pci/usb3/3-6/3-6:1.0"
    cls = tmp_path / "class/sound"
    for i, u in ((0, usb2), (1, usb)):                                    # plug order swapped on purpose
        u.mkdir(parents=True); (cls / f"card{i}").mkdir(parents=True); os.symlink(u, cls / f"card{i}" / "device")
    assert mcrec.resolve_port("usb3/3-4/3-4:1.0", str(cls)) == 1
    assert mcrec.resolve_port("/usb3/3-6/3-6:1.0", str(cls)) == 0
    with pytest.raises(mcrec.DeviceMissing): mcrec.resolve_port("usb3/3-5/3-5:1.0", str(cls))


def test_mark_cli_appends_offsets(tmp_path):
    s = Sim(tmp_path, [FakeDevice(to_i16(np.zeros(2 * RATE)), "usb3/3-4/3-4:1.0", 0)]); s.run(2)
    cfgp = tmp_path / "c.json"; json.dump(s.cfg, open(cfgp, "w"))
    mcrec.main(["mark", "--config", str(cfgp), "wheel in"])
    m = s.jl("marks.jsonl")[-1]
    assert m["label"] == "wheel in" and m["byte_offset"]["p0"] == 2 * RATE * 2 and m["wall_ns"] and m["mono_ns"]


# ---- package tests: seeded white noise (a periodic sine cannot reveal a whole-second shift); hpf off so the flac equals the source

def _pkg(tmp_path, s, a, b, name):
    import datetime as dt
    ist0 = dt.datetime.fromtimestamp(BASE_WALL / 1e9, mcrec.IST); fmt = "%Y-%m-%d %H:%M:%S"
    cfgp = tmp_path / "c.json"; json.dump(s.cfg, open(cfgp, "w")); out = tmp_path / name
    mcrec.main(["package", "--config", str(cfgp), "--from", (ist0 + dt.timedelta(seconds=a)).strftime(fmt), "--to", (ist0 + dt.timedelta(seconds=b)).strftime(fmt), "--out", str(out)])
    return out, json.load(open(out / "manifest.json"))

def _dec(out, p):
    return np.frombuffer(subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(out / "media" / f"{p}.flac"), "-f", "s16le", "-ar", "48000", "-ac", "1", "-"],
                                        capture_output=True, check=True).stdout, dtype="<i2")

def _lag0(x, ref):
    """cross-correlate x against the source; assert the peak is at lag 0 (zero-filled regions contribute nothing)."""
    n = 1 << int(np.ceil(np.log2(len(x) + len(ref))))
    c = np.fft.irfft(np.fft.rfft(x.astype(float), n) * np.conj(np.fft.rfft(ref.astype(float), n)), n)
    lag = int(np.argmax(c)); lag = lag - n if lag > n // 2 else lag
    assert lag == 0, lag

def _check_aligned(out, p, src, a_s, zero_spans):
    """flac == source[a_s:] sample for sample, except digital zeros inside zero_spans (seconds, relative to the source)."""
    x = _dec(out, p); ref = src[int(a_s * RATE):int(a_s * RATE) + len(x)].copy(); z = np.zeros(len(x), bool)
    for u, v in zero_spans: z[int(round((u - a_s) * RATE)):int(round((v - a_s) * RATE))] = True
    assert not x[z].any() and np.array_equal(x[~z], ref[~z]), p
    _lag0(x, ref)
    return x

def _mics(): return [dict(place="corner", port="usb3/3-4/3-4:1.0", gain=41), dict(place="high", port="usb3/3-6/3-6:1.0", gain=41)]


def test_T7_package_shape_and_flac_duration(tmp_path):
    rec = tmp_path / "rec"; rec.mkdir(); src = to_i16(noise(8 * RATE)); mics = _mics()
    s = Sim(rec, [FakeDevice(src, mics[0]["port"], 0), FakeDevice(src, mics[1]["port"], 1)], mics=mics); s.run(8)
    out, man = _pkg(tmp_path, s, 2, 6, "pkg")
    assert sorted(os.listdir(out)) == ["manifest.json", "media", "meta.json", "tracks"]
    assert sorted(os.listdir(out / "media")) == ["corner.flac", "high.flac"]
    assert sorted(os.listdir(out / "tracks")) == ["environment.jsonl", "transcript.jsonl"]
    assert os.path.getsize(out / "tracks" / "transcript.jsonl") == 0
    meta = json.load(open(out / "meta.json"))
    assert meta["SIMULATED"] is False and set(meta) == {"window_start_ist", "window_end_ist", "window_start_utc", "window_end_utc", "SIMULATED"}
    assert man["sample_rate"] == 48000 and [c["place"] for c in man["channels"]] == ["corner", "high"] and man["gaps"] == []
    assert man["channels"][0]["port_path"] == mics[0]["port"] and man["channels"][0]["gain_read_back"] == 41
    assert len(open(out / "tracks" / "environment.jsonl").read().splitlines()) >= 6
    for p in ("corner", "high"): assert abs(len(_dec(out, p)) - 4 * RATE) <= 1


def test_O20_package_zero_fills_gaps(tmp_path):
    rec = tmp_path / "rec"; rec.mkdir(); src = to_i16(noise(30 * RATE)); mics = _mics()
    s = Sim(rec, [FakeDevice(src, mics[0]["port"], 0), FakeDevice(src, mics[1]["port"], 1, down=(5.0, 15.0))], mics=mics, hpf=False); s.run(28)
    out, man = _pkg(tmp_path, s, 2, 25, "pkg")
    assert len(_dec(out, "corner")) == len(_dec(out, "high")) == 23 * RATE
    g = [e for e in s.jl("events.jsonl") if e["kind"] == "gap"][0]
    za, zb = (g["wall_start_ns"] - BASE_WALL) / 1e9, (g["wall_end_ns"] - BASE_WALL) / 1e9
    _check_aligned(out, "corner", src, 2, []); _check_aligned(out, "high", src, 2, [(za, zb)])
    assert len(s.pcm("high")) < 28 * RATE                               # raw pcm stays unpadded
    assert [(x["place"], x["zero_filled"], x["cause"]) for x in man["gaps"]] == [("high", True, "drop")]
    assert abs(man["gaps"][0]["gap_s"] - (zb - za)) < 0.01


def test_O22_dropped_and_never_returned_gets_open_ended_gap(tmp_path):
    rec = tmp_path / "rec"; rec.mkdir(); src = to_i16(noise(30 * RATE)); mics = _mics()
    s = Sim(rec, [FakeDevice(src, mics[0]["port"], 0), FakeDevice(src, mics[1]["port"], 1, down=(10.0, 999.0))], mics=mics, hpf=False); s.run(28)
    out, man = _pkg(tmp_path, s, 2, 25, "pkg")
    assert len(man["gaps"]) == 1
    g = man["gaps"][0]
    assert g["place"] == "high" and g["open_ended"] is True and g["zero_filled"] is True and g["cause"] == "drop"
    assert g["wall_end_ns"] == BASE_WALL + 25 * 10**9 and 14.9 <= g["gap_s"] <= 15.2
    _check_aligned(out, "high", src, 2, [(9.9, 25.0)]); _check_aligned(out, "corner", src, 2, [])


def test_O22b_recorder_restart_closes_open_drop(tmp_path):
    rec = tmp_path / "rec"; rec.mkdir(); src = to_i16(noise(40 * RATE)); mics = _mics()
    s = Sim(rec, [FakeDevice(src, mics[0]["port"], 0), FakeDevice(src, mics[1]["port"], 1, down=(10.0, 20.05))], mics=mics, hpf=False)
    s.run(20); s.restart(20.0); s.run(35, start=20.0)
    out, man = _pkg(tmp_path, s, 22, 30, "later"); assert man["gaps"] == []          # window after the restart: no gap
    out, man = _pkg(tmp_path, s, 2, 30, "across")
    assert [(g["place"], g["cause"], g["open_ended"]) for g in man["gaps"]] == [("high", "drop", False)]
    assert man["gaps"][0]["wall_end_ns"] == BASE_WALL + 20 * 10**9


def test_G1_drop_restart_later_drop_both_listed(tmp_path):
    rec = tmp_path / "rec"; rec.mkdir(); src = to_i16(noise(45 * RATE)); mics = _mics()
    s = Sim(rec, [FakeDevice(src, mics[0]["port"], 0), FakeDevice(src, mics[1]["port"], 1, down=[(10.0, 20.05), (30.0, 34.0)])], mics=mics, hpf=False)
    s.run(20); s.restart(20.0); s.run(40, start=20.0)
    out, man = _pkg(tmp_path, s, 2, 38, "pkg")
    gs = sorted((g["wall_start_ns"] - BASE_WALL) / 1e9 for g in man["gaps"])
    assert len(gs) == 2 and abs(gs[0] - 9.9) < 0.01 and abs(gs[1] - 29.9) < 0.01 and {g["place"] for g in man["gaps"]} == {"high"}
    _check_aligned(out, "high", src, 2, [(9.9, 20.0), (29.9, 33.9)]); _check_aligned(out, "corner", src, 2, [])


def test_G2_whole_recorder_down_18_to_20(tmp_path):
    rec = tmp_path / "rec"; rec.mkdir(); src = to_i16(noise(40 * RATE)); mics = _mics()
    s = Sim(rec, [FakeDevice(src, mics[0]["port"], 0), FakeDevice(src, mics[1]["port"], 1)], mics=mics, hpf=False)
    s.run(18); s.restart(20.0); s.run(35, start=20.0)
    out, man = _pkg(tmp_path, s, 2, 30, "pkg")
    for p in ("corner", "high"): _check_aligned(out, p, src, 2, [(18.0, 20.0)])
    assert sorted((g["place"], g["cause"]) for g in man["gaps"]) == [("corner", "restart"), ("high", "restart")]
    assert all(abs(g["gap_s"] - 2.0) < 0.01 and g["zero_filled"] for g in man["gaps"])


def test_G3_one_mic_down_until_restart_stays_aligned(tmp_path):
    rec = tmp_path / "rec"; rec.mkdir(); src = to_i16(noise(40 * RATE)); mics = _mics()
    s = Sim(rec, [FakeDevice(src, mics[0]["port"], 0), FakeDevice(src, mics[1]["port"], 1, down=(10.0, 20.05))], mics=mics, hpf=False)
    s.run(20); s.restart(20.0); s.run(35, start=20.0)
    out, man = _pkg(tmp_path, s, 2, 30, "pkg")
    # corner keeps recording only until the restart, then resumes at 20 s: its 20 s boundary is continuous (no gap)
    _check_aligned(out, "high", src, 2, [(9.9, 20.0)]); _check_aligned(out, "corner", src, 2, [])
    assert len(_dec(out, "corner")) == len(_dec(out, "high")) == 28 * RATE
    assert [(g["place"], g["cause"]) for g in man["gaps"]] == [("high", "drop")]
