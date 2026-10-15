"""Cause labelling against REAL kiosk_health_events rows (trimmed fixtures exported read-only from Neon) plus
synthetic tape intervals, because the tape mirror stops at 6 Oct 21:09 IST and has nothing after the power cut."""
import json, os
from datetime import datetime
from ras import causes as ca, kiosk_health as kh
from ras.classify import iso

FX = os.path.join(os.path.dirname(__file__), "fixtures")
T = lambda s: datetime.fromisoformat(s).timestamp()
U = lambda s: datetime.fromisoformat(s + "+00:00").timestamp()
ROOM = {"OPD1": "room_yh3etjpf", "OPD3": "room_87frpus9", "OPD4": "room_ux92qpws", "OPD5": "room_4ggnkg5x",
        "OPD6": "room_pnyc9u49", "OPD7": "room_qyzghzaf", "AUD": "room_d74hhmc4", "ECHO": "room_bh6jtq4t"}


def rows(name):
    d = json.load(open(os.path.join(FX, name)))
    return [{**r, "ts": datetime.fromisoformat(r["ts"])} for r in d["rows"]]


def events(*names):
    seen, allrows = set(), []
    for n in names:
        for r in rows(n):
            if r["id"] not in seen:
                seen.add(r["id"])
                allrows.append(r)
    return kh.normalise_rows(allrows)


def iv(state, a, b, **ev):
    return {"ist_day": datetime.fromtimestamp(a).strftime("%Y-%m-%d"), "state": state, "ts_start": iso(a), "ts_end": iso(b),
            "_a": a, "_b": b, "evidence": ev}


def off_run(stop, back, stop_pad=30):
    """audio until just before `stop`, recorder_off (a stop) until `back`, audio again. Split at IST midnight like the classifier."""
    a = stop - stop_pad
    mid = datetime.fromtimestamp(a).replace(hour=0, minute=0, second=0, microsecond=0).timestamp() + 86400
    out = [iv("audio_present", a - 3600, a)]
    if a < mid < back:
        out += [iv("recorder_off", a, mid, session_end={"fleet_wide": True}), iv("recorder_off", mid, back)]
    else:
        out += [iv("recorder_off", a, back, session_end={"fleet_wide": True})]
    return out + [iv("audio_present", back, back + 3600)]


def causes_of(ivs):
    return [(i["state"], i["evidence"].get("cause")) for i in ivs]


# ---- power: 7 Oct 00:16 IST (18:46Z) ----------------------------------------------------------------------

def test_power_cut_real_rows_find_six_rooms_ending_at_their_power_on():
    sp = ca.power_spans(events("kh_real_power_07oct.json"))
    assert set(sp) == {ROOM[k] for k in ("OPD1", "OPD3", "OPD4", "OPD5", "OPD6", "OPD7")}
    assert all(s["basis"] == "own_new_boot" for v in sp.values() for s in v)       # every room has a later boot in the table now
    stops = sorted(s["a"] for v in sp.values() for s in v)
    assert U("2026-10-06T18:46:00") <= stops[0] and stops[-1] <= U("2026-10-06T18:47:45") and stops[-1] - stops[0] <= 120
    on = lambda k: max(s["b"] for s in sp[ROOM[k]])
    # the morning power-on of the three rooms that stayed dark (IST 09:49:24, 09:01:32, 10:26:53)
    assert abs(on("OPD1") - T("2026-10-07T09:49:24+05:30")) < 90 and abs(on("OPD4") - T("2026-10-07T09:01:32+05:30")) < 200
    assert abs(on("OPD5") - T("2026-10-07T10:26:53+05:30")) < 200
    assert on("OPD3") - min(s["a"] for s in sp[ROOM["OPD3"]]) < 120                  # OPD 3 was back within 90 s


