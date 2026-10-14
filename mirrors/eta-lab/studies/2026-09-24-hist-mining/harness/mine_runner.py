#!/usr/bin/env python3
"""mine_runner.py — HIST stage 1 room decision (ruling 107a: sequential room check, +-3 min padding; ruling 146: mining only, stop rules).
For each new anchor (dated <=17 Sep, shortlist non-empty, lexicon terms exist): run rank-1 room's window (consult +-3 min) through the harness; keep the room if the booked procedure is heard (fleet's lexicon, on the
PINNED-collapsed native text), else rank 2, else rank 3. ONE job in flight per router: one worker per router I own (:30100, :30200; lab-mover's split). Stops (writes state, exits 3) on:  the DRAIN file ~/eta-data/hist-mining/DRAIN (private to this runner: finish current windows, start no new one; the way to restart);
  the STOP file ~/eta-data/hist-mining/STOP;   failed-job rate > 2% once >= 20 jobs have finished (an infra error gets ONE retry first; only the final outcome counts).
Results (with text + provenance) -> ~/eta-data/hist-mining/runs/<run_id>/<room>/<ist_date>/<tok8>-r<rank>.json 0600, NEVER overwritten (ruling 184; the older results/ files are backfilled into the vault by lab-viewer). State (ids + booleans + terms, NO text) -> mine_state.json 0600. Resumable: a finished window is not re-run.
  python3 mine_runner.py [--max N] [--routers :30100,:30200]      (~/.venv-r2/bin/python)"""
import argparse, json, os, subprocess, sys, threading, time, queue
from datetime import datetime, timedelta
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-surgery-review-v2"))
import run_window, lexicon
HM = os.path.expanduser("~/eta-data/hist-mining"); RES = f"{HM}/results"; STATE = f"{HM}/mine_state.json"; STOP = f"{HM}/STOP"; DRAIN = f"{HM}/DRAIN"; PAD = timedelta(minutes=3)
iso = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
lock = threading.Lock(); stats = {"jobs": 0, "failed": 0}; stop = threading.Event(); why = []

NODES = {":30100": "hist-cpu-1", ":30200": "hist-cpu-2"}
ORPHAN_PAT = r"node_route.py .*histwork/[A-Za-z0-9]{8}-r[123]\."

def my_jobs_on_nodes(nodes=("hist-cpu-1", "hist-cpu-2")):
    """Count MY node_route.py jobs still alive on the nodes (window ids <8 chars>-r<N>). A SIGTERM on the runner does NOT cancel a job already submitted to a router: the router finishes it, and a new process that submits at once puts TWO jobs on that router
    (lab-mover #792, the 1-job-per-router rule). So: restart by DRAIN (finish the current windows, then exit) and never start while any of these is still alive."""
    n = 0
    for h in nodes:
        r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", h, f"pgrep -fc '{ORPHAN_PAT}' || true"], capture_output=True, text=True, timeout=60)
        try: n += int((r.stdout.strip() or "0").splitlines()[-1])
        except ValueError: pass
    return n

def wait_for_no_jobs(max_wait_s=900, poll_s=20):
    t0 = time.time()
    while my_jobs_on_nodes() > 0:
        if time.time() - t0 > max_wait_s: return False
        print("waiting: my earlier jobs are still running on the routers", flush=True); time.sleep(poll_s)
    return True


def save(state):
    with lock:
        json.dump(state, open(STATE + ".tmp", "w"), indent=1); os.chmod(STATE + ".tmp", 0o600); os.replace(STATE + ".tmp", STATE)

def window(q, room, rank, router, wid, st):
    """Ruling 184: every execution writes a NEW file under runs/<run_id>/... and never overwrites. A window already done OK in ANY earlier run (recorded in the state) is not re-run: its hits are reused.
    A failed attempt is written as <wid>.attempt<N>.json by the writer, so a retry (infrastructure error only) never overwrites it."""
    prev = next((w for w in st["windows"] if w["rank"] == rank and w["ok"]), None)
    if prev: return {"_reused": prev}, False
    ch = [c for c in q["chunks"] if c["room_id"] == room]; a, b = iso(q["called"]) - PAD, iso(q["done"]) + PAD
    rec = run_window.run_window(ch, a, b, router, None, wid, room_id=room)
    if not rec["ok"] and rec.get("error") != "no_audio_in_window" and any(k in (rec.get("error") or "") for k in ("push_rc", "pull_failed", "node_route_rc", "poll_")):
        rec = run_window.run_window(ch, a, b, router, None, wid, room_id=room)   # ONE retry for infrastructure errors only; the failed first attempt is already on disk as <wid>.attempt<N>.json
    return rec, True

