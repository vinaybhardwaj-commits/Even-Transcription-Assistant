#!/usr/bin/env python3
"""drive_lane1.py — HF-5: resumable driver for the WHOLE lane-1 Whisper backfill on HF L4 jobs (job file whisper3_hf_job.py 3bec47c9, lane hashes e0d31902/5a550766/2e3b6c81). Run with the SYSTEM python3 (huggingface_hub 2.x: JobInfo.durations/labels; the hf-lane1 .venv has 0.36 and the budget gate fails closed there).
launch_lane.py / hf_budget.py / collect_lane.py are IMPORTED UNCHANGED (claims, plan(), release/reconcile with the HF-1c job-id guard, blind predicate, heldout pin). Nothing here edits them.
  drive_lane1.py                      DRY RUN (default): scope, per-day plan, box-only audio to push, cost / days projection, gate verdict. Creates and launches nothing.
  drive_lane1.py --run                loop: reconcile -> (push audio, plan next busiest day) -> launch 12-window jobs up to the concurrency target -> poll -> collect finished days. STOP/PAUSE files in drive/.
Scope = the HF-4 plan's worklist (windows + audio sha256); its id-collision exclusions stay excluded. Day order = Metasurfer consults (most first). Budget (all fail closed, from HF's own billed data):
  - stop ENTIRELY if effective balance - committed - new < $5 (balance = V's figure in drive/balance.json {balance_usd, asof}; usage-v2 billed since asof is subtracted) or lane total billed+committed+new > $220
  - hold for the day if lane spend today (IST) + new > $70 (the $10/day palimpsest reserve), or account spend today + committed + new > $80
  - without drive/HF1C-PASS (content = launch_lane sha16 12a2ed1e...) at most 2 jobs may ever be launched by this driver (PILOT_JOBS)
  - circuit breaker: 3 consecutive ERROR/CANCELED jobs => PAUSE file + stop. Concurrency starts at 2, +1 per cleanly COMPLETED job, -1 per ERROR, max --max-concurrent.
Torch identity (refuter N1): jobs run with `--with torch==2.14.1 --with av==19.0.1` (what the 8 Oct pilot resolved: unpinned torch = newest on PyPI = 2.14.1, wheel 528.9 MiB as in the pilot log); the job file and its sha are untouched.
Token: only inside hf's environment (never argv/log). No traffic via the Mini; box -> HF direct. Prints counts/ids only."""
import argparse, csv, glob, hashlib, json, math, os, re, subprocess, sys, tempfile, time
from datetime import datetime, timedelta, timezone
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/kit"))
import launch_lane as L, hf_budget as B
IST, UTC = L.IST, timezone.utc
DRIVE = f"{HERE}/drive"; STATE = f"{DRIVE}/state.json"; LEDGER = f"{DRIVE}/ledger.jsonl"; BAL = f"{DRIVE}/balance.json"; PASS = f"{DRIVE}/HF1C-PASS"
PLAN_DIR = os.path.expanduser("~/oc/backfill-now/e2e-lane1/plan-full-081035"); CONSULTS = os.path.expanduser("~/oc/backfill-now/metasurfer-9574-consults-per-day.csv")
PULL = os.path.expanduser("~/eta-data/hist/hf1-pull")
CFG = dict(lane_total_cap=220.0, day_lane_cap=70.0, day_acct_cap=80.0, min_balance=5.0, windows_per_job=12, timeout_min=45, rate_h=0.80, max_conc=6, start_conc=2, pilot_jobs=2, cooldown_errors=3, usd_per_window=0.038)
PINS = ["--with", "torch==2.14.1", "--with", "av==19.0.1"]
LAUNCH_SHA16 = "12a2ed1e3dcafee0"
def now_ist(): return datetime.now(IST)
def sha256_file(p): return L.sha256_file(p)
def sha16(p): return sha256_file(p)[:16]

