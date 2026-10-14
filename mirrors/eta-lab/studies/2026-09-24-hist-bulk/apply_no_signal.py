#!/usr/bin/env python3
"""apply_no_signal.py — ruling 255: apply the NO_SIGNAL list (exact-zero windows, rule no_signal_v1: every chunk size_bytes/duration_s in [700,716] B/s).
For every listed window:
  * NOT started by anyone: claim it (O_EXCL, owner 'no_signal') so no running process picks it up, and write a write-once SKIP record (state no_signal, ok false, no text, chunk keys + sizes, rule, reason).
  * already DONE (a router result exists): write a write-once ANNOTATION record (state no_signal_annotation) that points at the existing file(s); the existing files are never edited.
  * claimed / in flight: left alone (listed in the report; run again later to annotate it once done).
Everything goes into ONE new run_id in the vault layout (runs/<run_id>/<room>/<day>/<win>.json + manifests start/end). Ids, keys, sizes only: no text.  --dry-run counts only.
NO_SIGNAL means a recording fault: NOT silence, NOT 'no speech', NOT a finished empty transcript (eta-refuter-2 #1260)."""
import glob, hashlib, json, os, sys
from datetime import datetime, timezone, timedelta
HD = os.path.expanduser("~/eta-data/hist"); IST = timezone(timedelta(hours=5, minutes=30)); DRY = "--dry-run" in sys.argv
RULE = "no_signal_v1: every chunk of the window has size_bytes/duration_s in [700,716] B/s (exact-zero recording; verified by energy on 12 chunks, hist-miner #1258/#1259)"
TIER = sys.argv[sys.argv.index("--tier") + 1] if "--tier" in sys.argv else "A"
LISTP = f"{HD}/exact_zero_windows_tier{TIER}.json"
ids = json.load(open(LISTP))["windows"]
W = {w["win_id"]: w for w in json.load(open(f"{HD}/windows_tier{TIER}.json"))}
CH = {c["id"]: c for j in json.load(open(f"{HD}/manifest.json"))["jobs"] for c in j["chunks"]}
last = {}
for l in open(f"{HD}/state.jsonl"): r = json.loads(l); last[r["win"]] = r["state"]
now = datetime.now(IST); nowi = now.isoformat(timespec="seconds")
rid = f"hist-bulk-{now.strftime('%Y%m%dT%H%M')}-{hashlib.sha256((RULE + LISTP).encode()).hexdigest()[:7]}"
def wo(path, obj):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f: json.dump(obj, f, ensure_ascii=False)
def find_files(win):
    out = []
    for p in glob.glob(f"{HD}/runs/*/*/*/{win}.json"): out.append(p.split("/runs/")[1])
    for p in glob.glob(f"{HD}/out/*/{win}.json"): out.append("hist-bulk-backfill-20260924/" + "/".join(p.split("/out/")[1:]) + " (old layout out/)")
    return out
def chunks_of(w):
    cs = [CH[i] for i in w["chunk_ids"] if i in CH]
    return [{"r2_key": c["r2_key"], "size_bytes": int(c["size_bytes"]), "duration_ms": int(c["duration_ms"]), "bytes_per_s": round(int(c["size_bytes"]) / (int(c["duration_ms"]) / 1000), 1)} for c in cs]
TWIN_SHA = hashlib.sha256(open(f"{HD}/stack_versions.json", "rb").read()).hexdigest()   # the Worker demands a 64-hex sha even when stack is not_run: cite the twin stack file this window WOULD have run under (reference only)

def prov(keys):
    return {"run_id": rid, "producer": "hist-bulk", "created_at": nowi, "provenance_complete": True, "not_run": ["stack", "guards", "diarizer"], "stack": None, "guards": None, "diarizer": None,
            "stack_versions_sha256": TWIN_SHA, "source_audio_keys": sorted(keys), "incomplete_reason": None,
            "note": "NO_SIGNAL: no STT engine ran on this window; stack/guards are null on purpose (not_run). stack_versions_sha256 is REFERENCE ONLY: the published twin stack this window would have run under."}
def base(w, cs, state):
    day = w["day"]; n = len(cs)
    nosig = {"rule": RULE, "reason": f"all {n} chunks exact-zero by size (700-716 B/s)", "chunks": cs,
             "meaning": "NO_SIGNAL = recording fault. It is NOT silence, NOT 'no speech', NOT a finished empty transcript; any downstream use must treat the window as untested."}
    return {"schema": "eta-lab-result/1", "window_id": w["win_id"], "room_id": w["room_id"], "day": day, "start": w["start"], "end": w["end"], "state": state, "ok": False, "error": "no_signal",
            "mining_only": True, "no_signal": nosig, "cut": {"n_chunks": n, "chunk_keys": [c["r2_key"] for c in cs]}, "provenance": prov([c["r2_key"] for c in cs])}
