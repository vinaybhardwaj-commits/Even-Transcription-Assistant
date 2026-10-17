"""Writer: shadow-classifier intervals -> Neon room_audio_state / room_audio_day (GATING migration 0129).

Per (room_id, ist_day) ONE transaction: DELETE the room-day, INSERT its intervals, assert in SQL that they are
contiguous, non-overlapping and sum to exactly 86400 s, UPSERT room_audio_day, commit. Any failure rolls the
room-day back and is logged (never the credential).

    python ras_write.py --dry-run                       # counts only, no writes
    python ras_write.py --since 2026-09-19              # backfill to today
    python ras_write.py --days-back 1                   # today and yesterday (hourly job)
"""
import argparse, collections, json, logging, os, sys
from datetime import datetime, timedelta

from ras.classify import IST, VERSION, parse_ts
from ras.run import run as run_classifier

CRED = os.path.expanduser("~/.config/eta-audio/db.url")
TAPES = os.path.expanduser("~/eta-data/tapes")
log = logging.getLogger("ras_write")

STATE_COL = {"recorder_off": "min_off", "muted": "min_muted", "zero_all_day": "min_zero_all_day",
             "audio_present": "min_present", "audio_gated": "min_gated", "withheld": "min_withheld"}
# voice_isolation_gated has no Neon state yet (room_audio_state_state_check lists only the older states): it is written as
# audio_gated with evidence.gated_reason ["voice_isolation"] and evidence.state_detail, until a migration adds the state.
NEON_STATE = {"voice_isolation_gated": "audio_gated"}
DAY_COLS = tuple(STATE_COL.values())

DELETE_SQL = "DELETE FROM room_audio_state WHERE room_id = %s AND ist_day = %s"
INSERT_SQL = ("INSERT INTO room_audio_state (room_id, machine, source, ist_day, state, ts_start, ts_end, evidence, "
              "classifier_version) VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)")
# the in-transaction guard: contiguous, non-overlapping, exactly 86400 s, spanning the IST day
CHECK_SQL = """
WITH s AS (
  SELECT ts_start, ts_end, lag(ts_end) OVER (ORDER BY ts_start) AS prev_end
  FROM room_audio_state WHERE room_id = %(room)s AND ist_day = %(day)s::date)
SELECT count(*) > 0
   AND coalesce(sum(extract(epoch FROM ts_end - ts_start)), 0) = 86400
   AND min(ts_start) = (%(day)s::date::timestamp AT TIME ZONE 'Asia/Kolkata')
   AND max(ts_end) = ((%(day)s::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
   AND coalesce(bool_and(prev_end IS NULL OR prev_end = ts_start), false) AS ok,
   count(*) AS n
FROM s"""
UPSERT_SQL = """
INSERT INTO room_audio_day (room_id, ist_day, min_off, min_muted, min_zero_all_day, min_present, min_gated,
  min_withheld, consult_min_usable, consult_min_uncertain, consult_min_lost, n_consults, classifier_version, written_at)
VALUES (%(room_id)s, %(ist_day)s, %(min_off)s, %(min_muted)s, %(min_zero_all_day)s, %(min_present)s, %(min_gated)s,
  %(min_withheld)s, %(consult_min_usable)s, %(consult_min_uncertain)s, %(consult_min_lost)s, %(n_consults)s,
  %(classifier_version)s, now())
ON CONFLICT (room_id, ist_day) DO UPDATE SET
  min_off = EXCLUDED.min_off, min_muted = EXCLUDED.min_muted, min_zero_all_day = EXCLUDED.min_zero_all_day,
  min_present = EXCLUDED.min_present, min_gated = EXCLUDED.min_gated, min_withheld = EXCLUDED.min_withheld,
  consult_min_usable = EXCLUDED.consult_min_usable, consult_min_uncertain = EXCLUDED.consult_min_uncertain,
  consult_min_lost = EXCLUDED.consult_min_lost, n_consults = EXCLUDED.n_consults,
  classifier_version = EXCLUDED.classifier_version, written_at = now()"""
WINDOWS_SQL = "SELECT room_slug, machine, t_open, t_close FROM eta_encounter_windows WHERE t_close IS NOT NULL"


class GuardFailed(Exception):
    pass


def load_url():
    return open(CRED).read().strip()   # never printed or logged


def source_for(slug):
    """OT boxes (ot-*, orb*) are Linux 'ot'; consultation-room kiosks are 'kiosk'. Judgement, see REPORT-audio-07."""
    return "ot" if slug and (slug.startswith("ot-") or slug.startswith("orb")) else "kiosk"


def room_slugs():
    out = {}
    for l in open(os.path.join(TAPES, "manifest.jsonl")):
        r = json.loads(l)
        out[r["room_id"]] = r["r2_key"].split("/")[1]
    return out


def split_minutes(seconds_by_state, total=1440):
    """Whole minutes per day column that sum to exactly `total` (largest remainder)."""
    raw = {c: seconds_by_state.get(c, 0.0) / 60.0 for c in DAY_COLS}
    out = {c: int(v) for c, v in raw.items()}
    left = total - sum(out.values())
    for c in sorted(raw, key=lambda c: raw[c] - out[c], reverse=True)[:max(left, 0)]:
        out[c] += 1
    return out