# ---------- scope / ordering ----------
PILOT_STATE = f"{HERE}/state_whisper3_28sep.json"
def load_scope(plan_dir=PLAN_DIR, pilot_state=PILOT_STATE, wreb=None):
    """HF-4 worklist (minus its id-collision exclusions) PLUS the 28 Sep pilot's windows: the plan excluded them because the pilot had claimed them, but the pilot jobs timed out (15 of the 50 never ran)."""
    wl = {w["win_id"]: w for w in (json.loads(l) for l in open(f"{plan_dir}/worklist.jsonl") if l.strip())}
    excl = set(json.load(open(f"{plan_dir}/plan.json")).get("id_collision_excluded", []))
    scope = {k: v for k, v in wl.items() if k not in excl}
    if pilot_state and os.path.exists(pilot_state):
        ids = {w for r in json.load(open(pilot_state)).values() for w in r["windows"]}
        if ids - set(scope):
            man = {w["win_id"]: w for w in (json.loads(l) for l in open(f"{wreb or L.WREB}/manifest-2026-09-28.jsonl"))}
            for i in sorted(ids - set(scope) - excl):
                m = man[i]; scope[i] = {"win_id": i, "room": m["room"], "ist_date": m["ist_date"], "start": m["start"], "end": m["end"], "audio": os.path.relpath(m["audio"], wreb or L.WREB), "audio_sha256": m["sha256"], "need": list(L.TRACKS)}
    return scope, excl

def day_order(scope, consults_csv=CONSULTS):
    days = sorted({w["ist_date"] for w in scope.values()}); rank = {}
    try:
        for r in csv.DictReader(open(consults_csv)): rank[r["date"]] = int(r["completed_consults"])
    except Exception: pass
    return sorted(days, key=lambda d: (-rank.get(d, -1), d))

# ---------- money ----------
def read_balance(path=BAL):
    j = json.load(open(path)); return float(j["balance_usd"]), j["asof"]
def lane_spend(jobs, rates, now, cfg=CFG):
    """jobs: iterable of JobInfo-like (id, flavor, labels, status.stage, durations.running_secs, created_at). -> dict. Terminal lane job = ceil(running min) x rate; open job = full timeout committed."""
    day0 = now.astimezone(IST).replace(hour=0, minute=0, second=0, microsecond=0)
    r = dict(lane_total_billed=0.0, lane_today_billed=0.0, committed_lane=0.0, committed_all=0.0, open_lane=0)
    for j in jobs:
        fl = str(j.flavor).split(".")[-1].lower().replace("_", "-"); hr = rates.get(fl, rates.get(str(j.flavor)))
        if hr is None: raise B.BudgetUnavailable(f"no rate for flavor {j.flavor}")
        is_lane = ((j.labels or {}).get("name", "")).startswith(B.LANE_JOB_PREFIX); stage = j.status.stage
        if stage in B.OPEN_STAGES:
            c = hr * cfg["timeout_min"] / 60.0; r["committed_all"] += c
            if is_lane: r["committed_lane"] += c; r["open_lane"] += 1
        elif is_lane and j.durations and j.durations.running_secs:
            c = math.ceil(j.durations.running_secs / 60) * hr / 60.0; r["lane_total_billed"] += c
            if j.created_at.astimezone(IST) >= day0: r["lane_today_billed"] += c
    return r
def gate(sp, acct_today, bal_eff, new_cost, cfg=CFG):
    """-> ('ok'|'day'|'stop', [reasons]).  'stop' = end the run (money), 'day' = hold until the next IST day."""
    stop, day = [], []
    if bal_eff - sp["committed_all"] - new_cost < cfg["min_balance"]: stop.append(f"balance {bal_eff:.2f} - committed {sp['committed_all']:.2f} - new {new_cost:.2f} < {cfg['min_balance']:.0f}")
    if sp["lane_total_billed"] + sp["committed_lane"] + new_cost > cfg["lane_total_cap"]: stop.append(f"lane total {sp['lane_total_billed']:.2f}+{sp['committed_lane']:.2f}+{new_cost:.2f} > {cfg['lane_total_cap']:.0f}")
    if sp["lane_today_billed"] + sp["committed_lane"] + new_cost > cfg["day_lane_cap"]: day.append(f"lane today {sp['lane_today_billed']:.2f}+{sp['committed_lane']:.2f}+{new_cost:.2f} > {cfg['day_lane_cap']:.0f}")
    if acct_today + sp["committed_all"] + new_cost > cfg["day_acct_cap"]: day.append(f"account today {acct_today:.2f}+{sp['committed_all']:.2f}+{new_cost:.2f} > {cfg['day_acct_cap']:.0f}")
    return ("stop" if stop else "day" if day else "ok"), stop + day

