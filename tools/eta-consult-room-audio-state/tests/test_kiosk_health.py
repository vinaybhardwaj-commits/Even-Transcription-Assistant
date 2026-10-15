import json, os
from datetime import datetime
import pytest
from ras.classify import FULL_MS, iso
from ras import kiosk_health as kh

T = lambda s: datetime.fromisoformat(s).timestamp()
DEV = "C270 HD WEBCAM"          # the real device name in kiosk_health_events (OPD 4 and Audiometry)


def real_rows(name):
    d = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", name)))
    return [{**r, "ts": datetime.fromisoformat(r["ts"])} for r in d["rows"]]


ALL = kh.normalise_rows(real_rows("kh_real_usb_06oct.json"))
# the OPD 4 events of 6 Oct 17:25-17:27 IST as the mapping sees them (usb_removed comes from the audio.devices row)
EVENTS = [e for e in ALL["room_ux92qpws"] if e["type"] in ("audio.error", "usb_removed", "usb_added") and
          T("2026-10-06T11:55:00+00:00") <= e["ts"] <= T("2026-10-06T11:58:00+00:00")]


def iv(state, a, b, **ev):
    return {"ist_day": "2026-10-06", "state": state, "ts_start": iso(a), "ts_end": iso(b), "_a": a, "_b": b,
            "evidence": {"gap_ms": 1, **ev}}


def test_fixture_usb_removed_opens_span_iokit_alone_does_not():
    sp = kh.device_missing_spans(EVENTS, DEV)
    assert len(sp) == 1 and sp[0]["a"] == T("2026-10-06T17:26:58.496+05:30") and sp[0]["b"] is None
    assert sp[0]["kh_event_ids"] == [7856]
    assert kh.device_missing_spans(EVENTS[:1], DEV) == []


def test_other_device_removal_is_ignored():
    ev = [{"id": "x", "ts": 1.0, "type": "usb_removed", "device": "USB Keyboard"}]
    assert kh.device_missing_spans(ev, DEV) == []


def test_audio_error_start_failure_input_not_found_opens():
    ev = [{"id": "e1", "ts": 100.0, "type": "audio.error", "error": "start_failure", "detail": "Input device not found"},
          {"id": "e2", "ts": 150.0, "type": "audio.error", "error": "start_failure", "detail": "permission denied"}]
    sp = kh.device_missing_spans(ev, DEV)
    assert len(sp) == 1 and sp[0]["a"] == 100.0 and sp[0]["kh_event_ids"] == ["e1"]
    assert kh.device_missing_spans(ev[1:], DEV) == []


def test_closes_on_usb_added():
    ev = EVENTS + [{"id": "a1", "ts": T("2026-10-06T18:00:00+05:30"), "type": "usb_added", "device": "C270 HD WEBCAM"}]
    sp = kh.device_missing_spans(ev, DEV)
    assert sp[0]["b"] == T("2026-10-06T18:00:00+05:30") and sp[0]["closed_by"] == "usb_added"
    assert sp[0]["kh_event_ids"] == [7856, "a1"]


def test_closes_when_audio_devices_lists_it_again_but_not_before():
    ev = EVENTS + [{"id": "d1", "ts": T("2026-10-06T17:40:00+05:30"), "type": "audio.devices", "devices": ["MacBook Mic"]},
                   {"id": "d2", "ts": T("2026-10-06T17:50:00+05:30"), "type": "audio.devices", "devices": ["C270 HD WEBCAM"]}]
    sp = kh.device_missing_spans(ev, DEV)
    assert sp[0]["b"] == T("2026-10-06T17:50:00+05:30") and sp[0]["closed_by"] == "audio.devices"


def test_closes_on_first_full_chunk():
    full = [T("2026-10-06T17:10:00+05:30"), T("2026-10-06T19:00:00+05:30"), T("2026-10-06T19:05:00+05:30")]
    sp = kh.device_missing_spans(EVENTS, DEV, full_chunk_starts=full)
    assert sp[0]["b"] == T("2026-10-06T19:00:00+05:30") and sp[0]["closed_by"] == "full_chunk"


def test_full_chunk_starts_only_counts_full_length_chunks():
    cs = [{"start": 1.0, "manifest_ms": FULL_MS}, {"start": 2.0, "manifest_ms": FULL_MS - 1}]
    assert kh.full_chunk_starts(cs) == [1.0]


