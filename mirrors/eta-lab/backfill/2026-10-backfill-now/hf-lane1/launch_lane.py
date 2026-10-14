#!/usr/bin/env python3
"""launch_lane.py — HF-1 lane-1 launcher: whisper x3 (forced-en a2131b2d, cap2 c7bd317b, auto 4b67551a) onto REB, one HF job transcribes a window with all needed configs (one model load).
Derived (copied, not edited) from ~/eta-data/koyal-build/launch_koyal.py 362811ba. DEFAULT IS --dry-run: reads manifest/REB/claims and LISTS buckets + billing (read-only), creates and launches nothing.
  launch_lane.py --lane whisper3 --day 2026-09-28 [--dry-run] [--max-jobs N] [--windows-per-job K] [--timeout 45m]
  launch_lane.py --lane whisper3 --day 2026-09-28 --launch --balance-usd <V's figure> [--max-jobs N]     (NOT authorised yet: needs a later order)
  launch_lane.py --lane whisper3 --day 2026-09-28 --reconcile        release claims (MOVE, never delete) of ERROR/CANCELED jobs
Guards (all fail closed): heldout.py sha16 f672c1ef046089dd + union id f07171dc; blind predicate per window (start/end-1s IST days + ist_date + id day; unparseable = blind) before any claim;
the job file's own embedded blind list must equal heldout's; skip-if-exists per (track, window): REB track file | out bucket | claim; O_EXCL claims; budget gate from usage-v2 (hf_budget.py).
HF-1b (BF-CHECK-2 rulings): F1 the lane has its OWN track identity (box config dict + producer fields, hashes e0d31902 / 5a550766 / 2e3b6c81, never a2131b2d/c7bd317b/4b67551a); F2 --reconcile also releases claims of windows a COMPLETED
job did not write; F3 --balance-usd needs --balance-asof (usage-v2 billed since then is subtracted); F4 explicit --label name=whisper3_hf_job-<sha8>; F7 --launch refused if the audio listing failed; F8 no account token is sent to the job
(optional --job-secrets-file for a READ-ONLY fine-grained token if the bucket mount ever needs one).
Token: the account token is read in-process for the hf CLI/API only (environment, never argv, never printed, NOT a job secret). No transcript text anywhere."""
import argparse, glob, importlib.util, json, math, os, re, subprocess, sys, time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import hf_budget
HELDOUT_PY = os.path.expanduser("~/eta-data/drtpqma/heldout.py"); HELDOUT_SHA16 = "f672c1ef046089dd"; UNION_SHA8 = "f07171dc"
JOB = f"{HERE}/whisper3_hf_job.py"
HIST = os.path.expanduser("~/eta-data/hist"); WREB = f"{HIST}/windows-reb"; CLAIMS_DEFAULT = f"{WREB}/claims-hf"; REB_DEFAULT = os.path.expanduser("~/eta-data/reb")
MODEL_ID = "openai/whisper-large-v3-turbo"
def _job_module():
    spec = importlib.util.spec_from_file_location("whisper3_hf_job", JOB); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
TRACKS = dict(_job_module().LANE_HASHES)   # HF-1b F1: the lane's OWN track identity (producer fields in the config), never the box hashes a2131b2d/c7bd317b/4b67551a
IST = timezone(timedelta(hours=5, minutes=30))
# --- cost model: ASSUMPTIONS (no L4 measurement exists yet; the first pilot job must be timed and these replaced) ---
SPEED_X = 40.0        # audio-seconds transcribed per wall-second per config (whisper-large-v3-turbo fp16, batch 8, L4)
LOAD_MIN = 4.0        # model download + load per job
FLAVOR, RATE_USD_H = "l4x1", 0.80

def sha256_file(p):
    import hashlib
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()

def mon(day): return datetime.strptime(day, "%Y-%m-%d").strftime("%d%b").lower()       # 2026-09-28 -> 28sep
def audio_bucket(day): return f"vrbeven/reb-backfill-{mon(day)}-audio"
def out_bucket(day): return f"vrbeven/reb-whisper3-{mon(day)}-out"

def load_job_module():
    spec = importlib.util.spec_from_file_location("whisper3_hf_job", JOB); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

