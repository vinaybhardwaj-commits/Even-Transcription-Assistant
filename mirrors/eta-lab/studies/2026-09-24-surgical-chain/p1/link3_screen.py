"""link3_screen.py: piece C of the link-3 translated stratum (ruling 222, linker #1100).

Counts the intelligibility screen and assembles the translated stratum's scoring input. Reads box-only files and writes counts only to stdout / --counts-out:

  mt/translated.json  A's output: list of {item, room, i, lang, at, en, q, dropped?}; q is Gemini's own flag: "ok" | "garbled" | "untranslatable"; at = ISO time of the HIST turn (linker #1122)
  mt/deid.json        the same records plus en_deid (the de-identified English; deid passes `at` through); nothing is scored that has not been through deid
  mt/screened.json    OUT (box, 0600): translated.json's records with dropped (bool) and drop_reason set. A never writes `dropped`; only C does
  mt/score_input.json OUT (box, 0600): the kept turns, en = en_deid, grouped item -> room, every record tagged stratum = "translated"

Rules (linker #1100): kept = q "ok". Any other q, or a missing q, is dropped: "garbled", "untranslatable", "unflagged". No length cuts. A kept turn needs en_deid AND at, or nothing is written (fail closed). An item with zero kept turns is INCOMPLETE. Nothing is dropped silently: the counts carry a
dropped-turn table of (item, room, i, reason). Stdout, the counts file and the table carry ids and numbers, never turn text.

  python3 link3_screen.py --mt-dir ~/eta-data/surgical-chain/p1/mt [--counts-out counts.json]

--mt-dir is required (no default: v7.15 and piece B use ~/eta-data/surgical-chain/p1/mt/, and a wrong default would screen the wrong tree).
An item that failed MT is absent from translated.json and so absent from this report; the integration adapter must reconcile against A's per-item provenance so a failed item is reported, never silently absent.
A stale score_input.json is removed before every run, and the new one is written under a temp name and renamed into place, and only when the run is not BLOCKED: a BLOCKED run never leaves a scoring input behind (an INCOMPLETE item just has no entry in it).
"""
import argparse, collections, json, os, sys

STRATUM = "translated"
REASONS = ("garbled", "untranslatable", "unflagged")
OK_Q = "ok"


def key(r):
    return (r["item"], r["room"], int(r["i"]))


def reason_for(q):
    """None when the turn is kept, else the drop reason. A missing or unknown q is 'unflagged' (never a silent pass)."""
    if q == OK_Q:
        return None
    return q if q in ("garbled", "untranslatable") else "unflagged"


def screen(translated):
    """translated -> (screened records with dropped/drop_reason set, report). Counts only; no text in the report."""
    screened = []
    per = collections.OrderedDict()
    table = []
    for r in sorted(translated, key=key):
        why = reason_for(r.get("q"))
        s = dict(r, dropped=why is not None, drop_reason=why)
        screened.append(s)
        c = per.setdefault(r["item"], dict(turns_in=0, dropped=dict.fromkeys(REASONS, 0), kept=0))
        c["turns_in"] += 1
        if why is None:
            c["kept"] += 1
        else:
            c["dropped"][why] += 1
            table.append(dict(item=r["item"], room=r["room"], i=int(r["i"]), reason=why))
    for c in per.values():
        c["status"] = "OK" if c["kept"] else "INCOMPLETE"
    total = dict(turns_in=sum(c["turns_in"] for c in per.values()), kept=sum(c["kept"] for c in per.values()),
                 dropped={r: sum(c["dropped"][r] for c in per.values()) for r in REASONS})
    report = dict(stratum=STRATUM, items=per, total=total, incomplete_items=sorted(i for i, c in per.items() if c["status"] == "INCOMPLETE"), dropped_table=table)
    return screened, report


