"""consult_bundle.py: per-consult bundle reader (ORDER 19A; ETA-PALIMPSEST-ARTEFACT-READ-CONTRACT-13-OCT-2026 sections 2-5). READ-ONLY: nothing is written except the --out file (0600).

    python3 -m kit.reb.consult_bundle --uid U [--out FILE]

bundle(consult_uid) -> {consult_uid, scope_path, manifest (as stored), source: cutter | caa, cutter_row (the latest index row, or null),
                        tracks: {stt, translate, diar_sarvam, diar_nemotron, role_llm, role_judge, role_caa, parts, acoustics}}
Each track slot is {path (relative to the REB root, includes the cfg8), status, version, engine, track (the JSON exactly as stored)} or null. Segments are NOT transformed.
Canonical selection (contract section 5): status ok only; newest by extras.created_at, else the file's mtime (ties: the later manifest entry); a cutter consult never uses version "caa"
(a caa consult may); parts only config.clef_mode == "clef+jev". Scope lookup, the cutter-or-caa decision and the CAA manifest reader are export_consult_audit's.
Stdout (no --out or with it) is COUNTS ONLY: the layers found with their cfg8, the others null. The full bundle goes only to --out.
"""
import argparse
import collections
import json
import os
import sys

from . import export_consult_audit as eca
from . import reb
from . import sarvam_lane as sl

SLOTS = (
    # slot, layer, engines, extra predicate on (entry, body)
    ("stt", "stt", ("sarvam-saaras-v3",), None),
    ("translate", "translate", ("sarvam-saaras-v3", "sarvam-mayura-v1"), lambda body: body.get("version") != eca.GAPFILL_VERSION),
    ("translate_gapfill", "translate", (eca.GAPFILL_ENGINE,), lambda body: body.get("version") == eca.GAPFILL_VERSION),
    ("diar_sarvam", "diar", ("sarvam-saaras-v3",), None),
    ("diar_nemotron", "diar", ("nemotron",), None),
    ("role_llm", "role", ("llm-roles",), None),
    ("role_judge", "role", ("text-judge",), None),
    ("role_caa", "role", ("caa-labels",), None),
    ("parts", "parts", ("clef-jev",), lambda body: (body.get("config") or {}).get("clef_mode") == "clef+jev"),
    ("acoustics", "acoustics", ("room_profile_acoustics",), None),
)


class ScopeError(LookupError):
    pass


def pick(win, layer, engines, cutter, pred=None, bad=None):
    """-> the slot dict for the canonical track, or None."""
    best, best_key = None, None
    for i, e in enumerate(win.manifest.get("tracks", [])):
        if e.get("layer") != layer or e.get("engine") not in engines or e.get("status") != "ok":
            continue
        if cutter and e.get("version") == "caa":
            continue
        path = os.path.join(win.root, e["path"])
        if not os.path.exists(path):
            continue   # quarantined or missing: not evidence here
        body = eca.read_track(path)
        if body is None:
            if bad is not None:
                bad["unparseable_tracks"] += 1   # counted, never raised
            continue
        if body.get("status") != "ok" or (pred and not pred(body)):
            continue
        key = (eca.created_key(body, path), i)
        if best_key is None or key > best_key:
            best_key, best = key, {"path": e["path"], "status": body.get("status"), "version": e.get("version"), "engine": e.get("engine"), "track": body}
    return best


def bundle(consult_uid, root=None, index=None, caa_path=eca.CAA_MANIFEST):
    root = root or reb.DEFAULT_ROOT
    index = index or sl.CLIP_INDEX
    row = sl.latest_rows(index).get(consult_uid) if os.path.exists(index) else None
    scopes = eca.scan_scopes(root).get(consult_uid) or []
    if row is not None:
        match = [s for s in scopes if s[0] == row.get("ist_date") and s[1] == row.get("room_id")]
        scopes = match or scopes
    if not scopes:
        raise ScopeError("no consult scope in the REB store for the uid")
    if len(scopes) > 1:
        raise ScopeError("the uid has more than one consult scope")
    date, room, d = scopes[0]
    mpath = os.path.join(d, "manifest.json")
    with open(mpath) as f:
        win = reb.Window(root, json.load(f), mpath)
    cutter = row is not None
    if not cutter and consult_uid not in eca.read_caa_manifest(caa_path) and win.manifest.get("source_kind") != "consult_clip_external":
        raise ScopeError("the uid is in neither the cutter index nor the CAA manifest")
    bad = collections.Counter()
    tracks = {slot: pick(win, layer, engines, cutter, pred, bad) for slot, layer, engines, pred in SLOTS}
    return {"unparseable_tracks": bad["unparseable_tracks"], "consult_uid": consult_uid, "scope_path": os.path.relpath(d, root), "manifest": win.manifest, "source": "cutter" if cutter else "caa", "cutter_row": row, "tracks": tracks}


def counts(b):
    """Counts only: source, and per slot the cfg8 (the last path component's cfg8) or null. No uid, no text."""
    def cfg8(slot):
        if slot is None:
            return None
        return os.path.basename(slot["path"])[:-5].rsplit("__", 1)[-1]
    return {"source": b["source"], "unparseable_tracks": b["unparseable_tracks"], "layers_found": sum(1 for v in b["tracks"].values() if v is not None), "tracks": {k: cfg8(v) for k, v in b["tracks"].items()}}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--uid", required=True)
    ap.add_argument("--out")
    ap.add_argument("--root", default=None, help="REB root (default: ~/eta-data/reb)")
    ap.add_argument("--index", default=None, help="cutter index.jsonl")
    ap.add_argument("--caa-manifest", default=eca.CAA_MANIFEST)
    a = ap.parse_args(argv)
    try:
        b = bundle(a.uid, root=a.root, index=a.index, caa_path=a.caa_manifest)
    except ScopeError as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2
    if a.out:
        eca.write_private(a.out, json.dumps(b, ensure_ascii=False))
    print(json.dumps(counts(b), sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