def load_guard(heldout_py=HELDOUT_PY, expect_sha16=HELDOUT_SHA16):
    """Assert the heldout.py pin, load its union, and prove the job file's embedded blind list equals it. Returns (heldout module, union, job module)."""
    got = sha256_file(heldout_py)[:16]
    if got != expect_sha16: raise SystemExit(f"REFUSED: heldout.py sha16 {got} != {expect_sha16}")
    sys.path.insert(0, os.path.dirname(heldout_py)); import heldout
    union, uid = heldout.load_union()
    if not str(uid).startswith(UNION_SHA8): raise SystemExit(f"REFUSED: blind union id {str(uid)[:8]} != {UNION_SHA8}")
    jm = load_job_module(); rid = {"OPD4": "room_ux92qpws", "OPD5": "room_4ggnkg5x", "OPD7": "room_qyzghzaf"}
    want = {(d, rid[r]) for d, r in (x.split() for x in union)}
    if want != set(jm.BLIND): raise SystemExit("REFUSED: the job's embedded blind list differs from heldout.py's union")
    if jm.HELDOUT_SHA16 != expect_sha16: raise SystemExit("REFUSED: job HELDOUT_SHA16 constant differs")
    return heldout, union, jm

def window_days(w):
    st = datetime.fromisoformat(w["start"].replace("Z", "+00:00")).astimezone(IST); en = datetime.fromisoformat(w["end"].replace("Z", "+00:00")).astimezone(IST) - timedelta(seconds=1)
    m = re.search(r"(\d{4}-\d{2}-\d{2})_room_[a-z0-9]+_\d{4}", w["win_id"])
    if not m: raise ValueError("unparseable window id")
    return {st.date().isoformat(), en.date().isoformat(), w["ist_date"], m.group(1)}

def is_blind(w, heldout, union):
    try: return any(heldout.is_held_out(union, d, w["room"]) for d in window_days(w))
    except Exception: return True      # fail closed

def _hf_env(): return dict(os.environ, HF_TOKEN=open(os.path.expanduser("~/.cache/huggingface/token")).read().strip())

def ls_bucket(bucket):
    """Basenames in a bucket (read-only list), or None if the bucket does not exist / cannot be listed."""
    r = subprocess.run(["hf", "buckets", "ls", bucket, "-R", "--format", "quiet"], capture_output=True, text=True, env=_hf_env(), timeout=300)
    return {l.split("/")[-1] for l in r.stdout.split() if l.strip()} if r.returncode == 0 else None

def reb_track(reb_root, w, engine): return f"{reb_root}/{w['ist_date']}/{w['room']}/{w['win_id']}/tracks/stt.{engine}__v1__{TRACKS[engine]}.json"
def claim_path(claims_root, engine, win): return f"{claims_root}/{engine}__{TRACKS[engine]}/{win}"

