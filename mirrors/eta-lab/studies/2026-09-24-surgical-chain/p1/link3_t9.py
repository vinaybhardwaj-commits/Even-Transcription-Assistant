"""link3_t9.py: T9 (v7.18 + addendum v7.18a) assembly + screening for the 337b-English stratum.

Counts-only stdout. No patient text is printed.

  python3 studies/2026-09-24-surgical-chain/p1/link3_t9.py select
  python3 studies/2026-09-24-surgical-chain/p1/link3_t9.py assemble
  python3 studies/2026-09-24-surgical-chain/p1/link3_t9.py screen
"""
import collections
import glob
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import link3_run as R
import link3_translate as T

BOX = os.path.expanduser("~/eta-data/surgical-chain/p1/")
RUN = BOX + "run/"
MT = BOX + "mt-337b/"
ANN_GLOB = os.path.expanduser("~/eta-data/lab-vault/staged/annotations/translation/*/*/*-linker.json")

ITEMS_T9 = ("c001", "c004", "c006", "c011", "c012", "c013", "c014", "c016", "c021", "c023", "c025", "c026", "c028", "c030", "c033", "c034", "c035", "c036", "c037")
EXCLUDED_T9 = ("c001",)
INDIC = frozenset(("kn", "hi", "ta", "ml", "bn", "gu", "te", "mr"))
# v7.18a: English is whatever the pinned hist_turns calls English; everything that is neither
# that nor one of the 8 Indic tags is dropped and counted as out_of_scope_lang.
ENGLISH = ("en", "english")
DROP_REASONS = ("garbled", "untranslatable", "mt_failed", "missing_337b", "stale", "empty_en", "out_of_scope_lang")


def _sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def _sha256_text(t):
    return _sha256_bytes((t or "").encode("utf-8"))


def _read_json(path):
    with open(path) as f:
        return json.load(f)


def _write_private(path, obj, indent=None):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent)
    os.chmod(path, 0o600)


def _selected_rooms(manifest):
    out = []
    for it in ITEMS_T9:
        for room in (manifest.get(it) or {}).get("rooms", []):
            if room["turns"] and room["non_english_share"] > 0.5:
                out.append((it, room["id"]))
    return out


def _snapshot_files():
    files = sorted(glob.glob(ANN_GLOB), key=os.path.basename)
    out = []
    for path in files:
        with open(path, "rb") as f:
            out.append({"path": path, "sha256": _sha256_bytes(f.read()), "name": os.path.basename(path)})
    return out


def _k_from_entry(entry):
    p = entry["path"].split(os.sep + "runs" + os.sep, 1)[1]
    run_id, room_id, date_ist, leaf = p.split(os.sep)[0], p.split(os.sep)[1], p.split(os.sep)[2], os.path.basename(p)
    return f"{run_id}/{room_id}/{date_ist}/{leaf[:-5]}" if leaf.endswith(".json") else f"{run_id}/{room_id}/{date_ist}/{leaf}"


def _segment_rows(path):
    """Turn rows from one window file. The turn mapping itself is the pinned link3_run.hist_turns (v7.18 R2.3, review F3);
    this only attaches each turn's segment index in the record's segments list (the 337b annotation's `i`), by walking the
    same document with the same non-empty-stripped-text filter, and refuses (counts in the message) if the two disagree."""
    turns = R.hist_turns(path)
    doc = _read_json(path)
    segs = doc.get("segments") or doc.get("turns") or []
    seg_is = [i for i, s in enumerate(segs) if (s.get("text") or "").strip()]
    if len(seg_is) != len(turns):
        raise SystemExit(f"t9 refused: segment-index walk disagrees with hist_turns ({len(seg_is)} vs {len(turns)} turns) at {path}")
    rows = []
    for t, si in zip(turns, seg_is):
        if (segs[si].get("text") or "").strip() != t["orig"]:   # per-row binding (refuter-2 #2583 should-fix): same count is not enough
            raise SystemExit(f"t9 refused: segment-index walk misaligned with hist_turns at segment {si} in {path}")
        rows.append(dict(turn_i=t["i"], seg_i=si, text=t["orig"], at=t["at"], lang=t["lang"]))
    return rows


def cmd_select():
    man = _read_json(RUN + "manifest.json")
    sel = _selected_rooms(man)
    by_item = collections.Counter(it for it, _ in sel)
    print(json.dumps(dict(items=len(by_item), rooms=len(sel), per_item=dict(sorted(by_item.items())))))


