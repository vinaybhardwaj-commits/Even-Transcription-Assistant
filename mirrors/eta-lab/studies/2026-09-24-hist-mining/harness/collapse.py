"""collapse.py — Python wrapper around collapse_run.mts (the pinned production collapseAssembled). collapse(texts) -> (results, meta). No text is logged."""
import json, os, subprocess
HERE = os.path.dirname(os.path.abspath(__file__))
def collapse(texts):
    r = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--import", os.path.join(HERE, "register.mjs"), os.path.join(HERE, "collapse_run.mts")],
                       input=json.dumps({"texts": texts}), capture_output=True, text=True, timeout=120)
    if r.returncode: raise SystemExit(f"collapse_run failed rc={r.returncode}: {r.stderr.strip()[:200]}")
    j = json.loads(r.stdout)
    return j["results"], {k: j[k] for k in ("pinned_sha", "file_sha256", "numwords_sha")}
if __name__ == "__main__":
    res, meta = collapse(["thank you thank you thank you thank you thank you take one tablet", "take five five five tablets", None, ""])
    assert res[0]["text"] == "thank you take one tablet" and res[0]["units_collapsed"] == 1, res[0]
    assert res[1]["text"] == "take five five five tablets" and not res[1]["changed"], res[1]
    print("selftest OK:", meta, "| loop collapsed, number words preserved, null/empty handled:", [r["text"] for r in res[2:]])
