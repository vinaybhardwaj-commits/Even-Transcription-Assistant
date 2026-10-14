#!/usr/bin/env python3
"""bench.py -- 453.C LOCAL MODELS benchmark runner (herdr-kit).

Runs 5 real loop tasks (fleet room-check JSON, conductor digest line, roadmap rev
line, bus subject tag, sha-format check) through:
  L-raw : raw ollama /api/chat with format:"json", temperature 0 (poller-style arm)
  L-oc  : `opencode run -m ollama/llama3.1:8b` with the 453.C provider block
  P-oc  : `opencode run -m opencode/qwen3.8-flash` (paid baseline, GO-window-gated)
3 runs per cell. Results -> untracked scratch json + a printed summary table.

NO PHI: all five task prompts are synthetic nophi strings written verbatim below.
Cost arm: local always 0 (step_finish.cost == 0 measured); paid side from
step_finish.cost; token counts on the LOCAL arm are context-window-ish nonsense
(OC quirk, ~16k reported regardless of prompt) and are recorded but never costed.

Usage:
  python3 bench.py --warmup            # warm ollama, run L arms only, $0
  python3 bench.py --paid              # include the paid baseline arm ($~0.005/run)
"""
import argparse, json, os, subprocess, sys, time

OLLAMA = "http://127.0.0.1:11434"
OC = os.path.expanduser("~/.opencode/bin/opencode")
CFG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "opencode.jsonc")
WS = "/tmp"   # opencode workdir for bench runs (scratch, nophi)
RUNS = 3

# --- the 5 tasks (verbatim, synthetic, nophi) ------------------------------
TASKS = [
    {"id": "t1-room-check", "lane": "fleet-watch",
     "task": ('You have data: {"ts":"2026-09-26T15:20:00+05:30","rooms":'
              '[{"room":"OPD 4","state":"recording","recording":true,"last_piece_age_s":42},'
              '{"room":"OPD 5","state":"idle","recording":false,"last_piece_age_s":null}]}. '
              "Expected rooms: OPD 1, OPD 3, OPD 4, OPD 5. Answer with ONE strict JSON object "
              'and nothing else: {"rooms":[{"room":<name>,"recording":<bool>,"state":<state>}],'
              '"fleet_issues":[<short strings>]}. Copy values, do not guess.')},
    {"id": "t2-digest-line", "lane": "conductor",
     "task": ('Given: {"rooms":8,"recording":3,"problems":["OPD 4 NOT_RECORDING"]}. '
              "Return ONE line exactly following the pattern: "
              "'digest: <n> rooms, <m> recording, problems: <list or none>'")},
    {"id": "t3-rev-line", "lane": "roadmap",
     "task": ('Given: rev 3, sha 3ea44355, 2 items changed, 1 open decision. Return ONE line '
              "exactly matching this pattern: '<rev> (<sha>): <n> items changed, <m> open'")},
    {"id": "t4-subject-tag", "lane": "bus",
     "task": ("Tag this bus subject with one word (DEPLOY|REVIEW|ALERT|PLAN): "
              "'vh: badge JS crash on Safari only after 427L merge'. "
              "Reply with exactly one word, nothing else.")},
    {"id": "t5-sha-format", "lane": "bus",
     "task": ("These tokens are candidate 8-hex sha prefixes: a0ef7603, dbc0afba9e8faf62, "
              "2593ffec, g1f2e3d4. Reply ONE line listing ONLY the invalid ones, comma-separated; "
              "if none are invalid reply OK. Nothing else.")},
]

# --- arms ------------------------------------------------------------------
def l_raw(task, timeout=120):
    """Poller-style arm: direct /api/chat, structured, temperature 0."""
    import urllib.request
    body = json.dumps({"model": "llama3.1:8b", "stream": False, "format": "json",
                       "options": {"temperature": 0},
                       "messages": [{"role": "user", "content": task}]})
    t0 = time.time()
    req = urllib.request.Request(OLLAMA + "/api/chat", data=body.encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read())
    return {"ok": True, "answer": d.get("message", {}).get("content", ""),
            "wall_s": round(time.time() - t0, 2),
            "eval_tokens": d.get("eval_count", 0),
            "tok_s": round(d.get("eval_count", 0) / max(d.get("eval_duration", 1) / 1e9, 1e-9), 1),
            "cost": 0.0}

