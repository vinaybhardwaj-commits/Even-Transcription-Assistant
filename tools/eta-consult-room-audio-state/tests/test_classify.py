from ras.classify import build_chunks, classify_room, gated_decision, annotate_session_end, day_start_ts
from ras.zeros import analyse, runs
import numpy as np

T0 = "2026-10-03T04:00:00.000Z"
from datetime import datetime, timedelta, timezone


def ts(off):
    return (datetime(2026, 10, 3, 4, 0, tzinfo=timezone.utc) + timedelta(seconds=off)).isoformat().replace("+00:00", "Z")


def chunk(i, off, dur=300.0, sess="s1", lo=0.01, zruns=(), manifest_ms=None):
    r = {"id": f"c{i}", "session_id": sess, "started_at": ts(off), "duration_ms": manifest_ms or round(dur * 1000)}
    f = {"id": f"c{i}", "decoded_ms": round(dur * 1000), "lo_frac": lo, "zero_frac": lo, "runs": [list(x) for x in zruns]}
    return r, f


def mk(specs):
    rows, feats = [], {}
    for r, f in specs:
        rows.append(r)
        feats[r["id"]] = f
    return build_chunks(rows, feats)


def states(ivs):
    """Intervals inside the data span (the day's leading/trailing recorder_off fill is dropped)."""
    out = [(iv["state"], round(iv["_b"] - iv["_a"])) for iv in ivs]
    while out and out[0][0] == "recorder_off":
        out.pop(0)
    while out and out[-1][0] == "recorder_off":
        out.pop()
    return out


def total_min(ivs):
    return sum(iv["_b"] - iv["_a"] for iv in ivs) / 60


def old_history(n=200, start=None, **kw):
    """n clean chunks in the 7 days before the test day (T0 = 04:00Z 3 Oct = 09:30 IST)."""
    start = -34200 - n * 300 - 3600 if start is None else start     # ends 1 h before 00:00 IST of 3 Oct
    return [chunk(1000 + i, start + i * 300, **kw) for i in range(n)]


def day3(ivs):
    return [iv for iv in ivs if iv["ist_day"] == "2026-10-03"]


def test_zero_runs_eps1():
    a = np.array([0, 1, -1, 0, 5, 0, 0], dtype=np.int16)
    assert runs(np.abs(a.astype(int)) <= 1, 2) == [(0, 4), (5, 2)]
    assert analyse(np.zeros(48000, dtype=np.int16))["max_run_s"] == 1.0


def test_audio_present_only():
    ivs = classify_room(mk([chunk(0, 0), chunk(1, 300)]))
    assert states(ivs) == [("audio_present", 600)]


def test_muted_inside_full_chunks():
    ivs = day3(classify_room(mk(old_history() + [chunk(0, 0, zruns=[(100, 20)]), chunk(1, 300)])))
    assert states(ivs) == [("audio_present", 100), ("muted", 20), ("audio_present", 480)]


def test_short_run_not_muted():
    assert states(day3(classify_room(mk(old_history() + [chunk(0, 0, zruns=[(100, 9)])])))) == [("audio_present", 300)]


def test_mute_joined_across_chunk_boundary():
    ivs = day3(classify_room(mk(old_history() + [chunk(0, 0, zruns=[(295, 5)]), chunk(1, 300, zruns=[(0, 8)])] + [chunk(i, 300 * i) for i in range(2, 80)])))
    assert ("muted", 13) in states(ivs)


def test_unplug_signature_is_now_recorder_off_never_device_missing():
    ch = [chunk(0, 0, dur=100, manifest_ms=100000, zruns=[(98, 2)]), chunk(1, 130, sess="s2")]
    st = states(classify_room(mk(ch)))
    assert st == [("audio_present", 100), ("recorder_off", 30), ("audio_present", 300)]


def test_gap_without_zero_tail_is_recorder_off():
    ch = [chunk(0, 0, dur=100, manifest_ms=100000), chunk(1, 130, sess="s2")]
    assert ("recorder_off", 30) in states(classify_room(mk(ch)))


def test_no_device_missing_state_ever():
    ch = [chunk(0, 0, dur=100, manifest_ms=100000, zruns=[(98, 2)]), chunk(1, 105.4, sess="s1")]
    assert "device_missing" not in [iv["state"] for iv in classify_room(mk(ch))]


