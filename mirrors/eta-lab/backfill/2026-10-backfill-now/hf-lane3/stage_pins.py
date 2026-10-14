#!/usr/bin/env python3
"""stage_pins.py — HF-3b helper of stage_snapshots.sh (BOX side, read-only on the caches): proves that the two pinned snapshots on the box are EXACTLY the pinned revisions with EXACTLY the measured file set
(code-file pins via lane3_cpu_job.verify_snapshot + every file's sha256 against the c4 measurement), then writes <stage>/lane3-pins/pinned_snapshots.json (the manifest that install_hf1.sh re-checks on HF-1).
  stage_pins.py --indic-hub H --sra-hub H --measured c4_measured-20261008.json --stage-dir D        (diagnostics on stderr only; exit non-zero on ANY mismatch)"""
import argparse, importlib.util, json, os, sys
from datetime import datetime
HERE = os.path.dirname(os.path.abspath(__file__))
def job():
    spec = importlib.util.spec_from_file_location("lane3_cpu_job", f"{HERE}/lane3_cpu_job.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("--indic-hub", required=True); ap.add_argument("--sra-hub", required=True); ap.add_argument("--measured", required=True); ap.add_argument("--stage-dir", required=True)
    a = ap.parse_args(argv); J = job(); meas = json.load(open(a.measured))["hf_snapshots"]; fams = {}
    for fam, hub, mkey in (("indic", a.indic_hub, "indic_conformer"), ("sravaani", a.sra_hub, "sravaani")):
        repo, rev = J.MODELS[fam]; snap = os.path.join(hub, "models--" + repo.replace("/", "--"), "snapshots", rev)
        if not os.path.isdir(snap): raise SystemExit(f"REFUSED: {fam} snapshot {snap} not found")
        m = meas[mkey]
        if m["revision"] != rev or m["repo"] != repo: raise SystemExit(f"REFUSED: measurement is for {m['repo']}@{m['revision']}, job pins {repo}@{rev}")
        J.verify_snapshot(fam, snap); J.verify_manifest(snap, m["files_sha256"])
        fams[fam] = {"repo": repo, "revision": rev, "n_files": len(m["files_sha256"]), "files": m["files_sha256"]}
        print(f"stage_pins: {fam} {repo}@{rev[:12]}: {len(m['files_sha256'])} files verified (code pins + full sha256 manifest)", file=sys.stderr)
    d = os.path.join(a.stage_dir, "lane3-pins"); os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "pinned_snapshots.json"), "w") as f: json.dump({"schema": "lane3-pinned-snapshots/1", "created_at": datetime.now().astimezone().isoformat(timespec="seconds"), "source_measurement": os.path.basename(a.measured), "families": fams}, f)
    return 0
if __name__ == "__main__": sys.exit(main())