def check_stratum(records):
    """Fails (ValueError) if any record lacks the 'translated' stratum tag."""
    bad = sum(1 for r in records if r.get("stratum") != STRATUM)
    if bad:
        raise ValueError(f"{bad} record(s) without stratum={STRATUM!r}")


def guard_pooled(records):
    """The pooled (native) stratum input must hold no translated record: raises if one is present."""
    bad = sum(1 for r in records if r.get("stratum") == STRATUM)
    if bad:
        raise ValueError(f"{bad} translated record(s) in the pooled (native) stratum input")


def assemble(screened, deid):
    """Kept turns -> {item: {room: {"id": room, "turns": [...]}}} using en_deid only. Returns (score_input, missing_deid_count, missing_at_count).
    A kept turn with no en_deid, or no `at`, is NOT scored (fail closed): the counts come back and the caller must refuse to write."""
    by_key = {key(r): r for r in deid}
    out = collections.OrderedDict()
    missing = 0
    missing_at = 0
    for r in screened:
        if r["dropped"]:
            continue
        d = by_key.get(key(r))
        if d is None or not isinstance(d.get("en_deid"), str):
            missing += 1
            continue
        at = r.get("at") if r.get("at") is not None else d.get("at")               # A writes it, deid passes it through; link3_run.stage_score filters on it
        if not isinstance(at, str) or not at:
            missing_at += 1
            continue
        turn = dict(i=int(r["i"]), en=d["en_deid"], lang=r.get("lang"), at=at, stratum=STRATUM)
        out.setdefault(r["item"], collections.OrderedDict()).setdefault(r["room"], dict(id=r["room"], stratum=STRATUM, turns=[]))["turns"].append(turn)
    return out, missing, missing_at


def _write_private(path, obj, indent=None):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent)
    os.chmod(path, 0o600)


def write_score_input(path, score_input):
    """The translated input lives only in an `mt/` directory, never beside the pooled raw/ or deid/ inputs.
    Written under a temp name and renamed, so a failure part-way never leaves a half-written or stale file."""
    if os.path.basename(os.path.dirname(os.path.abspath(path))) != "mt":
        raise ValueError("score_input must be written inside an mt/ directory")
    flat = [t for rooms in score_input.values() for room in rooms.values() for t in room["turns"]]
    check_stratum(flat)
    tmp = path + ".tmp"
    _write_private(tmp, score_input)
    os.replace(tmp, path)


def run(mt_dir, counts_out=None):
    stale = os.path.join(mt_dir, "score_input.json")
    for leftover in (stale, stale + ".tmp"):
        if os.path.exists(leftover):
            os.remove(leftover)                               # fail closed: whatever this run decides, no older scoring input survives it
    with open(os.path.join(mt_dir, "translated.json")) as f:
        translated = json.load(f)
    with open(os.path.join(mt_dir, "deid.json")) as f:
        deid = json.load(f)
    screened, report = screen(translated)
    score_input, missing, missing_at = assemble(screened, deid)
    report["kept_without_deid"] = missing
    report["kept_without_at"] = missing_at
    _write_private(os.path.join(mt_dir, "screened.json"), screened)
    if missing or missing_at:
        report["status"] = "BLOCKED_NO_DEID" if missing else "BLOCKED_NO_AT"     # nothing un-deidentified or un-timed is ever scored; score_input.json is not written
    else:
        report["status"] = "INCOMPLETE" if report["incomplete_items"] else "OK"
        write_score_input(stale, score_input)                 # an INCOMPLETE item simply has no entry; a BLOCKED run wrote nothing
    text = json.dumps(report, indent=1)
    if counts_out:
        _write_private(counts_out, report, indent=1)          # yoga-drain F4: every output file is 0600, the counts file included
    print(text)
    return report


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--mt-dir", required=True)
    ap.add_argument("--counts-out")
    a = ap.parse_args()
    sys.exit(0 if run(a.mt_dir, a.counts_out)["status"] == "OK" else 1)