def test_fleet_wide_stop_session_end_evidence():
    def room(offset):
        cs = mk([chunk(0, offset - 300, dur=300), chunk(1, 5000, sess="s2")])
        return cs, classify_room(cs)
    per = {"a": room(0), "b": room(30), "c": room(-60), "d": room(4000)}
    annotate_session_end(per)
    off = lambda r: [iv for iv in per[r][1] if iv["state"] == "recorder_off" and iv["evidence"].get("session_end")]
    assert off("a")[0]["evidence"]["session_end"]["fleet_wide"] is True
    assert off("a")[0]["evidence"]["session_end"]["other_rooms_stopping_within_2min"] == 2
    assert off("d")[0]["evidence"]["session_end"]["fleet_wide"] is False


def test_dead_day_then_gap_still_gets_recorder_off():
    ch = [chunk(i, 300 * i, lo=1.0, zruns=[(0, 300)]) for i in range(3)] + \
         [chunk(3 + i, 3000 + 300 * i, lo=1.0, zruns=[(0, 300)]) for i in range(2)]
    st = states(classify_room(mk(ch)))
    assert st == [("zero_all_day", 900), ("recorder_off", 2100), ("zero_all_day", 600)]


def test_every_day_sums_to_1440_including_empty_day():
    day = 86400
    ch = [chunk(0, 0), chunk(1, 300), chunk(2, 2 * day), chunk(3, 2 * day + 300, lo=0.2, zruns=[(10, 40)])]
    ivs = classify_room(mk(ch), snapshot_end=None)
    by = {}
    for iv in ivs:
        by[iv["ist_day"]] = by.get(iv["ist_day"], 0) + (iv["_b"] - iv["_a"]) / 60
    assert sorted(by) == ["2026-10-03", "2026-10-04", "2026-10-05"]       # middle day has no chunks
    assert all(abs(v - 1440) < 1e-6 for v in by.values())
    mid = [iv for iv in ivs if iv["ist_day"] == "2026-10-04"]
    assert [iv["state"] for iv in mid] == ["recorder_off"]


def test_overlapping_and_jittery_chunks_still_tile_exactly():
    ch = [chunk(0, 0, dur=300), chunk(1, 299.5, dur=300), chunk(2, 601, dur=300)]
    ivs = classify_room(mk(ch))
    assert abs(total_min(ivs) - 1440) < 1e-6
    for p, n in zip(ivs, ivs[1:]):
        assert abs(p["_b"] - n["_a"]) < 1e-6


def test_snapshot_tail_flagged_unobserved():
    ch = [chunk(0, 0), chunk(1, 300)]
    ivs = classify_room(mk(ch))
    assert ivs[-1]["state"] == "recorder_off" and ivs[-1]["evidence"]["after_snapshot"] is True
    assert abs(total_min(ivs) - 1440) < 1e-6


def test_possible_dead_flag_on_midday_mute_reaching_day_end():
    hist = old_history(200)
    ch = [chunk(0, 0), chunk(1, 300, zruns=[(0, 300)], lo=1.0)] + [chunk(2 + i, 600 + 300 * i, zruns=[(0, 300)], lo=1.0) for i in range(9)]
    ivs = [iv for iv in classify_room(mk(hist + ch)) if iv["ist_day"] == "2026-10-03" and iv["state"] == "muted"]
    assert ivs and ivs[0]["evidence"]["possible_dead"] is True


def test_short_mute_between_audio_has_no_possible_dead():
    hist = old_history(200)
    ch = [chunk(0, 0, zruns=[(100, 20)]), chunk(1, 300)]
    iv = [i for i in classify_room(mk(hist + ch)) if i["state"] == "muted" and i["ist_day"] == "2026-10-03"][0]
    assert iv["evidence"]["possible_dead"] is False


def test_clipping_frac_on_audio_present():
    r, f = chunk(0, 0)
    f["clip_frac"] = 0.02
    ap = [i for i in classify_room(mk([(r, f)])) if i["state"] == "audio_present"][0]
    assert ap["evidence"]["clipping_frac"] == 0.02