def worker(router, todo, S, Q, state):
    while not stop.is_set():
        if os.path.exists(STOP): why.append("STOP file"); stop.set(); break
        try: tok = todo.get_nowait()
        except queue.Empty: return
        q = Q[tok]; terms = lexicon.terms_for(q["booked_procedure"]); st = state[tok]
        for rank, room in enumerate(S[tok]["shortlist"], 1):
            if stop.is_set(): break
            if os.path.exists(DRAIN): why.append("DRAIN file"); stop.set(); break      # finish the windows in flight, start no new one, exit cleanly (use this to restart; never SIGTERM)
            wid = f"{tok[:8]}-r{rank}"
            try: rec, ran = window(q, room, rank, router, wid, st)
            except Exception as e:      # a harness exception must be a COUNTED failed window, not a silently dead worker thread
                rec, ran = {"ok": False, "error": f"harness_exception_{type(e).__name__}", "transcript_native_collapsed": ""}, True
            if "_reused" in rec:        # done in an earlier run: reuse its recorded hits, add nothing
                if rec["_reused"]["terms_heard"]: st["located_room"], st["located_rank"], st["terms_heard"] = room, rank, rec["_reused"]["terms_heard"]; break
                continue
            with lock:
                if ran and rec.get("error") != "no_audio_in_window":
                    stats["jobs"] += 1; stats["failed"] += 0 if rec["ok"] else 1
                    if stats["jobs"] >= 20 and stats["failed"] / stats["jobs"] > 0.02: why.append(f"error rate {stats['failed']}/{stats['jobs']}"); stop.set()
            hits = sorted(lexicon.hits((rec.get("transcript_native_collapsed") or "").lower(), terms)) if rec["ok"] else []
            st["windows"].append({"rank": rank, "room_id": room, "ok": rec["ok"], "error": rec.get("error"), "audio_s": (rec.get("cut") or {}).get("duration_s"), "wall_s": rec.get("wall_s"),
                                  "english_dominant": rec.get("english_dominant"), "router": router, "terms_heard": hits, "run_id": run_window.RUN_ID, "vault_key": f"runs/{run_window.RUN_ID}/{room}/{S[tok]['day']}/{wid}.json"})
            if hits: st["located_room"], st["located_rank"], st["terms_heard"] = room, rank, hits; break
        else:
            if not stop.is_set(): st["outcome"] = "not_heard_in_shortlist"
        if st.get("located_room"): st["outcome"] = "located"
        save(state)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--max", type=int, default=0); ap.add_argument("--routers", default=":30100,:30200"); a = ap.parse_args()
    S = json.load(open(f"{HM}/shortlist.json")); Q = {q["token_uid"]: q for q in json.load(open(f"{HM}/queue.json"))}
    state = json.load(open(STATE)) if os.path.exists(STATE) else {}
    cand = sorted((t for t, v in S.items() if v["day"] <= "2026-09-17" and v["shortlist"]), key=lambda t: (S[t]["day"], t))
    nolex = [t for t in cand if not lexicon.terms_for(Q[t]["booked_procedure"])]
    cand = [t for t in cand if t not in nolex and state.get(t, {}).get("outcome") not in ("located", "not_heard_in_shortlist")]
    if a.max: cand = cand[:a.max]
    for t in cand: state.setdefault(t, {"day": S[t]["day"], "booked": Q[t]["booked_procedure"], "windows": []})
    todo = queue.Queue(); [todo.put(t) for t in cand]
    os.makedirs(RES, mode=0o700, exist_ok=True)
    print(f"anchors to run: {len(cand)} | no lexicon terms (cannot be checked, skipped): {len(nolex)} | routers: {a.routers}", flush=True)
    import hashlib
    routers = a.routers.split(","); t_start = datetime.now().astimezone()
    try:
        run_window.write_manifest(run_window.RUN_ID, routers[0], {"counts": {"planned_anchors": len(cand)}, "queue": {"tier": "hist-miner stage 1 (anchors <= 17 Sep, sequential room check)", "window_list_sha256": hashlib.sha256("\n".join(sorted(cand)).encode()).hexdigest()},
                                  "stop_rules": {"error_rate": "> 2% failed jobs once >= 20 finished (infrastructure errors get one retry)", "stop_file": STOP}, "routers": routers, "started_at": t_start.isoformat(timespec="seconds")})
    except Exception as e: print("manifest start not written:", type(e).__name__, flush=True)
    if not wait_for_no_jobs(): print("ABORT: my earlier jobs are still alive on the nodes after 15 min; not starting (would break the 1-job-per-router rule)", flush=True); sys.exit(5)
    th = [threading.Thread(target=worker, args=(r, todo, S, Q, state)) for r in routers]
    [t.start() for t in th]; [t.join() for t in th]
    from collections import Counter
    try:
        wins = [w for v in state.values() for w in v["windows"] if w.get("run_id") == run_window.RUN_ID]
        run_window.write_manifest(run_window.RUN_ID, routers[0], {"counts": {"planned_anchors": len(cand), "windows_ok": sum(1 for w in wins if w["ok"]), "windows_failed": sum(1 for w in wins if not w["ok"] and w["error"] != "no_audio_in_window"),
                                  "windows_no_audio": sum(1 for w in wins if w["error"] == "no_audio_in_window"), "anchors_located": sum(1 for v in state.values() if v.get("outcome") == "located" and any(w.get("run_id") == run_window.RUN_ID for w in v["windows"]))},
                                  "stopped": why or None, "ended_at": datetime.now().astimezone().isoformat(timespec="seconds")}, end=True)
    except Exception as e: print("manifest end not written:", type(e).__name__, flush=True)
    print("outcomes:", dict(Counter(v.get("outcome", "unfinished") for v in state.values())), "| jobs", stats["jobs"], "failed", stats["failed"], "| stopped:", why or None, flush=True)
    sys.exit(3 if why else 0)

if __name__ == "__main__": main()
