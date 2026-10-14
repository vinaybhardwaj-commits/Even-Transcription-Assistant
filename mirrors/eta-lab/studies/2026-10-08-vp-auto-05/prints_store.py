#!/usr/bin/env python3
"""Versioned live voiceprints (vp-auto-05, R1-R4). Files sit next to prints-provisional-06oct.json in ~/eta-data/consult:
  prints-live-v001.json   byte-identical copy of prints-provisional-06oct.json (that file, and the VP-ACC pin on it, is NEVER written)
  prints-live-v002.json.. each = the previous version + the prints minted by one run (never edited in place; created O_EXCL, 0600)
  prints-live.json        a symlink to the current version, swapped atomically (symlink + os.replace); the cutter's config.PRINTS points at it
  prints-live.audit.jsonl one line per version / rollback (append-only)
  python3 prints_store.py init | status | rollback --doctor-uid UID"""
import argparse, contextlib, fcntl, hashlib, json, os, re, shutil, sys, time
D = os.path.expanduser("~/eta-data/consult"); PROVISIONAL = "prints-provisional-06oct.json"; POINTER = "prints-live.json"; AUDIT = "prints-live.audit.jsonl"
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
vname = lambda n: f"prints-live-v{n:03d}.json"

def versions(d=D): return sorted(int(m.group(1)) for f in os.listdir(d) if (m := re.fullmatch(r"prints-live-v(\d{3})\.json", f)))
def current(d=D):
    """-> (version number, path) the pointer resolves to, or (None, None)."""
    p = f"{d}/{POINTER}"
    if not os.path.islink(p): return None, None
    t = os.path.basename(os.readlink(p)); m = re.fullmatch(r"prints-live-v(\d{3})\.json", t)
    return (int(m.group(1)), f"{d}/{t}") if m and os.path.exists(f"{d}/{t}") else (None, None)

