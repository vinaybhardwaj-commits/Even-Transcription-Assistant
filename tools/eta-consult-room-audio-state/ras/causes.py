"""evidence.cause on recorder_off / device_missing intervals, from kiosk-health events. Not wired into ras.run or
ras_write: until review PASS nothing here is written to Neon.

cause values (absent = unknown), highest priority first:
  power             >= 3 rooms' kiosk-health streams stop within 120 s, and the room shows a new boot_id afterwards
                    (own_new_boot; covers the dark time until that boot), or it never reports again while >= 2 of the
                    other stopping rooms rebooted (cohort_new_boot; covers the off run)
  usb_power         the C270 iokit_not_responding start_failure hits >= 2 rooms within 60 s; runs until that kiosk
                    reboots (a new boot_id), else until the recorder produces audio
  no_session_start  in clinic hours (07:00-20:00 IST) the kiosk was up (heartbeats at most 180 s apart) and the held
                    recorder.status says session_open "no" (a status holds until the next one)
evidence.cause_basis and evidence.cause_kh_event_ids say why. A cause covers the contiguous recorder_off /
device_missing intervals after it begins, until audio resumes; intervals are split where a span starts or ends.

Events come from kiosk_health.normalise_rows. UNVALIDATED: the 120 s / 3 rooms, 60 s / 2 rooms, 300 s silence, 180 s
heartbeat gap and the 07:00-20:00 clinic hours (assumed); `_clock_suspect` rows are skipped (none exist yet).
"""
from . import kiosk_health as kh
from .classify import SLIVER_S, IST, iso
from datetime import datetime

POWER_WINDOW_S, POWER_MIN_ROOMS, POWER_COHORT_BOOTS = 120.0, 3, 2
USB_WINDOW_S, USB_MIN_ROOMS = 60.0, 2
SILENCE_S = 300.0              # a kiosk-health stream silent this long is a discontinuity
HEARTBEAT_GAP_S = 180.0
CLINIC_START_H, CLINIC_END_H = 7, 20
MIN_SPAN_S = 30.0
STATUS_STALE_S = 600.0         # a held recorder.status older than this at the start of a stretch is not trusted (e.g. across a reboot)
TAPE_BEFORE_S, TAPE_AFTER_S = 330.0, 120.0   # the tape's last chunk can end up to one chunk before the kiosk stops
PLANNED_LEAD_S = 300.0         # a planned-restart marker this long before a stop (or up to the boot) explains it
USB_DEVICE = "C270 HD WEBCAM"  # the recorder input whose iokit start_failure is usb_power
RECOMPUTE_MIN_DAYS = 3         # labels must be recomputed over at least this many IST days (late kiosk rows; anchor day must be loaded)
OFFISH = ("recorder_off", "device_missing")
PRIORITY = {"power": 0, "usb_power": 1, "no_session_start": 2}


def is_iokit(ev):
    if ev["type"] == "iokit_not_responding":
        return True
    return ev["type"] == "audio.error" and ev.get("error") == "start_failure" and \
        "iokit_not_responding" in str(ev.get("detail", "")).lower()


def recompute_days_back(days_back):
    """--days-back value to use when cause labels are wired: today plus days_back days is at least RECOMPUTE_MIN_DAYS."""
    return max(int(days_back), RECOMPUTE_MIN_DAYS - 1)


def cluster_rooms(points, window, min_rooms):
    """points [(t, room)] -> {(t, room): set of rooms in the best `window`-second window holding that point, or
    empty when it has fewer than min_rooms distinct rooms}."""
    res, pts = {}, sorted(points)
    for t, room in pts:
        best = set()
        for lo in (p[0] for p in pts if p[0] <= t and t - p[0] <= window):
            rooms = {r for tt, r in pts if lo <= tt <= lo + window}
            if len(rooms) > len(best):
                best = rooms
        res[(t, room)] = best if len(best) >= min_rooms else set()
    return res


def discontinuities(events_by_room):
    """Per room: [{"stop", "last_id", "resume", "new_boot", "first_id"}]. A discontinuity is a boot_id change or a
    silence of at least SILENCE_S between events; a stream still silent at the horizon (latest event of any room)
    is one with resume None."""
    horizon = max((e["ts"] for evs in events_by_room.values() for e in evs), default=0.0)
    out = {}
    for room, evs in events_by_room.items():
        evs = sorted(evs, key=lambda e: (e["ts"], str(e["id"])))
        ds = []
        for a, b in zip(evs, evs[1:]):
            boot = bool(a.get("boot_id") and b.get("boot_id") and a["boot_id"] != b["boot_id"])
            if boot or b["ts"] - a["ts"] >= SILENCE_S:
                planned = any(e.get("planned_restart") and a["ts"] - PLANNED_LEAD_S <= e["ts"] <= b["ts"] for e in evs)
                ds.append({"stop": a["ts"], "last_id": a["id"], "resume": b["ts"], "new_boot": boot, "first_id": b["id"],
                           "planned": planned})
        if evs and horizon - evs[-1]["ts"] >= SILENCE_S:
            ds.append({"stop": evs[-1]["ts"], "last_id": evs[-1]["id"], "resume": None, "new_boot": False, "first_id": None,
                       "planned": any(e.get("planned_restart") and e["ts"] >= evs[-1]["ts"] - PLANNED_LEAD_S for e in evs)})
        out[room] = ds
    return out