def test_zero_all_day_whole_day():
    ch = [chunk(i, 300 * i, lo=1.0, zruns=[(0, 300)]) for i in range(4)]
    assert states(classify_room(mk(ch))) == [("zero_all_day", 1200)]


def test_partial_zero_day_is_muted_not_dead():
    ch = [chunk(0, 0, lo=1.0, zruns=[(0, 300)]), chunk(1, 300), chunk(2, 600), chunk(3, 900)]
    st = [s for s, _ in states(classify_room(mk(ch)))]
    assert "muted" in st and "zero_all_day" not in st


def test_gated_room_needs_60s():
    hist = old_history(200, zruns=[(10, 5)])        # prior week: gated mic
    ch = [chunk(0, 0, zruns=[(100, 20)])]
    ivs = classify_room(mk(hist + ch))
    assert all(iv["state"] != "muted" for iv in day3(ivs))
    assert gated_decision(mk(hist), day_start_ts("2026-10-03"))["gated"] is True
    ch2 = [chunk(0, 0, zruns=[(10, 90)])]
    day = [iv for iv in classify_room(mk(hist + ch2)) if iv["ist_day"] == "2026-10-03"]
    assert ("muted", 90) in states(day)


def test_gate_decision_ignores_current_and_later_data():
    hist = old_history(200)                         # clean history -> not gated
    d0 = gated_decision(mk(hist), day_start_ts("2026-10-03"))
    later = [chunk(5000 + i, i * 300, zruns=[(10, 5)]) for i in range(300)]   # gate-like data ON/after the day
    d1 = gated_decision(mk(hist + later), day_start_ts("2026-10-03"))
    assert d0 == d1 and d0["gated"] is False and d0["decision"] == "rolling_7d"
    # the day's own labels are identical with or without the later gate-like chunks
    mine = [chunk(0, 0, zruns=[(100, 20)])]
    a = day3(classify_room(mk(hist + mine)))
    b = day3(classify_room(mk(hist + mine + [chunk(7000 + i, 90000 + i * 300, zruns=[(10, 5)]) for i in range(300)])))
    assert [(x["state"], x["ts_start"], x["ts_end"]) for x in a] == [(x["state"], x["ts_start"], x["ts_end"]) for x in b]
    assert ("muted", 20) in states(a)


def test_insufficient_history_is_conservative_and_recorded():
    d = gated_decision(mk([chunk(0, 0)]), day_start_ts("2026-10-03"))
    assert d["decision"] == "insufficient_history" and d["gated"] is True


def test_evidence_fields():
    iv = [i for i in day3(classify_room(mk(old_history() + [chunk(0, 0, zruns=[(100, 20)])]))) if i["state"] == "muted"][0]
    ev = iv["evidence"]
    assert ev["zero_frac"] == 1.0 and ev["max_zero_run_s"] == 20 and ev["chunk_ids"] == ["c0"] and ev["segment"] == ["s1"]


DAY = 86400


def test_room_that_went_dark_is_tiled_through_snapshot_day():
    ivs = classify_room(mk([chunk(0, 0), chunk(1, 300)]), last_day="2026-10-06")
    by = {}
    for iv in ivs:
        by.setdefault(iv["ist_day"], []).append(iv)
    assert sorted(by) == ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"]
    for d in ("2026-10-04", "2026-10-05", "2026-10-06"):
        assert [(i["state"], round((i["_b"] - i["_a"]) / 60)) for i in by[d]] == [("recorder_off", 1440)]
        assert by[d][0]["evidence"]["after_snapshot"] is True


def test_first_day_before_first_chunk_is_tiled():
    ivs = classify_room(mk([chunk(0, 2 * DAY)]), first_day="2026-10-03")
    assert sorted({i["ist_day"] for i in ivs}) == ["2026-10-03", "2026-10-04", "2026-10-05"]
    assert abs(total_min(ivs) - 3 * 1440) < 1e-6


def test_blind_day_is_one_withheld_interval_with_no_features():
    ch = [chunk(0, 0), chunk(1, 300), chunk(2, 2 * DAY)]
    ivs = classify_room(mk(ch), blind_days={"2026-10-04"}, first_day="2026-10-03", last_day="2026-10-05")
    w = [i for i in ivs if i["ist_day"] == "2026-10-04"]
    assert len(w) == 1 and w[0]["state"] == "withheld" and round((w[0]["_b"] - w[0]["_a"]) / 60) == 1440
    assert w[0]["evidence"] == {"reason": "blind_holdout"}
    assert abs(total_min(ivs) - 3 * 1440) < 1e-6