# ---------- one driver at a time (C1) ----------
def take_lock(path=None):
    """exclusive non-blocking flock on drive/LOCK, held for the life of the process. Returns the open file, or raises SystemExit(3) if another driver holds it."""
    import fcntl
    path = path or f"{DRIVE}/LOCK"; os.makedirs(os.path.dirname(path), exist_ok=True); f = open(path, "a+")
    try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError: raise SystemExit("REFUSED: another drive_lane1 holds drive/LOCK")
    f.seek(0); f.truncate(); f.write(f"{os.getpid()}\n"); f.flush(); return f

class LaunchUnknown(RuntimeError): pass      # hf returned success but no job id could be parsed: the job may be running

# ---------- state ----------
def load_state(path=None):
    path = path or STATE
    return json.load(open(path)) if os.path.exists(path) else {"jobs": {}, "conc": CFG["start_conc"], "err_streak": 0, "days": {}}
def save_state(st, path=None):
    path = path or STATE
    os.makedirs(os.path.dirname(path), exist_ok=True); tmp = f"{path}.{os.getpid()}.tmp"; json.dump(st, open(tmp, "w")); os.replace(tmp, path)
def ledger(ev, **kw):
    os.makedirs(DRIVE, exist_ok=True); open(LEDGER, "a").write(json.dumps({"t": now_ist().isoformat(timespec="seconds"), "ev": ev, **kw}) + "\n")

# ---------- HF backend (real); tests substitute a fake with the same methods ----------
class Backend:
    def __init__(self):
        from huggingface_hub import HfApi
        self.api = HfApi(token=L._hf_env()["HF_TOKEN"]); self.ns = self.api.whoami()["name"]
    def ls_bucket(self, name): return L.ls_bucket(name)
    def stage(self, jid):
        try: return self.api.inspect_job(job_id=jid, namespace=self.ns).status.stage
        except Exception: return "UNKNOWN"
    def spend(self, cfg=CFG):
        now = datetime.now(UTC); jobs = list(self.api.list_jobs(namespace=self.ns)); rates = B.flavor_rates(self.api)
        day0 = now.astimezone(IST).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
        return lane_spend(jobs, rates, now, cfg), B.billed_since(day0, now), (lambda t: B.billed_since(t.astimezone(UTC), now))
    def create_bucket(self, name):
        env = L._hf_env(); subprocess.run(["hf", "buckets", "create", name.split("/")[1], "--private", "--exist-ok"], capture_output=True, env=env)
    def upload_verify(self, local, bucket, name, sha):
        """upload one file, then download it back to a temp dir and compare sha256. Returns True only if it round-trips."""
        env = L._hf_env(); r = subprocess.run(["hf", "buckets", "cp", local, f"hf://buckets/{bucket}/{name}"], capture_output=True, text=True, env=env)
        if r.returncode: return False
        with tempfile.TemporaryDirectory() as t:
            r = subprocess.run(["hf", "buckets", "cp", f"hf://buckets/{bucket}/{name}", f"{t}/x"], capture_output=True, text=True, env=env)
            return r.returncode == 0 and os.path.exists(f"{t}/x") and sha256_file(f"{t}/x") == sha
    def launch(self, day, chunk, rev, job_path, blind_sha, own):
        env = L._hf_env(); send = [{k: v for k, v in w.items() if not k.startswith("_") and k != "audio_sha256"} for w in chunk]
        cmd = ["hf", "jobs", "uv", "run", "--flavor", L.FLAVOR, "--timeout", f"{CFG['timeout_min']}m", "--label", f"name={B.LANE_JOB_PREFIX}-{sha256_file(job_path)[:8]}", "--label", "lane=whisper3", *PINS,
               "-e", "WINDOWS=" + json.dumps(send), "-e", f"MODEL_ID={L.MODEL_ID}", "-e", f"MODEL_REVISION={rev}", "-e", f"EXPECT_SCRIPT_SHA16={sha256_file(job_path)[:16]}", "-e", f"HELDOUT_SHA16={L.HELDOUT_SHA16}",
               "-e", f"EXPECT_BLIND_SHA16={blind_sha}", "-v", f"hf://buckets/{L.audio_bucket(day)}:/mnt/audio:ro", "-v", f"hf://buckets/{L.out_bucket(day)}:/mnt/out", "--detach", job_path]
        r = subprocess.run(cmd, capture_output=True, text=True, env=env); o = r.stdout + r.stderr; m = re.search(r"vrbeven/([0-9a-f]{24})", o)
        if m: return m.group(1)
        if r.returncode == 0: raise LaunchUnknown("hf jobs returned 0 but no job id could be parsed")
        return None
    def pull(self, day, dest):
        r = subprocess.run(["hf", "buckets", "sync", f"hf://buckets/{L.out_bucket(day)}", dest], capture_output=True, text=True, env=L._hf_env()); return r.returncode == 0