def test_power_cut_labels_opd1_4_5_power_until_power_on_then_no_session_start():
    ev = events("kh_real_power_07oct.json", "kh_real_nosession_07oct.json")
    starts = {"OPD1": "09:53", "OPD4": "10:24", "OPD5": "10:28"}
    by = {ROOM[k]: [iv("audio_present", T("2026-10-06T22:00:00+05:30"), U("2026-10-06T18:46:00")),
                    iv("recorder_off", U("2026-10-06T18:46:00"), T("2026-10-07T" + h + ":00+05:30"), session_end={"fleet_wide": True}),
                    iv("audio_present", T("2026-10-07T" + h + ":00+05:30"), T("2026-10-07T" + h + ":00+05:30") + 600)]
          for k, h in starts.items()}
    out = ca.label_causes(by, ev)
    for room, ivs in out.items():
        offs = [i for i in ivs if i["state"] == "recorder_off"]
        assert offs[0]["evidence"]["cause"] == "power" and offs[0]["evidence"]["cause_basis"] == "own_new_boot"
        assert [i["evidence"]["cause"] for i in offs if "cause" in i["evidence"]][0] == "power"
        assert ivs[0]["state"] == "audio_present" and "cause" not in ivs[0]["evidence"] and "cause" not in ivs[-1]["evidence"]
        assert abs(sum(i["_b"] - i["_a"] for i in ivs) - sum(i["_b"] - i["_a"] for i in by[room])) < 1e-6


def test_two_stopping_rooms_are_not_power():
    ev = events("kh_real_power_07oct.json")
    two = {ROOM["OPD1"]: ev[ROOM["OPD1"]], ROOM["OPD4"]: ev[ROOM["OPD4"]]}
    assert ca.power_spans(two) == {}


def test_no_new_boot_means_no_power():
    ev = events("kh_real_power_07oct.json")
    for evs in ev.values():
        for e in evs:
            e["boot_id"] = "same"
    assert ca.power_spans(ev) == {}


def test_stops_spread_over_more_than_120s_are_not_a_cohort():
    near = ca.cluster_rooms([(0.0, "a"), (100.0, "b"), (210.0, "c")], 120.0, 3)
    assert all(not v for v in near.values())
    near = ca.cluster_rooms([(0.0, "a"), (60.0, "b"), (110.0, "c")], 120.0, 3)
    assert all(len(v) == 3 for v in near.values())


def test_cohort_basis_for_a_room_whose_later_events_have_not_arrived_yet():
    """A kiosk silent after the cut counts as power when >= 2 of the other stopping rooms rebooted."""
    ev = events("kh_real_power_07oct.json")
    cut = U("2026-10-06T18:50:00")
    lagging = {r: ([e for e in evs if e["ts"] <= cut] if r in (ROOM["OPD1"], ROOM["OPD5"]) else evs) for r, evs in ev.items()}
    sp = ca.power_spans(lagging)
    assert [s["basis"] for s in sp[ROOM["OPD1"]]] == ["cohort_new_boot"]
    assert sp[ROOM["OPD5"]][-1]["basis"] == "cohort_new_boot"       # OPD 5 also booted briefly at 00:17:39 before going dark again
    assert sp[ROOM["OPD1"]][0]["b"] is None
    # synthetic: two silent rooms and only ONE rebooted room is not enough for the cohort basis
    hb = lambda i, t, boot: {"id": i, "ts": t, "type": "heartbeat", "boot_id": boot}
    syn = {"A": [hb(1, 0, "a"), hb(2, 30, "a")], "B": [hb(3, 0, "b"), hb(4, 35, "b")],
           "C": [hb(5, 0, "c"), hb(6, 40, "c"), hb(7, 100, "c2"), hb(8, 2000, "c2")]}
    assert ca.power_spans(syn) == {} or all(s["basis"] != "cohort_new_boot" for v in ca.power_spans(syn).values() for s in v)


def test_clock_suspect_rows_are_skipped():
    rs = [{"id": 1, "room_id": "r", "ts": datetime.fromtimestamp(100), "boot_id": "b", "kind": "heartbeat", "payload": {}},
          {"id": 2, "room_id": "r", "ts": datetime.fromtimestamp(200), "boot_id": "b", "kind": "heartbeat", "payload": {"_clock_suspect": True}},
          {"id": 3, "room_id": "r", "ts": datetime.fromtimestamp(300), "boot_id": "b", "kind": "heartbeat", "_clock_suspect": True, "payload": {}}]
    assert [e["id"] for e in kh.normalise_rows(rs)["r"]] == [1]


# ---- usb_power: 6 Oct 17:25 IST (OPD 4 and Audiometry) -------------------------------------------------------

