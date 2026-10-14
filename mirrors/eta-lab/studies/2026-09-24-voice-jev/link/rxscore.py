#!/usr/bin/env python3
"""vj-link step 3 (box): which doctor's prescribed items are SPOKEN in which room? For every (room-day R, doctor D) of the date:
  window of each D consult = [Rx.timestamp - 60 s, Rx.updated_at + 60 s] (Rx.updated_at missing or > 40 min -> +12 min); an Rx is HIT in R when >= 1 of its drug or test
  words (brand/generic/test name words, >= 5 letters, generic dosage-form words removed) is heard in R's transcript in that window (exact, prefix >= 6, or difflib >= 0.86).
  NULL: the same count with D's windows shifted by +-2 h and +-3 h (lx's null: the room talks about drugs all day, so a hit is only informative above its shifted-time rate).
  EXCESS = hits - null mean.  Items are matched on transcript text as produced (English/Latin script only: Kannada/Hindi-script drug names are not matched, so counts are a floor).
Usage: rxscore.py <pilot_dir> <date>[,<date>..] -> <pilot_dir>/rxscore-<date>.json (box only; hit windows carry no text). Console: ids and counts."""
import glob, json, os, re, statistics, sys
from collections import defaultdict
from difflib import SequenceMatcher

PD, DATES = sys.argv[1], sys.argv[2].split(",")
MIN_TURNS, SHIFTS = 300, (-3, -2, 2, 3)
STOP = set("""tablet tablets capsule capsules syrup suspension injection inj cream gel ointment drops drop lotion solution powder sachet spray inhaler
 strip strips tab cap oral each daily twice thrice after before food meal meals morning night bedtime days week weeks month months forte plus extended release
 test tests blood profile complete count total serum level levels routine study scan screening panel with without fasting random report culture examination
 function general normal urine stool right left both view full body whole basic advanced package health checkup""".split())
WORD = re.compile(r"[a-z][a-z0-9]{4,}")


def words(s):
    return [w for w in WORD.findall((s or "").lower()) if w not in STOP]


def item_words(rx):
    out = set()
    for m in rx["meds"]:
        for k in ("brand_name", "generic_name"): out.update(words(m.get(k)))
    for t in rx["tests"]: out.update(words(t.get("name")))
    return out


def close(a, b):
    if a == b: return True
    if len(a) >= 6 and len(b) >= 6 and (a.startswith(b[:6]) or b.startswith(a[:6])): return True
    return len(a) >= 5 and len(b) >= 5 and a[0] == b[0] and abs(len(a) - len(b)) <= 2 and SequenceMatcher(None, a, b).ratio() >= 0.86


class Room:
    def __init__(self, turns):
        self.t = sorted((int(t["s_ms"]), int(t["e_ms"]), set(words(t.get("text")))) for t in turns if t.get("s_ms") and t.get("e_ms"))
        self.starts = [x[0] for x in self.t]

    def heard(self, a, b):
        import bisect
        i = bisect.bisect_left(self.starts, a - 120_000)   # turns are short; 2 min look-back covers a turn that began before a
        out = set()
        while i < len(self.t) and self.t[i][0] <= b:
            if self.t[i][1] >= a: out |= self.t[i][2]
            i += 1
        return out


def hit(room, rx, shift_ms=0):
    a = rx["start_ms"] - 60_000 + shift_ms
    end = rx["end_ms"] if rx["end_ms"] and 0 < rx["end_ms"] - rx["start_ms"] <= 2_400_000 else rx["start_ms"] + 720_000
    b = end + 60_000 + shift_ms
    H = room.heard(a, b)
    if not H: return 0
    return int(any(close(w, h) for w in rx["_w"] for h in H))


for date in DATES:
    rx = json.load(open(f"{PD}/rx-{date}.json"))
    rx = [r for r in rx if not r["is_draft"] and (r["meds"] or r["tests"])]
    for r in rx: r["_w"] = item_words(r)
    rx = [r for r in rx if r["_w"]]
    by = defaultdict(list)
    for r in rx: by[r["doctor_uid"]].append(r)
    rooms = {}
    for p in sorted(glob.glob(f"{PD}/turns-*.json")):
        d = json.load(open(p))
        if d["room"]["date"] == date and d["room"]["n_turns"] >= MIN_TURNS: rooms[d["room"]["room_day_id"]] = (d["room"]["room"], Room(d["turns"]))
    out = {}
    for rd, (name, room) in rooms.items():
        rows = []
        for doc, rs in by.items():
            if len(rs) < 3: continue
            hits = [r["rx_uid"] for r in rs if hit(room, r)]
            nulls = [sum(hit(room, r, h * 3_600_000) for r in rs) for h in SHIFTS]
            rows.append({"doctor_uid": doc, "rx": len(rs), "hit": len(hits), "null_mean": round(statistics.mean(nulls), 2), "null_max": max(nulls),
                         "excess": round(len(hits) - statistics.mean(nulls), 2), "hit_rx": hits})
        rows.sort(key=lambda x: (-x["excess"], -x["hit"]))
        for i, x in enumerate(rows): x["rank"] = i + 1
        out[rd] = {"room": name, "date": date, "top": rows[:8]}
        b = rows[0] if rows else None; u = rows[1] if len(rows) > 1 else None
        print(f"{date} {name:<16} {rd} | " + (f"BEST {b['doctor_uid']} hit={b['hit']}/{b['rx']} null={b['null_mean']} excess={b['excess']} | RUNNER {u['doctor_uid']} hit={u['hit']}/{u['rx']} excess={u['excess']}" if b and u else "none"), flush=True)
    json.dump(out, open(f"{PD}/rxscore-{date}.json", "w"), indent=1); os.chmod(f"{PD}/rxscore-{date}.json", 0o600)