# ---------- plan / audio ----------
def plan_day(day, scope, heldout, union, reb_root, claims_root, audio_ls, out_ls, wreb=None):
    """launch_lane.plan() unchanged, then restricted to the HF-4 scope (and collision exclusions)."""
    todo, st, gaps = L.plan(day, heldout, union, reb_root, claims_root, audio_ls, out_ls, f"{wreb or L.WREB}/manifest-{day}.jsonl")
    keep = [w for w in todo if w["win_id"] in scope]; return keep, st, [g for g in gaps if g in scope]
def box_only(todo, scope, audio_ls, wreb=None):
    """todo = plan_day(..., audio_ls=None) (windows that still need tracks; blind already excluded). -> [(abs local path, basename, sha256)] for those whose audio is not in the audio bucket listing"""
    return [(f"{wreb or L.WREB}/{scope[w['win_id']]['audio']}", os.path.basename(w["audio"]), scope[w["win_id"]]["audio_sha256"]) for w in todo if audio_ls is None or os.path.basename(w["audio"]) not in audio_ls]
def push_missing(be, day, items):
    c = {"pushed": 0, "failed": 0, "local_sha_mismatch": 0}
    for p, name, sha in items:
        if not os.path.isfile(p) or sha256_file(p) != sha: c["local_sha_mismatch"] += 1; continue          # never push audio that is not the manifest's
        if be.upload_verify(p, L.audio_bucket(day), name, sha): c["pushed"] += 1
        else: c["failed"] += 1
    return c

# ---------- the loop body ----------
def pass_ok(): return os.path.exists(PASS) and open(PASS).read().strip().startswith(LAUNCH_SHA16)
def launched_total(st): return sum(1 for r in st["jobs"].values() if r.get("by") == "drive_lane1")
def open_jobs(st): return {j: r for j, r in st["jobs"].items() if not r.get("reconciled")}

def reconcile(st, be, claims_root, days_out_ls):
    """HF-1c semantics: only terminal jobs, claims moved only if they still record that job id. Updates err_streak / conc."""
    n = 0; terminal = {}
    for day in sorted({r["day"] for r in open_jobs(st).values()}):
        sub = {j: r for j, r in open_jobs(st).items() if r["day"] == day}
        k, seen = L.reconcile_state(sub, claims_root, be.stage, lambda d=day: days_out_ls(d)); n += k
        for jid, stage in seen: terminal[jid] = stage
    for jid, stage in terminal.items():
        r = st["jobs"][jid]
        if not r.get("reconciled"): continue
        if stage in ("ERROR", "CANCELED", "FAILED"): st["err_streak"] += 1; st["conc"] = max(CFG["start_conc"], st["conc"] - 1); ledger("job_error", jid=jid, stage=stage)
        elif stage == "COMPLETED": st["err_streak"] = 0; st["conc"] = min(CFG["max_conc"], st["conc"] + 1); ledger("job_done", jid=jid)
    return n