def cmd_assemble(man=None, index=None, snapshot=None, mt_dir=None):
    """mt_dir / index / snapshot / man are injectable for tests only; the run path uses the real ones."""
    mt_dir = mt_dir or MT
    man = man if man is not None else _read_json(RUN + "manifest.json")
    idx = index if index is not None else R.index_windows()
    snap = snapshot if snapshot is not None else _snapshot_files()
    by_last = {}
    for f in sorted(snap, key=lambda x: x["name"]):
        data = _read_json(f["path"])
        for it in data.get("items", []):
            by_last[(it.get("k"), int(it.get("i", -1)))] = it

    translated = []
    screen_items = collections.OrderedDict()
    item_kept_indic = collections.Counter()
    room_indic = collections.Counter()
    room_kept_indic = collections.Counter()
    unresolved_rooms = []
    zero_turn_rooms = []

    for item, room_id in sorted(_selected_rooms(man)):
        entry = idx.get(room_id)
        if not entry:
            unresolved_rooms.append(room_id)          # counted and reported, never silently skipped (review F4)
            continue
        k = _k_from_entry(entry)
        seg_rows = _segment_rows(entry["path"])
        rec = screen_items.setdefault(item, dict(turns_in=0, kept=0, kept_indic=0, dropped=dict.fromkeys(DROP_REASONS, 0), rooms=set(), uncov_rooms=0))
        rec["rooms"].add(room_id)
        if not seg_rows:
            zero_turn_rooms.append(room_id)           # an indexed window with no non-empty segment: counted, not silently UNCOVERED
        for row in seg_rows:
            rec["turns_in"] += 1
            base = dict(item=item, room=room_id, i=row["turn_i"], lang=row["lang"], at=row["at"], stratum="translated")
            if row["lang"] in ENGLISH:
                translated.append(dict(base, en=row["text"], q="ok", src="native"))
                rec["kept"] += 1
                continue
            if row["lang"] not in INDIC:
                rec["dropped"]["out_of_scope_lang"] += 1   # v7.18a (review F2)
                translated.append(dict(base, en="", q="ok", dropped=True, drop_reason="out_of_scope_lang", src=None))
                continue

            room_indic[(item, room_id)] += 1
            ann = by_last.get((k, row["seg_i"]))
            reason = None
            en = ""
            q = "mt_failed"
            if ann is None:
                reason = "missing_337b"
            else:
                q = ann.get("q") or "mt_failed"
                if ann.get("err"):
                    reason = "mt_failed"
                elif q == "garbled":
                    reason = "garbled"
                elif q == "untranslatable":
                    reason = "untranslatable"
                elif q != "ok":
                    reason = "mt_failed"
                elif ann.get("src_sha256") != _sha256_text(row["text"]):
                    reason = "stale"
                elif not isinstance(ann.get("en"), str) or not ann.get("en", "").strip():
                    reason = "empty_en"
                else:
                    en = ann["en"].strip()

            if reason is None:
                translated.append(dict(base, en=en, q="ok", src="337b"))
                rec["kept"] += 1
                rec["kept_indic"] += 1
                item_kept_indic[item] += 1
                room_kept_indic[(item, room_id)] += 1
            else:
                rec["dropped"][reason] += 1
                translated.append(dict(base, en="", q=q, dropped=True, drop_reason=reason, src="337b"))

        if room_indic[(item, room_id)] and not room_kept_indic[(item, room_id)]:
            rec["uncov_rooms"] += 1

    for it in sorted(screen_items):
        v = screen_items[it]
        v["rooms"] = len(v["rooms"])
        v["status"] = "UNCOVERED" if item_kept_indic[it] == 0 else "OK"   # kept INDIC turns only (v7.18 R3, review F1)

    translated_sha = _sha256_bytes(json.dumps(translated, ensure_ascii=False).encode("utf-8"))
    prov = dict(model_requested="google/gemini-3.8-flash", source="337b_annotation_snapshot", translated_sha256=translated_sha,
                script_sha=T.committed_sha(os.path.abspath(__file__), cwd=HERE), prereg_sha=T.committed_sha(os.path.join(HERE, "..", "P1-PREREG-v7.18.md"), cwd=HERE),
                prereg_addendum_sha=T.committed_sha(os.path.join(HERE, "..", "P1-PREREG-v7.18a.md"), cwd=HERE),
                snapshot_count=len(snap), snapshot_sha256=_sha256_bytes(json.dumps(snap, sort_keys=True).encode("utf-8")),
                items={it: dict(status=("UNCOVERED" if item_kept_indic[it] == 0 else "MT_OK"),   # the pinned score_translated scores MT_OK items only; any other status becomes the item's verdict (v7.18 R4: UNCOVERED is decided before Jev)
                                turns_in=screen_items[it]["turns_in"], turns_returned=screen_items[it]["kept"],
                                kept_indic=screen_items[it]["kept_indic"], turns=screen_items[it]["turns_in"], rooms=screen_items[it]["rooms"],
                                uncov_rooms=screen_items[it]["uncov_rooms"]) for it in sorted(screen_items)},
                batch="b4", items_expected=list(ITEMS_T9), excluded=list(EXCLUDED_T9))

    total = dict(turns_in=sum(v["turns_in"] for v in screen_items.values()), kept=sum(v["kept"] for v in screen_items.values()),
                 dropped={r: sum(v["dropped"][r] for v in screen_items.values()) for r in DROP_REASONS},
                 uncovered_items=sum(1 for it in ITEMS_T9 if item_kept_indic[it] == 0),
                 unresolved_rooms=len(unresolved_rooms), unresolved_room_ids=sorted(set(unresolved_rooms)), zero_turn_rooms=len(zero_turn_rooms))
    _write_private(mt_dir + "snapshot_manifest.json", dict(files=snap), indent=1)
    _write_private(mt_dir + "translated.json", translated)
    _write_private(mt_dir + "provenance.json", prov, indent=1)
    _write_private(mt_dir + "ledger.json", dict(translate=dict(translated_sha256=translated_sha, script_sha=prov["script_sha"], prereg_sha=prov["prereg_sha"], prereg_addendum_sha=prov["prereg_addendum_sha"])), indent=1)
    _write_private(mt_dir + "assemble_report.json", dict(items=screen_items, total=total), indent=1)
    print(json.dumps(dict(snapshot_files=len(snap), items=len(screen_items), translated_rows=len(translated), uncovered_items=total["uncovered_items"],
                          unresolved_rooms=total["unresolved_rooms"], zero_turn_rooms=total["zero_turn_rooms"])))