def fsync_dir(d):
    fd = os.open(d, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

def swap_pointer(target_name, d=D):
    """atomic: build the new symlink beside the old one, rename over it, fsync the directory."""
    tmp = f"{d}/.{POINTER}.{os.getpid()}.tmp"
    if os.path.lexists(tmp): os.remove(tmp)
    os.symlink(target_name, tmp); os.replace(tmp, f"{d}/{POINTER}"); fsync_dir(d)

@contextlib.contextmanager
def store_lock(d=D):
    """one writer at a time (add / rollback / orphan cleanup)."""
    f = open(f"{d}/.prints-live.lock", "a"); fcntl.flock(f, fcntl.LOCK_EX)
    try: yield
    finally: f.close()

def move_aside_orphans(d, current_version):
    """vp-auto-05b F5: a version file ABOVE the pointer's version was never pointed to (a crash between writing it and the swap, or a half-written file): move it to _to_delete/ (never deleted by this code) so the next version number is free. -> list of moved names."""
    moved = []
    for n in versions(d):
        if n > current_version:
            os.makedirs(f"{d}/_to_delete", mode=0o700, exist_ok=True); dst = f"{d}/_to_delete/{vname(n)}.{time.strftime('%Y%m%d-%H%M%S')}"
            os.replace(f"{d}/{vname(n)}", dst); moved.append(os.path.basename(dst))
    if moved: audit(d, event="orphan_moved_aside", files=moved)
    return moved

def audit(d, **kw):
    fd = os.open(f"{d}/{AUDIT}", os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a") as fh: fh.write(json.dumps(dict(kw, at=time.strftime("%Y-%m-%dT%H:%M:%S%z"))) + "\n")

def write_new_version(d, n, content_bytes):
    p = f"{d}/{vname(n)}"; fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)                 # never overwrites a version
    with os.fdopen(fd, "wb") as fh: fh.write(content_bytes); fh.flush(); os.fsync(fh.fileno())
    return p

def init(d=D):
    """v001 = the provisional file, byte for byte; pointer -> v001. REFUSES when a pointer already exists (valid or dangling) or any version file exists: it can never re-point a store that has history (vp-auto-05b F6)."""
    if os.path.lexists(f"{d}/{POINTER}") or versions(d): raise SystemExit(f"REFUSED: a live pointer / version files already exist in {d}; init is only for an empty store")
    src = f"{d}/{PROVISIONAL}"; data = open(src, "rb").read()
    write_new_version(d, 1, data)
    if sha(f"{d}/{vname(1)}") != hashlib.sha256(data).hexdigest(): raise SystemExit("v001 differs from the provisional file: STOP")
    swap_pointer(vname(1), d); audit(d, event="init", version=1, sha256=sha(f"{d}/{vname(1)}"), provisional_sha256=sha(src))
    return dict(did="init", version=1, sha256=sha(f"{d}/{vname(1)}"), provisional_sha256=sha(src))

def load(d=D):
    n, p = current(d)
    if n is None: raise SystemExit("no live pointer: run init")
    return n, p, json.load(open(p))

def _add(new_prints, d, code_commit, known_uids, strict):
    with store_lock(d):
        n, p, doc = load(d); move_aside_orphans(d, n); have = {x["doctor_uid"] for x in doc["prints"]}; have_fold = {h.strip().lower() for h in have}
        add, refused = [], {}
        for x in new_prints:
            u = x["doctor_uid"]
            why = None
            if not isinstance(u, str) or u != u.strip() or not u or not re.fullmatch(r"[A-Za-z0-9]{20}", u): why = f"doctor_uid {u!r} is not a normalised 20-char alphanumeric uid"
            elif known_uids is not None and u not in known_uids: why = f"doctor_uid {u!r} is not a warehouse doctor uid"
            elif u in have or u.lower() in have_fold: why = "doctor already has a print (exact or equal ignoring case)"
            elif x.get("minted_by") != "vp-auto": why = "only minted_by 'vp-auto' prints may be added"
            if why:
                if strict and not why.startswith("doctor already"): raise ValueError(why)
                refused[u if isinstance(u, str) else repr(u)] = why; continue
            add.append(x)
        if not add: return dict(version=None, added=[], refused=refused)
        new = dict(doc, prints=doc["prints"] + add, live_version=n + 1, parent=os.path.basename(p), parent_sha256=sha(p))
        nn = n + 1; path = write_new_version(d, nn, (json.dumps(new, indent=1) + "\n").encode()); fsync_dir(d)
        swap_pointer(vname(nn), d); audit(d, event="add", version=nn, doctors=[x["doctor_uid"] for x in add], sha256=sha(path), code_commit=code_commit)
        return dict(version=nn, added=[x["doctor_uid"] for x in add], refused=refused)

def add_prints(new_prints, d=D, code_commit=None, known_uids=None):
    """R1: ADD ONLY. A print whose doctor_uid already exists (exact, or equal ignoring case / surrounding blanks) is refused: never replaced, merged or edited. A malformed uid (not 20 ASCII alphanumerics, e.g. blanks or zero-width characters) or one outside known_uids raises ValueError.
    -> new version number, or None when nothing was added. The file is on disk (fsync) before the pointer swap; orphans of a crashed earlier run are moved aside first."""
    return _add(new_prints, d, code_commit, known_uids, True)["version"]

def add_prints_report(new_prints, d=D, code_commit=None, known_uids=None):
    """the daily job's variant (05c N6): nothing raises per doctor; -> dict(version, added [uids really written], refused {uid: reason})."""
    return _add(new_prints, d, code_commit, known_uids, False)

def rollback(doctor_uid, d=D):
    """R4: remove ONE auto print (minted_by vp-auto) by doctor_uid: new version without it, pointer swapped. A human-confirmed print is refused."""
    with store_lock(d):
        n, p, doc = load(d); move_aside_orphans(d, n); hit = [x for x in doc["prints"] if x["doctor_uid"] == doctor_uid]
        if not hit: raise SystemExit(f"no print for {doctor_uid} in v{n:03d}")
        if hit[0].get("minted_by") != "vp-auto": raise SystemExit("REFUSED: not an auto print (human-confirmed prints are not removed by this command)")
        new = dict(doc, prints=[x for x in doc["prints"] if x["doctor_uid"] != doctor_uid], live_version=n + 1, parent=os.path.basename(p), parent_sha256=sha(p))
        nn = n + 1; path = write_new_version(d, nn, (json.dumps(new, indent=1) + "\n").encode()); fsync_dir(d)
        swap_pointer(vname(nn), d); audit(d, event="rollback", version=nn, removed=doctor_uid, sha256=sha(path)); return nn

def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("cmd", choices=["init", "status", "rollback"]); ap.add_argument("--doctor-uid"); a = ap.parse_args(argv)
    if a.cmd == "init": print(json.dumps(init()))
    elif a.cmd == "status":
        n, p = current(); print(json.dumps(dict(version=n, file=p and os.path.basename(p), sha256=p and sha(p), provisional_sha256=sha(f"{D}/{PROVISIONAL}"), versions=versions())))
    else:
        if not a.doctor_uid: ap.error("--doctor-uid")
        print(json.dumps(dict(rolled_back_to_version=rollback(a.doctor_uid))))
if __name__ == "__main__": main()