def tick(st, be, scope, order, heldout, union, jm, args, sleep=time.sleep):
    """One loop pass. Returns a status string: 'launched N', 'hold:<why>', 'stop:<why>', 'idle', 'done'."""
    if os.path.exists(f"{DRIVE}/STOP"): return "stop:STOP file"
    out_cache = {}
    def out_ls(d):
        if d not in out_cache: out_cache[d] = be.ls_bucket(L.out_bucket(d))
        return out_cache[d]
    reconcile(st, be, args.claims_root, out_ls)
    if st["err_streak"] >= CFG["cooldown_errors"]:
        open(f"{DRIVE}/PAUSE", "w").write(f"circuit breaker: {st['err_streak']} consecutive failed jobs\n"); save_state(st); return "stop:circuit breaker (PAUSE written)"
    if os.path.exists(f"{DRIVE}/PAUSE"): save_state(st); return "hold:PAUSE file"
    n_open = len(open_jobs(st))
    if n_open >= st["conc"]: save_state(st); return f"hold:concurrency {n_open}/{st['conc']}"
    if not pass_ok() and launched_total(st) >= CFG["pilot_jobs"]: save_state(st); return f"hold:PILOT_JOBS={CFG['pilot_jobs']} reached; no refuter PASS file ({PASS})"
    sp, acct_today, billed_fn = be.spend()
    own = len([1 for r in open_jobs(st).values() if r.get("by") == "drive_lane1"]) * CFG["rate_h"] * CFG["timeout_min"] / 60.0        # S1: HF's listing can lag a just-launched job
    sp = {**sp, "committed_lane": max(sp["committed_lane"], own), "committed_all": max(sp["committed_all"], own)}
    bal, asof = read_balance(args.balance_file); bal_eff = L.effective_balance(bal, asof, billed_fn=lambda a, b: billed_fn(a))
    new_cost = CFG["rate_h"] * CFG["timeout_min"] / 60.0
    verdict, why = gate(sp, acct_today, bal_eff, new_cost)
    if verdict != "ok": save_state(st); return f"{'stop' if verdict == 'stop' else 'hold'}:{'; '.join(why)}"
    rev = L.model_revision(None)
    for day in order:
        if st["days"].get(day, {}).get("complete"): continue
        audio_ls = be.ls_bucket(L.audio_bucket(day))
        if audio_ls is None: be.create_bucket(L.audio_bucket(day)); audio_ls = set()
        need_all, _, _ = plan_day(day, scope, heldout, union, args.reb_root, args.claims_root, None, out_ls(day), args.wreb)
        miss = box_only(need_all, scope, audio_ls, args.wreb)
        if miss:
            ledger("push_audio", day=day, n=len(miss), **push_missing(be, day, miss)); audio_ls = be.ls_bucket(L.audio_bucket(day)) or set()
        todo, stt, gaps = plan_day(day, scope, heldout, union, args.reb_root, args.claims_root, audio_ls, out_ls(day), args.wreb)
        if gaps: ledger("audio_gap", day=day, n=len(gaps))
        if not todo:
            if stt.get("claimed_only", 0): ledger("day_open_claimed", day=day, claimed_only=stt["claimed_only"])          # S2: foreign/stale claims keep the day open
            elif not any(r["day"] == day for r in open_jobs(st).values()) and not gaps: st["days"].setdefault(day, {})["complete"] = True; ledger("day_complete", day=day)
            continue
        chunk = todo[:CFG["windows_per_job"]]; own = f"drive_lane1-{os.getpid()}-{int(time.time())}"; mine = []
        for w in chunk:                                                     # claims: ALL-or-nothing per window (as launch_lane)
            got = [e for e in w["need"] if L.claim(args.claims_root, e, w["win_id"], own)]
            if len(got) == len(w["need"]): mine.append(w)
            else:
                for e in got: L.release(args.claims_root, e, w["win_id"], "lost-race")
        if not mine: continue
        if any(L.is_blind(w, heldout, union) for w in mine): raise SystemExit("REFUSED: blind window reached the launch step")       # belt and braces; plan() already excludes them
        be.create_bucket(L.out_bucket(day))
        try: jid = be.launch(day, mine, rev, L.JOB, jm.blind_list_sha16(jm.BLIND), own)
        except LaunchUnknown as ex:                                  # S3: the job may be running; keep the claims, never auto-release
            open(f"{DRIVE}/PAUSE", "w").write(f"launch with unparsed job id ({day}, {len(mine)} windows, owner {own}); claims KEPT, check `hf jobs ps`\n")
            ledger("LAUNCH_UNKNOWN", day=day, owner=own, windows=[w["win_id"] for w in mine]); save_state(st); return "stop:launch job id not parsed (claims kept, PAUSE written)"
        if not jid:
            for w in mine:
                for e in w["need"]: L.release(args.claims_root, e, w["win_id"], "launch-failed")
            save_state(st); return "hold:launch failed (claims released)"
        ledger("launched_raw", jid=jid, day=day, owner=own)        # on disk before anything that could crash
        try:
            for w in mine:
                for e in w["need"]: L.set_claim_job(args.claims_root, e, w["win_id"], own, jid)
        except BaseException:
            open(f"{DRIVE}/PAUSE", "w").write(f"crash after launch of {jid} before claims were tagged; claims KEPT\n"); ledger("CRASH_AFTER_LAUNCH", jid=jid, owner=own); raise
        st["jobs"][jid] = {"windows": [w["win_id"] for w in mine], "tracks": {w["win_id"]: w["need"] for w in mine}, "day": day, "by": "drive_lane1", "t": now_ist().isoformat(timespec="seconds")}
        ledger("launch", jid=jid, day=day, n=len(mine), committed_usd=round(new_cost, 2)); save_state(st); return f"launched {len(mine)} ({day}) {jid}"
    save_state(st)
    return "done" if all(st["days"].get(d, {}).get("complete") for d in order) else "idle"