def test_usb_power_real_rows_hit_audiometry_and_opd4():
    sp = ca.usb_power_spans(events("kh_real_usb_06oct.json"))
    assert set(sp) == {ROOM["AUD"], ROOM["OPD4"]}
    assert abs(sp[ROOM["AUD"]][0]["a"] - U("2026-10-06T11:55:22.917")) < 0.01
    assert abs(sp[ROOM["OPD4"]][0]["a"] - U("2026-10-06T11:55:59.387")) < 0.01
    assert abs(sp[ROOM["AUD"]][0]["a"] - sp[ROOM["OPD4"]][0]["a"]) <= 60


def test_opd4_device_missing_and_usb_power_together():
    ev = events("kh_real_usb_06oct.json")
    a0 = T("2026-10-06T17:25:59.470+05:30")
    end = T("2026-10-06T20:57:44.603+05:30")
    base = [iv("audio_present", a0 - 600, a0), iv("recorder_off", a0, end, session_end={"fleet_wide": False}),
            iv("audio_present", end, end + 600)]
    dm = kh.apply_device_missing(base, kh.device_missing_spans(ev[ROOM["OPD4"]], "C270 HD WEBCAM"))
    assert [i["state"] for i in dm] == ["audio_present", "recorder_off", "device_missing", "audio_present"]
    assert abs(dm[2]["_a"] - T("2026-10-06T17:26:58.496+05:30")) < 0.01 and dm[2]["evidence"]["kh_event_ids"] == [7856]
    out = ca.label_causes({ROOM["OPD4"]: dm}, ev)[ROOM["OPD4"]]
    assert causes_of(out) == [("audio_present", None), ("recorder_off", "usb_power"), ("device_missing", "usb_power"),
                              ("audio_present", None)]


def test_audiometry_usb_power_until_its_reboot_and_never_no_session_start():
    """Audiometry's kiosk reports session_open "yes" (recording) all morning with iokit start_failures, so 07:00-08:57 IST
    is usb_power until the 03:26:54Z reboot, NOT no_session_start (that needs a closed session)."""
    ev = events("kh_real_usb_06oct.json", "kh_real_power_07oct.json", "kh_real_nosession_07oct.json")
    a = T("2026-10-06T17:25:22.704+05:30")
    reboot = U("2026-10-07T03:26:54")
    back = min(e["ts"] for e in ev[ROOM["AUD"]] if e["type"] == "recorder.status" and e["ts"] > reboot and e["session_open"] == "yes")
    run = off_run(a, back, stop_pad=0)
    out = ca.label_causes({ROOM["AUD"]: run}, ev)[ROOM["AUD"]]
    offs = [i for i in out if i["state"] == "recorder_off"]
    usb = [i for i in offs if i["evidence"].get("cause") == "usb_power"]
    assert usb and usb[0]["_a"] == a and "cause" not in out[0]["evidence"] and "cause" not in out[-1]["evidence"]
    assert reboot <= usb[-1]["_b"] <= reboot + 120                         # ends at the reboot (first event of the new boot)
    assert not [i for i in offs if i["evidence"].get("cause") == "no_session_start"]
    clinic = [i for i in usb if i["_a"] <= T("2026-10-07T07:30:00+05:30") < i["_b"]]
    assert clinic                                                          # 07:30 IST is covered by usb_power
    assert sum(i["_b"] - i["_a"] for i in out) == sum(i["_b"] - i["_a"] for i in run)


def test_one_room_iokit_only_is_not_usb_power():
    ev = events("kh_real_usb_06oct.json")
    only = {ROOM["AUD"]: ev[ROOM["AUD"]]}
    assert ca.usb_power_spans(only) == {}


def test_iokit_events_more_than_60s_apart_are_not_usb_power():
    ev = events("kh_real_usb_06oct.json")
    for e in ev[ROOM["OPD4"]]:
        e["ts"] += 40
    assert ca.usb_power_spans(ev) == {}


# ---- no_session_start: 7 Oct 07:30-09:33 IST on OPD 3/6/7/ECHO ---------------------------------------------

