#!/usr/bin/env python3
"""Turn mined.json into a .sql file of INSERTs for voice_print_generation. DRY RUN ONLY: this never
connects to a database. V (or the Orchestrator) applies the file, after migration 0108 is applied.

    python3 emit_sql.py --mined mined.json --day-filter salanki_11sep,... --generation 2 --out gen2.sql

One INSERT per clinician. Insert-only; a rerun collides on (clinician_id, generation) and does
nothing. voice_print is not touched.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from s2b_lib import generation_insert_sql

ap = argparse.ArgumentParser()
ap.add_argument("--mined", required=True)
ap.add_argument("--generation", type=int, required=True)
ap.add_argument("--days", default="", help="comma list of day ids to include; default all")
ap.add_argument("--attested-by", default="", help="id of the manifest/attestation, recorded in provenance")
ap.add_argument("--out", required=True)
a = ap.parse_args()
keep = set(filter(None, a.days.split(",")))
by_clin: dict[str, list] = {}
for rec in json.load(open(a.mined)):
    if keep and rec["day"] not in keep:
        continue
    by_clin.setdefault(rec["clinician_id"], []).append(rec)
stmts = []
for cid, recs in sorted(by_clin.items()):
    samples = [c["embedding_base64"] for r in recs for c in r["clips"]]
    if not samples:
        continue
    prov = {
        "method": "s2b_room_audio_v1",
        "days": sorted(r["day"] for r in recs),
        "clips": len(samples),
        "speech_ms": sum(c["speech_ms"] for r in recs for c in r["clips"]),
        "attested_by": a.attested_by or None,
    }
    stmts.append(generation_insert_sql(cid, a.generation, samples, prov))
open(a.out, "w").write("\n".join(stmts) + "\n")
print(f"{len(stmts)} INSERT(s) written; nothing executed", file=sys.stderr)