def power_spans(events_by_room):
    """{room: [span]} for the power cause."""
    disc = discontinuities(events_by_room)
    # planned (steward / fleet) restarts are not power evidence, for the cohort or the room. Boot gaps cannot tell a
    # planned restart from a cut (real cut gaps were 48-93 s, real single-room reboots 53-97 s), so only markers count.
    def evidence(d):
        return not d["planned"]
    pts = [(d["stop"], room) for room, ds in disc.items() for d in ds if evidence(d)]
    near = cluster_rooms(pts, POWER_WINDOW_S, POWER_MIN_ROOMS)
    res = {}
    for room, ds in disc.items():
        for d in ds:
            if not evidence(d):
                continue
            cohort = near[(d["stop"], room)]
            if not cohort:
                continue
            if d["new_boot"]:
                basis = "own_new_boot"
            elif d["resume"] is None:
                rebooted = sum(1 for o in cohort if o != room and any(
                    x["new_boot"] and evidence(x) and abs(x["stop"] - d["stop"]) <= POWER_WINDOW_S for x in disc[o]))
                if rebooted < POWER_COHORT_BOOTS:
                    continue
                basis = "cohort_new_boot"
            else:
                continue
            ids = [d["last_id"]] + ([d["first_id"]] if d["first_id"] is not None else [])
            # power covers the dark time only: it ends when the kiosk boots again (the morning power-on)
            res.setdefault(room, []).append({"a": d["stop"], "b": d["resume"] if d["new_boot"] else None, "cause": "power",
                                             "basis": basis, "ids": ids, "anchor": True})
    return res


def usb_power_spans(events_by_room, usb_device=USB_DEVICE):
    hits = []
    for room, evs in events_by_room.items():
        for e in evs:
            if not is_iokit(e):
                continue
            if e.get("device") and not kh._matches(e["device"], usb_device):
                continue                 # the row names another device: not the C270 failure
            hits.append((e["ts"], room, e["id"], "named" if e.get("device") else "unknown_device"))
    near = cluster_rooms([(t, r) for t, r, _, _ in hits], USB_WINDOW_S, USB_MIN_ROOMS)
    disc = discontinuities(events_by_room)
    res = {}
    for t, room, eid, dev in sorted(hits):
        if not near[(t, room)]:
            continue
        reboot = next((d["resume"] for d in disc[room] if d["new_boot"] and d["stop"] >= t), None)
        res.setdefault(room, []).append({"a": t, "b": reboot, "cause": "usb_power", "basis": "iokit_start_failure_multi_room",
                                         "ids": [eid], "anchor": True,
                                         "device": "unknown_device" if dev == "unknown_device" else usb_device})
    return res


def _clinic_portions(a, b):
    """The parts of [a, b) inside 07:00-20:00 IST."""
    out, day0 = [], datetime.fromtimestamp(a, IST).replace(hour=0, minute=0, second=0, microsecond=0)
    while day0.timestamp() < b:
        lo = day0.replace(hour=CLINIC_START_H).timestamp()
        hi = day0.replace(hour=CLINIC_END_H).timestamp()
        x, y = max(a, lo), min(b, hi)
        if y - x >= MIN_SPAN_S:
            out.append((x, y))
        day0 = datetime.fromtimestamp(day0.timestamp() + 86400 + 3600, IST).replace(hour=0, minute=0, second=0, microsecond=0)
    return out


def _no_subspans(st, a, b):
    """Sub-spans of [a, b) in which the held recorder.status says session_open "no". A status holds from its ts until
    the next status; before the first status in the portion the last earlier status holds if it is at most STATUS_STALE_S
    old (unknown otherwise)."""
    st = sorted(st, key=lambda e: e["ts"])
    cuts = [a] + [e["ts"] for e in st if a < e["ts"] < b] + [b]
    out = []
    for x, y in zip(cuts, cuts[1:]):
        held = next((e for e in reversed(st) if e["ts"] <= x), None)
        if held is not None and x - held["ts"] <= STATUS_STALE_S and str(held.get("session_open")).lower() == "no":
            if out and abs(out[-1][1] - x) < 1e-6:
                out[-1] = (out[-1][0], y, out[-1][2])
            else:
                out.append((x, y, held["id"]))
    return [o for o in out if o[1] - o[0] >= MIN_SPAN_S]


def _kiosk_up(hb, a, b):
    """Heartbeats cover [a, b]: one at or before a and one at or after b, each within HEARTBEAT_GAP_S, and no gap
    between consecutive heartbeats from the first to the last above HEARTBEAT_GAP_S."""
    before = [t for t in hb if t <= a]
    after = [t for t in hb if t >= b]
    if not before or not after or a - before[-1] > HEARTBEAT_GAP_S or after[0] - b > HEARTBEAT_GAP_S:
        return False
    pts = [before[-1]] + [t for t in hb if a < t < b] + [after[0]]
    return max(y - x for x, y in zip(pts, pts[1:])) <= HEARTBEAT_GAP_S