def test_no_session_start_real_rows_opd3_6_7_echo():
    ev = events("kh_real_nosession_07oct.json")
    by = {}
    for k in ("OPD3", "OPD6", "OPD7", "ECHO"):
        back = min(e["ts"] for e in ev[ROOM[k]] if e["type"] == "recorder.status" and e["session_open"] == "yes")   # session opens ~09:34 IST
        by[ROOM[k]] = [iv("audio_present", T("2026-10-06T19:00:00+05:30"), T("2026-10-06T20:57:00+05:30")),
                       iv("recorder_off", T("2026-10-06T20:57:00+05:30"), T("2026-10-07T00:00:00+05:30"), session_end={}),
                       iv("recorder_off", T("2026-10-07T00:00:00+05:30"), back),
                       iv("audio_present", back, back + 600)]
    out = ca.label_causes(by, ev)
    for room, ivs in out.items():
        nss = [i for i in ivs if i["evidence"].get("cause") == "no_session_start"]
        back = next(i for i in ivs if i["state"] == "audio_present" and i["_a"] > T("2026-10-07T00:00:00+05:30"))["_a"]
        assert len(nss) == 1, room
        assert nss[0]["_a"] == T("2026-10-07T07:00:00+05:30") and nss[0]["_b"] == back          # the clinic-hours part only
        assert nss[0]["_b"] - nss[0]["_a"] > 7800                                               # covers 07:30-09:33
        assert all("cause" not in i["evidence"] for i in ivs if i is not nss[0])


def test_no_session_start_needs_heartbeats_and_closed_session():
    ev = events("kh_real_nosession_07oct.json")
    back = U("2026-10-07T04:04:00")
    base = lambda: {ROOM["OPD3"]: [iv("recorder_off", T("2026-10-07T00:00:00+05:30"), back)]}
    no_hb = {r: [e for e in evs if e["type"] != "heartbeat"] for r, evs in ev.items()}
    assert "cause" not in ca.label_causes(base(), no_hb)[ROOM["OPD3"]][0]["evidence"]
    open_sess = {r: [{**e, "session_open": "yes"} if e["type"] == "recorder.status" else e for e in evs] for r, evs in ev.items()}
    assert "cause" not in ca.label_causes(base(), open_sess)[ROOM["OPD3"]][0]["evidence"]
    hb = [e["ts"] for e in ev[ROOM["OPD3"]] if e["type"] == "heartbeat"]
    gap = {r: [e for e in evs if not (e["type"] == "heartbeat" and U("2026-10-07T02:30:00") < e["ts"] < U("2026-10-07T02:40:00"))]
           for r, evs in ev.items()}
    out = ca.label_causes(base(), gap)[ROOM["OPD3"]]
    assert all(i["evidence"].get("cause") != "no_session_start" or not (i["_a"] <= U("2026-10-07T02:35:00") < i["_b"]) for i in out)


def test_overnight_off_is_not_no_session_start():
    ev = events("kh_real_nosession_07oct.json")
    ivs = {ROOM["OPD3"]: [iv("recorder_off", T("2026-10-07T00:00:00+05:30"), T("2026-10-07T06:30:00+05:30"))]}
    assert all("cause" not in i["evidence"] for i in ca.label_causes(ivs, ev)[ROOM["OPD3"]])


def test_inputs_not_mutated_and_not_wired():
    ev = events("kh_real_power_07oct.json")
    by = {ROOM["OPD1"]: off_run(U("2026-10-06T18:46:20"), T("2026-10-07T09:30:00+05:30"))}
    before = json.dumps(by, sort_keys=True)
    ca.label_causes(by, ev)
    assert json.dumps(by, sort_keys=True) == before
    root = os.path.join(os.path.dirname(__file__), "..")
    for f in ("ras/run.py", "ras/classify.py", "ras_write.py", "ras/hourly.py", "ras/scan.py", "ras/report.py"):
        src = open(os.path.join(root, f)).read()
        assert "ras.causes" not in src and "import causes" not in src and "kiosk_health" not in src


# ---- FLEET 7 Oct session starts as a cross-check (labels come from kiosk health, not from this list) ------------