def test_chunk_crossing_into_blind_day_is_clipped():
    c = chunk(0, DAY - 34200 - 100, dur=300)               # 100 s before midnight IST, 200 s into 4 Oct
    ivs = classify_room(mk([c]), blind_days={"2026-10-04"}, first_day="2026-10-03", last_day="2026-10-04")
    w = [i for i in ivs if i["ist_day"] == "2026-10-04"]
    assert [i["state"] for i in w] == ["withheld"] and abs(total_min(ivs) - 2 * 1440) < 1e-6


def test_same_session_restart_is_tagged_and_never_session_end():
    def room(restart):
        cs = mk([chunk(0, 0, dur=300), chunk(1, 305.4, dur=300, sess="s1" if restart else "s2")])
        return cs, classify_room(cs)
    per = {"a": room(True), "b": room(True), "c": room(True)}
    annotate_session_end(per)
    for r in per.values():
        off = [i for i in r[1] if i["state"] == "recorder_off" and i["_b"] - i["_a"] < 30]
        assert off and off[0]["evidence"]["restart"] is True and "session_end" not in off[0]["evidence"]


def test_restart_gaps_do_not_make_other_rooms_fleet_wide():
    def long_stop(off):
        cs = mk([chunk(0, off - 300, dur=300), chunk(1, 5000, sess="s2")])
        return cs, classify_room(cs)
    def restarter(off):
        cs = mk([chunk(0, off - 300, dur=300), chunk(1, off + 5, dur=300)])
        return cs, classify_room(cs)
    per = {"a": long_stop(0), "r1": restarter(10), "r2": restarter(-20), "r3": restarter(30)}
    annotate_session_end(per)
    se = [i for i in per["a"][1] if i["evidence"].get("session_end")][0]["evidence"]["session_end"]
    assert se["other_rooms_stopping_within_2min"] == 0 and se["fleet_wide"] is False


def test_data_edge_never_sets_fleet_wide():
    per = {}
    for k, name in enumerate("abcde"):
        cs = mk([chunk(0, 0, dur=300), chunk(1, 300 + k, dur=300)])     # every room's data ends together
        per[name] = (cs, classify_room(cs))
    annotate_session_end(per)
    assert all("session_end" not in i["evidence"] for _, ivs in per.values() for i in ivs)


def test_per_room_cutoff_flags_tail_not_global_snapshot():
    late = mk([chunk(0, 0), chunk(1, 300), chunk(2, 600)])
    early = mk([chunk(0, 0)])
    ivs = classify_room(early, cutoff=early[-1]["end"])
    tail = [i for i in ivs if i["state"] == "recorder_off"][-1]
    assert tail["evidence"]["after_snapshot"] and abs(tail["_a"] - early[-1]["end"]) < 1e-6
    assert tail["evidence"]["room_last_chunk_end"]


def test_no_slivers_or_zero_length_intervals():
    blips = [(100, 15), (115.1, 15), (130.2, 14.8), (145.1, 0.05 + 5)]
    ch = [chunk(0, 0, zruns=blips)]
    ivs = classify_room(mk(old_history() + ch))
    for iv in ivs:
        assert iv["_b"] - iv["_a"] >= 1.0, iv
    assert abs(total_min(day3(ivs)) - 1440) < 1e-6


def test_gate_catches_first_day_of_gating_without_history():
    """Clean history (so rolling_7d says not gated), then the mic starts gating: runs of 12-20 s separated by blips."""
    hist = old_history(200)
    runs, t = [], 10.0
    for k in range(8):
        runs.append((t, 12 + k))
        t += 12 + k + 0.15
    ch = [chunk(i, 300 * i, zruns=[(a, l) for a, l in runs if a < 280]) for i in range(40)]
    d = gated_decision(mk(hist), day_start_ts("2026-10-03"))
    assert d["gated"] is False                       # the lag the Refuter saw
    ivs = day3(classify_room(mk(hist + ch)))
    assert all(iv["state"] != "muted" for iv in ivs)


