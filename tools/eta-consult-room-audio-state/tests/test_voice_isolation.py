"""audio-13: voice_isolation_gated (macOS 26 Voice Isolation: exact-zero background between speech bursts)."""
import numpy as np
from ras import classify as cl, zeros

T0 = cl.parse_ts("2026-10-06T04:00:00Z")
SR = zeros.SR


def sig(kind, secs=60, seed=0):
    """int16 test signals. gated_speech: speech bursts (peak ~0.1) separated by exact zero; zero_fill: all zero;
    floor: a normal room floor (noise ~0.003) with speech bursts; floor_only: noise only."""
    rng = np.random.default_rng(seed)
    n = SR * secs
    a = np.zeros(n, dtype=np.int16)
    burst = lambda lo, hi: a.__setitem__(slice(int(lo * SR), int(hi * SR)), (rng.normal(0, 3000, int((hi - lo) * SR))).astype(np.int16))
    if kind == "gated_speech":
        for lo in range(5, secs - 5, 15):
            burst(lo, lo + 4)
    elif kind == "zero_fill":
        pass
    elif kind == "floor":
        a = (rng.normal(0, 100, n)).astype(np.int16)
        for lo in range(5, secs - 5, 15):
            burst(lo, lo + 4)
    elif kind == "floor_only":
        a = (rng.normal(0, 100, n)).astype(np.int16)
    elif kind == "one_click":
        a[SR:SR + 200] = 5000
    return a


def chunk(kind, **kw):
    g, s, n = zeros.vi_bins(sig(kind, **kw))
    return {"id": "c", "session": "s", "start": T0, "end": T0 + 60, "dur": 60.0, "manifest_ms": 60000, "lo_frac": 0.0,
            "clip_frac": 0.0, "zero_frac": 0.0, "runs": [], "vi": {"g": g, "s": s, "n": n}}


def test_gated_frames_between_speech_is_voice_isolation():
    c = chunk("gated_speech")
    ev = cl.vi_chunk(c)
    assert ev and ev["gated_share_of_nonspeech"] > 0.9 and ev["speech_s"] > 10


def test_pure_zero_fill_is_not_voice_isolation():
    assert cl.vi_chunk(chunk("zero_fill")) is None


def test_normal_room_floor_is_not_voice_isolation():
    assert cl.vi_chunk(chunk("floor")) is None
    assert cl.vi_chunk(chunk("floor_only")) is None


def test_a_single_click_in_zero_fill_is_not_voice_isolation():
    assert cl.vi_chunk(chunk("one_click")) is None


def test_chunk_without_vi_counts_is_never_flagged():
    c = chunk("gated_speech")
    c["vi"] = None
    assert cl.vi_chunk(c) is None


def test_frame_thresholds():
    a = np.zeros(SR * 2, dtype=np.int16)
    a[:960] = 65 * np.ones(960, dtype=np.int16)          # peak 65 < 0.002: gated only if the frame is >= 95% zero (it is not)
    a[960:1920] = 0
    a[960:960 + 40] = 5                                    # 40/960 nonzero: zero_ratio .958 >= .95, peak 5 -> gated
    a[1920:2880] = 328                                     # peak 328 >= 0.01 -> speech
    g, s, n = zeros.vi_bins(a)
    assert (g[0], s[0]) == (48, 1) and n == [50, 50]   # frame 0 (peak 65, not 95% zero) is neither; frame 2 is speech


def test_classify_room_labels_only_enabled_rooms_and_splits_where_the_signature_ends():
    cs = []
    for i, kind in enumerate(["gated_speech", "gated_speech", "floor"]):
        c = chunk(kind)
        c["id"], c["start"], c["end"] = f"c{i}", T0 + 60 * i, T0 + 60 * (i + 1)
        cs.append(c)
    day = cl.ist_day(T0)
    on = cl.classify_room(cs, first_day=day, last_day=day, vi_enabled=True)
    states = [(i["state"], round(i["_b"] - i["_a"])) for i in on if i["state"] != "recorder_off"]
    assert states == [("voice_isolation_gated", 120), ("audio_present", 60)]
    vi = next(i for i in on if i["state"] == "voice_isolation_gated")
    assert vi["evidence"]["gated_reason"] == ["voice_isolation"] and vi["evidence"]["vi_chunks"] == 2
    off = cl.classify_room(cs, first_day=day, last_day=day, vi_enabled=False)
    assert all(i["state"] != "voice_isolation_gated" for i in off)
    assert abs(sum(i["_b"] - i["_a"] for i in on) - 86400) < 1e-6


def test_neon_writes_voice_isolation_as_audio_gated_with_detail():
    import ras_write
    cs = []
    for i in range(2):
        c = chunk("gated_speech")
        c["id"], c["start"], c["end"] = f"c{i}", T0 + 60 * i, T0 + 60 * (i + 1)
        cs.append(c)
    day = cl.ist_day(T0)
    ivs = cl.classify_room(cs, first_day=day, last_day=day, vi_enabled=True)
    rd = ras_write.build_room_days({"r": ivs}, {}, {}, {"r": "opd-4-x"})[0]
    states = {row[4] for row in rd["rows"]}
    assert "voice_isolation_gated" not in states and "audio_gated" in states
    assert any('"state_detail":"voice_isolation_gated"' in row[7] for row in rd["rows"])
    assert rd["day"]["min_gated"] == 2 and sum(rd["day"][c] for c in ras_write.DAY_COLS) == 1440


def test_hosts_config_is_opd4_and_opd5():
    from ras.hosts import macos26_rooms
    assert macos26_rooms() == {"room_ux92qpws", "room_4ggnkg5x"}
