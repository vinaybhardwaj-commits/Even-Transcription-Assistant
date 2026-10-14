#!/usr/bin/env python3
"""requeue_c3.py — ORDERS-C3-REQUEUE-1 (backfill-lead, 7 Oct 2026). Re-queue every window whose latest state came from a c3 router
since 2026-09-26 and is done/failed (BF-CHECK-1: c3 output is degraded). runner.py is NOT touched: it queues a window when its LATEST
state in state.jsonl is not "done" and no claim file exists, so a re-queue = one appended state line + the claim file moved aside.

  requeue_c3.py                                  dry run (default): writes a set file, prints counts, changes nothing else
  requeue_c3.py --apply --phase {C,rest} --set-file F --expect-sha16 S    append + move claims + write-once manifest
Run with /home/eta/.venv-r2/bin/python. --base-dir (default ~/eta-data/hist) holds state.jsonl, claims/, windows_tier{A,B,C}.json
(point it at a scratch copy to test; the real state.jsonl is never rewritten, only appended to by --apply).
Never prints transcript text; only window ids, routers, states, counts."""
import argparse, collections, hashlib, json, os, sys, time
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
SINCE = "2026-09-26"
RUN = "requeue-c3-1"
HELDOUT_DIR = os.path.expanduser("~/eta-data/drtpqma")
OUT_DEFAULT = "/home/eta/oc/backfill-now"

def sha16_bytes(b): return hashlib.sha256(b).hexdigest()[:16]

def load_state(base):
    last, n = {}, 0
    with open(f"{base}/state.jsonl") as f:
        for l in f:
            if not l.strip(): continue
            r = json.loads(l); last[r["win"]] = r; n += 1
    return last, n

def load_windows(base):
    tier = {}
    for t in "ABC":
        p = f"{base}/windows_tier{t}.json"
        if os.path.exists(p):
            for w in json.load(open(p)): tier.setdefault(w["win_id"], (t, w))   # first tier wins (A/B/C ids do not collide: C ids start with 'c-')
    return tier

def blind_checker():
    sys.path.insert(0, HELDOUT_DIR)
    import heldout
    union, _ = heldout.load_union()
    def blind(w):   # same predicate as runner.py _blind: IST day of start AND of end-1s; unparseable = blind (fail closed)
        try:
            st = datetime.fromisoformat(w["start"].replace("Z", "+00:00")).astimezone(IST)
            en = datetime.fromisoformat(w["end"].replace("Z", "+00:00")).astimezone(IST) - timedelta(seconds=1)
            days = {st.date().isoformat(), en.date().isoformat()}
        except Exception:
            return True
        return any(heldout.is_held_out(union, d, w["room_id"]) for d in days)
    return blind

def is_target(r): return str(r.get("router", "")).startswith(":c3") and r["t"][:10] >= SINCE and r["state"] in ("done", "failed")

def build_set(base):
    last, n = load_state(base); tier = load_windows(base); blind = blind_checker()
    targets, other_c3 = [], []
    for win, r in last.items():
        if str(r.get("router", "")).startswith(":c3") and r["t"][:10] >= SINCE:
            if is_target(r):
                tw = tier.get(win)
                targets.append({"win": win, "router": r["router"], "state": r["state"], "t": r["t"], "tier": tw[0] if tw else "?",
                                "day": (tw[1].get("day") if tw else None), "blind": bool(tw and blind(tw[1]))})
            else: other_c3.append({"win": win, "router": r["router"], "state": r["state"], "t": r["t"]})   # running / no_audio / chunks_dropped etc.: reported, never targeted
    targets.sort(key=lambda x: x["win"])
    return targets, other_c3, n

def summarize(targets, other):
    s = {"n_targets": len(targets), "by_tier": collections.Counter(t["tier"] for t in targets), "by_router": collections.Counter(t["router"] for t in targets),
         "by_router_state": collections.Counter(f'{t["router"]}/{t["state"]}' for t in targets), "by_day": dict(sorted(collections.Counter((t["t"][:10]) for t in targets).items())),
         "blind_targets": sum(t["blind"] for t in targets), "unplanned_tier_unknown": sum(t["tier"] == "?" for t in targets),
         "c3_latest_not_targeted": dict(collections.Counter(f'{o["router"]}/{o["state"]}' for o in other))}
    return {k: (dict(v) if isinstance(v, collections.Counter) else v) for k, v in s.items()}