FLEET = json.load(open(os.path.join(FX, "fleet_session_starts_07oct.json")))
OFF_FROM = {   # where each room's tape would have gone quiet (synthetic tape; the real mirror ends 6 Oct 21:09 IST)
    "room_yh3etjpf": U("2026-10-06T18:46:00"), "room_87frpus9": U("2026-10-06T18:46:00"), "room_ux92qpws": U("2026-10-06T18:46:00"),
    "room_4ggnkg5x": U("2026-10-06T18:46:00"), "room_pnyc9u49": U("2026-10-06T18:46:00"), "room_qyzghzaf": U("2026-10-06T18:46:00"),
    "room_bh6jtq4t": T("2026-10-06T20:00:00+05:30"), "room_d74hhmc4": T("2026-10-06T17:25:22.704+05:30"),
    "room_ymch4bxu": T("2026-10-06T17:23:00+05:30")}


def fleet_events():
    return events("kh_real_usb_06oct.json", "kh_real_power_07oct.json", "kh_real_nosession_07oct.json")


def fleet_intervals(room):
    start = T("2026-10-07T" + FLEET["starts_ist"][room] + ":00+05:30")
    mid = T("2026-10-07T00:00:00+05:30")
    a = OFF_FROM[room]
    offs = [iv("recorder_off", a, mid, session_end={}), iv("recorder_off", mid, start)] if a < mid else [iv("recorder_off", a, start)]
    return [iv("audio_present", a - 600, a)] + offs + [iv("audio_present", start, start + 600)], start


def labelled(ivs, hhmm):
    t = T("2026-10-07T" + hhmm + "+05:30")
    for i in ivs:
        if i["_a"] <= t < i["_b"]:
            return i["evidence"].get("cause") if i["state"] in ("recorder_off", "device_missing") else i["state"]


def label_all():
    ev, out, starts = fleet_events(), {}, {}
    by = {}
    for room in FLEET["starts_ist"]:
        if room in ev:
            by[room], starts[room] = fleet_intervals(room)
    return ca.label_causes(by, ev), ev, starts


def test_kiosk_health_session_start_matches_fleet_for_every_room_with_rows():
    ev = fleet_events()
    checked = 0
    for room, hhmm in FLEET["starts_ist"].items():
        if room not in ev:
            continue                                                    # ORB2 has no kiosk-health rows
        fleet = T("2026-10-07T" + hhmm + ":00+05:30")
        boots = [e["ts"] for a, e in zip(ev[room], ev[room][1:]) if a["boot_id"] != e["boot_id"] and e["ts"] <= fleet + 120]
        since = boots[-1] if boots else 0
        # right after a boot the recorder file can still say "recording" (stale); the real start is the first
        # "recording" after the kiosk has reported "ready"
        ready = min(e["ts"] for e in ev[room] if e["type"] == "recorder.status" and e["state"] == "ready" and e["ts"] >= since)
        kh_start = min(e["ts"] for e in ev[room] if e["type"] == "recorder.status" and e["state"] == "recording" and e["ts"] > ready)
        assert abs(kh_start - fleet) <= 90, (FLEET["names"][room], kh_start - fleet)
        checked += 1
    assert checked == 9


def test_fleet_window_labels_power_for_dark_kiosks_and_no_session_start_for_up_kiosks():
    out, ev, starts = label_all()
    # kiosk dark from 00:16 until the morning power-on: power
    for room in ("room_yh3etjpf", "room_ux92qpws", "room_4ggnkg5x"):
        assert labelled(out[room], "07:30:00") == "power", FLEET["names"][room]
    # kiosk up (heartbeats) but no session: no_session_start from 07:30 to the start
    for room in ("room_pnyc9u49", "room_qyzghzaf", "room_bh6jtq4t", "room_87frpus9"):
        assert labelled(out[room], "07:30:00") == "no_session_start" and labelled(out[room], "09:30:00") == "no_session_start"
    # OPD 1 and OPD 5: power until power-on, then no_session_start until the session
    assert labelled(out["room_yh3etjpf"], "09:48:00") == "power" and labelled(out["room_yh3etjpf"], "09:51:30") == "no_session_start"
    assert labelled(out["room_4ggnkg5x"], "10:25:00") == "power" and labelled(out["room_4ggnkg5x"], "10:27:30") == "no_session_start"
    # OPD 4: power until 09:01, no_session_start until the recorder 'failed' at 09:34, then session open but failing (no cause)
    o4 = out["room_ux92qpws"]
    assert labelled(o4, "09:00:00") == "power" and labelled(o4, "09:20:00") == "no_session_start" and labelled(o4, "10:00:00") is None
    # Audiometry: usb_power until its 08:56:54 reboot (session open but the C270 failing), then no_session_start
    au = out["room_d74hhmc4"]
    assert labelled(au, "07:30:00") == "usb_power" and labelled(au, "09:00:00") == "no_session_start" and labelled(au, "09:30:00") == "no_session_start"
    # Dietary: its kiosk went dark at 17:23 IST on 6 Oct on its own (not in a cohort): no heartbeats, no label
    dt = out["room_ymch4bxu"]
    assert labelled(dt, "07:30:00") is None and labelled(dt, "10:00:00") is None


