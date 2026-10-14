#!/usr/bin/env python3
"""337e full run on Hugging Face Jobs (r386 S4, r382). Box side orchestrator. Same window list and audio cut as full_run.py (window_audio_full -> lossless FLAC via cut_batch.py).
Per batch of N windows: cut FLAC on the box -> `hf buckets sync` into the PRIVATE bucket vrbeven/diarlab-337e/in/bNNN -> submit ONE HF Job (a10g-large, label project=diar-lab-337e) that runs
hf_consume.py on that dir and writes /data/out/bNNN.jsonl (turns only) -> delete the local FLAC once the sync succeeded. `collect` fetches out/*.jsonl, checks window ids against the batch lists, writes
~/eta-data/speaker-labels/full_nemo_hf.jsonl. `cleanup` deletes the bucket (audio + turns) ONLY when collect verified every window; it does nothing else.
The HF token is read from ~/.claude/secrets/hf_token into the environment of the hf CLI only (never argv, never printed).
usage: hf_run.py launch [--batch 420] [--limit N] | status | collect | cleanup"""
import argparse, glob, json, os, subprocess, sys, threading, time
HOME = os.path.expanduser("~/eta-data"); HERE = os.path.dirname(os.path.abspath(__file__)); SL = os.path.dirname(HERE)
STATE = f"{HOME}/speaker-labels/hf_run"; BUCKET = "vrbeven/diarlab-337e"; VENV = "/home/eta/vad/venv/bin/python"; RES = f"{HOME}/speaker-labels/full_nemo_hf.jsonl"
ENV = dict(os.environ, HF_TOKEN=open(os.path.expanduser("~/.claude/secrets/hf_token")).read().strip())
DONE_FILES = [f"{HOME}/speaker-labels/{n}" for n in ("ref_nemo.jsonl", "full_nemo_t4.jsonl", "full_nemo_l4.jsonl")]
INSTALL = ("set -e; apt-get update -qq >/dev/null && apt-get install -y -qq git >/dev/null; uv venv /opt/v --python 3.12 -q; "
           "uv pip install -q --python /opt/v/bin/python --index-strategy unsafe-best-match --extra-index-url https://download.pytorch.org/whl/cu126 -r /code/requirements.txt; ")


def hf(*a, **k): return subprocess.run(["hf", *a], env=ENV, capture_output=True, text=True, **k)


def done_ids():
    s = set()
    for f in DONE_FILES + [RES]:
        if os.path.exists(f):
            for l in open(f): s.add(json.loads(l)["window_id"])
    return s


def enumerate_todo(redo=None):
    seen = {}
    for root in ("hist", "hist-mining"):
        for p in glob.glob(f"{HOME}/{root}/runs/*/*/*/*.json"):
            try: d = json.load(open(p))
            except Exception: continue
            if d.get("segments") and d["window_id"] not in seen: seen[d["window_id"]] = (d["start"], os.path.relpath(p, HOME))
    dn = set() if redo else done_ids()
    if redo:
        keep = []
        for l in open(redo): keep.append(json.loads(l)["window_id"])
        seen = {w: seen[w] for w in keep if w in seen}
    return sorted(((s, w, p) for w, (s, p) in seen.items() if w not in dn), reverse=True)   # newest first


def launch(a):
    os.makedirs(STATE, mode=0o700, exist_ok=True); todo = enumerate_todo(a.redo_from)[:a.limit] if a.limit else enumerate_todo(a.redo_from)
    batches = [todo[i:i + a.batch] for i in range(0, len(todo), a.batch)]
    json.dump({f"{a.tag}{k:03d}": [w for _, w, _ in b] for k, b in enumerate(batches)}, open(f"{STATE}/batches_{a.tag}.json", "w"))
    print(f"to do {len(todo)} windows in {len(batches)} batches", flush=True)
    jobs = {}
    for k, b in enumerate(batches):
        name = f"{a.tag}{k:03d}"; d = f"{HOME}/speaker-labels/hf_cut/{name}"; os.makedirs(d, mode=0o700, exist_ok=True)
        lst = f"{HOME}/speaker-labels/hf_cut/{name}.json"; json.dump({"windows": [dict(window_id=w, path=p) for _, w, p in b]}, open(lst, "w"))
        r = subprocess.run(["nice", "-n", "10", VENV, os.path.join(SL, "cut_batch.py"), lst, d, "--workers", "6"], capture_output=True, text=True)
        print(name, "cut:", r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr[-200:], flush=True)
        n_files = len(glob.glob(d + "/*.flac"))
        s = hf("buckets", "sync", d, f"hf://buckets/{BUCKET}/in/{name}")
        if s.returncode: sys.exit(f"sync failed {name}: {s.stderr[-300:]}")
        print(name, f"synced {n_files} flac", flush=True)
        j = hf("jobs", "run", "-d", "--flavor", "a10g-large", "--timeout", "3h", "--name", f"diar-lab-337e-{name}", "-l", "project=diar-lab-337e", "-v", f"{SL}/hf:/code:ro",
               "-v", f"hf://buckets/{BUCKET}:/data", "ghcr.io/astral-sh/uv:python3.12-bookworm", "bash", "-c",
               INSTALL + f"/opt/v/bin/python /code/hf_consume.py /data/in/{name} /data/out/{name}.jsonl")
        jid = next((x.split("=", 1)[1] for x in j.stdout.split() if x.startswith("id=")), None)
        if not jid: sys.exit(f"job submit failed {name}: {j.stderr[-300:]}")
        jobs[name] = jid; json.dump(jobs, open(f"{STATE}/jobs_{a.tag}.json", "w")); print(name, "job", jid, flush=True)
        for f in glob.glob(d + "/*.flac"): os.unlink(f)
        os.rmdir(d); os.unlink(lst)