def write_once(path, obj):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f: json.dump(obj, f, indent=1)

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-dir", default=os.path.expanduser("~/eta-data/hist")); ap.add_argument("--out-dir", default=OUT_DEFAULT)
    ap.add_argument("--dry-run", action="store_true", help="the default; accepted for explicitness"); ap.add_argument("--apply", action="store_true")
    ap.add_argument("--phase", choices=["C", "rest"]); ap.add_argument("--set-file"); ap.add_argument("--expect-sha16")
    a = ap.parse_args(); base = a.base_dir; ts = datetime.now(IST).strftime("%Y%m%d%H%M")
    os.makedirs(a.out_dir, exist_ok=True)
    if not a.apply:
        if a.phase or a.set_file or a.expect_sha16: sys.exit("--phase/--set-file/--expect-sha16 only with --apply")
        targets, other, n = build_set(base)
        doc = {"schema": "requeue-c3-1-set/1", "created_at": datetime.now(IST).isoformat(timespec="seconds"), "base_dir": base, "state_lines_read": n, "since": SINCE, "targets": targets, "not_targeted_c3_latest": other}
        p = f"{a.out_dir}/requeue-c3-1-set-{ts}.json"; write_once(p, doc)
        print("DRY RUN (nothing changed in", base, ")"); print(json.dumps(summarize(targets, other), indent=1))
        print("set file:", p, "sha16:", sha16_bytes(open(p, "rb").read())); return
    # ---- apply ----
    if not (a.phase and a.set_file and a.expect_sha16): sys.exit("--apply needs --phase, --set-file and --expect-sha16")
    raw = open(a.set_file, "rb").read()
    if sha16_bytes(raw) != a.expect_sha16: sys.exit(f"REFUSED: set file sha16 {sha16_bytes(raw)} != --expect-sha16 {a.expect_sha16}")
    doc = json.loads(raw); tier = load_windows(base); blind = blind_checker(); last, _ = load_state(base)
    tierC = {w["win_id"] for w in json.load(open(f"{base}/windows_tierC.json"))}
    chosen, skipped = [], collections.Counter()
    for t in doc["targets"]:
        win = t["win"]; cur = last.get(win)
        if (win in tierC) != (a.phase == "C"): continue                                      # phase membership, re-checked against the CURRENT windows_tierC.json
        if win not in tier: skipped["not_in_any_window_file"] += 1; continue                  # cannot be re-run by runner.py: report, do not requeue
        if blind(tier[win][1]): skipped["blind_refused"] += 1; continue                       # never bypass the blind guard
        if cur is None or cur["t"] != t["t"] or cur["state"] != t["state"] or cur.get("router") != t["router"]:
            skipped["latest_state_changed_since_set_file"] += 1; continue                     # something (e.g. the box loop) moved it on: leave it alone
        chosen.append(t)
    mf = f"{a.out_dir}/requeue-c3-1-{a.phase}-{ts}.json"
    if os.path.exists(mf): sys.exit(f"REFUSED: manifest {mf} exists (write-once)")
    trash = f"{base}/_to_delete/claims-requeue-c3-1-{a.phase}"; os.makedirs(trash, mode=0o700, exist_ok=True)
    now = datetime.now().isoformat(timespec="seconds")   # same naive-local format runner.log_state writes
    lines = [json.dumps({"t": now, "run": RUN, "win": t["win"], "state": "requeue", "router": t["router"], "reason": "BF-CHECK-1 c3 degraded"}) + "\n" for t in chosen]
    moved, noclaim = 0, 0
    for t in chosen:
        src = f"{base}/claims/{t['win']}"
        if os.path.exists(src):
            dst = f"{trash}/{t['win']}"
            if os.path.exists(dst): dst += f".{int(time.time())}"
            os.rename(src, dst); moved += 1
        else: noclaim += 1
    fd = os.open(f"{base}/state.jsonl", os.O_WRONLY | os.O_APPEND)   # append-only, one write per batch of lines
    try:
        for i in range(0, len(lines), 200): os.write(fd, "".join(lines[i:i + 200]).encode())
    finally: os.close(fd)
    write_once(mf, {"schema": "requeue-c3-1-manifest/1", "applied_at": datetime.now(IST).isoformat(timespec="seconds"), "phase": a.phase, "base_dir": base, "set_file": a.set_file, "set_sha16": a.expect_sha16,
                    "n_requeued": len(chosen), "claims_moved": moved, "claims_absent": noclaim, "claims_moved_to": trash, "skipped": dict(skipped), "windows": [t["win"] for t in chosen]})
    print(f"APPLIED phase {a.phase} to {base}: requeued {len(chosen)}, claims moved {moved}, no claim {noclaim}, skipped {dict(skipped)}"); print("manifest:", mf)

if __name__ == "__main__": main()
