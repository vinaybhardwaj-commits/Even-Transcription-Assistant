#!/usr/bin/env python3
"""Stage the window files written before the vault existed, under run_id <producer>-backfill-20260924.

Reads ~/eta-data/hist/out/<job>/<window>.json (old layout, hist-bulk via run_window), writes an
identical payload plus schema + provenance to
  ~/eta-data/lab-vault/staged/runs/hist-bulk-backfill-20260924/<room_id>/<ist_date>/<window_id>.json
The originals are never touched. Output is deterministic (no wall-clock), so reruns are no-ops and
vault-push reports 200 identical. A staged file is never rewritten: if a source changed after it
was staged (a rerun overwrote it), that is reported, not silently re-staged, because the vault
key is already written or will 409.

  backfill.py [--quiet-min 10] [--dry-run]
"""
import argparse, hashlib, json, os, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path.home()
SRC = Path(os.environ.get("LAB_BACKFILL_SRC", HOME / "eta-data/hist/out"))
HIST = Path(os.environ.get("LAB_BACKFILL_HIST", HOME / "eta-data/hist"))
STACK_REF = Path(os.environ.get("LAB_BACKFILL_STACK", HOME / "eta-data/hist/stack_versions.json"))
STAGED = Path(os.environ.get("LAB_VAULT_STAGED", HOME / "eta-data/lab-vault/staged"))
PRODUCER, DAY = "hist-bulk", "20260924"
RUN_ID = f"{PRODUCER}-backfill-{DAY}"
IST = timezone(timedelta(hours=5, minutes=30))


def ist_date(start):
    return datetime.fromisoformat(start).astimezone(IST).strftime("%Y-%m-%d")


def chunk_index():
    """window_id -> [chunk records], from hist-bulk's own inventory.json + windows_tierA.json."""
    inv = {(i["room_id"], i["day"]): {str(c["id"]): c for c in i["chunks"]} for i in json.loads((HIST / "inventory.json").read_text())}
    out = {}
    for w in json.loads((HIST / "windows_tierA.json").read_text()):
        chunks = inv.get((w["room_id"], w["day"]), {})
        out[w["win_id"]] = [chunks[str(c)] for c in w["chunk_ids"] if str(c) in chunks]
    return out


def build(doc, src_rel, src_sha, stack_ref, stack_sha, chunks):
    prov = {
        "run_id": RUN_ID, "producer": PRODUCER,
        "created_at": doc.get("started_at"), "provenance_complete": False,
        "backfilled_from": {"path": src_rel, "sha256": src_sha, "backfilled_on": "2026-09-24"},
        # What the old writer recorded itself. Nothing below was added after the fact.
        "recorded_at_write": {k: doc[k] for k in ("versions", "cut", "router", "node", "served_by", "router_status", "mining_only") if k in doc},
        # The stack running when the backfill was made. NOT verified to be the stack that produced this file.
        "stack_reference": {"note": "stack_versions.json at backfill time; the producing stack is not recorded in the file", "file_sha256": stack_sha, **stack_ref} if stack_ref else None,
        "missing": ["stack", "guards", "diarizer", "stack_versions_sha256"] + ([] if chunks else ["source_audio_keys"]),
    }
    if chunks:  # rebuilt from the producer's own inventory: which eta-audio chunks the window was cut from
        prov["source_audio_keys"] = [c["r2_key"] for c in chunks]
        prov["source_chunks"] = [{k: c[k] for k in ("r2_key", "started_at", "ended_at", "duration_ms")} for c in chunks]
    out = {"schema": "eta-lab-result/1", "provenance": prov}
    out.update({k: v for k, v in doc.items() if k not in ("schema", "provenance")})
    return out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--quiet-min", type=float, default=10); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    stack_ref = json.loads(STACK_REF.read_text()) if STACK_REF.exists() else None
    stack_sha = hashlib.sha256(STACK_REF.read_bytes()).hexdigest() if stack_ref else None
    cidx = chunk_index()
    n = {"staged": 0, "unchanged": 0, "too_new": 0, "bad": 0, "changed_since_staged": 0}
    for f in sorted(SRC.glob("*/*.json")):
        if time.time() - f.stat().st_mtime < a.quiet_min * 60:
            n["too_new"] += 1; continue
        raw = f.read_bytes()
        try:
            doc = json.loads(raw)
            room, wid, day = doc["room_id"], doc["window_id"], ist_date(doc["start"])
        except Exception as e:
            print(f"bad {f}: {type(e).__name__}", file=sys.stderr); n["bad"] += 1; continue
        dest = STAGED / "runs" / RUN_ID / room / day / f"{wid}.json"
        body = (json.dumps(build(doc, f"{f.parent.name}/{f.name}", hashlib.sha256(raw).hexdigest(), stack_ref, stack_sha, cidx.get(wid, [])), sort_keys=True, ensure_ascii=False) + "\n").encode()
        if dest.exists():
            n["unchanged" if dest.read_bytes() == body else "changed_since_staged"] += 1
            if dest.read_bytes() != body:
                print(f"changed since staged (not restaged): {f.parent.name}/{f.name}", file=sys.stderr)
            continue
        n["staged"] += 1
        if not a.dry_run:
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_name(f".{dest.name}.tmp"); tmp.write_bytes(body); os.chmod(tmp, 0o600); tmp.rename(dest)
    print(json.dumps(n))
    return 1 if n["bad"] or n["changed_since_staged"] else 0


if __name__ == "__main__":
    sys.exit(main())
