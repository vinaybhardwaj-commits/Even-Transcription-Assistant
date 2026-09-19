#!/usr/bin/env python3
"""
Arm D question-wording trial (Use A.2, docs/handoff/ETA-JEV-INTEGRATION.md). Network-bound: one
stdio Jev process, jev_ask over the even-jev launcher; NO model, NO Mini-heavy work. Text (the
synthetic fixtures) stays in process; the results file carries ids, labels and scores only.

Trials the FOUR noul questions of Slice J2 §5.3 (start, end, clinician, clinical) at three candidate
wordings each, against one synthetic labelled 16-window day, three repeats for drift. `phase` is a
6-way CHOICE, not a noul, so the AUC/margin method the brief specifies does not apply to it — it is
reported as underspecified, not trialled here. Every wording × window is one question; all are
batched into ONE jev_ask call per repeat (16*4*3 = 192 <= 200).

Usage: python3 wording_trial.py [repeats]     (default 3)
"""
import json, subprocess, sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fixtures import SETTING, WINDOWS, DIMS, WORDINGS

LAUNCHER = "/Users/vinaybhardwaj/dev/even-jev-mcp/run.sh"
RESULTS = "/Users/vinaybhardwaj/dev/scratch/armd-wording-trial-19-SEP-2026.tsv"
PRESSURE = "/Users/vinaybhardwaj/dev/mini-pressure.jsonl"


def pressure():
    try:
        d = json.loads(open(PRESSURE).read().strip().splitlines()[-1])
        return d.get("verdict"), d.get("free_pct")
    except Exception:
        return "unknown", None


class Jev:
    def __init__(self):
        self.p = subprocess.Popen(["/bin/sh", LAUNCHER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.n = 0
        self._rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                 "clientInfo": {"name": "armd-wording-trial", "version": "1"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"); self.p.stdin.flush()

    def _rpc(self, method, params):
        self.n += 1
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params}) + "\n"); self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError("jev server closed")
            m = json.loads(line)
            if m.get("id") == self.n:
                return m

    def ask(self, state, questions):
        t0 = time.time()
        m = self._rpc("tools/call", {"name": "jev_ask", "arguments": {"state": state, "questions": questions}})
        res = m["result"]; txt = res["content"][0]["text"]
        if res.get("isError"):
            raise RuntimeError("jev_ask error: " + txt[:200])
        out = json.loads(txt); out["wall_ms"] = int((time.time() - t0) * 1000)
        return out

    def close(self):
        try:
            self.p.stdin.close(); self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def qid(dim, wording, w):
    return "%s__%s__%s" % (dim, wording, w)


def build_questions():
    qs = {}
    for dim in DIMS:
        for wname, pack in WORDINGS[dim].items():
            for (w, *_rest) in WINDOWS:
                qs[qid(dim, wording=wname, w=w)] = {
                    "type": "noul",
                    "instructions": pack["instructions"].replace("{W}", w),
                    "criteria": pack["criteria"],
                }
    return qs


def auc(pos, neg):
    if not pos or not neg:
        return float("nan")
    wins = 0.0
    for a in pos:
        for b in neg:
            wins += 1.0 if a > b else 0.5 if a == b else 0.0
    return wins / (len(pos) * len(neg))