def _oc_run(model, task, timeout=180):
    t0 = time.time()
    try:
        p = subprocess.run([OC, "run", "--agent", "ping-agent", "-m", model,
                            "--format", "json", "--dir", WS, task],
                           capture_output=True, text=True, timeout=timeout,
                           env=dict(os.environ, OPENCODE_CONFIG=CFG))
    except subprocess.TimeoutExpired:
        return {"ok": False, "answer": "TIMEOUT", "wall_s": round(time.time() - t0, 2), "cost": 0.0}
    ans, cost = "", None
    for line in p.stdout.splitlines():
        if line.strip().startswith("{"):
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("type") == "text" and not ans: ans = e.get("part", {}).get("text", "")
            if e.get("type") == "error": ans = "ERR:" + str(e.get("error"))[:120]; break
            if e.get("type") == "step_finish": cost = (e.get("part", {}) or {}).get("cost", 0)
    return {"ok": bool(ans) and not ans.startswith("ERR:"), "answer": ans,
            "wall_s": round(time.time() - t0, 2), "cost": cost or 0.0}

def l_oc(task, timeout=180):
    return _oc_run("ollama/llama3.1:8b", task, timeout)

def p_oc(task, timeout=180):
    return _oc_run("opencode/qwen3.8-flash", task, timeout)

# --- judges (strict, per lane) ---------------------------------------------
def jload(s):
    try: return json.loads(s[s.index("{"):s.rindex("}") + 1])
    except Exception: return None

def judge(tid, ans):
    a = jload(ans) if ans else None
    if tid == "t1-room-check":
        if not isinstance(a, dict): return {"ok": False, "note": "non-JSON"}
        got = {x.get("room"): (x.get("recording"), x.get("state")) for x in a.get("rooms", []) if isinstance(x, dict)}
        exp = {"OPD 4": (True, "recording"), "OPD 5": (False, "idle")}
        extra = sorted(set(got) - set(exp))
        return {"ok": got == exp, "hallucinated_rows": extra}
    if tid == "t2-digest-line":
        s = (ans or "").strip()
        return {"ok": s.startswith("digest: 8 rooms, 3 recording") and "problems:" in s and "```" not in s}
    if tid == "t3-rev-line":
        s = (ans or "").strip().rstrip(".")
        return {"ok": s in ("rev 3 (3ea44355): 2 items changed, 1 open", "rev 3 (3ea44355): 2 items changed, 1 open decision")}
    if tid == "t4-subject-tag":
        s = (ans or "").strip().strip(".,")
        return {"ok": s in ("ALERT", "REVIEW", "PLAN", "DEPLOY")}
    if tid == "t5-sha-format":
        s = (ans or "").strip()
        flags = [w for w in s.replace(",", " ").split() if "g1f2e3d4" in w or "dbc0afba9e8faf62" in w]
        return {"ok": bool(s) and s != "OK" and flags, "note": s[:60]}
    return {"ok": None}

def warm():
    import urllib.request
    body = json.dumps({"model": "llama3.1:8b", "stream": False, "messages": [{"role": "user", "content": "Reply OK"}]})
    req = urllib.request.Request(OLLAMA + "/api/chat", data=body.encode(), headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=180).read()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--warmup", action="store_true", help="warm the model first (recommended)")
    ap.add_argument("--paid", action="store_flag" if False else "store_true", help="also run the paid baseline arm")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "bench-results.json"))
    args = ap.parse_args()
    if args.warmup:
        print("warming llama3.1:8b ...", file=sys.stderr); warm()
    results = []
    for t in TASKS:
        for i in range(args.runs):
            row = {"task": t["id"], "lane": t["lane"], "run": i + 1}
            row["L-raw"] = l_raw(t["task"]); row["L-raw"]["judge"] = judge(t["id"], row["L-raw"]["answer"]); row["L-raw"]["answer"] = row["L-raw"]["answer"][:400]
            row["L-oc"] = l_oc(t["task"]);  row["L-oc"]["judge"] = judge(t["id"], row["L-oc"]["answer"]); row["L-oc"]["answer"] = row["L-oc"]["answer"][:400]
            if args.paid:
                row["P-oc"] = p_oc(t["task"]); row["P-oc"]["judge"] = judge(t["id"], row["P-oc"]["answer"]); row["P-oc"]["answer"] = row["P-oc"]["answer"][:400]
            results.append(row)
            print(f"{t['id']} run{i+1}: L-raw ok={row['L-raw']['judge']['ok']} {row['L-raw']['wall_s']}s | "
                  f"L-oc ok={row['L-oc']['judge']['ok']} {row['L-oc']['wall_s']}s"
                  + (f" | P-oc ok={row['P-oc']['judge']['ok']} {row['P-oc']['wall_s']}s ${row['P-oc']['cost']:.5f}" if args.paid else ""),
                  file=sys.stderr)
    out = {"bench": "453.C", "ts_epoch": time.time(), "runs_per_cell": args.runs, "tasks": results}
    with open(args.out, "w") as f: json.dump(out, f, indent=1)
    print("wrote", args.out, file=sys.stderr)

if __name__ == "__main__":
    main()
