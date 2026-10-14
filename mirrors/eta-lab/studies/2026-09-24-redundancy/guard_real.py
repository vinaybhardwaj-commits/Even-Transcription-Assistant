import json, subprocess, sys
import final_layers as F
R, M = F.R, F.M
B = "collapse_build/"
def run(h, mode, texts):
    r = subprocess.run(["node", B + h, mode], input=json.dumps(texts), capture_output=True, text=True, timeout=240)
    if r.returncode != 0: raise RuntimeError("harness failed")
    return json.loads(r.stdout)
def numtoks(t): return sum(F.is_number_token(w) for w in t.split())
rows = [x for x in M.fetch() if x["period"] == "today"]
texts = {x["wid"]: x["t"] for x in rows if x["t"].strip()}
loop_ws = {w for w, t in texts.items() if R.phrase_loops(t)}
res = []
for name, h, mode in [("REAL guard on stored text (fixed-point check: expect 0 changed)", "h_real.cjs", "x"),
                      ("F1: unit up to 12 words", "h_f1.cjs", "x"),
                      ("F1+F2: also across line breaks", "h_f1.cjs", "x+cross"),
                      ("F1+F2+F3: number exemption only if >= half the unit", "h_f3.cjs", "x+cross")]:
    out = run(h, mode, texts)
    changed = [w for w in texts if out[w] != texts[w]]
    res.append({"variant": name,
                "loop_windows_after": sum(bool(R.phrase_loops(out[w])) for w in loop_ws),
                "windows_changed": len(changed), "changed_outside_the_13_loop_windows": sum(w not in loop_ws for w in changed),
                "chars_removed": sum(len(texts[w]) - len(out[w]) for w in changed),
                "chars_removed_outside_the_13": sum(len(texts[w]) - len(out[w]) for w in changed if w not in loop_ws),
                "number_tokens_removed": sum(max(0, numtoks(texts[w]) - numtoks(out[w])) for w in changed)})
print(json.dumps({"windows": len(texts), "loop_windows_before": len(loop_ws), "variants": res}, indent=1))
