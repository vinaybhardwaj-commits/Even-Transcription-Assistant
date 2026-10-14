#!/usr/bin/env python3
"""stage_local.py — HF-3c helpers (stdlib only, runs on HF-1's python3.10 and on the box). Lane 3 reads ONLY local disk (/tmp/lane3-local); /data (hf-mount FUSE) is only a persistent source and a destination for finished outputs.
  audio  --src /data/lane3/audio --dst <L>/audio --windows w.json [w2.json ...]   copy each window's audio (tmp + rename, never overwrite), sha256-verify against the window list (audio_sha256); mismatch/missing => non-zero
  marker-write --root <L> --job <lane3_cpu_job.py>                              write <L>/READY (json + its own sha) after the staged pieces check out
  marker-check --root <L> --want-job <sha16>                                    exit 0 only if READY exists, is self-consistent, names this root + this job sha16, and every listed file still exists with its size
  mirror --src <L>/out --dst /data/lane3/out [--logs <L>/work --logs-dst /data/lane3/work]   copy finished out/<family>/<win>.json (atomic tmp+rename, NEVER overwrites; an existing different file is reported, kept) + log files (atomic replace)
Prints counts only."""
import argparse, hashlib, json, os, sys, time

def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 22), b""): h.update(c)
    return h.hexdigest()

def copy_atomic(src, dst, overwrite=False):
    """tmp in the destination dir, fsync, then rename (overwrite=False: os.link, so an existing dst is never replaced). Returns 'copied' | 'exists'."""
    d = os.path.dirname(dst); os.makedirs(d, exist_ok=True); tmp = os.path.join(d, f".{os.path.basename(dst)}.{os.getpid()}.tmp")
    with open(src, "rb") as a, open(tmp, "wb") as b:
        for c in iter(lambda: a.read(1 << 22), b""): b.write(c)
        b.flush(); os.fsync(b.fileno())
    try:
        if overwrite: os.replace(tmp, dst)
        else:
            try: os.link(tmp, dst)
            except FileExistsError: return "exists"
            except OSError:                                   # filesystems without hardlinks (FUSE): exclusive create + rename is not available, so check-then-rename (single mirror process)
                if os.path.exists(dst): return "exists"
                os.rename(tmp, dst); tmp = None
        return "copied"
    finally:
        if tmp and os.path.exists(tmp): os.unlink(tmp)

def stage_audio(src, dst, window_files):
    c = {"windows": 0, "copied": 0, "present_ok": 0, "missing": 0, "sha_mismatch": 0}; seen = set()
    for wf in window_files:
        for w in json.load(open(wf)):
            if w["audio"] in seen: continue
            seen.add(w["audio"]); c["windows"] += 1; s = os.path.join(src, w["audio"]); d = os.path.join(dst, w["audio"])
            if os.path.exists(d):
                if sha256_file(d) == w["audio_sha256"]: c["present_ok"] += 1; continue
                os.rename(d, d + f".bad-{int(time.time())}")                         # never delete; re-copy from the source
            if not os.path.isfile(s): c["missing"] += 1; continue
            copy_atomic(s, d)
            if sha256_file(d) != w["audio_sha256"]: os.rename(d, d + f".bad-{int(time.time())}"); c["sha_mismatch"] += 1; continue
            c["copied"] += 1
    return c

def body_sha(m): return hashlib.sha256(json.dumps({k: v for k, v in m.items() if k != "marker_sha16"}, sort_keys=True).encode()).hexdigest()[:16]

