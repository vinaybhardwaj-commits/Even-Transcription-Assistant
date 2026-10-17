"""Build the 252 P-SYN scripts, truth sheets and twins, and write them to disk.

Layout under OUT:
  manifest.json                      sha256 and size of every other file
  enrolment/pseudo_doctors.json      32 pseudo-doctors and their enrolment utterances
  dev/<script_id>/{script,truth,twin[,twin_defect]}.json
  test/README.md                     do-not-touch warning (spec A2.1, F)
  test/<script_id>/...
"""

import hashlib
import json
from pathlib import Path

from . import enrolment, split, strata
from .schema import dumps
from .truth import GENERATOR_VERSION, build_truth, finalise_script
from .twin import apply_note_defect, build_twin

CONFIG = Path(__file__).parent / "config.json"
SPEC = "PDQI9-E-SPEC-v7 A2.1, A4.1, A4.1a, A4.1c, A4.4 (branch cloudpane/cloud-pdqi9-v5/v7)"

TEST_README = """# TEST SPLIT: DO NOT TOUCH UNTIL S4

These 168 P-SYN scripts are the preregistered test split (PDQI9-E-SPEC-v7 A2.1, F).
No gate fit, threshold choice, prompt tuning or T24/T28 figure may be computed on
them before the S2 prereg freeze. Dev work uses ../dev only.

Voicing (S1) may read these files to render audio. Nothing else may open them
before S4. Every file is hashed in ../manifest.json; `python -m eval.pdqi9.psyn
validate DIR` fails if any of them changes.

All content is synthetic: invented speakers, no real consult content.
"""


def load_config():
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def generate(seed, config=None):
    """Return (pool, [(script, truth, twin, twin_defect|None)], split summary). Pure, no I/O."""
    cfg = config or load_config()
    pool = enrolment.build_pool(seed)
    pool_ids = [p["pseudo_doctor_id"] for p in pool]
    enrol = {p["pseudo_doctor_id"]: p["enrolment"] for p in pool}
    raw = []
    for mod in strata.MODULES:
        raw.extend(mod.generate(seed, pool))
    scripts = [finalise_script(s, seed, pool_ids) for s in raw]
    for s in scripts:
        for sp in s["speakers"]:
            sp["enrolment"] = enrol[sp["pseudo_doctor_id"]] if sp["pseudo_doctor_id"] else None
    summary = split.assign(scripts, cfg["dev_counts"], cfg["split_seed"])
    out = []
    for s in scripts:
        t = build_truth(s)
        tw = build_twin(s, t)
        td = apply_note_defect(s, tw) if s["stratum"] == "S-N" else None
        out.append((s, t, tw, td))
    return pool, out, summary


def write(out_dir, seed, config=None):
    cfg = config or load_config()
    out_dir = Path(out_dir)
    if out_dir.exists() and any(out_dir.iterdir()):
        raise SystemExit(f"refusing to write into non-empty {out_dir}")
    pool, bundles, summary = generate(seed, cfg)
    files = {}
    files["enrolment/pseudo_doctors.json"] = dumps({
        "synthetic": True, "note": "Enrolment reading sentences; never spoken in any consult.",
        "pseudo_doctors": pool})
    files["test/README.md"] = TEST_README
    index = []
    for s, t, tw, td in bundles:
        d = f"{s['split']}/{s['script_id']}"
        files[f"{d}/script.json"] = dumps(s)
        files[f"{d}/truth.json"] = dumps(t)
        files[f"{d}/twin.json"] = dumps(tw)
        if td is not None:
            files[f"{d}/twin_defect.json"] = dumps(td)
        index.append({"script_id": s["script_id"], "stratum": s["stratum"], "split": s["split"], "dir": d})
    entries = []
    for path in sorted(files):
        data = files[path].encode("utf-8")
        p = out_dir / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        entries.append({"path": path, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
    counts = {"by_stratum": summary,
              "by_split": {sp: sum(v[sp] for v in summary.values()) for sp in ("dev", "test")}}
    manifest = {"generator_version": GENERATOR_VERSION, "seed": seed, "split_seed": cfg["split_seed"],
                "synthetic": True, "spec": SPEC, "total_scripts": len(bundles), "counts": counts,
                "scripts": index, "files": entries}
    (out_dir / "manifest.json").write_text(dumps(manifest), encoding="utf-8")
    return manifest