skip, annot, left = [], [], []
for win in ids:
    w = W[win]; cs = chunks_of(w)
    if last.get(win) == "done": annot.append((w, cs)); continue
    if DRY: (skip if not os.path.exists(f"{HD}/claims/{win}") else left).append((w, cs)); continue
    os.makedirs(f"{HD}/claims", mode=0o700, exist_ok=True)
    try: fd = os.open(f"{HD}/claims/{win}", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.write(fd, b"no_signal"); os.close(fd); skip.append((w, cs))
    except FileExistsError: left.append((w, cs))
print(f"listed {len(ids)} | to SKIP (claimed for no_signal): {len(skip)} | to ANNOTATE via per-run addenda (already done): {len(annot)} | left alone (in flight or claimed by a process): {len(left)}" + (" [dry run]" if DRY else ""))
if DRY: sys.exit(0)
start = {"schema": "eta-lab-result/1", "provenance": {"run_id": rid, "producer": "hist-bulk", "created_at": nowi, "provenance_complete": True, "not_run": ["stack", "guards", "diarizer"], "stack": None, "guards": None, "diarizer": None, "stack_versions_sha256": TWIN_SHA, "source_audio_keys": []},
         "queue": {"kind": "no_signal", "rule": RULE, "list": f"exact_zero_windows_tier{TIER}.json", "listed": len(ids), "skip": len(skip), "annotate": len(annot), "left_alone": len(left)}}
wo(f"{HD}/manifests/{rid}.start.json", start)
with open(f"{HD}/state.jsonl", "a") as sf:
    for w, cs in skip:
        rec = base(w, cs, "no_signal"); rec["decision"] = "skipped: not transcribed (ruling 255); claimed before any process started it"
        wo(f"{HD}/runs/{rid}/{w['room_id']}/{w['day']}/{w['win_id']}.json", rec)
        sf.write(json.dumps({"t": datetime.now().isoformat(timespec="seconds"), "run": rid, "win": w["win_id"], "state": "no_signal"}) + "\n")
    by_run = {}
    for w, cs in annot:
        fs = find_files(w["win_id"]) or ["?"]
        for f in fs: by_run.setdefault(f.split("/")[0], []).append(w["win_id"])
end_extra = {}
for run_id, wins in sorted(by_run.items()):
    ap_ = f"{HD}/manifests/{run_id}.addendum.json"
    body = {"reason": f"no_signal_v1 (exact_zero_by_size_v1): the listed window ids of THIS run have every chunk at 700-716 B/s of tape (exact-zero recording). Their records say ok with empty text; read them as NO_SIGNAL (a recording fault), NOT as silence or 'no speech', and treat them as untested for any downstream use. The window files are unchanged (write-once).",
            "rule": RULE, "no_signal": {"rule": "exact_zero_by_size_v1", "rule_sha": "eaf36bb4233bba76708553c25edd02779affec3b9b049a3e7ca8ec5bc8415f2e", "window_ids": sorted(set(wins))}, "count": len(set(wins)), "evidence_list": "studies/2026-09-24-hist-bulk/no_signal_windows_tierA.json (ids, rule, chunk sizes; eta-lab)", "applied_by_run": rid}
    if run_id == "hist-bulk-backfill-20260924" or os.path.exists(ap_):   # one addendum per run key (write-once): an existing one cannot take a second; the ids go into this run's manifest instead
        end_extra[run_id] = sorted(set(wins)); continue
    wo(ap_, {"schema": "eta-lab-result/1", "provenance": {"run_id": run_id, "producer": "hist-bulk", "created_at": nowi}, "addendum": body})
    print("addendum written for", run_id, len(set(wins)), "windows")
end = {**start, "provenance": {**start["provenance"], "created_at": datetime.now(IST).isoformat(timespec="seconds")}, "counts": {"skipped": len(skip), "annotated": len(annot), "left_alone": len(left)}, "ended_at": datetime.now(IST).isoformat(timespec="seconds"),
       "left_alone_ids": [w["win_id"] for w, _ in left], "annotation_ids_for_runs_with_an_existing_addendum": end_extra}
wo(f"{HD}/manifests/{rid}.json", end)
print("run_id", rid, "| files written under runs/ and manifests/")
