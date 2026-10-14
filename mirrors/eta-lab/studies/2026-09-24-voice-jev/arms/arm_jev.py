"""Arms 2 and 3: Jev answers Q1-Q3 for each turn.
  arm 3: state = the evidence card (field card_text)   arm 2: state = raw-number variant (field raw_text)
Input jsonl (from vj-data, NO truth): {turn_id, window_id, doctor_name, card_text, raw_text}.
Output jsonl (raw, one line per turn; resumable): {turn_id, window_id, arm, q1:{choice,confidence,probabilities}, q2_p, q3_p, model, usage, latency_s, ts, freeze_sha12}
Usage: arm_jev.py --arm 3 --in cards.jsonl --out out/arm3.jsonl [--backend jev|mock] [--workers 4] --arm1 out/arm1.jsonl --confident-ids page_confident.txt [--select doubtful+page]
"""
import argparse, concurrent.futures as cf, hashlib, os, sys, time
import common as C


def mock_call(state, qs):
    """Offline stand-in for tests: deterministic pseudo-answers from a hash of the state (it cannot know the truth)."""
    h = int(hashlib.sha256(state.encode()).hexdigest(), 16)
    ch = C.Q1_KEYS[h % 5]; conf = 0.5 + (h >> 8) % 50 / 100
    return {"model": "mock", "answers": {"q1": {"type": "choice", "choice": ch, "confidence": conf, "probabilities": {k: 0.2 for k in C.Q1_KEYS}},
                                         "q2": {"type": "noul", "noul": 0.5}, "q3": {"type": "noul", "noul": 0.5}}, "usage": {"input_tokens": len(state) // 4, "output_tokens": 70}}


def state_of(rec, arm):
    return C.strip_question_block(rec["card_text" if arm == 3 else "raw_text"])


def input_sha(rec, arm):
    """sha256 (first 12) of the exact state sent, so a re-rendered card is never mistaken for an already-run one when resuming."""
    f = "card_text" if arm == 3 else "raw_text"
    return C.sha256_bytes(state_of(rec, arm).encode())[:12] if rec.get(f) else None


def run_one(rec, arm, backend):
    field = "card_text" if arm == 3 else "raw_text"
    if not rec.get(field): return {"turn_id": rec["turn_id"], "window_id": rec.get("window_id"), "arm": arm, "error": f"missing {field}"}
    state = state_of(rec, arm)
    qs = C.questions(rec.get("doctor_name"))
    t0 = time.time()
    try:
        r = mock_call(state, qs) if backend == "mock" else C.jev_call(state, qs)
    except Exception as e:
        return {"turn_id": rec["turn_id"], "window_id": rec.get("window_id"), "arm": arm, "error": str(e)}
    a = r["answers"]
    return {"turn_id": rec["turn_id"], "window_id": rec.get("window_id"), "arm": arm, "input_sha12": input_sha(rec, arm),
            "q1": {"choice": a["q1"]["choice"], "confidence": a["q1"].get("confidence"), "probabilities": a["q1"].get("probabilities")},
            "q2_p": a["q2"]["noul"], "q3_p": a["q3"]["noul"], "model": r.get("model"), "usage": r.get("usage"),
            "latency_s": round(time.time() - t0, 3), "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **C.stamp()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", type=int, choices=[2, 3], required=True)
    ap.add_argument("--in", dest="inp", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--backend", choices=["jev", "mock"], default="jev"); ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--select", choices=["all", "doubtful", "doubtful+page"], default="doubtful+page",
                    help="which turns to run (needs --arm1): every DOUBTFUL turn plus the confident sample = the 40 confident items of the Who-is-speaking page (default; needs --confident-ids; ruling 169)")
    ap.add_argument("--arm1", help="out/arm1.jsonl (doubtful flags)"); ap.add_argument("--confident-ids", help="file, one turn_id per line: the page's confident items"); ap.add_argument("--turn-ids", help="file, one turn_id per line: restrict further (refuter re-query)")
    a = ap.parse_args()
    C.freeze_text()
    rows = C.read_jsonl(a.inp); C.blind_check(a.inp, rows)
    if a.select != "all":
        if not a.arm1: raise SystemExit("--select needs --arm1")
        keep = C.select_turns(C.read_jsonl(a.arm1), a.select, open(a.turn_ids).read().split() if a.turn_ids else None, open(a.confident_ids).read().split() if a.confident_ids else None)
        rows = [r for r in rows if r["turn_id"] in keep]
    cur = {r["turn_id"]: input_sha(r, a.arm) for r in rows}
    done = {r["turn_id"] for r in C.read_jsonl(a.out) if "error" not in r and r.get("input_sha12") == cur.get(r["turn_id"])} if os.path.exists(a.out) else set()   # a changed card re-runs
    todo = [r for r in rows if r["turn_id"] not in done]
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    t0, n_err = time.time(), 0
    with cf.ThreadPoolExecutor(a.workers) as ex:
        for out in ex.map(lambda r: run_one(r, a.arm, a.backend), todo):
            C.append_jsonl(a.out, out); n_err += "error" in out
    print(f"arm{a.arm}: {len(todo)} run, {len(done)} resumed, {n_err} errors, {time.time() - t0:.1f}s wall")
    return 1 if n_err else 0


if __name__ == "__main__":
    sys.exit(main())
