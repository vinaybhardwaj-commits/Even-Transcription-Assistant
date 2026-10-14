#!/usr/bin/env python3
"""account_windows.py — ruling 291: is EVERY window of Tier A and Tier B accounted for? Read-only; counts and ids only (no text).
For each window id of windows_tier{A,B}.json: its last state in state.jsonl, and the record files that exist for it (hist/out, hist/runs/*/*/*/, .attempt files counted apart).
Buckets: done_ok (state done + an ok record), no_signal_ok (a no_signal skip record AND the id is in the exact-zero list of that tier), no_audio, failed (record with an error), and the problems:
unaccounted (no state and no record), still_running, state_without_record, record_without_state, state_record_disagree, duplicate_ok_records (an ok record in more than one run), no_signal_not_in_list.
Writes the problem ids (not text) to ~/eta-data/hist-mining/account_windows.json (0600).   python3 account_windows.py [--selftest]"""
import glob, json, os, sys
from collections import Counter, defaultdict
H = os.path.expanduser("~/eta-data/hist"); OUT = os.path.expanduser("~/eta-data/hist-mining/account_windows.json")

def last_states():
    st = {}
    for l in open(f"{H}/state.jsonl"):
        try: e = json.loads(l)
        except Exception: continue
        if e.get("win"): st[e["win"]] = (e.get("state"), e.get("run"), e.get("error"))
    return st

def record_index():
    idx = defaultdict(list); attempts = Counter()
    for pat in (f"{H}/out/*/*.json", f"{H}/runs/*/*/*/*.json"):
        for f in glob.glob(pat):
            b = os.path.basename(f)[:-5]
            if ".attempt" in b: attempts[b.split(".attempt")[0]] += 1; continue
            try: r = json.load(open(f))
            except Exception: idx[b].append({"bad": True, "file": f}); continue
            idx[b].append({"ok": bool(r.get("ok")), "state": r.get("state"), "error": r.get("error"), "run": ((r.get("provenance") or {}).get("run_id") or os.path.relpath(f, H).split("/")[1] if "/runs/" in f else "out"), "file": f})
    return idx, attempts

def account(wins, zero_ids, st, idx):
    b = Counter(); prob = defaultdict(list)
    for w in wins:
        s = st.get(w); recs = idx.get(w, []); state = s[0] if s else None
        oks = [r for r in recs if r.get("ok")]; ns = [r for r in recs if r.get("state") == "no_signal"]
        if any(r.get("bad") for r in recs): b["unreadable_record"] += 1; prob["unreadable_record"].append(w); continue
        if state == "running": b["still_running"] += 1; prob["still_running"].append(w); continue
        if state is None and not recs: b["unaccounted"] += 1; prob["unaccounted"].append(w); continue
        if state is None: b["record_without_state"] += 1; prob["record_without_state"].append(w); continue
        if state == "no_signal":
            if not ns: b["state_without_record"] += 1; prob["state_without_record"].append(w)
            elif w not in zero_ids: b["no_signal_not_in_list"] += 1; prob["no_signal_not_in_list"].append(w)
            else: b["no_signal_ok"] += 1
            continue
        if not recs: b["state_without_record"] += 1; prob["state_without_record"].append(w); continue
        if state == "done":
            if not oks: b["state_record_disagree"] += 1; prob["state_record_disagree"].append(w)
            elif len({r["run"] for r in oks}) > 1: b["duplicate_ok_records"] += 1; prob["duplicate_ok_records"].append(w)
            else: b["done_ok"] += 1
        elif state == "no_audio": b["no_audio"] += 1
        else: b[f"failed_or_other:{state}"] += 1; prob[f"failed_or_other:{state}"].append(w)
    return b, prob

def main():
    st = last_states(); idx, attempts = record_index(); res = {}
    for tier in ("A", "B"):
        wins = [w["win_id"] for w in json.load(open(f"{H}/windows_tier{tier}.json"))]; z = json.load(open(f"{H}/exact_zero_windows_tier{tier}.json"))
        zw = z.get("windows") or z.get("ids") or []; zero = set(zw if not zw or isinstance(zw[0], str) else [x["win_id"] for x in zw])
        b, prob = account(wins, zero, st, idx); res[tier] = {"windows": len(wins), "buckets": dict(b), "problems": {k: v for k, v in prob.items()}, "windows_with_attempt_files": sum(1 for w in wins if attempts.get(w))}
        ok = sum(v for k, v in b.items() if k in ("done_ok", "no_signal_ok", "no_audio")); print(f"Tier {tier}: {len(wins)} windows | accounted {ok} | buckets {dict(b)} | with .attempt files {res[tier]['windows_with_attempt_files']}")
    claims = set(os.listdir(f"{H}/claims")) if os.path.isdir(f"{H}/claims") else set()
    for tier in ("A", "B"):
        acc = set(w["win_id"] for w in json.load(open(f"{H}/windows_tier{tier}.json"))) - set(res[tier]["problems"].get("unaccounted", [])) - set(sum(res[tier]["problems"].values(), []))
        orphan = sorted(c for c in claims if c in set(w["win_id"] for w in json.load(open(f"{H}/windows_tier{tier}.json"))) and c not in acc)
        res[tier]["claims_without_final_record"] = orphan; print(f"Tier {tier}: claim files for windows with no final accounted record: {len(orphan)}")
    both = set(w["win_id"] for w in json.load(open(f"{H}/windows_tierA.json"))) & set(w["win_id"] for w in json.load(open(f"{H}/windows_tierB.json")))
    print("ids in BOTH tiers:", len(both)); res["in_both_tiers"] = sorted(both)
    json.dump(res, open(OUT, "w"), indent=1); os.chmod(OUT, 0o600)

def selftest():
    st = {"a": ("done", "r1", None), "b": ("no_signal", "r2", None), "c": ("running", "r1", None), "d": ("done", "r1", None), "e": ("no_audio", "r1", "x"), "f": ("done", "r1", None), "g": ("no_signal", "r2", None)}
    idx = {"a": [{"ok": True, "run": "r1"}], "b": [{"ok": False, "state": "no_signal", "run": "r2"}], "d": [{"ok": False, "run": "r1"}], "e": [{"ok": False, "run": "r1"}], "f": [{"ok": True, "run": "r1"}, {"ok": True, "run": "r9"}], "g": [{"ok": False, "state": "no_signal", "run": "r2"}], "h": [{"ok": True, "run": "r1"}]}
    b, p = account(["a", "b", "c", "d", "e", "f", "g", "h", "i"], {"b"}, st, idx)
    assert b == {"done_ok": 1, "no_signal_ok": 1, "still_running": 1, "state_record_disagree": 1, "no_audio": 1, "duplicate_ok_records": 1, "no_signal_not_in_list": 1, "record_without_state": 1, "unaccounted": 1}, dict(b)
    print("selftest OK")

if __name__ == "__main__": selftest() if "--selftest" in sys.argv else main()
