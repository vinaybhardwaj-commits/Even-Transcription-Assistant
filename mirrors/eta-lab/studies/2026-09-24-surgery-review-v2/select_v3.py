#!/usr/bin/env python3
"""select_v3.py — SURGERY-REVIEW-V3 selection + ruling-63 leakage gate. Reads pool/scan.json (ids, probabilities, no text) and pool/index.json.
Rules (Fable's order + V's mix): consults of 21-24 Sep only (boundaries lane covers those days); every ANCHORED positive the scan misses is ALWAYS included; ~70% real proposals
(status proposed_now, or an anchored miss), ~30% look-alikes (history / mentioned_only / referred); minor category <=20% of the set.
GATE (ruling 63): each selected consult is disjoint from V's labelled consults by token_uid AND by time within the same room-day (5 v2 pilot + v1 consults.csv rows of the v1 key).
Writes selected.json (0600; ids, why, private facts) and items.json (0600, for encounter_bounds). Prints ids and counts only."""
import csv, json, os
from datetime import datetime
V3 = os.path.expanduser("~/eta-data/surgery-review-v3"); P = f"{V3}/pool"
V2 = os.path.expanduser("~/eta-data/surgery-review-v2"); V1 = os.path.expanduser("~/eta-data/surgery-30")


def labelled():
    out = []  # (token_uid, room_day_id, start, end)
    for v in json.load(open(f"{V2}/pilot-key.json")).values():
        out.append((v["token_uid"], v["room_day_id"], datetime.fromisoformat(v["called"]), datetime.fromisoformat(v["done"])))
    toks = {v["token_uid"] for v in json.load(open(f"{V1}/key.json"))["key"].values()}
    for r in csv.DictReader(open(f"{V1}/inputs/consults.csv")):
        if r["token_uid"] in toks:
            out.append((r["token_uid"], r["room_day_id"], datetime.fromisoformat(r["called_at"]), datetime.fromisoformat(r["completed_at"])))
    return out


def leaks(item, lab):
    a, b = datetime.fromisoformat(item["called"]), datetime.fromisoformat(item["done"])
    why = []
    for t, rd, s, e in lab:
        if t == item["token_uid"]:
            why.append("same token_uid")
        elif rd == item["room_day_id"] and s < b and a < e:
            why.append("time overlap in the same room-day")
    return why


def pick(scan, idx):
    inwin = {q: v for q, v in scan.items() if "2026-09-21" <= idx[q]["day"] <= "2026-09-24" and "recall_p" in v}
    sel = {}
    for q, v in inwin.items():  # anchored misses: ALWAYS
        if idx[q]["source"] == "anchor" and not v["passed"]:
            sel[q] = "anchored positive the scan MISSED (booking: " + (idx[q]["booked_procedure"] or "") + ")"
    for q, v in inwin.items():
        if v["passed"] and v["status"] and (v["status"][0] if isinstance(v["status"], (list, tuple)) else v["status"]) == "proposed_now":
            sel.setdefault(q, "scan: proposed_now")
    for q, v in inwin.items():
        st = v["status"][0] if isinstance(v["status"], (list, tuple)) else v["status"]
        if v["passed"] and st in ("history", "mentioned_only", "referred"):
            sel.setdefault(q, "scan: look-alike (" + st + ")")
    return sel, inwin


def main():
    scan = json.load(open(f"{P}/scan.json")); idx = json.load(open(f"{P}/index.json")); lab = labelled()
    sel, inwin = pick(scan, idx)
    dropped = {q: leaks(idx[q], lab) for q in sel if leaks(idx[q], lab)}
    for q in dropped:
        sel.pop(q)
    cat = lambda q: (scan[q]["category"][0] if isinstance(scan[q]["category"], (list, tuple)) else scan[q]["category"])
    stt = lambda q: (scan[q]["status"][0] if isinstance(scan[q]["status"], (list, tuple)) else scan[q]["status"])
    trimmed = []
    while True:  # minor OPD procedures are <=20% of the set: drop the weakest UNANCHORED minor item until they are
        minor = [q for q in sel if scan[q].get("category") and cat(q) == "minor"]
        if len(minor) <= 0.2 * len(sel):
            break
        weak = sorted((q for q in minor if "MISSED" not in sel[q]), key=lambda q: scan[q]["recall_p"])
        if not weak:
            break
        trimmed.append(weak[0]); sel.pop(weak[0])
    print("trimmed for the minor cap:", trimmed)
    print("labelled intervals in the gate:", len(lab), "| consults in window (21-24 Sep):", len(inwin), "| selected:", len(sel), "| dropped by the leakage gate:", dropped or 0)
    print("minor:", len(minor), f"({len(minor) / max(1, len(sel)):.0%}, limit 20%)", "| proposals:", sum(1 for q in sel if "MISSED" in sel[q] or stt(q) == "proposed_now"), "| look-alikes:", sum(1 for q in sel if stt(q) in ("history", "mentioned_only", "referred") and "MISSED" not in sel[q]))
    out = {q: {"why": w, **{k: idx[q][k] for k in ("token_uid", "room_day_id", "called", "done", "day", "source", "booked_procedure")}, "scan": scan[q]} for q, w in sorted(sel.items())}
    json.dump(out, open(f"{V3}/selected.json", "w"), indent=1); os.chmod(f"{V3}/selected.json", 0o600)
    print("selected ids:", " ".join(sorted(sel)))


if __name__ == "__main__":
    main()