def window_coverage():
    out, ev, starts = label_all()
    cov = {}
    lo = T("2026-10-07T07:30:00+05:30")
    for room, ivs in out.items():
        span = starts[room] - lo
        got = {}
        for i in ivs:
            a, b = max(i["_a"], lo), min(i["_b"], starts[room])
            if b > a and i["state"] in ("recorder_off", "device_missing"):
                got[i["evidence"].get("cause")] = got.get(i["evidence"].get("cause"), 0) + (b - a)
        cov[room] = {k: round(v / 60, 1) for k, v in got.items()}, round(span / 60, 1)
    return cov


def test_window_0730_to_start_is_fully_labelled_except_opd4_failed_phase_and_dietary():
    cov = window_coverage()
    for room, (got, span) in cov.items():
        labelled_min = sum(v for k, v in got.items() if k)
        name = FLEET["names"][room]
        if name in ("Dietary",):
            assert labelled_min == 0
        elif name == "OPD4":
            assert abs(span - labelled_min - 50.0) < 1.5                  # 09:34:08-10:24 is session-open 'failed', unlabelled
        else:
            assert span - labelled_min < 1.0, (name, got, span)           # under a minute left unlabelled at the edges


def test_a_stale_status_from_before_a_reboot_is_not_held_across_it():
    st = [{"id": 1, "ts": 0.0, "type": "recorder.status", "session_open": "no", "state": "ready"},
          {"id": 2, "ts": 40000.0, "type": "recorder.status", "session_open": "no", "state": "ready"}]
    assert ca._no_subspans(st, 30000.0, 40100.0) == [(40000.0, 40100.0, 2)]      # 30000-40000 is unknown, not "no"


def test_power_on_to_first_status_is_unlabelled_then_no_session_start():
    ev = events("kh_real_power_07oct.json", "kh_real_nosession_07oct.json")
    by = {ROOM["OPD1"]: [iv("audio_present", U("2026-10-06T18:00:00"), U("2026-10-06T18:46:00")),
                         iv("recorder_off", U("2026-10-06T18:46:00"), T("2026-10-07T09:53:03+05:30"), session_end={}),
                         iv("audio_present", T("2026-10-07T09:53:03+05:30"), T("2026-10-07T10:30:00+05:30"))]}
    off = [i for i in ca.label_causes(by, ev)[ROOM["OPD1"]] if i["state"] == "recorder_off"]
    assert [i["evidence"].get("cause") for i in off] == ["power", None, "no_session_start"]     # 8 s between power-on and the first status
    assert off[1]["_b"] - off[1]["_a"] < 30
    assert abs(off[2]["_a"] - T("2026-10-07T09:49:32+05:30")) < 90 and off[2]["_b"] == T("2026-10-07T09:53:03+05:30")


def test_no_session_start_also_labels_device_missing_time():
    ev = events("kh_real_nosession_07oct.json")
    a, b = T("2026-10-07T09:10:00+05:30"), T("2026-10-07T09:20:00+05:30")
    out = ca.label_causes({ROOM["OPD3"]: [iv("device_missing", a, b, kh_event_ids=[1])]}, ev)[ROOM["OPD3"]]
    assert [(i["state"], i["evidence"].get("cause")) for i in out] == [("device_missing", "no_session_start")]
    assert out[0]["evidence"]["kh_event_ids"] == [1]