def main():
    repeats = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    v, free = pressure()
    print("mini: verdict=%s free=%s (this trial is network-bound; no model/docker)" % (v, free))
    state = {"setting": SETTING, "windows": [{"id": w, "text": t} for (w, t, *_l) in WINDOWS]}
    labels = {w: dict(zip(DIMS, l)) for (w, _t, *l) in WINDOWS}
    questions = build_questions()
    print("questions in one call: %d ; repeats: %d" % (len(questions), repeats))

    J = Jev()
    runs = []          # list of {qid: noul}
    tok = 0; calls = 0; wall = 0
    try:
        for r in range(repeats):
            out = J.ask(state, questions)
            runs.append({k: a.get("noul") for k, a in out["answers"].items()})
            tok += out["usage"]["input_tokens"]; calls += 1; wall += out["wall_ms"]
            print("  repeat %d: %d answers, %d input_tokens, %d ms" % (r + 1, len(runs[-1]), out["usage"]["input_tokens"], out["wall_ms"]))
    finally:
        J.close()

    # ── per-item table (scores only, no text) ──
    os.makedirs(os.path.dirname(RESULTS), exist_ok=True)
    with open(RESULTS, "w") as f:
        f.write("# Arm D wording trial — synthetic fixtures, noul scores only (no transcript text). %s\n" % time.strftime("%Y-%m-%d %H:%M"))
        f.write("dim\twording\twindow\tlabel\t" + "\t".join("run%d" % (i + 1) for i in range(repeats)) + "\tmean\n")
        for dim in DIMS:
            for wname in WORDINGS[dim]:
                for (w, *_rest) in WINDOWS:
                    vals = [runs[i][qid(dim, wname, w)] for i in range(repeats)]
                    mean = sum(vals) / len(vals)
                    f.write("%s\t%s\t%s\t%d\t%s\t%.3f\n" % (dim, wname, w, labels[w][dim],
                            "\t".join("%.3f" % x for x in vals), mean))

    # ── metrics per (dim, wording) ──
    print("\n=== per-wording metrics (AUC / worst-margin / max-drift / conf-wrong / abstain) ===")
    summary = {}
    for dim in DIMS:
        rows = []
        for wname in WORDINGS[dim]:
            means, per_run = {}, {w: [] for (w, *_r) in WINDOWS}
            for (w, *_rest) in WINDOWS:
                vals = [runs[i][qid(dim, wname, w)] for i in range(repeats)]
                means[w] = sum(vals) / len(vals); per_run[w] = vals
            pos = [means[w] for (w, *_r) in WINDOWS if labels[w][dim] == 1]
            neg = [means[w] for (w, *_r) in WINDOWS if labels[w][dim] == 0]
            a = auc(pos, neg)
            worst = (min(pos) - max(neg)) if (pos and neg) else float("nan")
            drift = max(max(per_run[w]) - min(per_run[w]) for (w, *_r) in WINDOWS)
            conf_wrong = sum(1 for (w, *_r) in WINDOWS
                             if abs(means[w] - 0.5) > 0.3 and ((means[w] > 0.5) != (labels[w][dim] == 1)))
            abstain = sum(1 for (w, *_r) in WINDOWS if abs(means[w] - 0.5) < 0.1)
            rows.append((wname, a, worst, drift, conf_wrong, abstain))
        rows.sort(key=lambda x: (-x[1], -x[2], x[3]))   # AUC desc, margin desc, drift asc
        summary[dim] = rows
        print("\n[%s]" % dim)
        for (wname, a, worst, drift, cw, ab) in rows:
            print("  %-14s AUC=%.3f  worst_margin=%+.3f  max_drift=%.3f  conf_wrong=%d  abstain=%d" % (wname, a, worst, drift, cw, ab))

    # ── headline pick per question ──
    print("\n=== PICK (chosen / runner-up) ===")
    for dim in DIMS:
        rows = summary[dim]
        chosen = rows[0]; runner = rows[1] if len(rows) > 1 else rows[0]
        usable = "USABLE" if (chosen[2] >= 0 and chosen[3] <= max(chosen[2], 0.001)) else "CHECK"
        print("  %-10s chosen=%s (AUC=%.3f margin=%+.3f drift=%.3f) [%s]  runner-up=%s (AUC=%.3f)"
              % (dim, chosen[0], chosen[1], chosen[2], chosen[3], usable, runner[0], runner[1]))

    print("\nCOST: %d calls / %d questions-per-call / %d ms / $%.5f  (input_tokens=%d @ $42e-9)"
          % (calls, len(questions), wall, tok * 42e-9, tok))
    print("RESULTS TABLE: %s" % RESULTS)


if __name__ == "__main__":
    main()
