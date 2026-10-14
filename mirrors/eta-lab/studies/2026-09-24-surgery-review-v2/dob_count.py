#!/usr/bin/env python3
"""dob_count.py — COUNTS-ONLY, regex-only (no model) counter for the partial-date-of-birth shapes added in deid.py (day-month next to a birth cue, its repeats, 'born <month>',
numeric day-month after an unambiguous cue). It sizes the gap found in LINK3 b3 (c028|l3-c028-r2|2) over stored files, so Fable can decide what to regenerate.

  dob_count.py --field en FILE ...                       # RAW files: turns the new rules would tag (what a regenerate would change)
  dob_count.py --field en_deid FILE ...                  # de-identified files: EVERY turn in the file that still holds a shape. This is NOT "what was sent":
                                                         # a file also holds greyed context, garbled and dropped turns that never reached Jev.
  dob_count.py --field en_deid --sent-keys KEYS.json [--sent-entry NAME] FILE ...
                                                         # only the turns whose key is in KEYS: the SENT figure (surgery: fleet's surgery_sent_turn_keys.json,
                                                         # entry e.g. final-v5fresh/deid_r1; link-3: pass a batch's score_input.json as FILE, no keys needed)
Inputs: a consult {id, turns:[{i, ...}]} (key "<file stem>#i", fleet's basis; --key-by id uses the internal id instead), a record list [{item, room, i, ...}] (key "item|room|i"), or a link-3 score_input.json
{item: {room: {turns:[{i, ...}]}}} (key "item|room|i"; every turn in it was scored). KEYS.json: a list of keys, {"sent_turn_keys": [...]}, or {entry: {"sent_turn_keys": [...]}}.
Prints one JSON line per file and a TOTAL; --keys adds the hit keys (ids only). It never prints, logs or writes any transcript text, and writes no file.
WITH A SCOPE IT FAILS CLOSED (exit 2, after printing every row): a scope that matches nothing must not read as clean. It is an error when the keys file lists keys for this file's other
key basis (stem vs id), when the scope lists keys for the file that are not all found in it, when a record-list/score_input file matches no scope key at all, or when the WHOLE
run has turns_in_scope == 0 (a wrong --sent-entry reads every file as a legitimate zero). The TOTAL also reports unmatched_scope_keys/unmatched_stems: scope keys whose file was not processed
(harmless when you run a subset of files, a red flag when you meant to run them all).
Needs deid.py from the same directory (the successor blob)."""
import argparse, json, os, re, sys

import deid

NUMERIC = re.compile(rf"(?i)(?<!\w){deid._NUMCUE}(?!\w)[^\n]{{0,30}}?{deid._NUMDM}")
MONTH_ONLY = re.compile(rf"(?i)\bborn\b[^.\n]{{0,20}}?\b{deid._MONFULL}\b")


def shapes(text):
    """Which new shapes occur in this text: a set of 'daymonth', 'numeric', 'monthonly'."""
    out = set()
    if deid.partial_dob_spans(text):
        out.add("daymonth")
    if NUMERIC.search(text):
        out.add("numeric")
    if MONTH_ONLY.search(text):
        out.add("monthonly")
    return out


def turns_of(path, key_by="stem"):
    """Return (turns, meta): turns = [(key, turn)], meta = {'kind', 'stem', 'id'}. A consult's key is "<stem or id>#i"."""
    with open(path) as fh:
        doc = json.load(fh)
    stem = os.path.basename(path).rsplit(".", 1)[0]
    if isinstance(doc, list):
        return [(f"{t.get('item', stem)}|{t.get('room', '')}|{t['i']}", t) for t in doc], {"kind": "records", "stem": stem, "id": None}
    if isinstance(doc, dict) and "turns" in doc:
        cid = doc.get("id", stem)
        base = stem if key_by == "stem" else cid
        return [(f"{base}#{t['i']}", t) for t in doc["turns"]], {"kind": "consult", "stem": stem, "id": cid}
    if isinstance(doc, dict):  # score_input.json: item -> room -> {turns: [...]}
        out = []
        for item, rooms in doc.items():
            if not isinstance(rooms, dict) or not all(isinstance(r, dict) and "turns" in r for r in rooms.values()):
                raise ValueError("unsupported file shape: not a consult, a record list or a score_input")
            for room, obj in rooms.items():
                out += [(f"{item}|{room}|{t['i']}", t) for t in obj["turns"]]
        return out, {"kind": "score_input", "stem": stem, "id": None}
    raise ValueError("unsupported file shape")


