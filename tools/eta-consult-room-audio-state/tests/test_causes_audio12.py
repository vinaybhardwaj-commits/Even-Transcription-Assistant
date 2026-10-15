"""audio-12: the six REFUTE-audio-10 MINORs. Synthetic 60 s heartbeat streams (the real fixtures are in test_causes.py)."""
import os, sys
import numpy
from ras import causes as ca, kiosk_health as kh
from ras.classify import iso


def hb(room, i, t, boot, **kw):
    return {"id": f"{room}{i}", "ts": float(t), "type": "heartbeat", "boot_id": boot, **kw}


def stream(room, stop, resume, boot_after=True, **marker):
    """heartbeats every 60 s to `stop`, silence, then (resume) heartbeats on a new boot_id for 10 minutes."""
    evs = [hb(room, i, t, room + "0") for i, t in enumerate(range(0, int(stop) + 1, 60))]
    if marker:
        evs.append({"id": room + "m", "ts": stop - 30.0, "type": "heartbeat", "boot_id": room + "0", **marker})
    if resume is not None:
        evs += [hb(room, 1000 + i, resume + 60 * i, room + ("1" if boot_after else "0")) for i in range(10)]
    return evs


def cut(stop, gap, rooms=("A", "B", "C"), **marker):
    return {r: stream(r, stop + k * 10, stop + k * 10 + gap, **marker) for k, r in enumerate(rooms)}


def off(room_a, a, b):
    return {"ist_day": "d", "state": "recorder_off", "ts_start": iso(a), "ts_end": iso(b), "_a": a, "_b": b, "evidence": {}}


# 1. planned (steward / fleet) restarts are not power
def test_baseline_cut_with_a_long_gap_is_power():
    assert set(ca.power_spans(cut(600, 300))) == {"A", "B", "C"}


def test_a_planned_restart_marker_on_every_room_is_not_power():
    assert ca.power_spans(cut(600, 300, planned_restart=True)) == {}


def test_planned_marker_on_one_room_removes_it_from_the_cohort():
    ev = cut(600, 300)
    ev["A"] = stream("A", 600, 900, planned_restart=True)
    assert ca.power_spans(ev) == {}            # only 2 rooms are left, below the 3-room cohort


def test_normalise_rows_keeps_steward_initiator_as_planned():
    row = {"id": 1, "room_id": "A", "ts": 10.0, "boot_id": "b", "kind": "heartbeat", "payload": {"initiator": "steward"}}
    plain = {**row, "id": 2, "payload": {}}
    ev = kh.normalise_rows([row, plain])["A"]
    assert ev[0].get("planned_restart") and not ev[1].get("planned_restart")


# 2. no boot-gap rule: the real 7 Oct cut keeps all nine power spans (room 9u49's 48 s reboot included)
def test_real_power_fixture_keeps_all_nine_power_spans():
    import json
    from tests.test_causes import events
    sp = ca.power_spans(events("kh_real_power_07oct.json"))
    assert not hasattr(ca, "RESTART_GAP_S")
    assert sum(len(v) for v in sp.values()) == 9
    assert "room_pnyc9u49" in sp and any(round(s["b"] - s["a"]) < 60 for s in sp["room_pnyc9u49"])


def test_short_boot_gap_with_a_cohort_is_still_power():
    assert set(ca.power_spans(cut(600, 40))) == {"A", "B", "C"}


def test_planned_markers_match_whole_values_only():
    mk = lambda **p: kh.normalise_rows([{"id": 1, "room_id": "A", "ts": 1.0, "boot_id": "b", "kind": "heartbeat",
                                         "payload": p}])["A"][0].get("planned_restart", False)
    assert mk(reason="unscheduled power loss") is False
    assert mk(reason="ups_update_failed") is False
    assert mk(initiator="unsteward") is False
    assert mk(reason="Steward ") is True and mk(initiator="fleet") is True and mk(planned=True) is True
    assert mk(planned="false") is False