def status(a):
    jobs = json.load(open(f"{STATE}/jobs_{a.tag}.json"))
    for n, j in jobs.items():
        i = hf("jobs", "inspect", f"vrbeven/{j}").stdout.splitlines()
        print(n, j, next((x for x in i[1].split("\t") if x.startswith("{'stage'")), "?") if len(i) > 1 else "?")


def job_stage(jid):
    i = hf("jobs", "inspect", f"vrbeven/{jid}").stdout.splitlines()
    return (next((x for x in i[1].split("\t") if x.startswith("{'stage'")), "?") if len(i) > 1 else "?")


def submit(name):
    j = hf("jobs", "run", "-d", "--flavor", "a10g-large", "--timeout", "3h", "--name", f"diar-lab-337e-{name}", "-l", "project=diar-lab-337e", "-v", f"{SL}/hf:/code:ro",
           "-v", f"hf://buckets/{BUCKET}:/data", "ghcr.io/astral-sh/uv:python3.12-bookworm", "bash", "-c",
           INSTALL + f"/opt/v/bin/python /code/hf_consume.py /data/in/{name} /data/out/{name}.jsonl")
    return next((x.split("=", 1)[1] for x in j.stdout.split() if x.startswith("id=")), None)


def resubmit(a):
    """resubmit batches whose job died at container start (HF host problem, e.g. MOUNT_ATTR_IDMAP) or ended in ERROR; hf_consume.py is resumable so a half-done batch just continues"""
    rj = f"{STATE}/jobs_{a.tag}_retry.json"; retry = json.load(open(rj)) if os.path.exists(rj) else {}
    jobs = json.load(open(f"{STATE}/jobs_{a.tag}.json"))
    for name, jid in jobs.items():
        cur = retry.get(name, {"ids": [jid]})["ids"][-1]; st = job_stage(cur)
        if "ERROR" in st or "CANCELED" in st:
            if len(retry.get(name, {"ids": [jid]})["ids"]) >= 5: print(name, "gave up after 5 attempts"); continue
            new = submit(name)
            if new: retry.setdefault(name, {"ids": [jid]})["ids"].append(new); print(name, "resubmitted", new)
        else: print(name, cur, st)
    json.dump(retry, open(rj, "w"))


def babysit(a):
    """loop: resubmit failed batches until every batch's latest job is COMPLETED (launch must have finished so jobs_<tag>.json is complete)"""
    while True:
        resubmit(a); rj = json.load(open(f"{STATE}/jobs_{a.tag}_retry.json")); jobs = json.load(open(f"{STATE}/jobs_{a.tag}.json"))
        sts = {n: job_stage(rj.get(n, {"ids": [j]})["ids"][-1]) for n, j in jobs.items()}
        print(time.strftime("%H:%M"), {n: ("OK" if "COMPLETED" in s else s[:30]) for n, s in sts.items()}, flush=True)
        if all("COMPLETED" in s for s in sts.values()) or any("gave up" in str(s) for s in sts.values()): return
        time.sleep(90)


def collect(a):
    batches = json.load(open(f"{STATE}/batches_{a.tag}.json")); ok = True; got = {}
    if a.only: batches = {k: v for k, v in batches.items() if k in a.only.split(",")}
    for name, ids in batches.items():
        dst = f"{STATE}/{name}.jsonl"
        if os.path.exists(dst): os.unlink(dst)
        r = hf("buckets", "cp", f"hf://buckets/{BUCKET}/out/{name}.jsonl", dst)
        if r.returncode or not os.path.exists(dst): print(name, "MISSING", r.stderr[-100:]); ok = False; continue
        rows = [json.loads(l) for l in open(dst)]; have = {x["window_id"] for x in rows}
        miss = set(ids) - have; extra = have - set(ids)
        print(name, f"{len(have)}/{len(ids)} windows, missing {len(miss)}, extra {len(extra)}")
        if miss or extra: ok = False
        got[name] = rows
    if not ok: sys.exit("NOT VERIFIED: nothing written, nothing to clean up")
    if a.tag != "b": print("tag", a.tag, "is a parity test: not appended; turns in", STATE); return
    have = done_ids() if os.path.exists(RES) else set()
    with open(RES, "a") as f:
        for rows in got.values():
            for x in rows:
                if x["window_id"] not in have: f.write(json.dumps(x) + "\n")
    print("VERIFIED and appended to", RES, sum(len(r) for r in got.values()), "windows")


def cleanup(a):
    if not os.path.exists(f"{STATE}/VERIFIED"): sys.exit("run collect first and touch VERIFIED yourself after checking; nothing deleted")
    print(hf("buckets", "delete", BUCKET, "--yes").stdout)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("cmd", choices=["launch", "status", "collect", "cleanup", "resubmit", "babysit"]); ap.add_argument("--batch", type=int, default=420); ap.add_argument("--limit", type=int); ap.add_argument("--tag", default="b"); ap.add_argument("--only"); ap.add_argument("--redo-from")
    a = ap.parse_args(); {"launch": launch, "status": status, "collect": collect, "cleanup": cleanup, "resubmit": resubmit, "babysit": babysit}[a.cmd](a)
