#!/usr/bin/python3
"""Build ~/eta-data/consult/clip-index/patients.json: consult_uid -> patient name (cache; dir 0700, file 0600).

Join (all read-only):
  1. Neon  eta_encounter_windows.consult_uid -> warehouse_prescription_uid (else prescription_ref)     [--fetch-windows]
  2. Metabase db 13 (company warehouse):
       SELECT p.uid, p."timestamp", p._parent_id, i.first_name, i.last_name, i.display_name
       FROM "individuals-prescriptions" p LEFT JOIN individuals i ON i._id = p._parent_id
       WHERE p.uid IN (<prescription ids>)
     saved as a pipe-separated file:  uid|timestamp|first_name|last_name|display_name   (--psv)
Run with the cutter venv for --fetch-windows (psycopg); the merge step is standard library only.
"""
import argparse, datetime as dt, json, os, re, sys, tempfile

HOME = os.path.expanduser("~")
OUT_DIR = os.path.join(HOME, "eta-data", "consult", "clip-index")
CUTTER = os.path.join(HOME, "oc", "consult", "cutter")
INDEX = os.path.join(HOME, "eta-data", "consult", "clips", "index.jsonl")
SOURCE = "metabase:db13 individuals-prescriptions.uid -> individuals._id=_parent_id (first_name last_name)"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
PHONEISH = re.compile(r"^[\d\s+()-]{6,}$")


def clean_name(first, last, display=""):
    """'First Last'; drops phone-number-looking and bare-punctuation parts; falls back to display_name; None if nothing usable."""
    parts = []
    for p in (first, last):
        p = " ".join((p or "").split())
        if not p or PHONEISH.match(p) or not re.search(r"[^\W\d_]", p):
            continue
        parts.append(p)
    name = " ".join(parts)
    if not name:
        d = " ".join((display or "").split())
        name = "" if PHONEISH.match(d) else d
    return name or None


def ist_open(v):
    """Neon t_open (aware datetime or ISO string; naive = UTC) -> IST wall-clock 'YYYY-MM-DD HH:MM:SS', or None."""
    try:
        d = v if isinstance(v, dt.datetime) else dt.datetime.fromisoformat(str(v))
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return d.astimezone(IST).strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return None


def read_psv(path):
    """-> {prescription_uid: {name, ts}}"""
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            c = (line.split("|") + [""] * 5)[:5]
            out[c[0]] = {"name": clean_name(c[2], c[3], c[4]), "ts": c[1]}
    return out


def latest_cut_uids(index_path=INDEX):
    latest = {}
    with open(index_path, encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if isinstance(r, dict) and r.get("consult_uid"):
                latest[r["consult_uid"]] = r
    return [u for u, r in latest.items() if r.get("status") == "cut"]


def fetch_windows(uids):
    """Neon (read-only, via the cutter's own connector) -> {consult_uid: [{warehouse_prescription_uid, prescription_ref}]}"""
    sys.dont_write_bytecode = True
    sys.path.insert(0, CUTTER)
    from psycopg.rows import dict_row
    from cutter import db
    with db.connect(row_factory=dict_row) as c:
        rows = c.execute("select consult_uid, warehouse_prescription_uid, prescription_ref, t_open from eta_encounter_windows where consult_uid = any(%s)", (uids,)).fetchall()
    out = {}
    for r in rows:
        out.setdefault(r["consult_uid"], []).append({"warehouse_prescription_uid": r["warehouse_prescription_uid"], "prescription_ref": r["prescription_ref"], "t_open": r["t_open"]})
    return out


def merge(uids, windows, names):
    res = {}
    for u in uids:
        opened = next((o for o in (ist_open(w.get("t_open")) for w in windows.get(u, []) if w.get("t_open")) if o), None)
        cands = []
        for w in windows.get(u, []):
            for via in ("warehouse_prescription_uid", "prescription_ref"):
                if w.get(via) and (w[via], via) not in cands:
                    cands.append((w[via], via))
        hit = next(((pid, via) for pid, via in cands if names.get(pid, {}).get("name")), None)
        if hit:
            pid, via = hit
            res[u] = {"patient_name": names[pid]["name"], "source": SOURCE, "matched_on": {"prescription_uid": pid, "via": via},
                      "prescription_ts": names[pid]["ts"], "called_at": None, "window_t_open_ist": opened}
        else:
            reason = "no prescription id on the window" if not cands else "prescription id not found in warehouse (or no usable name)"
            res[u] = {"patient_name": None, "source": None, "matched_on": None, "reason": reason, "window_t_open_ist": opened}
    return res


def write_private(path, obj):
    d = os.path.dirname(path)
    os.makedirs(d, mode=0o700, exist_ok=True)  # the default dir is already 0700; an explicit --out dir is left as the caller made it
    fd, tmp = tempfile.mkstemp(prefix=".p-", dir=d)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=0, sort_keys=True)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--psv", required=True)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--windows", help="JSON {consult_uid: [{warehouse_prescription_uid, prescription_ref, ...}]} (e.g. presc-map.json)")
    g.add_argument("--fetch-windows", action="store_true")
    ap.add_argument("--index", default=INDEX)
    ap.add_argument("--out", default=os.path.join(OUT_DIR, "patients.json"))
    a = ap.parse_args(argv)
    uids = latest_cut_uids(a.index)
    windows = fetch_windows(uids) if a.fetch_windows else json.load(open(a.windows, encoding="utf-8"))
    res = merge(uids, windows, read_psv(a.psv))
    write_private(a.out, res)
    m = sum(1 for v in res.values() if v["patient_name"])
    print("patients.json: %d matched / %d cut consults" % (m, len(res)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