def marker_write(root, job):
    files = {}
    for sub in ("bin", "hf_home/lane3-pins", "audio"):
        for dp, _, fs in os.walk(os.path.join(root, sub)):
            for f in fs:
                if f.startswith(".") or ".bad-" in f: continue
                p = os.path.join(dp, f); files[os.path.relpath(p, root)] = os.path.getsize(p)
    for v in ("venv-indic", "venv-sra"):
        p = os.path.join(root, v, "bin", "python")
        if not os.path.exists(p): raise SystemExit(f"REFUSED: {p} missing")
        files[f"{v}/bin/python"] = 0
    snaps = {}
    for dp, dn, fs in os.walk(os.path.join(root, "hf_home", "hub")):
        if os.path.basename(os.path.dirname(dp)) == "snapshots" and os.path.basename(os.path.dirname(os.path.dirname(dp))).startswith("models--"): snaps[os.path.basename(os.path.dirname(os.path.dirname(dp)))] = os.path.basename(dp)
    m = {"root": os.path.realpath(root), "job_sha16": sha256_file(job)[:16], "pins_manifest_sha16": sha256_file(os.path.join(root, "hf_home/lane3-pins/pinned_snapshots.json"))[:16], "snapshots": snaps, "files": files, "created": time.strftime("%Y-%m-%dT%H:%M:%S")}
    m["marker_sha16"] = body_sha(m); tmp = os.path.join(root, ".READY.tmp"); open(tmp, "w").write(json.dumps(m, indent=1)); os.replace(tmp, os.path.join(root, "READY")); return m

def marker_check(root, want_job):
    try: m = json.load(open(os.path.join(root, "READY")))
    except Exception: return "no/unreadable READY marker"
    if m.get("marker_sha16") != body_sha(m): return "READY marker not self-consistent"
    if m.get("root") != os.path.realpath(root): return "READY marker is for another root"
    if m.get("job_sha16") != want_job: return f"READY marker job sha16 {m.get('job_sha16')} != {want_job}"
    if sha256_file(os.path.join(root, "bin", "lane3_cpu_job.py"))[:16] != want_job: return "local job file sha16 differs"
    for rel, size in m["files"].items():
        p = os.path.join(root, rel)
        if not os.path.exists(p) or (size and os.path.getsize(p) != size): return f"staged file missing/changed: {rel}"
    return None

def mirror(src, dst, logs=None, logs_dst=None):
    c = {"copied": 0, "exists_skipped": 0, "differs_kept": 0, "logs": 0}
    for dp, _, fs in os.walk(src):
        for f in sorted(fs):
            if f.startswith(".") or not f.endswith(".json"): continue
            p = os.path.join(dp, f); d = os.path.join(dst, os.path.relpath(p, src))
            r = copy_atomic(p, d)
            if r == "copied": c["copied"] += 1
            elif sha256_file(p) == sha256_file(d): c["exists_skipped"] += 1
            else: c["differs_kept"] += 1                                                    # never overwrite; surfaced
    if logs and os.path.isdir(logs):
        for f in os.listdir(logs):
            p = os.path.join(logs, f)
            if f.endswith(".log") and os.path.isfile(p): copy_atomic(p, os.path.join(logs_dst, f), overwrite=True); c["logs"] += 1
    return c

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter); sp = ap.add_subparsers(dest="cmd", required=True)
    a_ = sp.add_parser("audio"); a_.add_argument("--src", required=True); a_.add_argument("--dst", required=True); a_.add_argument("--windows", nargs="+", required=True)
    w_ = sp.add_parser("marker-write"); w_.add_argument("--root", required=True); w_.add_argument("--job", required=True)
    k_ = sp.add_parser("marker-check"); k_.add_argument("--root", required=True); k_.add_argument("--want-job", required=True)
    m_ = sp.add_parser("mirror"); m_.add_argument("--src", required=True); m_.add_argument("--dst", required=True); m_.add_argument("--logs"); m_.add_argument("--logs-dst")
    a = ap.parse_args(argv)
    if a.cmd == "audio":
        c = stage_audio(a.src, a.dst, a.windows); print(json.dumps(c)); return 0 if c["missing"] == 0 and c["sha_mismatch"] == 0 else 1
    if a.cmd == "marker-write": m = marker_write(a.root, a.job); print(f"READY written: marker_sha16={m['marker_sha16']} job_sha16={m['job_sha16']} files={len(m['files'])}"); return 0
    if a.cmd == "marker-check":
        why = marker_check(a.root, a.want_job)
        if why: print("REFUSED:", why); return 3
        return 0
    print(json.dumps(mirror(a.src, a.dst, a.logs, a.logs_dst))); return 0

if __name__ == "__main__": sys.exit(main())