def cmd_screen():
    translated = _read_json(MT + "translated.json")
    deid = _read_json(MT + "deid.json")
    by_key = {(r["item"], r["room"], int(r["i"])): r for r in deid}
    screened = []
    score_input = collections.OrderedDict()
    per = collections.OrderedDict()
    kept_indic = collections.Counter()
    missing_deid = 0
    missing_at = 0
    for r in sorted(translated, key=lambda x: (x["item"], x["room"], int(x["i"]))):
        why = r.get("drop_reason") if r.get("drop_reason") in DROP_REASONS else None
        if why is None and r.get("q") != "ok":
            why = "mt_failed"
        s = dict(r, dropped=why is not None, drop_reason=why)
        screened.append(s)
        c = per.setdefault(r["item"], dict(turns_in=0, kept=0, kept_indic=0, dropped=dict.fromkeys(DROP_REASONS, 0)))
        c["turns_in"] += 1
        if s["dropped"]:
            c["dropped"][s["drop_reason"]] += 1
            continue
        d = by_key.get((r["item"], r["room"], int(r["i"])))
        if d is None or not isinstance(d.get("en_deid"), str):
            missing_deid += 1
            continue
        at = r.get("at") if isinstance(r.get("at"), str) and r.get("at") else d.get("at")
        if not isinstance(at, str) or not at:
            missing_at += 1
            continue
        c["kept"] += 1
        if r.get("src") == "337b":                     # only kept 337b turns make an item covered for T9 (v7.18 R3, review F1)
            c["kept_indic"] += 1
            kept_indic[r["item"]] += 1
        turn = dict(i=int(r["i"]), en=d["en_deid"], lang=r.get("lang"), at=at, stratum="translated")
        score_input.setdefault(r["item"], collections.OrderedDict()).setdefault(r["room"], dict(id=r["room"], stratum="translated", turns=[]))["turns"].append(turn)

    for it in sorted(per):
        per[it]["status"] = "UNCOVERED" if kept_indic[it] == 0 else "OK"
    report = dict(stratum="translated", status=("BLOCKED_NO_DEID" if missing_deid else "BLOCKED_NO_AT" if missing_at else "OK"),
                  items=per, total=dict(turns_in=sum(v["turns_in"] for v in per.values()), kept=sum(v["kept"] for v in per.values()), dropped={r: sum(v["dropped"][r] for v in per.values()) for r in DROP_REASONS},
                                          uncovered_items=sum(1 for v in per.values() if v["status"] == "UNCOVERED")), kept_without_deid=missing_deid, kept_without_at=missing_at)
    _write_private(MT + "screened.json", screened)
    if report["status"] == "OK":
        _write_private(MT + "score_input.json", score_input)
    _write_private(MT + "screen_report.json", report, indent=1)
    print(json.dumps(dict(status=report["status"], items=len(per), kept=report["total"]["kept"], uncovered_items=report["total"]["uncovered_items"])))


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    cmd = args[0] if args else ""
    if cmd == "select":
        cmd_select()
    elif cmd == "assemble":
        cmd_assemble()
    elif cmd == "screen":
        cmd_screen()
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
