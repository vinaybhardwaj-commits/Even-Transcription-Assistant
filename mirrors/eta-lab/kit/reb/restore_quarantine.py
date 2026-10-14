"""restore_quarantine.py: move the quarantined held-out tracks back to their live path (ORDERS-PALIMPSEST-11A step 4; architect #11051, refuter #11049).

Scope: only tracks/_quarantine-blind-preexisting/ and tracks/_quarantine-r3w51/ under <root>/<ist_date>/<room>/<window>/ (the 46 tracks of the blind R3/W51 room-days).
Dry run by default; --write moves. Rule, checked per file again at move time:
  0. sealed: a window dir named like a SEALED_WINDOWS clip (L041, L057, L139, L182) is never restored -> `sealed`;
  1. guard: the heldout guard (from_hist.load_heldout, fail closed) must NOT hold the room-day nor the window span -> else `still_held`, nothing moves. This is the gate that the
     shared heldout.py has been swapped; with the old file every file is `still_held`;
  2. the live path tracks/<same name> must be free -> else `live_exists` (never overwritten);
  3. the quarantined file's sha256 equals the sha256 of the window manifest's entry for that name -> else `manifest_sha_mismatch` (no entry: `no_manifest_entry`);
  4. that sha256 is on a line of the date's index.jsonl -> else `not_in_index`.
Move = os.link(live) then os.unlink(quarantined): atomic, fails rather than overwrites. No copy, no delete of data, no manifest or index edit (the manifest entry already points at the live
path and the index line already exists, so the collector picks the track up as an ordinary one). Empty quarantine dirs are left in place. Output: counts per reason and the per-file
list (window dir, file, sha256, outcome) in a 0600 file under out/; the bus gets counts only.
"""
import argparse
import collections
import glob
import hashlib
import json
import os
import sys
import time

from .from_hist import GuardUnavailable, OUT_DIR, REB_ROOT, SEALED_WINDOWS, load_heldout, window_held

QUARANTINE_DIRS = ("_quarantine-blind-preexisting", "_quarantine-r3w51")
# Sealed clips (architect #11062/#11071): one definition, from_hist.SEALED_WINDOWS; their quarantined tracks are never restored by this script.
OUTCOMES = ("files", "sealed", "restored", "would_restore", "still_held", "live_exists", "manifest_sha_mismatch", "no_manifest_entry", "not_in_index", "errors")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def index_shas(root, date, cache):
    if date not in cache:
        shas, p = set(), os.path.join(root, date, "index.jsonl")
        if os.path.exists(p):
            for line in open(p):
                try:
                    shas.add(json.loads(line).get("sha256"))
                except ValueError:
                    pass
        cache[date] = shas
    return cache[date]


def candidates(root):
    for qname in QUARANTINE_DIRS:
        for qd in sorted(glob.glob(os.path.join(root, "*", "*", "*", "tracks", qname))):
            for f in sorted(os.listdir(qd)):
                if os.path.isfile(os.path.join(qd, f)):
                    yield qd, f


def process(root, qd, name, is_held, write, cache):
    """-> (outcome, sha256). Every check is made here, at move time."""
    tracks_dir = os.path.dirname(qd)
    wd = os.path.dirname(tracks_dir)
    room, date = os.path.basename(os.path.dirname(wd)), os.path.basename(os.path.dirname(os.path.dirname(wd)))
    src, live = os.path.join(qd, name), os.path.join(tracks_dir, name)
    if os.path.basename(wd) in SEALED_WINDOWS:
        return "sealed", None
    try:
        m = json.load(open(os.path.join(wd, "manifest.json")))
        if is_held(date, room) or window_held(is_held, room, m.get("t0_ms"), m.get("t1_ms")):
            return "still_held", None
        sha = sha256_file(src)
        entry = next((e for e in m.get("tracks", []) if os.path.basename(e.get("path", "")) == name), None)
        if entry is None:
            return "no_manifest_entry", sha
        if entry.get("sha256") != sha:
            return "manifest_sha_mismatch", sha
        if sha not in index_shas(root, date, cache):
            return "not_in_index", sha
        if os.path.lexists(live):
            return "live_exists", sha
        if not write:
            return "would_restore", sha
        os.link(src, live)   # fails if the live path appeared meanwhile: never overwrites
        os.unlink(src)
        return "restored", sha
    except FileExistsError:
        return "live_exists", None
    except GuardUnavailable:
        raise
    except Exception:  # noqa: BLE001 - one bad file must not stop the run; counted
        return "errors", None


def run(root=REB_ROOT, write=False, is_held=None, out_dir=OUT_DIR):
    is_held = is_held or load_heldout()   # fail closed
    cnt, rows, cache = collections.Counter({k: 0 for k in OUTCOMES}), [], {}
    for qd, name in candidates(root):
        out, sha = process(root, qd, name, is_held, write, cache)
        cnt[out] += 1
        cnt["files"] += 1
        rows.append({"window_dir": os.path.relpath(os.path.dirname(os.path.dirname(qd)), root), "quarantine_dir": os.path.basename(qd), "file": name, "sha256": sha, "outcome": out})
    path = None
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, "restore-quarantine-" + ("write-" if write else "dry-") + time.strftime("%Y%m%dT%H%M%S") + ".json")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"counts": dict(cnt), "files": rows}, f, indent=1, sort_keys=True)
    return dict(cnt), path


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=REB_ROOT)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dry-run", action="store_true", help="default")
    g.add_argument("--write", action="store_true")
    a = ap.parse_args(argv)
    cnt, path = run(a.root, write=a.write)
    print(json.dumps({"counts": cnt, "write": bool(a.write), "list": path}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
