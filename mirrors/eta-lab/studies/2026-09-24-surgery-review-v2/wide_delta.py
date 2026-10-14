#!/usr/bin/env python3
"""wide_delta.py — candidates the earlier passes never saw: wide_scan's placement rule (>= 2 distinct SPECIFIC procedure terms in one room's PQM window, best >= 2x the second) over consults of 21-24 Sep whose
token_uid is in NO earlier selected*.json / ship key (wide_scan only excluded the strict pool and set B, so a rerun would re-place W## items and overwrite selected_wide.json). Writes selected_wide_delta.json (ids D01.., private, 0600)
and items_wide_delta.json. Read-only against the DB. Prints counts only. FRESHNESS is NOT decided here: run fresh_overlap.py on the staged items (content, not room_day)."""
import glob, json, os
from concurrent.futures import ThreadPoolExecutor
import anchor as an, locate, select_v3 as sv
from wide_scan import decide

V3 = sv.V3


def seen_tokens():
    s = set()
    for f in glob.glob(f"{V3}/selected*.json") + [f"{V3}/pool/index.json", f"{V3}/ship-key.json", f"{V3}/ship-v4-key.json"]:
        try:
            d = json.load(open(f))
        except Exception:
            continue
        for v in (d.values() if isinstance(d, dict) else d):
            if isinstance(v, dict) and v.get("token_uid"):
                s.add(v["token_uid"])
    return s


def main():
    an.FROM, an.TO = "2026-09-21", "2026-09-24"
    cons = an.consults(); lab = sv.labelled(); seen = seen_tokens()
    todo, skipped = [], {"seen": 0, "duration": 0, "labelled": 0}
    for c in cons:
        mins = (c["done"] - c["called"]).total_seconds() / 60
        if c["token_uid"] in seen:
            skipped["seen"] += 1
        elif not (3 <= mins <= 45):
            skipped["duration"] += 1
        elif any(t == c["token_uid"] for t, _, _, _ in lab):
            skipped["labelled"] += 1
        else:
            todo.append(c)
    print("consults 21-24 Sep:", len(cons), "| never seen, to place:", len(todo), "| skipped:", skipped, "| seen tokens:", len(seen))

    def one(c):
        try:
            return c, decide(locate.rooms_in_window({"called": c["called"].isoformat(), "done": c["done"].isoformat()}))
        except SystemExit:
            return c, "error"
    out, stat = {}, {"placed": 0, "none": 0, "error": 0, "labelled_time": 0}
    with ThreadPoolExecutor(4) as ex:
        for c, r in ex.map(one, todo):
            if r == "error":
                stat["error"] += 1; continue
            if r is None:
                stat["none"] += 1; continue
            rd, terms = r
            item = {"token_uid": c["token_uid"], "room_day_id": rd, "called": c["called"].isoformat(), "done": c["done"].isoformat()}
            if sv.leaks(item, lab):
                stat["labelled_time"] += 1; continue
            out[f"D{len(out) + 1:02d}"] = {**item, "day": c["called"].date().isoformat(), "source": "content_placed_delta", "booked_procedure": None, "doctor_uid": c["doctor_uid"], "doctor_name": c["doctor_name"], "terms": terms}
            stat["placed"] += 1
    print("placement:", stat, "| by day:", {d: sum(1 for v in out.values() if v["day"] == d) for d in sorted({v["day"] for v in out.values()})})
    p = f"{V3}/selected_wide_delta.json"; json.dump(out, open(p, "w"), indent=1); os.chmod(p, 0o600)
    items = [{"item_id": q, "room_day_id": v["room_day_id"], "ist_date": v["day"], "called_at": v["called"], "completed_at": v["done"], "doctor_uid": v["doctor_uid"]} for q, v in out.items()]
    p = f"{V3}/items_wide_delta.json"; json.dump(items, open(p, "w"), indent=1); os.chmod(p, 0o600)


if __name__ == "__main__":
    main()