# ---------- collect ----------
def screen_hf(src, scope, stage):
    """Per pulled file, BEFORE collect_lane: in scope, machine 'hf-job:', job sha16 3bec47c9, stub audio sha256 == the manifest's. Symlinks accepted files into <stage>/<day>/."""
    c = {"files": 0, "not_in_scope": 0, "unreadable": 0, "machine_not_hf": 0, "script_sha_mismatch": 0, "audio_sha_mismatch": 0, "accepted": 0}; days = set()
    for fn in sorted(os.listdir(src)):
        if not fn.endswith(".json") or fn.startswith("."): continue
        c["files"] += 1; wid = fn[:-5]
        if wid not in scope: c["not_in_scope"] += 1; continue
        try: d = json.load(open(f"{src}/{fn}")); stub, tracks = d["manifest_stub"], d["tracks"]
        except Exception: c["unreadable"] += 1; continue
        if not tracks or not all(str(t.get("machine", "")).startswith("hf-job:") for t in tracks.values()): c["machine_not_hf"] += 1; continue
        if not all((t.get("provenance") or {}).get("script_sha16") == "3bec47c98551c29b" for t in tracks.values()): c["script_sha_mismatch"] += 1; continue
        if (stub.get("audio") or {}).get("sha256") != scope[wid]["audio_sha256"] or stub.get("window_id") != wid: c["audio_sha_mismatch"] += 1; continue
        day = scope[wid]["ist_date"]; os.makedirs(f"{stage}/{day}", mode=0o700, exist_ok=True); os.symlink(os.path.abspath(f"{src}/{fn}"), f"{stage}/{day}/{fn}"); days.add(day); c["accepted"] += 1
    return c, sorted(days)