def test_true_mute_without_blips_still_muted_after_cluster_rule():
    hist = old_history(200)
    ivs = day3(classify_room(mk(hist + [chunk(0, 0, zruns=[(100, 25)])])))
    assert ("muted", 25) in states(ivs)


def test_gate_onset_with_real_audio_between_runs_no_false_mutes():
    """The OPD 5 2 Oct pattern: clean history, then 10-20 s zero runs separated by seconds of audio."""
    hist = old_history(200)
    zr, t = [], 5.0
    for k in range(6):                              # the gate has been chattering with short runs first
        zr.append((t, 4.0))
        t += 4.0 + 3.0
    for k in range(10):
        zr.append((t, 11 + k))
        t += 11 + k + 3.0
    ch = [chunk(i, 300 * i, zruns=[(a, l) for a, l in zr if a + l < 299]) for i in range(30)]
    assert gated_decision(mk(hist), day_start_ts("2026-10-03"))["gated"] is False
    assert all(iv["state"] != "muted" for iv in day3(classify_room(mk(hist + ch))))


def test_real_mute_in_gate_active_room_needs_300s():
    hist = old_history(200)
    zr = [(5 + 14 * k, 8) for k in range(5)]        # five 8 s runs = gate activity
    ch = [chunk(0, 0, zruns=zr + [(100, 40)])]
    assert all(iv["state"] != "muted" for iv in day3(classify_room(mk(hist + ch))))


def test_blip_separated_runs_are_one_muted_stretch():
    """OPD 3 25 Sep pattern: ~8 min of zero split by 0.53 s and 0.62 s blips (not gated)."""
    hist = old_history(200)
    ch = [chunk(0, 0, zruns=[(10, 79), (89.53, 124), (214.15, 85.85)]), chunk(1, 300, zruns=[(0, 190.15)])]
    ivs = day3(classify_room(mk(hist + ch)))
    m = [iv for iv in ivs if iv["state"] == "muted"]
    assert len(m) == 1 and abs((m[0]["_b"] - m[0]["_a"]) - (490.15 - 10)) < 1
    assert m[0]["evidence"]["gate_active"] is False


def test_mute_across_chunk_boundary_gap_is_not_denied():
    hist = old_history(200)
    ch = [chunk(0, 0, dur=299.5, zruns=[(200, 99.5)]), chunk(1, 300.2, zruns=[(0, 60)])]
    m = [iv for iv in day3(classify_room(mk(hist + ch))) if iv["state"] == "muted"]
    assert len(m) == 1 and (m[0]["_b"] - m[0]["_a"]) > 159


def test_zero_stretch_not_denied_by_a_neighbouring_short_run():
    hist = old_history(200)
    ch = [chunk(0, 0, zruns=[(100, 30), (130.4, 2)])]
    assert any(iv["state"] == "muted" for iv in day3(classify_room(mk(hist + ch))))


def test_dead_kiosk_reads_off_not_unobserved_until_the_data_edge():
    ch = mk([chunk(0, 0), chunk(1, 300)])
    edge = ch[-1]["end"] + 3 * DAY + 3600
    ivs = classify_room(ch, last_day="2026-10-07", cutoff=edge)
    off = [iv for iv in ivs if iv["state"] == "recorder_off"]
    plain = [iv for iv in off if not iv["evidence"].get("after_snapshot")]
    after = [iv for iv in off if iv["evidence"].get("after_snapshot")]
    assert plain and after
    assert all(iv["_b"] <= edge + 1e-6 for iv in plain) and all(iv["_a"] >= edge - 1e-6 for iv in after)
    assert any(abs(iv["_a"] - ch[-1]["end"]) < 1e-6 for iv in plain)          # the dead kiosk's real stop is a plain recorder_off
    assert abs(total_min(ivs) - 5 * 1440) < 1e-6


