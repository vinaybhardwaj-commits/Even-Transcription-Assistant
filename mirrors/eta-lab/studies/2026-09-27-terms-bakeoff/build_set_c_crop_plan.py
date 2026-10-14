"""W50 set (c): the per-consult crop plan (or tape_gap) for all 92 span-cap-retained consults - the dry-run report
refuter-3 asked for (bus #5173 checklist item (d), a per-consult manifest) BEFORE any audio is decoded or copied.

Ties together: select_set_c_consults (the 92 consults + their already-padded span), hist_manifest (the raw tape
chunk inventory per room+day, reb #5192's recommended authoritative source, unioned across manifest.json and
manifest_tierC.json), and tape_crop (pure gap-aware crop planning). Does NOT decode or move any audio - this is
the planning/reporting step only.

Four distinct outcomes (refuter-3 #5193 - each is a different signal, never collapsed into one "gap" bucket):
  - "ok": full coverage, ready to crop.
  - "tape_gap": some tape exists and overlaps the span, but coverage has a real (>2s) hole - ADDENDUM-2 G1.
  - "no_tape_in_span": this room-day HAS tape, but none of it overlaps the consult's claimed span at all -
    possibly a linker error (a confirmed/probable link should have tape at that time), worth a human glance.
  - "no_manifest_entry": this room-day has NO tape inventory in EITHER manifest file at all.
`HistManifestConflict` (a room-day appearing in both manifests with a genuine, irreconcilable disagreement - see
hist_manifest.py's module docstring for the 3 precise conditions; merely appearing in both is NOT one, since
manifest.json/manifest_tierC.json commonly hold complementary partial windows of the same session, unioned by
r2_key) is deliberately NOT caught here - it propagates and stops the script, per refuter-3's explicit ask to
fail loudly rather than silently paper over a REAL disagreement.
"""
import json

from hist_manifest import load_chunks_for_job
from select_set_c_consults import list_set_c_consults
from tape_crop import plan_crop


def build_plan():
    """-> list of per-consult result dicts: {consult_id, day, room_id, span_start, span_end, duration_s, status,
    segments? (if status=="ok"), reason? (if status!="ok")}. Raises HistManifestConflict, uncaught, if any
    involved room-day has conflicting manifest entries - see module docstring."""
    kept, excluded_by_span_cap = list_set_c_consults()
    results = []
    for c in kept:
        day_iso = f"2026-09-{c['day']}"
        try:
            chunks = load_chunks_for_job(c["room_id"], day_iso)
        except KeyError as e:
            results.append({**c, "status": "no_manifest_entry", "reason": str(e)})
            continue
        crop = plan_crop(chunks, c["span_start"], c["span_end"])
        results.append({**c, **crop})
    return results, excluded_by_span_cap


def summarize(results):
    by_status = {}
    for r in results:
        by_status.setdefault(r["status"], 0)
        by_status[r["status"]] += 1
    return by_status


if __name__ == "__main__":
    import sys

    results, excluded_by_span_cap = build_plan()
    summary = summarize(results)
    print(f"# span_cap excluded: {len(excluded_by_span_cap)}", file=sys.stderr)
    print(f"# crop plan: {json.dumps(summary)}", file=sys.stderr)
    out = []
    for r in results:
        row = {
            "consult_id": r["consult_id"], "day": r["day"], "room_id": r["room_id"],
            "span_start": r["span_start"].isoformat(), "span_end": r["span_end"].isoformat(),
            "duration_s": r["duration_s"], "status": r["status"],
        }
        if r["status"] == "ok":
            row["segments"] = r["segments"]
        else:
            row["reason"] = r["reason"]
        out.append(row)
    print(json.dumps(out, indent=1))