def no_session_spans(events_by_room, by_room):
    """Clinic-hours parts of still-unlabelled recorder_off / device_missing intervals where the kiosk was up (heartbeats) and the
    recorder.status said no session was open."""
    res = {}
    for room, ivs in by_room.items():
        evs = events_by_room.get(room, [])
        hb = sorted(e["ts"] for e in evs if e["type"] == "heartbeat")
        st = [e for e in evs if e["type"] == "recorder.status"]
        for iv in ivs:
            if iv["state"] not in OFFISH or "cause" in iv["evidence"]:
                continue
            for pa, pb in _clinic_portions(iv["_a"], iv["_b"]):
                for a, b, sid in _no_subspans(st, pa, pb):
                    if not _kiosk_up(hb, a, b):
                        continue
                    res.setdefault(room, []).append({"a": a, "b": b, "cause": "no_session_start",
                                                     "basis": "heartbeats_up_session_closed", "ids": [sid], "anchor": False})
    return res


def _split(iv, a, b, label):
    """Split iv at [a, b) -> [piece]; the middle gets the label. Slivers under SLIVER_S fold into a neighbour."""
    cuts = [(iv["_a"], a, False), (a, b, True), (b, iv["_b"], False)]
    cuts = [[x, y, lab] for x, y, lab in cuts if y - x > 1e-9]
    changed = True
    while changed and len(cuts) > 1:
        changed = False
        for k, (x, y, lab) in enumerate(cuts):
            if y - x < SLIVER_S:
                j = k - 1 if k > 0 else 1
                if j < k:
                    cuts[j][1] = y
                else:
                    cuts[j][0] = x
                cuts.pop(k)
                changed = True
                break
    out = []
    for x, y, lab in cuts:
        ev = dict(iv["evidence"])
        if x > iv["_a"]:
            ev.pop("session_end", None)
        if lab:
            ev.update({"cause": label["cause"], "cause_basis": label["basis"], "cause_kh_event_ids": list(label["ids"])})
            if label.get("device"):
                ev["cause_device"] = label["device"]
        out.append({**iv, "_a": x, "_b": y, "ts_start": iso(x), "ts_end": iso(y), "evidence": ev})
    return out


def _apply(ivs, a, b, label):
    """Label the unlabelled recorder_off / device_missing time inside [a, b)."""
    out = []
    for iv in ivs:
        if iv["state"] not in OFFISH or "cause" in iv["evidence"] or iv["_b"] <= a or iv["_a"] >= b:
            out.append(iv)
            continue
        x, y = max(a, iv["_a"]), min(b, iv["_b"])
        out.extend(_split(iv, x, y, label) if y - x >= SLIVER_S else [iv])
    return out


def label_causes(by_room, events_by_room):
    """by_room: {room: [interval dicts sorted by time, across days]} (classifier output). Returns new intervals
    with evidence.cause where determined; the inputs are not mutated. Order: power, usb_power, then no_session_start
    on what is still unlabelled."""
    out = {r: [{**iv, "evidence": dict(iv["evidence"])} for iv in ivs] for r, ivs in by_room.items()}
    spans = {r: [] for r in out}
    for source in (power_spans(events_by_room), usb_power_spans(events_by_room)):
        for room, sp in source.items():
            if room in spans:
                spans[room].extend(sp)
    for room in out:
        # a usb failure before a power cut keeps usb_power up to the cut: apply it, clipped, ahead of the power label
        cuts = [p["a"] for p in spans[room] if p["cause"] == "power"]
        for sp in [s for s in spans[room] if s["cause"] == "usb_power"]:
            cut = min((c for c in cuts if c > sp["a"] and (sp["b"] is None or c < sp["b"])), default=None)
            if cut is not None:
                spans[room].append({**sp, "b": cut, "pre_power": True})
        for sp in sorted(spans[room], key=lambda s: (-1 if s.get("pre_power") else PRIORITY[s["cause"]], s["a"])):
            ivs = out[room]
            k = next((k for k, iv in enumerate(ivs) if iv["state"] in OFFISH and
                      ((iv["_a"] - TAPE_AFTER_S <= sp["a"] < iv["_b"]) or
                       (sp["a"] - TAPE_BEFORE_S <= iv["_a"] <= sp["a"] + TAPE_AFTER_S))), None)
            if k is None:
                continue
            end = k
            while end + 1 < len(ivs) and ivs[end + 1]["state"] in OFFISH and abs(ivs[end + 1]["_a"] - ivs[end]["_b"]) < 1e-3:
                end += 1
            # an off run that began long before the stop is labelled from the stop on, not from its own start
            a = ivs[k]["_a"] if ivs[k]["_a"] >= sp["a"] - TAPE_BEFORE_S else sp["a"]
            b = ivs[end]["_b"] if sp["b"] is None else min(ivs[end]["_b"], sp["b"])
            out[room] = _apply(ivs, a, b, sp)
    for room, sps in no_session_spans(events_by_room, out).items():
        for sp in sps:
            out[room] = _apply(out[room], sp["a"], sp["b"], sp)
    return out