def test_apply_converts_recorder_off_inside_span_only_with_evidence():
    a0 = T("2026-10-06T17:25:59.470+05:30")
    off = iv("recorder_off", a0, T("2026-10-06T20:57:44.603+05:30"), session_end={"fleet_wide": False})
    audio = iv("audio_gated", T("2026-10-06T08:44:03+05:30"), a0)
    sp = kh.device_missing_spans(EVENTS, DEV)
    out = kh.apply_device_missing([audio, off], sp)
    assert [i["state"] for i in out] == ["audio_gated", "recorder_off", "device_missing"]
    pre, miss = out[1], out[2]
    assert pre["_a"] == a0 and pre["_b"] == sp[0]["a"] and pre["evidence"]["session_end"] == {"fleet_wide": False}
    assert miss["_a"] == sp[0]["a"] and miss["_b"] == off["_b"] and miss["evidence"]["kh_event_ids"] == [7856]
    assert "session_end" not in miss["evidence"]
    assert sum(i["_b"] - i["_a"] for i in out) == sum(i["_b"] - i["_a"] for i in [audio, off])
    assert all(a["_b"] == b["_a"] for a, b in zip(out, out[1:]))


def test_apply_closed_span_leaves_recorder_off_after_it():
    off = iv("recorder_off", 1000.0, 5000.0)
    out = kh.apply_device_missing([off], [{"a": 2000.0, "b": 3000.0, "kh_event_ids": ["k"], "closed_by": "usb_added"}])
    assert [(i["state"], i["_a"], i["_b"]) for i in out] == [("recorder_off", 1000.0, 2000.0),
                                                              ("device_missing", 2000.0, 3000.0),
                                                              ("recorder_off", 3000.0, 5000.0)]


def test_apply_span_covering_whole_interval_and_non_overlapping_span():
    off = iv("recorder_off", 1000.0, 2000.0)
    whole = kh.apply_device_missing([off], [{"a": 0.0, "b": None, "kh_event_ids": ["k"], "closed_by": None}])
    assert [(i["state"], i["_a"], i["_b"]) for i in whole] == [("device_missing", 1000.0, 2000.0)]
    same = kh.apply_device_missing([off], [{"a": 3000.0, "b": 4000.0, "kh_event_ids": ["k"], "closed_by": None}])
    assert same == [off]


def test_apply_no_sliver_when_span_edge_is_within_a_second():
    off = iv("recorder_off", 1000.0, 5000.0)
    out = kh.apply_device_missing([off], [{"a": 1000.4, "b": None, "kh_event_ids": ["k"], "closed_by": None}])
    assert [(i["state"]) for i in out] == ["device_missing"] and out[0]["_a"] == 1000.0
    assert all(i["_b"] - i["_a"] >= 1.0 for i in out)


def test_never_wired_into_the_pipeline_or_the_writer():
    root = os.path.join(os.path.dirname(__file__), "..")
    for f in ("ras/run.py", "ras/classify.py", "ras_write.py", "ras/hourly.py", "ras/scan.py"):
        assert "kiosk_health" not in open(os.path.join(root, f)).read(), f


def test_real_opd4_6oct_output_with_fixture():
    fn = os.path.expanduser("~/eta-data/consult/audio-state/room_ux92qpws_2026-10-06.jsonl")
    if not os.path.exists(fn):
        pytest.skip("no shadow file")
    ivs = []
    for l in open(fn):
        r = json.loads(l)
        ivs.append({**r, "_a": T(r["ts_start"]), "_b": T(r["ts_end"])})
    out = kh.apply_device_missing(ivs, kh.device_missing_spans(EVENTS, DEV))
    miss = [i for i in out if i["state"] == "device_missing"]
    assert miss and miss[0]["_a"] == T("2026-10-06T17:26:58.496+05:30")
    assert abs(sum(i["_b"] - i["_a"] for i in out) - 86400) < 1e-6
    assert [i["state"] for i in ivs if i["state"] == "device_missing"] == []       # the shadow output has none


R = lambda i, ts: {"id": i, "ts": float(ts), "type": "usb_removed", "device": "C270 HD WEBCAM"}
A = lambda i, ts: {"id": i, "ts": float(ts), "type": "usb_added", "device": "C270 HD WEBCAM"}
SF = lambda i, ts: {"id": i, "ts": float(ts), "type": "audio.error", "error": "start_failure", "detail": "Input device not found"}


