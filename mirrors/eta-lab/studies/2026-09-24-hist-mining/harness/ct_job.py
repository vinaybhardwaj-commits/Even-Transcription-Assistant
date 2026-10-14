#!/usr/bin/env python3
"""ct_job.py — ruling 315: the 12-window CT mining job (ct_candidates_job_v1.json, non_english_dominant_windows). Twin stack, translate ON, one job per router, mining only (ruling 146), NO scoring.
  python3 ct_job.py --check   one window on :30100 through run_window(translate=True); prints structure/numbers only (no text) and whether transcript_english looks like usable English
  python3 ct_job.py --run     the remaining windows on the 12 routers (hist-cpu-1/2 + the two L4-host routers), stops starting windows at 06:40 IST; writes start/end manifests for the ONE run id
One run id for --check and --run (ct_job_run_id.txt, IST minute + code sha7, ruling 184); every record is write-once under runs/<run_id>/... via the harness."""
import datetime as dt, json, os, sys, threading, time, hashlib
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
HM = os.path.expanduser("~/eta-data/hist-mining"); H = os.path.expanduser("~/eta-data/hist"); RIDF = f"{HM}/ct_job_run_id.txt"
import provenance
if not os.environ.get("HIST_RUN_ID"):
    os.environ["HIST_RUN_ID"] = open(RIDF).read().strip() if os.path.exists(RIDF) else provenance.run_id("hist-miner")
    if not os.path.exists(RIDF): open(RIDF, "w").write(os.environ["HIST_RUN_ID"]); os.chmod(RIDF, 0o600)
import run_window
ROUTERS = []      # 25 Sep 06:25: the job (ruling 315) is CANCELLED and every mining node is deleted (Fable, V ordered); this script can no longer target any router
IST = dt.timezone(dt.timedelta(hours=5, minutes=30)); DEADLINE = dt.datetime.now(IST).replace(hour=6, minute=40, second=0, microsecond=0)
iso = lambda s: dt.datetime.fromisoformat(s)

def load():
    job = json.load(open(f"{HM}/ct_candidates_job_v1.json")); ids = job["non_english_dominant_windows"]
    wins = {w["win_id"]: w for t in "AB" for w in json.load(open(f"{H}/windows_tier{t}.json"))}
    ch = {c["id"]: c for r in json.load(open(f"{H}/inventory.json")) for c in r["chunks"]}
    return [wins[i] for i in ids], ch

def one(w, ch, router):
    return run_window.run_window([ch[i] for i in w["chunk_ids"]], iso(w["start"]), iso(w["end"]), router, None, w["win_id"], room_id=w["room_id"], translate=True)

def english_check(rec):
    en = rec.get("transcript_english") or ""; nat = rec.get("transcript_native") or ""
    letters = [c for c in en if c.isalpha()]; latin = sum(1 for c in letters if c.isascii())
    return {"ok": bool(rec.get("ok")), "error": rec.get("error"), "has_english_field": bool(en), "english_chars": len(en), "native_chars": len(nat), "latin_share_of_letters": round(latin / len(letters), 3) if letters else None, "english_equals_native": en.strip() == nat.strip() if en else None, "segments": len(rec.get("segments") or [])}

def main():
    wins, ch = load(); wins.sort(key=lambda w: w["tape_s"])
    if "--check" in sys.argv:
        raise SystemExit("ct_job --check is retired: ruling 315 job cancelled, no nodes exist (the one check ran 06:04-06:08 and FAILED)")
        rec = one(wins[0], ch, ":30100"); r = english_check(rec)
        r["window"] = wins[0]["win_id"]; r["run_id"] = os.environ["HIST_RUN_ID"]; r["pass"] = bool(r["ok"] and r["has_english_field"] and r["english_chars"] >= 20 and (r["latin_share_of_letters"] or 0) >= 0.9 and not r["english_equals_native"])
        print(json.dumps(r)); return
    if "--run" in sys.argv:
        raise SystemExit("ct_job --run is cancelled: ruling 315 job cancelled, no nodes exist")
        done = {os.path.basename(f)[:-5] for f in __import__("glob").glob(f"{HM}/runs/{os.environ['HIST_RUN_ID']}/*/*/*.json") if ".attempt" not in f}
        todo = [w for w in wins if w["win_id"] not in done]; lock = threading.Lock(); res = []
        run_window.write_manifest(run_window.RUN_ID, ROUTERS[0], {"counts": {"planned": len(wins), "already_done_in_check": len(wins) - len(todo)}, "queue": {"job": "ct_candidates_v1 (ruling 315), translate ON, twin stack", "window_list_sha256": hashlib.sha256("\n".join(sorted(w["win_id"] for w in wins)).encode()).hexdigest()}})
        def worker(router):
            while dt.datetime.now(IST) < DEADLINE:
                with lock:
                    if not todo: return
                    w = todo.pop(0)
                t0 = time.time(); rec = one(w, ch, router); e = english_check(rec)
                with lock: res.append({"win": w["win_id"], "router": router, "wall_s": round(time.time() - t0), **e}); print(w["win_id"], router, "ok" if e["ok"] else e["error"], flush=True)
        ts = [threading.Thread(target=worker, args=(r,)) for r in ROUTERS]; [t.start() for t in ts]; [t.join() for t in ts]
        run_window.write_manifest(run_window.RUN_ID, ROUTERS[0], {"counts": {"planned": len(wins), "ok": sum(1 for r in res if r["ok"]) + (len(wins) - len(res) - len(todo) if False else 0), "failed": sum(1 for r in res if not r["ok"]), "not_started_at_deadline": len(todo)}}, end=True)
        print(json.dumps({"ran": len(res), "ok": sum(1 for r in res if r["ok"]), "failed": [r["win"] for r in res if not r["ok"]], "not_started": [w["win_id"] for w in todo]}))
        return
    print(__doc__)
if __name__ == "__main__": main()
