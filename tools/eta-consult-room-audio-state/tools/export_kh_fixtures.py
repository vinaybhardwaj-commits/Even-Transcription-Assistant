"""Export small, patient-free kiosk_health_events slices (read-only SELECTs) as test fixtures.
Keeps only the fields the cause labelling needs; no recorder.log lines, no hid, no chrome, no process/window text."""
import json, os, sys
import psycopg

OUT = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures")
URL = open(os.path.expanduser("~/.config/eta-audio/db.url")).read().strip()


def trim(kind, p):
    p = p or {}
    if kind == "audio.error":
        return {k: p.get(k) for k in ("class", "code_name", "detail", "start_failure")}
    if kind == "audio.devices":
        names = lambda l: None if l is None else [{"name": d.get("name")} for d in l if isinstance(d, dict)]
        return {"trigger": p.get("trigger"), "usb_added": names(p.get("usb_added")), "usb_removed": names(p.get("usb_removed")),
                "devices": names(p.get("devices")), "usb_audio": names(p.get("usb_audio"))}
    if kind == "recorder.status":
        return {"state": p.get("state"), "session_open": p.get("session_open")}
    return {}


def rows(cur, sql, args=()):
    cur.execute(sql, args)
    return [{"id": r[0], "room_id": r[1], "ts": r[2].isoformat(), "boot_id": r[3], "kind": r[4], "payload": trim(r[4], r[5])}
            for r in cur.fetchall()]


def main():
    with psycopg.connect(URL, connect_timeout=20) as c:
        c.read_only = True
        cur = c.cursor()
        cols = "id, room_id, ts, boot_id, kind, payload"
        usb = rows(cur, f"""SELECT {cols} FROM kiosk_health_events WHERE room_id IN ('room_ux92qpws','room_d74hhmc4')
              AND ts BETWEEN '2026-10-06 11:30+00' AND '2026-10-06 12:30+00'
              AND kind IN ('audio.error','audio.devices','recorder.status','heartbeat') ORDER BY ts, id""")
        horizon = rows(cur, f"SELECT {cols} FROM kiosk_health_events ORDER BY ts DESC, id DESC LIMIT 1")[0]["ts"]
        # one heartbeat per room per 3 minutes over 18:30Z-04:15Z keeps every stream gap below the 300 s silence line;
        # every heartbeat from 18:40Z to 18:50Z so the cut itself is exact
        power = rows(cur, f"""SELECT {cols} FROM kiosk_health_events WHERE id IN (
              SELECT min(id) FROM kiosk_health_events WHERE kind = 'heartbeat'
                AND ts BETWEEN '2026-10-06 18:30+00' AND '2026-10-07 05:30+00'
              GROUP BY room_id, floor(extract(epoch FROM ts) / 180))
              OR (kind = 'heartbeat' AND ts BETWEEN '2026-10-06 18:40+00' AND '2026-10-06 18:50+00')
              ORDER BY ts, id""")
        nosess = rows(cur, f"""SELECT {cols} FROM kiosk_health_events WHERE kind IN ('heartbeat','recorder.status')
              AND ts BETWEEN '2026-10-07 00:30+00' AND '2026-10-07 05:30+00' ORDER BY ts, id""")
    for name, data in (("kh_real_usb_06oct.json", usb), ("kh_real_power_07oct.json", power), ("kh_real_nosession_07oct.json", nosess)):
        json.dump({"_note": "Real kiosk_health_events rows, trimmed to the fields the cause labelling needs (read-only export)",
                   "horizon": horizon, "rows": data}, open(os.path.join(OUT, name), "w"), indent=0)
        print(name, len(data))


if __name__ == "__main__":
    main()