# 3. usb_power checks the device named in the row
def usb(room, t, device=None, i=0):
    return {"id": f"{room}u{i}", "ts": float(t), "type": "audio.error", "error": "start_failure",
            "detail": "iokit_not_responding", "device": device, "boot_id": room + "0"}


def test_usb_power_other_named_device_is_not_usb_power():
    ev = {"A": [usb("A", 100, "USB Keyboard")], "B": [usb("B", 110, "C270 HD WEBCAM")]}
    assert ca.usb_power_spans(ev) == {}


def test_usb_power_named_c270_in_two_rooms_is_labelled_with_the_device():
    ev = {"A": [usb("A", 100, "c270  hd webcam")], "B": [usb("B", 110, "C270 HD WEBCAM")]}
    sp = ca.usb_power_spans(ev)
    assert set(sp) == {"A", "B"} and sp["A"][0]["device"] == "C270 HD WEBCAM"


def test_usb_power_with_no_device_in_the_row_says_unknown_device():
    ev = {"A": [usb("A", 100)], "B": [usb("B", 110)]}
    sp = ca.usb_power_spans(ev)
    assert sp["A"][0]["device"] == "unknown_device"
    out = ca.label_causes({"A": [off("A", 90, 400)]}, ev)["A"]
    assert out[0]["evidence"]["cause"] == "usb_power" and out[0]["evidence"]["cause_device"] == "unknown_device"


def test_normalise_rows_keeps_the_audio_error_device():
    row = {"id": 1, "room_id": "A", "ts": 5.0, "boot_id": "b", "kind": "audio.error",
           "payload": {"start_failure": True, "detail": "iokit_not_responding", "device": "C270 HD WEBCAM"}}
    assert kh.normalise_rows([row])["A"][0]["device"] == "C270 HD WEBCAM"


# 4. a usb failure followed by a power cut keeps usb_power for the earlier stop
def test_usb_failure_then_power_cut_keeps_usb_power_before_the_cut():
    ev = cut(1000, 300)
    ev["A"] = sorted(ev["A"] + [usb("A", 200, "C270 HD WEBCAM")], key=lambda e: e["ts"])
    ev["B"] = sorted(ev["B"] + [usb("B", 210, "C270 HD WEBCAM")], key=lambda e: e["ts"])
    out = ca.label_causes({"A": [off("A", 150, 1300)]}, ev)["A"]
    got = [(round(i["_a"]), round(i["_b"]), i["evidence"].get("cause")) for i in out]
    stop = 960                                  # A's last heartbeat before the cut (60 s beats)
    assert got[0] == (150, stop, "usb_power")
    assert got[-1][2] == "power" and got[-1][0] == stop and len(got) == 2


def test_usb_failure_alone_still_covers_the_whole_off_run():
    ev = {"A": [usb("A", 200, "C270 HD WEBCAM")], "B": [usb("B", 210, "C270 HD WEBCAM")]}
    out = ca.label_causes({"A": [off("A", 150, 1300)]}, ev)["A"]
    assert [i["evidence"].get("cause") for i in out] == ["usb_power"] and out[0]["_b"] == 1300


# 5. recompute window >= 3 days
def test_recompute_window_is_at_least_three_days():
    assert ca.RECOMPUTE_MIN_DAYS >= 3
    assert ca.recompute_days_back(1) == 2          # today + 2 days back = 3 IST days
    assert ca.recompute_days_back(0) == 2
    assert ca.recompute_days_back(5) == 5


# 6. numpy comes from the venv
def test_numpy_comes_from_the_venv_not_user_site():
    if sys.prefix == sys.base_prefix:
        return                                      # not run in a venv (CI without ras-venv); the deploy venv is what matters
    assert os.path.realpath(numpy.__file__).startswith(os.path.realpath(sys.prefix) + os.sep), numpy.__file__
    req = open(os.path.join(os.path.dirname(__file__), "..", "requirements.txt")).read()
    assert "numpy" in req
