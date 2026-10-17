"""Read-only: check the kiosk-health fixtures against the live rows, and list every power / usb_power cohort in the
whole table (5-7 Oct) so false positives are visible. Prints counts and times only."""
import json, os, sys
from datetime import datetime, timezone
import psycopg

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ras import causes as ca, kiosk_health as kh

URL = open(os.path.expanduser("~/.config/eta-audio/db.url")).read().strip()
FX = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures")
ist = lambda t: datetime.fromtimestamp(t, timezone.utc).astimezone().strftime("%m-%d %H:%M:%S")


def main():
    with psycopg.connect(URL, connect_timeout=20) as c:
        c.read_only = True
        cur = c.cursor()
        cur.execute("""SELECT id, room_id, ts, boot_id, kind, payload FROM kiosk_health_events
                       WHERE kind IN ('heartbeat','recorder.status','audio.error','audio.devices') ORDER BY ts, id""")
        rows = [{"id": r[0], "room_id": r[1], "ts": r[2], "boot_id": r[3], "kind": r[4], "payload": r[5]} for r in cur.fetchall()]
    live = {r["id"]: r for r in rows}
    bad = checked = 0
    for name in ("kh_real_usb_06oct.json", "kh_real_power_07oct.json", "kh_real_nosession_07oct.json"):
        for fr in json.load(open(os.path.join(FX, name)))["rows"]:
            checked += 1
            lr = live.get(fr["id"])
            if lr is None or lr["room_id"] != fr["room_id"] or lr["kind"] != fr["kind"] or lr["boot_id"] != fr["boot_id"] or \
                    lr["ts"] != datetime.fromisoformat(fr["ts"]):
                bad += 1
    print(json.dumps({"fixture_rows_checked": checked, "mismatch_vs_live": bad, "live_rows_read": len(rows)}))
    ev = kh.normalise_rows(rows)
    for room, sp in sorted(ca.power_spans(ev).items()):
        for s in sp:
            print("power", room[-4:], ist(s["a"]), s["basis"])
    for room, sp in sorted(ca.usb_power_spans(ev).items()):
        for s in sp:
            print("usb_power", room[-4:], ist(s["a"]), "until", ist(s["b"]) if s["b"] else "open")
    disc = ca.discontinuities(ev)
    print("discontinuities per room:", {r[-4:]: len(v) for r, v in disc.items()})
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