def collect_day(be, day, scope, heldout, union, reb_root, apply, pull_root=PULL):
    import collect_lane as C
    if apply and not pass_ok(): raise SystemExit("REFUSED: --apply-collect needs drive/HF1C-PASS (launch_lane sha16)")      # C3, in code
    dest = f"{pull_root}/{time.strftime('%Y%m%dT%H%M%S')}-{day}"; os.makedirs(dest, mode=0o700)
    if not be.pull(day, dest): return {"day": day, "pull": "failed"}
    scr, days = screen_hf(dest, scope, f"{dest}/_stage"); res = {"day": day, "pull_dir": dest, "screen": scr}
    for d in days:
        res["dry" if not apply else "applied"] = C.collect(d, f"{dest}/_stage/{d}", reb_root, apply, heldout, union)
    return res

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", action="store_true"); ap.add_argument("--max-concurrent", type=int, default=CFG["max_conc"]); ap.add_argument("--poll-s", type=int, default=60)
    ap.add_argument("--reb-root", default=L.REB_DEFAULT); ap.add_argument("--claims-root", default=L.CLAIMS_DEFAULT); ap.add_argument("--wreb", default=L.WREB); ap.add_argument("--balance-file", default=BAL)
    ap.add_argument("--apply-collect", action="store_true", help="collect_lane --write for finished days (default: dry-run only)"); ap.add_argument("--max-ticks", type=int, default=0); ap.add_argument("--no-collect", action="store_true", help="do not pull/collect at all (needed to --run without --apply-collect once HF1C-PASS exists)")
    a = ap.parse_args(argv); CFG["max_conc"] = a.max_concurrent; os.makedirs(DRIVE, exist_ok=True)
    if a.apply_collect and not pass_ok(): raise SystemExit("REFUSED: --apply-collect needs drive/HF1C-PASS (launch_lane sha16)")                 # C3
    if a.run and pass_ok() and not a.apply_collect and not a.no_collect: raise SystemExit("REFUSED: HF1C-PASS exists: --run needs --apply-collect (or --no-collect)")   # C2
    lock = take_lock() if a.run else None                                                                                               # C1
    heldout, union, jm = L.load_guard(); scope, excl = load_scope(); order = day_order(scope); be = Backend(); st = load_state()
    if not a.run:
        audio = {d: be.ls_bucket(L.audio_bucket(d)) for d in order}; tot = push = 0; rows = []
        for d in order:
            todo, _, _ = plan_day(d, scope, heldout, union, a.reb_root, a.claims_root, None, None, a.wreb); miss = box_only(todo, scope, audio[d], a.wreb)
            tot += len(todo); push += len(miss); rows.append((d, len(todo), len(miss), audio[d] is None))
        sp, acct, bf = be.spend(); bal, asof = read_balance(a.balance_file) if os.path.exists(a.balance_file) else (None, None)
        usd = tot * CFG["usd_per_window"]
        print(json.dumps({"scope_windows": len(scope), "collision_excluded": sorted(excl), "plannable_now": tot, "box_only_to_push": push, "days_in_order": [r[0] for r in rows[:6]], "per_day_first6": rows[:6],
                          "est_usd": round(usd, 2), "days_at_70_per_day": round(usd / CFG["day_lane_cap"], 1), "spend": sp, "account_today": round(acct, 2), "balance_file": bool(bal), "pass_file": pass_ok(), "torch_pin": PINS}, indent=1)); return 0
    ticks = 0
    while True:
        status = tick(st, be, scope, order, heldout, union, jm, a); print(time.strftime("%H:%M:%S"), status, flush=True); ledger("tick", status=status)
        for day in order:                                                               # collect finished days (dry-run unless --apply-collect)
            d = st["days"].get(day, {})
            if a.no_collect or not d.get("complete") or d.get("collected"): continue
            if not a.apply_collect and d.get("dry_ok"): continue                      # C2: one dry-run per day, never a re-pull every tick
            r = collect_day(be, day, scope, heldout, union, a.reb_root, a.apply_collect); ledger("collect", **r)
            if "pull" not in r: d["collected" if a.apply_collect else "dry_ok"] = True; save_state(st)
        ticks += 1
        if status.startswith("stop") or status == "done" or (a.max_ticks and ticks >= a.max_ticks): break
        if status.startswith("hold:") and "today" in status: time.sleep(600)
        if not status.startswith("launched"): time.sleep(a.poll_s)           # a launch is followed at once by the next slot check
    return 0

if __name__ == "__main__": sys.exit(main())