def load_scope(path, entry):
    with open(path) as fh:
        doc = json.load(fh)
    if isinstance(doc, list):
        return set(doc)
    if isinstance(doc, dict) and "sent_turn_keys" in doc:
        return set(doc["sent_turn_keys"])
    if isinstance(doc, dict) and entry in doc and isinstance(doc[entry], dict) and "sent_turn_keys" in doc[entry]:
        return set(doc[entry]["sent_turn_keys"])
    names = sorted(k for k, v in doc.items() if isinstance(v, dict) and "sent_turn_keys" in v) if isinstance(doc, dict) else []
    sys.exit(f"--sent-entry must name one of {names}" if names else "unsupported --sent-keys file shape")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+"); ap.add_argument("--field", required=True, help="turn field to scan, e.g. en, en_deid, orig, text")
    ap.add_argument("--sent-keys", default=None, help="restrict counting to the turns whose key is listed (the SENT set)")
    ap.add_argument("--sent-entry", default=None, help="entry name inside a --sent-keys file that holds several sets")
    ap.add_argument("--key-by", choices=("stem", "id"), default="stem", help="consult key basis: the FILE STEM (default, fleet's) or the internal id")
    ap.add_argument("--keys", action="store_true", help="also print the keys of turns with a hit; ids only")
    a = ap.parse_args(argv)
    scope = load_scope(a.sent_keys, a.sent_entry) if a.sent_keys else None
    tot = {"files": 0, "turns": 0, "turns_in_scope": 0, "turns_hit": 0, "daymonth": 0, "numeric": 0, "monthonly": 0}
    failed = []
    seen_prefixes = set()
    for f in a.files:
        turns, meta = turns_of(f, a.key_by)
        n = in_scope = hit = 0; c = {"daymonth": 0, "numeric": 0, "monthonly": 0}; keys = []
        for key, t in turns:
            n += 1
            if scope is not None and key not in scope:
                continue
            in_scope += 1
            text = t.get(a.field)
            if not isinstance(text, str):  # a missing field is counted as a turn and never hits (an empty string has no shape either)
                continue
            sh = shapes(text)
            if sh:
                hit += 1; keys.append(key)
                for s_ in sh:
                    c[s_] += 1
        row = {"file": os.path.basename(f), "turns": n, "turns_in_scope": in_scope, "turns_hit": hit, **c}
        seen_prefixes.update(k.split("#", 1)[0] if meta["kind"] == "consult" else k.split("|", 1)[0] for k, _ in turns)
        if meta["kind"] == "consult":
            row["key_basis"] = a.key_by
        if scope is not None:
            problem = None
            if meta["kind"] == "consult":
                mine, other = (meta["stem"], meta["id"]) if a.key_by == "stem" else (meta["id"], meta["stem"])
                listed = sum(1 for k in scope if k.startswith(mine + "#"))
                listed_other = sum(1 for k in scope if k.startswith(other + "#")) if other != mine else 0
                row["scope_keys_for_this_file"] = listed
                if listed == 0 and listed_other > 0:
                    problem = "the keys file lists keys for this file under the OTHER key basis (stem vs id)"
                elif listed != in_scope:
                    problem = "the scope lists keys for this file that are not all found in it (or the reverse)"
            elif n > 0 and in_scope == 0:
                problem = "no turn of this file is in the scope"
            if problem:
                row["FAILED"] = problem; failed.append(os.path.basename(f))
        if a.keys:
            row["keys"] = keys
        print(json.dumps(row))
        tot["files"] += 1; tot["turns"] += n; tot["turns_in_scope"] += in_scope; tot["turns_hit"] += hit
        for k in c:
            tot[k] += c[k]
    tot["failed_files"] = len(failed)
    if scope is not None:
        unmatched = sorted({(k.split("#", 1)[0] if "#" in k else k.split("|", 1)[0]) for k in scope} - seen_prefixes)
        tot["unmatched_scope_keys"] = sum(1 for k in scope if (k.split("#", 1)[0] if "#" in k else k.split("|", 1)[0]) not in seen_prefixes)
        tot["unmatched_stems"] = unmatched[:50]
        if tot["turns_in_scope"] == 0:
            tot["FAILED"] = "with a scope, the whole run has turns_in_scope == 0 (a wrong --sent-entry, or none of the files belongs to it)"
            failed.append("<total>")
    print(json.dumps({"TOTAL": tot}))
    if failed:
        sys.exit(2)


if __name__ == "__main__":
    main()