def claim(claims_root, engine, win, owner):
    """O_EXCL claim; content = owner + job id (job filled in after launch). Returns True if THIS process now owns it."""
    d = f"{claims_root}/{engine}__{TRACKS[engine]}"; os.makedirs(d, mode=0o700, exist_ok=True)
    try: fd = os.open(f"{d}/{win}", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError: return False
    with os.fdopen(fd, "w") as f: json.dump({"owner": owner, "job": None, "t": datetime.now(IST).isoformat(timespec="seconds")}, f)
    return True

def set_claim_job(claims_root, engine, win, owner, job_id):
    p = claim_path(claims_root, engine, win); c = json.load(open(p))
    if c.get("owner") != owner: return
    c["job"] = job_id; open(p + ".tmp", "w").write(json.dumps(c)); os.replace(p + ".tmp", p)

def release(claims_root, engine, win, why, job_id=None):
    """MOVE (never delete) a claim to claims-hf/_released/<ts>/... HF-1c G1: with job_id given (reconcile), the claim is moved ONLY if its recorded job id equals job_id, so a claim that a
    later job (J2) took on the same window is never released by reconciling an earlier job (J1). job_id=None keeps the launcher's own unconditional release (lost race / launch failed)."""
    src = claim_path(claims_root, engine, win)
    if not os.path.exists(src): return False
    if job_id is not None:
        try: cur = json.load(open(src)).get("job")
        except Exception: return False                       # unreadable claim => keep it
        if cur != job_id: return False
    dst_dir = f"{claims_root}/_released/{time.strftime('%Y%m%dT%H%M%S')}/{engine}__{TRACKS[engine]}"; os.makedirs(dst_dir, mode=0o700, exist_ok=True)
    os.rename(src, f"{dst_dir}/{win}"); return True

def plan(day, heldout, union, reb_root, claims_root, audio_ls, out_ls, manifest_path=None):
    manifest_path = manifest_path or f"{WREB}/manifest-{day}.jsonl"
    man = [json.loads(l) for l in open(manifest_path)]
    ign = set()
    for f in glob.glob(f"{WREB}/BLIND-IGNORE-*.json"):
        j = json.load(open(f)); k = "ignore_list" if "ignore_list" in j else ("ids" if "ids" in j else None)
        if k: ign |= set(j[k])
    st = {"manifest": len(man), "blind_excluded": 0, "ignore_list_excluded": 0, "audio_not_in_bucket": 0, "all_tracks_done": 0, "claimed_only": 0, "planned": 0}; todo, gaps = [], []
    for w in man:
        if w["win_id"] in ign: st["ignore_list_excluded"] += 1; continue
        if is_blind(w, heldout, union): st["blind_excluded"] += 1; continue                 # BEFORE anything else touches this window: never planned, never listed as audio
        need, claimed = [], 0
        for e in TRACKS:
            if os.path.exists(reb_track(reb_root, w, e)): continue
            if out_ls is not None and f"{w['win_id']}.json" in out_ls: continue
            if os.path.exists(claim_path(claims_root, e, w["win_id"])): claimed += 1; continue
            need.append(e)
        if not need: st["all_tracks_done" if not claimed else "claimed_only"] += 1; continue
        if audio_ls is not None and os.path.basename(w["audio"]) not in audio_ls: st["audio_not_in_bucket"] += 1; gaps.append(w["win_id"]); continue
        todo.append({"win_id": w["win_id"], "room": w["room"], "ist_date": w["ist_date"], "start": w["start"], "end": w["end"], "audio": os.path.basename(w["audio"]), "need": need, "_dur": w["cut"]["duration_s"]})
    st["planned"] = len(todo); return todo, st, gaps

def estimate(chunk):
    wall_s = sum(w["_dur"] * len(w["need"]) / SPEED_X for w in chunk); minutes = math.ceil(LOAD_MIN + wall_s / 60.0)
    return minutes, round(minutes * RATE_USD_H / 60.0, 2)

def chunks_of(todo, k, max_jobs=None):
    jobs = [todo[i:i + k] for i in range(0, len(todo), k)]; return jobs[:max_jobs] if max_jobs else jobs

def model_revision(override=None):
    """The revision is part of the track identity (config.model_revision), so it is the job's PINNED_REVISION constant; an override that differs is refused."""
    pinned = _job_module().PINNED_REVISION
    if override and override != pinned: raise SystemExit("--model-revision must equal the revision pinned in the job (it is part of the track config hash)")
    return pinned

def effective_balance(balance_usd, asof, billed_fn=hf_budget.billed_since, now=None):
    """F3: V's balance figure is point-in-time; subtract usage-v2 billed since --balance-asof. Raises BudgetUnavailable (fail closed) if billing is unreadable."""
    if balance_usd is None: return None
    if not asof: raise SystemExit("--balance-usd needs --balance-asof <ISO time V read it, e.g. 2026-10-07T17:30+05:30>")
    t = datetime.fromisoformat(asof); t = t if t.tzinfo else t.replace(tzinfo=IST); now = now or datetime.now(timezone.utc)
    if t > now: raise SystemExit("--balance-asof is in the future")
    return balance_usd - billed_fn(t.astimezone(timezone.utc), now)

def reconcile_state(state, claims_root, stage_fn, out_ls_fn):
    """F2 + HF-1c G1: ERROR/CANCELED/FAILED job => release (move) its claims; COMPLETED job => release the claims of windows whose <win>.json is NOT in the out bucket. A claim is moved only if it still
    records THIS job id (release(job_id=jid)). A job that was reconciled to a terminal stage is marked rec["reconciled"] in `state` (the caller persists it) and is never revisited. Unknown stage or an
    unreadable out listing => keep the claims and do NOT mark. Returns (n_released, [(job, stage)])."""
    n, seen = 0, []
    for jid, rec in state.items():
        if rec.get("reconciled"): continue
        stage = stage_fn(jid); seen.append((jid, stage)); done = False
        if stage in ("ERROR", "CANCELED", "FAILED"):
            for w in rec["windows"]:
                for e in rec["tracks"].get(w, []): n += release(claims_root, e, w, stage, job_id=jid)
            done = True
        elif stage == "COMPLETED":
            out = out_ls_fn()
            if out is None: continue
            for w in rec["windows"]:
                if f"{w}.json" not in out:
                    for e in rec["tracks"].get(w, []): n += release(claims_root, e, w, "completed-not-written", job_id=jid)
            done = True
        if done: rec["reconciled"] = {"stage": stage, "t": time.strftime("%Y-%m-%dT%H:%M:%S")}
    return n, seen

def parse_timeout_min(s):
    m = re.fullmatch(r"(\d+)m", s)
    if not m: raise SystemExit("--timeout must look like 45m")
    return int(m.group(1))

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lane", required=True, choices=["whisper3"]); ap.add_argument("--day", required=True)
    g = ap.add_mutually_exclusive_group(); g.add_argument("--dry-run", action="store_true"); g.add_argument("--launch", action="store_true"); g.add_argument("--reconcile", action="store_true")
    ap.add_argument("--max-jobs", type=int, default=10); ap.add_argument("--windows-per-job", type=int, default=25); ap.add_argument("--timeout", default="45m")
    ap.add_argument("--balance-usd", type=float); ap.add_argument("--balance-asof", help="ISO time at which V read the balance (usage-v2 billed since then is subtracted)"); ap.add_argument("--job-secrets-file", help="optional: a file of secret env vars (KEY=VALUE) for the job, e.g. a READ-ONLY fine-grained HF token if the bucket mount needs one; the account token is never sent"); ap.add_argument("--model-revision"); ap.add_argument("--reb-root", default=REB_DEFAULT); ap.add_argument("--claims-root", default=CLAIMS_DEFAULT)
    ap.add_argument("--manifest"); ap.add_argument("--no-bucket-ls", action="store_true", help="tests only: skip bucket listing")
    a = ap.parse_args(argv); datetime.strptime(a.day, "%Y-%m-%d"); tmin = parse_timeout_min(a.timeout)
    heldout, union, jm = load_guard()
    state_p = f"{HERE}/state_whisper3_{mon(a.day)}.json"; state = json.load(open(state_p)) if os.path.exists(state_p) else {}
    if a.reconcile:
        from huggingface_hub import HfApi
        api = HfApi(token=_hf_env()["HF_TOKEN"]); ns = api.whoami()["name"]
        def stage_fn(jid):
            try: return api.inspect_job(job_id=jid, namespace=ns).status.stage
            except Exception: return "UNKNOWN"                       # unknown => keep the claims
        n, seen = reconcile_state(state, a.claims_root, stage_fn, lambda: ls_bucket(out_bucket(a.day)))
        for jid, stage in seen: print(jid, stage)
        tmp = state_p + ".tmp"; json.dump(state, open(tmp, "w")); os.replace(tmp, state_p)      # persist the reconciled markers
        print("claims released (moved):", n); return 0
    audio_ls = None if a.no_bucket_ls else ls_bucket(audio_bucket(a.day)); out_ls = None if a.no_bucket_ls else ls_bucket(out_bucket(a.day))
    todo, st, gaps = plan(a.day, heldout, union, a.reb_root, a.claims_root, audio_ls, out_ls, a.manifest)
    extra = {"blind_audio_present_in_bucket": 0, "other_manifest_audio_not_planned": 0, "unknown_files": 0}
    if audio_ls is not None:       # item 7: what else sits in the audio bucket (names only; nothing is downloaded)
        byname = {os.path.basename(w["audio"]): w for w in (json.loads(l) for l in open(a.manifest or f"{WREB}/manifest-{a.day}.jsonl"))}
        for n in audio_ls - {w["audio"] for w in todo}:
            w = byname.get(n)
            if w is None: extra["unknown_files"] += 1
            elif is_blind(w, heldout, union): extra["blind_audio_present_in_bucket"] += 1
            else: extra["other_manifest_audio_not_planned"] += 1
    jobs = chunks_of(todo, a.windows_per_job, a.max_jobs); ests = [estimate(c) for c in jobs]
    new_cost = round(len(jobs) * RATE_USD_H * tmin / 60.0, 2)
    rep = {"day": a.day, "audio_bucket": audio_bucket(a.day), "audio_bucket_files": None if audio_ls is None else len(audio_ls), "out_bucket": out_bucket(a.day), "out_bucket_exists": out_ls is not None,
           **st, "jobs": len(jobs), "windows_in_jobs": sum(len(c) for c in jobs), "est_minutes_total": sum(m for m, _ in ests), "est_usd_total": round(sum(u for _, u in ests), 2),
           "committed_usd_if_launched": new_cost, "cost_model": f"ASSUMPTION speed {SPEED_X:.0f}x/config, load {LOAD_MIN:.0f} min/job, {FLAVOR} ${RATE_USD_H}/h (no L4 measurement yet)", "audio_gap_sample": gaps[:5], "bucket_extras_not_planned": extra}
    bal_eff = None
    try:
        if a.balance_usd is not None and not a.balance_asof and not a.launch: rep["balance_note"] = "--balance-usd ignored in dry-run without --balance-asof"
        else: bal_eff = effective_balance(a.balance_usd, a.balance_asof)
        snap = hf_budget.snapshot(); ok, why = hf_budget.gate(snap, new_cost, bal_eff, require_balance=a.launch)
    except hf_budget.BudgetUnavailable as e: snap, ok, why = None, False, [f"FAIL CLOSED: {e}"]
    rep["budget"] = {"would_pass": ok, "reasons": why, "snapshot": snap, "balance_effective_usd": None if bal_eff is None else round(bal_eff, 2)}
    if not a.launch:
        print(json.dumps(rep, indent=1)); return 0
    # ---- launch (not authorised until a later order) ----
    if audio_ls is None: print("REFUSED: the audio bucket listing failed (None): the audio-gap and out-bucket skip checks would be silently dropped"); return 4        # F7
    if not ok: print("REFUSED by budget gate:", why); return 2
    if not jobs: print("nothing to launch"); return 0
    rev = model_revision(a.model_revision); own = f"launch_lane-{os.getpid()}-{int(time.time())}"; env = _hf_env()
    subprocess.run(["hf", "buckets", "create", out_bucket(a.day).split("/")[1], "--private"], capture_output=True, env=env); subprocess.run(["hf", "buckets", "settings", out_bucket(a.day), "--private"], capture_output=True, env=env)
    for chunk in jobs:
        mine = []                                                           # claims: ALL-or-nothing per window (lost race on any track => release what we took, skip window)
        for w in chunk:
            got = [e for e in w["need"] if claim(a.claims_root, e, w["win_id"], own)]
            if len(got) == len(w["need"]): mine.append(w)
            else:
                for e in got: release(a.claims_root, e, w["win_id"], "lost-race")
        if not mine: continue
        send = [{k: v for k, v in w.items() if k != "_dur"} for w in mine]
        cmd = ["hf", "jobs", "uv", "run", "--flavor", FLAVOR, "--timeout", a.timeout, "--label", f"name={hf_budget.LANE_JOB_PREFIX}-{sha256_file(JOB)[:8]}", "--label", "lane=whisper3", "-e", "WINDOWS=" + json.dumps(send), "-e", f"MODEL_ID={MODEL_ID}", "-e", f"MODEL_REVISION={rev}",
               "-e", f"EXPECT_SCRIPT_SHA16={sha256_file(JOB)[:16]}", "-e", f"HELDOUT_SHA16={HELDOUT_SHA16}", "-e", f"EXPECT_BLIND_SHA16={jm.blind_list_sha16(jm.BLIND)}",
               "-v", f"hf://buckets/{audio_bucket(a.day)}:/mnt/audio:ro", "-v", f"hf://buckets/{out_bucket(a.day)}:/mnt/out", "--detach", JOB]
        if a.job_secrets_file: cmd[cmd.index("--detach"):cmd.index("--detach")] = ["--secrets-file", a.job_secrets_file]   # F8: only when given; default = NO secret reaches the job (public model, platform-mounted buckets)
        r = subprocess.run(cmd, capture_output=True, text=True, env=env); o = r.stdout + r.stderr; m = re.search(r"vrbeven/([0-9a-f]{24})", o)
        if not m:
            for w in mine:
                for e in w["need"]: release(a.claims_root, e, w["win_id"], "launch-failed")
            print("launch failed:", o[-200:].replace(env["HF_TOKEN"], "***")); return 3
        jid = m.group(1)
        for w in mine:
            for e in w["need"]: set_claim_job(a.claims_root, e, w["win_id"], own, jid)
        state[jid] = {"windows": [w["win_id"] for w in mine], "tracks": {w["win_id"]: w["need"] for w in mine}, "t": datetime.now(IST).isoformat(timespec="seconds")}
        json.dump(state, open(state_p, "w")); print("launched", jid, len(mine))
    return 0

if __name__ == "__main__": sys.exit(main())
