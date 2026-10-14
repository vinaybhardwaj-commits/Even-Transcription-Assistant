"""W49 /timeline: write linker's pqm_truth lane, one file per room-day, to linker's OWN directory
(~/eta-data/linker/timeline/<room_id>/<date>.json — NOT the shared timeline/<room>/<date>.json path lx
already writes for jev_loop; lab-viewer's tools/timeline_seed.py merges every owner's own directory).

Source: the CAP-1/CAP-2 links.jsonl for the day (studies/2026-09-27-clarity-scorecard/s2day/cap_link.py's
output, branch linker/w33-4). Only status confirmed|probable rows carry a room (content-matched against
the room's audio) - a token's queue record alone (queue_token_steps.routing->>'STATION_UID') does not
reliably say which physical room it was called to, which is why cap_link.py exists at all (bus #4575).
status none/no_show/cancelled therefore CANNOT be placed on any specific room's timeline this way; they
are left out here, not silently rounded to "none" (an absent row means "not processed yet" per the shape
doc, not "checked and found nothing" - see TIMELINE-SHAPES.md).

token = the queue display_id (a bare short number, e.g. "48"), never the internal token_uid and never a
patient name. start_ms/end_ms are the UNPADDED called_at/completed_at (cap_link.py pads its own span by
PAD_S=30s each side for text-matching purposes only; that padding does not belong in a queue-truth display).

Fable 15:18 (surg-link finding): a completed_at-called_at duration of EXACTLY 3600s is a PQM auto-timeout
artifact, not a real consult length. Such rows are marked `suspect: true`; consumers must never treat
end_ms-start_ms as a real consult duration for a suspect row. Reported per day on stdout.

Usage: python3 pqm_timeline.py --day 2026-09-25 --links ~/eta-data/cap/2026-09-25/links.jsonl --tokens tokens-2026-09-25.json
       python3 pqm_timeline.py --day 2026-09-26 --links ~/eta-data/cap/2026-09-26/rows.csv --rows-csv
(--tokens: a {token_uid: display_id} json map, for a day with no rows.csv on disk; --rows-csv: read
token_uid->display_id straight from that day's cap rows.csv instead.)
"""
import argparse, csv, datetime as dt, hashlib, json, os

PAD_S = 30.0  # cap_link.py's PAD_S as of linker/w33-4 (frozen span padding); read the source day's link code if this ever needs re-checking


def unpad(iso_a, iso_b):
    a = dt.datetime.fromisoformat(iso_a) + dt.timedelta(seconds=PAD_S)
    b = dt.datetime.fromisoformat(iso_b) - dt.timedelta(seconds=PAD_S)
    return int(a.timestamp() * 1000), int(b.timestamp() * 1000)


def load_display_ids(rows_csv, day):
    m = {}
    for r in csv.DictReader(open(rows_csv)):
        if r["day"] == day and r.get("display_id"):
            m.setdefault(r["token_uid"], r["display_id"])
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", required=True)
    ap.add_argument("--links", required=True, help="path to that day's links.jsonl")
    ap.add_argument("--out", default=os.path.expanduser("~/eta-data/linker/timeline"))
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--rows-csv", help="that day's cap rows.csv (has display_id)")
    src.add_argument("--tokens", help="a {token_uid: display_id} json file (when no rows.csv exists for the day)")
    a = ap.parse_args()

    disp = load_display_ids(a.rows_csv, a.day) if a.rows_csv else json.load(open(a.tokens))
    src_sha = hashlib.sha256(open(a.links, "rb").read()).hexdigest()

    by_room = {}
    skipped_no_display = []
    for line in open(a.links):
        l = json.loads(line)
        if l["status"] not in ("confirmed", "probable") or not l.get("room"):
            continue
        tok = disp.get(l["consult_id"])
        if not tok:
            skipped_no_display.append(l["consult_id"]); continue
        s_ms, e_ms = unpad(l["span"][0], l["span"][1])
        suspect = (e_ms - s_ms) == 3600_000                # Fable 15:18/surg-link: an exact 3600s PQM auto-timeout, not a real consult
        by_room.setdefault(l["room"], []).append(dict(start_ms=s_ms, end_ms=e_ms, token=tok, status=l["status"], suspect=suspect))

    os.makedirs(a.out, mode=0o700, exist_ok=True)
    written = []
    for room, rows in by_room.items():
        rows.sort(key=lambda r: r["start_ms"])
        d = os.path.join(a.out, room)
        os.makedirs(d, mode=0o700, exist_ok=True); os.chmod(d, 0o700)
        p = os.path.join(d, a.day + ".json")
        json.dump(dict(schema=1, room_id=room, date=a.day, source_sha256=src_sha, pqm_truth=rows), open(p, "w"), indent=1)
        os.chmod(p, 0o600)
        written.append((room, len(rows)))
    os.chmod(a.out, 0o700)

    suspect_count = sum(1 for rows in by_room.values() for r in rows if r["suspect"])
    print(json.dumps(dict(day=a.day, rooms_written=len(written), rows_written=sum(n for _, n in written),
                           by_room={r: n for r, n in sorted(written)}, skipped_no_display_id=len(skipped_no_display),
                           suspect_3600s_timeouts=suspect_count)))


if __name__ == "__main__":
    main()