def consult_minutes(ivs, windows):
    """usable / uncertain / lost minutes and count of closed windows. Time on withheld days is excluded from all three."""
    u = g = l = 0.0
    for a, b in windows:
        for iv in ivs:
            o = max(0.0, min(b, iv["_b"]) - max(a, iv["_a"]))
            if not o:
                continue
            if iv["state"] == "audio_present":
                u += o
            elif iv["state"] in ("audio_gated", "voice_isolation_gated"):
                g += o
            elif iv["state"] != "withheld":
                l += o
    return round(u / 60), round(g / 60), round(l / 60)


def neon_evidence(iv):
    ev = iv["evidence"]
    return {**ev, "state_detail": iv["state"]} if iv["state"] in NEON_STATE else ev


def build_room_days(allint, windows_by_room, machine_by_room, slugs, days=None):
    """-> list of dicts {room_id, ist_day, intervals(rows), day(row), n}."""
    out = []
    for room, ivs in sorted(allint.items()):
        byday = collections.defaultdict(list)
        for iv in ivs:
            byday[iv["ist_day"]].append(iv)
        wins = windows_by_room.get(room, [])
        for day, lst in sorted(byday.items()):
            if days is not None and day not in days:
                continue
            secs = collections.Counter()
            for iv in lst:
                secs[STATE_COL[NEON_STATE.get(iv["state"], iv["state"])]] += iv["_b"] - iv["_a"]
            todays = [(a, b) for a, b in wins if datetime.fromtimestamp(a, IST).strftime("%Y-%m-%d") == day]
            cu, cg, cl = consult_minutes(ivs, todays)
            row = {"room_id": room, "ist_day": day, **split_minutes(secs), "consult_min_usable": cu,
                   "consult_min_uncertain": cg, "consult_min_lost": cl, "n_consults": len(todays),
                   "classifier_version": VERSION}
            src, mach = source_for(slugs.get(room)), machine_by_room.get(room)
            rows = [(room, mach, src, day, NEON_STATE.get(iv["state"], iv["state"]), iv["ts_start"], iv["ts_end"],
                     json.dumps(neon_evidence(iv), separators=(",", ":")), VERSION) for iv in lst]
            out.append({"room_id": room, "ist_day": day, "rows": rows, "day": row})
    return out


def fetch_windows(conn, slugs):
    """closed eta_encounter_windows -> ({room_id: [(t_open, t_close) epoch]}, {room_id: machine})"""
    slug2room = {v: k for k, v in slugs.items()}
    wins, mach = collections.defaultdict(list), {}
    with conn.cursor() as cur:
        cur.execute(WINDOWS_SQL)
        for slug, machine, t0, t1 in cur.fetchall():
            room = slug2room.get(slug)
            if room is None:
                continue
            wins[room].append((t0.timestamp(), t1.timestamp()))
            mach[room] = machine
    return wins, mach


def write_room_day(conn, rd):
    """One transaction per room-day. Returns True on commit, False after a logged rollback."""
    room, day = rd["room_id"], rd["ist_day"]
    try:
        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute(DELETE_SQL, (room, day))
                cur.executemany(INSERT_SQL, rd["rows"])
                cur.execute(CHECK_SQL, {"room": room, "day": day})
                ok, n = cur.fetchone()
                if not ok or n != len(rd["rows"]):
                    raise GuardFailed(f"guard failed: ok={ok} rows_in_db={n} rows_expected={len(rd['rows'])}")
                cur.execute(UPSERT_SQL, rd["day"])
        return True
    except Exception as e:  # rolled back by the transaction context
        log.error("ROLLBACK %s %s: %s", room, day, type(e).__name__ + ": " + str(e)[:200])
        return False


def days_for(args):
    today = datetime.now(IST).date()
    if args.days_back is not None:
        return {(today - timedelta(days=k)).isoformat() for k in range(args.days_back + 1)}
    since = datetime.fromisoformat(args.since).date()
    return {(since + timedelta(days=k)).isoformat() for k in range((today - since).days + 1)}


def begin_writes(conn):
    """End the implicit transaction opened by the windows read, then run in autocommit so that each room-day's
    conn.transaction() is a real BEGIN/COMMIT. Without this the room-day transactions are savepoints inside one
    outer transaction and nothing is durable until the connection closes (a killed run would lose everything)."""
    conn.commit()
    conn.autocommit = True


def write_all(conn, rds):
    """Write room-days one after another, each committed on its own. -> (committed, rolled_back)"""
    good = 0
    for rd in rds:
        good += bool(write_room_day(conn, rd))
    return good, len(rds) - good


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--since", default="2026-09-19")
    ap.add_argument("--days-back", type=int, default=None, help="only today and this many days before")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    allint = run_classifier()
    slugs = room_slugs()
    import psycopg
    with psycopg.connect(load_url(), connect_timeout=20) as conn:
        wins, mach = fetch_windows(conn, slugs)
        rds = build_room_days(allint, wins, mach, slugs, days_for(args))
        counts = collections.Counter()
        for rd in rds:
            for r in rd["rows"]:
                counts[r[4]] += 1
        summary = {"room_days": len(rds), "intervals": sum(len(r["rows"]) for r in rds),
                   "rooms": len({r["room_id"] for r in rds}), "by_state": dict(counts),
                   "closed_windows_read": sum(len(v) for v in wins.values()), "dry_run": args.dry_run}
        if args.dry_run:
            print(json.dumps(summary))
            return 0
        begin_writes(conn)
        good, bad = write_all(conn, rds)
    summary.update({"committed_room_days": good, "rolled_back": bad})
    print(json.dumps(summary))
    log.info("RUN room_days=%d committed=%d rolled_back=%d intervals=%d", summary["room_days"], good, bad,
             summary["intervals"])
    main.last = summary
    return 0 if bad == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