def test_dead_kiosk_last_stop_gets_session_end_only_when_not_after_snapshot():
    per = {}
    for name, start in (("a", 0), ("b", 20), ("c", 40)):      # three kiosks stop within 1 min of each other
        cs = mk([chunk(0, start, dur=300)])
        per[name] = (cs, classify_room(cs, last_day="2026-10-04", cutoff=cs[-1]["end"] + DAY))
    annotate_session_end(per)
    se = [i for i in per["a"][1] if i["evidence"].get("session_end")]
    assert se and se[0]["state"] == "recorder_off" and not se[0]["evidence"].get("after_snapshot")
    assert se[0]["evidence"]["session_end"]["fleet_wide"] is True


def test_gate_active_stretch_is_judged_by_its_longest_piece():
    """Many blip-separated gate runs summing to > 300 s are still gating, not a mute."""
    hist = old_history(200)
    zr, t = [], 2.0
    for k in range(20):
        zr.append((t, 14.0))
        t += 14.4
    ch = [chunk(0, 0, zruns=zr)]                      # one 288 s stretch of 20 pieces
    ch2 = [chunk(1, 300, zruns=zr)]
    ivs = day3(classify_room(mk(hist + ch + ch2)))
    assert all(iv["state"] != "muted" for iv in ivs)


