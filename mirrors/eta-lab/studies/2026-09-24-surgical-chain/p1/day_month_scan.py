"""day_month_scan.py: the native link-3 day-month scan of #1654, saved verbatim in logic so it can be reviewed and recounted (refuter-2 #1660). It READS box files and PRINTS COUNTS AND IDS ONLY.
The script that produced #1654 was an inline one-off run before review (ruling 297a; disclosed in the report, section 26); this file is that logic, unchanged, as a reviewable script.

  python3 day_month_scan.py selftest                      invented text only
  python3 day_month_scan.py scan DIR [DIR ...]            each DIR holds de-identified docs {id, turns:[{i, en, ...}]}; documents whose id contains "_rx" (prescription text) are counted apart

Shapes: DM = a day number (ordinal allowed, "of" allowed) next to a month name, either order; CUE = a birth cue in the SAME turn (birthday, b'day, bday, born, birth, dob, date of birth, d.o.b, age).
What the native scorer sends: for each scored room, ALL English turns (`en` non-empty) of the room's doc go into the room-level call, so the counts over a docs directory are the turns that were in a room-level call.
Output: per directory: docs, English turns, day-month turns, day-month turns with a cue, and the (doc id, turn index) of the cue hits; the day-month turns without a cue are only counted. No text is printed or written.
"""
import glob, json, os, re, sys

DM = re.compile(r"\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?\b", re.I)
CUE = re.compile(r"\b(birthday|b'?day|bday|born|birth|dob|date of birth|d\.o\.b|age)\b", re.I)


def scan_dir(d):
    docs = turns = 0; hits = []; dm = dm_cue = dm_rx = 0
    for f in sorted(glob.glob(os.path.join(d, "*.json"))):
        base = os.path.basename(f)[:-5]
        with open(f) as fh:
            try: doc = json.load(fh)
            except ValueError: continue
        ts = doc.get("turns") if isinstance(doc, dict) else None
        if not ts: continue
        rx = "_rx" in base
        if not rx: docs += 1
        for t in ts:
            txt = t.get("en") or ""
            if not txt.strip(): continue
            if not rx: turns += 1
            if DM.search(txt):
                if rx: dm_rx += 1
                else:
                    dm += 1
                    if CUE.search(txt): dm_cue += 1; hits.append((base, t.get("i")))
    return dict(docs=docs, english_turns=turns, day_month_turns=dm, day_month_with_cue=dm_cue, cue_hits=hits, day_month_in_prescription_docs=dm_rx)


def selftest():
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        docs = {"roomA": [(0, "Daily birthday. 6th July. Hello."), (1, "come back on 5th August"), (2, "no date here"), (3, "born in the month of May 3")], "roomA_rx": [(0, "review on 4th June")], "roomB": [(0, "12th March is my dob")]}
        for name, ts in docs.items():
            with open(os.path.join(d, name + ".json"), "w") as f: json.dump({"id": name, "turns": [{"i": i, "en": t} for i, t in ts]}, f)
        r = scan_dir(d)
        assert r["docs"] == 2 and r["english_turns"] == 5, r
        assert r["day_month_turns"] == 4 and r["day_month_with_cue"] == 3 and r["day_month_in_prescription_docs"] == 1, r
        assert r["cue_hits"] == [("roomA", 0), ("roomA", 3), ("roomB", 0)], r
        assert "birthday" not in json.dumps(r) and "August" not in json.dumps(r)               # no text in the result
    print("day_month_scan selftest ok (invented text only)")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "selftest": selftest()
    elif len(sys.argv) > 2 and sys.argv[1] == "scan":
        for d in sys.argv[2:]:
            r = scan_dir(d); print(f"{d}: docs {r['docs']}, English turns {r['english_turns']}, day-month turns {r['day_month_turns']}, with a cue {r['day_month_with_cue']} {r['cue_hits']}, in prescription docs {r['day_month_in_prescription_docs']}")
    else: sys.exit(__doc__)