def test_second_outage_after_a_full_chunk_opens_its_own_span():
    ev = [R("r1", 100), SF("f2", 2000)]
    sp = kh.device_missing_spans(ev, DEV, full_chunk_starts=[200.0])
    assert [(s["a"], s["b"], s["kh_event_ids"], s["closed_by"]) for s in sp] == [
        (100.0, 200.0, ["r1"], "full_chunk"), (2000.0, None, ["f2"], None)]


def test_recorder_off_between_the_two_spans_stays_off():
    ev = [R("r1", 100), SF("f2", 2000)]
    sp = kh.device_missing_spans(ev, DEV, full_chunk_starts=[200.0])
    off = iv("recorder_off", 100.0, 3000.0)
    out = kh.apply_device_missing([off], sp)
    assert [(i["state"], i["_a"], i["_b"]) for i in out] == [("device_missing", 100.0, 200.0), ("recorder_off", 200.0, 2000.0),
                                                              ("device_missing", 2000.0, 3000.0)]
    assert out[0]["evidence"]["kh_event_ids"] == ["r1"] and out[2]["evidence"]["kh_event_ids"] == ["f2"]


def test_repeat_opening_event_inside_the_same_outage_joins_that_span():
    sp = kh.device_missing_spans([R("r1", 100), SF("f1", 130)], DEV, full_chunk_starts=[])
    assert len(sp) == 1 and sp[0]["kh_event_ids"] == ["r1", "f1"]


def test_exact_device_name_match_only():
    for name in ("USB Keyboard", "Logitech C270 HD Webcam", "C270", ""):
        ev = [{"id": "x", "ts": 1.0, "type": "usb_removed", "device": name}]
        assert kh.device_missing_spans(ev, DEV) == []
    ev = [{"id": "x", "ts": 1.0, "type": "usb_removed", "device": "  c270   hd webcam "}]
    assert len(kh.device_missing_spans(ev, DEV)) == 1                      # case and whitespace are normalised
    assert kh.device_missing_spans([{"id": "y", "ts": 1.0, "type": "audio.devices", "devices": ["Logitech C270 HD"]}], DEV) == []


def test_empty_or_missing_configured_device_is_rejected():
    for bad in ("", "   ", None):
        with pytest.raises(ValueError):
            kh.device_missing_spans([R("r", 1)], bad)


def test_same_second_events_have_a_deterministic_order():
    a, b = R("r", 100), A("a", 100)
    s1 = kh.device_missing_spans([a, b], DEV)
    s2 = kh.device_missing_spans([b, a], DEV)
    assert s1 == s2 == []                                                  # removed and added together: no outage
    s3 = kh.device_missing_spans([b, a, R("r2", 100)], DEV)
    s4 = kh.device_missing_spans([R("r2", 100), a, b], DEV)
    assert s3 == s4


def test_no_device_missing_piece_under_one_second():
    off = iv("recorder_off", 0.0, 10.0)
    out = kh.apply_device_missing([off], [{"a": 9.5, "b": None, "kh_event_ids": ["k"], "closed_by": None}])
    assert [i["state"] for i in out] == ["recorder_off"] and out[0]["_b"] - out[0]["_a"] == 10.0
    out = kh.apply_device_missing([off], [{"a": -5.0, "b": 0.6, "kh_event_ids": ["k"], "closed_by": "usb_added"}])
    assert [i["state"] for i in out] == ["recorder_off"]


def test_fuzz_no_piece_under_one_second_and_totals_preserved():
    import random
    rnd = random.Random(7)
    for _ in range(3000):
        a = rnd.uniform(0, 50)
        off = iv("recorder_off", a, a + rnd.uniform(1.2, 60))
        spans = []
        for _ in range(rnd.randint(1, 3)):
            s = rnd.uniform(-5, 80)
            spans.append({"a": s, "b": None if rnd.random() < 0.2 else s + rnd.uniform(0.05, 30), "kh_event_ids": ["k"],
                          "closed_by": None})
        spans.sort(key=lambda x: x["a"])
        out = kh.apply_device_missing([off], spans)
        assert all(i["_b"] - i["_a"] >= 1.0 - 1e-9 for i in out), (off, spans, out)
        assert abs(sum(i["_b"] - i["_a"] for i in out) - (off["_b"] - off["_a"])) < 1e-9
        assert all(x["_b"] == y["_a"] for x, y in zip(out, out[1:]))