def _blip_mute(n_pieces, total_s, start=10.0, blip=0.3):
    """One mute of total_s seconds made of n_pieces zero pieces split by blips; spread over 300 s chunks."""
    piece = (total_s - blip * (n_pieces - 1)) / n_pieces
    t, per_chunk = start, {}
    for _ in range(n_pieces):
        end = t + piece
        c = int(t // 300)
        while t < end - 1e-9:
            cend = (c + 1) * 300
            seg_end = min(end, cend)
            per_chunk.setdefault(c, []).append((t - c * 300, seg_end - t))
            t, c = seg_end, c + 1 if seg_end >= cend else c
        t = end + blip
    return [chunk(c, 300 * c, zruns=zr) for c, zr in sorted(per_chunk.items())]


def test_refuter_A2_600s_mute_in_13_pieces_non_gated_reads_fully_muted():
    hist = old_history(200)
    ivs = day3(classify_room(mk(hist + _blip_mute(13, 600))))
    muted = sum(iv["_b"] - iv["_a"] for iv in ivs if iv["state"] == "muted")
    assert muted > 595 and gated_decision(mk(hist), day_start_ts("2026-10-03"))["gated"] is False
    assert all(not iv["evidence"]["gate_active"] for iv in ivs if iv["state"] == "muted")


def test_refuter_C_720s_mute_two_blips_in_gate_active_room_reads_fully_muted():
    hist = old_history(200)
    chatter = [chunk(0, 0, zruns=[(10 + 20 * k, 6) for k in range(12)])]    # gate chatter just before
    mute = _blip_mute(3, 720, start=300.0)
    ivs = day3(classify_room(mk(hist + chatter + mute)))
    m = [iv for iv in ivs if iv["state"] == "muted"]
    assert sum(iv["_b"] - iv["_a"] for iv in m) > 715
    assert m and m[0]["evidence"]["gate_active"] is True


def test_gate_active_counts_only_runs_ending_before_the_stretch():
    hist = old_history(200)
    ivs = day3(classify_room(mk(hist + _blip_mute(13, 600))))     # 12 own pieces must not flag the stretch
    assert [iv["evidence"]["gate_active"] for iv in ivs if iv["state"] == "muted"] == [False]


def test_density_line_between_gate_and_mute_blip_rates():
    hist = old_history(200)
    gate = _blip_mute(40, 640)          # 39 blips in 640 s = 3.7/min (>= 1 per 16 s): chatter
    real = _blip_mute(2, 900)           # 1 blip in 15 min: mute
    assert all(iv["state"] != "muted" for iv in day3(classify_room(mk(hist + gate))))
    assert any(iv["state"] == "muted" for iv in day3(classify_room(mk(hist + real))))


def test_interval_with_rejected_chatter_is_audio_gated_with_evidence():
    hist = old_history(200)
    ch = [chunk(0, 0, zruns=[(10 + 12.5 * k, 12) for k in range(12)], lo=0.5)]   # 12 pieces / ~2.8 min: chatter
    ivs = day3(classify_room(mk(hist + ch)))
    g = [iv for iv in ivs if iv["state"] == "audio_gated"]
    assert g and all(iv["state"] != "muted" for iv in ivs)
    ev = g[0]["evidence"]
    assert ev["n_stretches"] >= 1 and ev["chatter_seconds"] > 100 and ev["peak_blips_per_min"] > 2.0
    assert ev["zero_fraction"] == ev["zero_frac"] == 0.5
    assert ev["clipping_frac"] is None or ev["clipping_frac"] >= 0     # still carries audio_present evidence


def test_clean_audio_interval_stays_audio_present_and_real_mute_is_not_chatter():
    hist = old_history(200)
    ivs = day3(classify_room(mk(hist + [chunk(0, 0, zruns=[(100, 40)]), chunk(1, 300)])))
    assert "audio_gated" not in [iv["state"] for iv in ivs]
    assert [iv["state"] for iv in ivs if iv["state"] != "recorder_off"] == ["audio_present", "muted", "audio_present"]


def test_audio_gated_only_for_intervals_overlapping_the_chatter():
    hist = old_history(200)
    chat = chunk(0, 0, zruns=[(10 + 12.5 * k, 12) for k in range(10)])
    ch = [chat] + [chunk(i, 300 * i) for i in range(1, 5)] + [chunk(5, 1500, zruns=[(0, 40)]), chunk(6, 1800)]   # a mute far from the chatter splits the day
    st = [iv["state"] for iv in day3(classify_room(mk(hist + ch))) if iv["state"] != "recorder_off"]
    assert st == ["audio_gated", "muted", "audio_present"]


def _reasons(ivs):
    return [iv["evidence"].get("gated_reason") for iv in ivs if iv["state"] == "audio_gated"]


def test_gated_reason_density():
    hist = old_history(200)
    ch = [chunk(0, 0, zruns=[(10 + 12.5 * k, 12) for k in range(12)], lo=0.1)]
    assert "density" in _reasons(day3(classify_room(mk(hist + ch))))[0]


def test_gated_reason_gate_from_rolling_7d():
    hist = old_history(200, zruns=[(10, 5)])                     # prior week gated
    ivs = day3(classify_room(mk(hist + [chunk(0, 0), chunk(1, 300)])))
    assert _reasons(ivs) == [["gate"]]


def test_insufficient_history_alone_is_not_a_gate_reason():
    ivs = day3(classify_room(mk([chunk(0, 0), chunk(1, 300)])))
    assert [iv["state"] for iv in ivs if iv["state"] != "recorder_off"] == ["audio_present"]


def test_gated_reason_gate_active_day():
    hist = old_history(200)
    ch = [chunk(0, 0, zruns=[(10 + 12 * k, 4) for k in range(6)] + [(200, 12)])]   # 6 short runs, then a 12 s stretch
    ivs = day3(classify_room(mk(hist + ch)))
    assert _reasons(ivs) and "gate" in _reasons(ivs)[0]


def test_gated_reason_zero_frac_only():
    hist = old_history(200)
    ch = [chunk(0, 0, lo=0.6), chunk(1, 300, lo=0.6)]                # 60% zero, no stretches at all
    assert _reasons(day3(classify_room(mk(hist + ch)))) == [["zero_frac"]]
    ch2 = [chunk(0, 0, lo=0.49), chunk(1, 300, lo=0.49)]
    assert _reasons(day3(classify_room(mk(hist + ch2)))) == []


def test_240s_noisy_mute_in_gate_active_room_is_uncertain_not_usable():
    hist = old_history(200)
    chatter = [chunk(0, 0, zruns=[(10 + 20 * k, 6) for k in range(12)], lo=0.2)]
    noisy = _blip_mute(13, 240, start=300.0)                      # ~3 blips/min inside a 240 s mute
    ivs = day3(classify_room(mk(hist + chatter + noisy)))
    assert all(iv["state"] != "audio_present" for iv in ivs if iv["state"] != "recorder_off")
    assert any(iv["state"] == "audio_gated" for iv in ivs)


def test_clean_room_day_is_audio_present_with_no_reason():
    hist = old_history(200)
    ivs = day3(classify_room(mk(hist + [chunk(0, 0), chunk(1, 300)])))
    assert [iv["state"] for iv in ivs if iv["state"] != "recorder_off"] == ["audio_present"]
    assert "gated_reason" not in [iv for iv in ivs if iv["state"] == "audio_present"][0]["evidence"]
