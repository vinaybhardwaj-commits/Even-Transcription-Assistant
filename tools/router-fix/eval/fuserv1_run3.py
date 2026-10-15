#!/usr/bin/env python3
"""B4 RUN 3 (Fable GO #5642 option (c)): same 222-window DEV set, fuserv1 at the RUN 3 freeze sha
(ADDENDUM-7 schema + ADDENDUM-6 V4 + max_tokens 36000). Own eval-out file; RUN 1/2 untouched.
Shuffled order (seed 3, recorded). Cost cap $15 with stop-and-post. Running cost is recomputed from
the output file on every start (RUN 2's reset-on-resume bug fixed)."""
import json, os, random, sys, time, traceback
sys.path.insert(0, "/tmp/wt-reb-a447dc36/kit")
import reb as reb_pkg
sys.path.insert(0, "/home/eta/oc/router-fix/repo/fuserv1")
import gemini_call as gc, lexicon, number_parse as npm, runner
import subprocess
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODE_SHA = subprocess.check_output(["git", "-C", _REPO, "rev-parse", "HEAD"], text=True).strip()
if subprocess.check_output(["git", "-C", _REPO, "status", "--porcelain", "--", "fuserv1"], text=True).strip():
    sys.exit("refusing to run: fuserv1 has uncommitted changes")

RX_PATH = "/home/eta/eta-data/cap2/rx_history.jsonl"
CATALOG_PATH = "/tmp/dev_ingest_catalog_fixed.json"
OUT_PATH = "/home/eta/oc/router-fix/eval-out/b4-dev-run-3.jsonl"
COST_CAP_USD = 15.0
SEED = 3
MIN_COSTED = 15

os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
done, running_cost, n_costed = set(), 0.0, 0
if os.path.exists(OUT_PATH):
    for line in open(OUT_PATH):
        try:
            r = json.loads(line)
        except Exception:
            continue
        done.add(r["window_id"])
        c = (r.get("result") or {}).get("total_cost_usd")
        if c:
            running_cost += c
            n_costed += 1
catalog = json.load(open(CATALOG_PATH))
order = sorted(catalog, key=lambda c: c["window_id"])
random.Random(SEED).shuffle(order)
print(f"RUN 3 code sha {CODE_SHA}; {len(order)} windows, seed {SEED}, {len(done)} done (cost so far ${running_cost:.4f}), cap ${COST_CAP_USD}", flush=True)
lex = lexicon.load_lexicon(RX_PATH)
ridx = npm.build_reverse_index(2000)
send = gc.http_transport(gc.get_key())
t_start = time.time()
with open(OUT_PATH, "a") as out:
    for i, c in enumerate(order):
        wid = c["window_id"]
        if wid in done:
            continue
        t0 = time.time()
        try:
            w = reb_pkg.load_window(wid, ist_date=c["ist_date"], room_id=c["room_id"])
            res = runner.run_window(w, lex, ridx, send)
            rec = {"window_id": wid, "room_id": c["room_id"], "ist_date": c["ist_date"], "ok": True, "result": res}
            if res.get("total_cost_usd"):
                running_cost += res["total_cost_usd"]; n_costed += 1
        except Exception as e:
            rec = {"window_id": wid, "room_id": c["room_id"], "ist_date": c["ist_date"], "ok": False,
                   "error": str(e), "traceback": traceback.format_exc()}
        out.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n"); out.flush()
        done.add(wid)
        remaining = len(order) - len(done)
        proj = running_cost + remaining * (running_cost / n_costed) if n_costed >= MIN_COSTED else None
        print(f"[{len(done)}/{len(order)}] {wid} {'OK' if rec['ok'] else 'ERROR ' + rec.get('error','')} "
              f"{time.time()-t0:.1f}s cost=${running_cost:.4f} proj={'%.2f' % proj if proj else 'warming'}", flush=True)
        if running_cost > COST_CAP_USD or (proj is not None and proj > COST_CAP_USD):
            print(f"STOPPED_COST_CAP: spent ${running_cost:.4f}, projected {proj}, cap ${COST_CAP_USD}. HALT -- post first.", flush=True)
            sys.exit(2)
print(f"DONE wall={time.time()-t_start:.0f}s cost=${running_cost:.4f}", flush=True)
