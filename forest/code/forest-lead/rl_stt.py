#!/usr/bin/env python3
"""rl_stt: batch Sarvam saaras-v3 STT (diarization, auto language) for the FT Runo call-audio wave.

Reuses palimpsest's gateway client (kit.reb.sarvam_lane.Gateway) from ~/dev/eta-lab-run, which must be at the pinned commit
c41bb34a (asserted at startup, refuses otherwise) - Even AWS gateway, creds minted in-process from ~/.secrets/sarvam-sa.json.
No key is ever read into or printed by this script.

Gates (all checked BEFORE any network call; any violation refuses the whole run):
  1. sarvam_lane pin: eta-lab-run HEAD == c41bb34a..., tracked files under kit/ clean.
  2. manifest (G1, G2): every shard row's key_id must be in the RL-3 manifest (~/eta-data/forest/rl/audio/manifest.tsv, the RL-2 matched set)
     and the shard path must be the manifest's path for that key.
  3. split: the manifest row's patient_key (required column) goes through split_guard (vendor_split/, sha-pinned, list pin
     52959278edd8...); any H key or unknown key refuses.
  4. spend guard (V order 19 Oct 20:00, RUNO-AUDIO.md G1-G7): G1 the manifest episode must be a D episode in ft-labels-base/labels.parquet;
     G2 day_from_rx in 0..13 (manifest call_ts/call_date vs Rx date), day 0 only for calls after the consult time (needs call_ts), call date strictly before the event date; G3 ffprobe, skip < 20 s (counted); G4 skip keys whose
     stt/<key>.json exists, retry once; G5 out/<lane>/GO must hold 'GO <N_calls> <minutes>' (refuse without it, refuse if shard calls > N_calls
     or probed minutes > cap, hard stop at minutes x 1.05 - minutes are reserved before each send); G6 no call of any kind outside the
     shard rows (no smoke tests); G7 every PROGRESS line carries cumulative Sarvam minutes.
Ledger: one JSON line per job attempt to ~/eta-data/sarvam-ledger/forest-runo/<YYYY-MM-DD>.jsonl (0600, dir 0700), no text, no phones.

Run with the sarvam venv (has requests + google-auth):
  ~/.venv-sarvam/bin/python ~/oc/forest-lead/ft/rl_stt.py SHARD.tsv --lane ft-rl-stt-c [--workers 4] [--wait]

SHARD.tsv: header row with key_id, episode_id, duration, path (extra columns ignored).
Output: ~/eta-data/forest/rl/stt/<key_id>.json (0600): {key_id, episode_id, duration_s, engine, params, meta, result}.
Resumable (existing outputs skipped). A failed call is retried once, in a second pass. Failures go to <lane>/FAILED.tsv (key_id, reason).
Progress: one line to out/<lane>/PROGRESS.md every --progress-min (default 30). Counts only; no transcript text is logged.
DONE.md is written at the end with calls, minutes, failures.
"""
import argparse, collections, csv, datetime, fcntl, math, random, traceback, hashlib, json, os, re, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
LAB_REPO = os.path.expanduser("~/dev/eta-lab-run")
LAB_PIN = "c41bb34a5710deae3d091862ded9bd094ea71e66"   # full pinned commit (a prefix is accepted by check_lab_pin for tests only)
STT_DIR = os.path.expanduser("~/eta-data/forest/rl/stt")
OUT_ROOT = os.path.join(HERE, "out")
AUDIO_ROOT = os.path.expanduser("~/eta-data/forest/rl/audio")
MANIFEST = os.path.expanduser("~/eta-data/forest/rl/manifest.tsv")
SHARD_DIR = os.path.expanduser("~/eta-data/forest/rl")        # shard_<a|b|c>.tsv live here; --recover-only reads no other path
LEDGER_DIR = os.path.expanduser("~/eta-data/sarvam-ledger/forest-runo")
LIST_PIN = "52959278edd8cd5db65c362fb8fb872c1d8e7b79767fac81334d321491052d65"
VENDOR_SPLIT = os.path.join(HERE, "vendor_split")
VENDOR_SHA = {"split_guard.py": "2d39ef2884ee3f2308368d7b75911dd3b1391a870bb53a903af09c643088edbb",
              "rd0_common.py": "983455e9812451b1f8bc2556658510ff10d81389fe2bfccfa54d16917a6b8086"}
KEY_RE = re.compile(r"[0-9a-f]{32}")
LABELS = os.path.join(HERE, "out", "ft-labels-base", "labels.parquet")
FOREST_PY = os.path.expanduser("~/.venv-forest/bin/python")     # has pyarrow; the sarvam venv does not
MIN_CALL_S = 20.0                          # G3: shorter objects are rings / voicemail / drops
WINDOW_LAST_DAY = 13                       # G2 (forest-lead ruling): day_from_rx in 0..13; day 0 only after the consult time; strictly before the event date
CAP_FACTOR = 1.05                          # G5: hard stop at GO minutes x 1.05


class Refused(SystemExit):
    pass


def refuse(msg):
    raise Refused(f"REFUSED: {msg}")


def check_lab_pin(repo=LAB_REPO, pin=LAB_PIN):
    """Assert the sarvam_lane checkout is at the pinned commit with a clean kit/ tree; return its path."""
    def git(*a):
        return subprocess.run(["git", "-C", repo, *a], capture_output=True, text=True, timeout=30)
    head = git("rev-parse", "HEAD")
    if head.returncode != 0 or not head.stdout.strip().startswith(pin):
        refuse(f"{repo} HEAD is not the pinned sarvam_lane commit {pin}")
    # tracked changes, untracked AND ignored files under kit/ (a shadowing package dir would not show as modified); bytecode caches excluded
    dirty = git("status", "--porcelain", "--untracked-files=all", "--ignored", "--", "kit")
    left = [l for l in dirty.stdout.splitlines() if l.strip() and "__pycache__/" not in l and not l.rstrip().endswith(".pyc")]
    if dirty.returncode != 0 or left:
        refuse(f"{repo} kit/ has local modifications against pin {pin}")
    return repo


def load_sl():
    repo = check_lab_pin()
    sys.path.insert(0, repo)
    from kit.reb import sarvam_lane as sl
    want = os.path.realpath(os.path.join(repo, "kit", "reb", "sarvam_lane.py"))
    if os.path.realpath(getattr(sl, "__file__", "") or "") != want:
        refuse("sarvam_lane was imported from somewhere other than the pinned checkout")
    return sl


def load_guard(vendor=VENDOR_SPLIT, vendor_sha=VENDOR_SHA, lock_dir=None, pin=LIST_PIN, date=None):
    """split_guard from the sha-pinned vendored copy, constructed with the list pin."""
    for name, want in vendor_sha.items():
        with open(os.path.join(vendor, name), "rb") as f:
            if hashlib.sha256(f.read()).hexdigest() != want:
                refuse(f"vendored {name} sha mismatch")
    sys.path.insert(0, vendor)
    import split_guard
    return split_guard.load(lock_dir=lock_dir, pinned_list_sha256=pin, date=date)


def read_manifest(path=MANIFEST):
    if not os.path.exists(path):
        refuse("RL-3 manifest.tsv not found")
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f, delimiter="\t"))
    out = {}
    for r in rows:
        if r.get("key_id") in out:
            refuse("duplicate key_id in manifest")
        out[r.get("key_id")] = r
    return out


def load_labels(path=LABELS, py=FOREST_PY):
    """episode_id -> {split, rx_date, event_date, consult_ist} from labels.parquet, read by the forest venv. No patient columns are pulled."""
    code = ("import sys,json,pandas as pd\n"
            "d=pd.read_parquet(sys.argv[1],columns=['episode_id','split','rx_date','event_date','consult_ist'])\n"
            "for r in d.itertuples(index=False):\n"
            "    ev=None if pd.isna(r.event_date) else str(r.event_date)[:10]\n"
            "    ci=None if pd.isna(r.consult_ist) else str(r.consult_ist)\n"
            "    print(json.dumps([r.episode_id,r.split,str(r.rx_date)[:10],ev,ci]))\n")
    p = subprocess.run([py, "-I", "-c", code, path], capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        refuse("labels.parquet could not be read")
    out = {}
    for line in p.stdout.splitlines():
        e, sp, rx, ev, ci = json.loads(line)
        out[e] = dict(split=sp, rx_date=rx, event_date=ev, consult_ist=ci)
    return out


def _date(v):
    try:
        return datetime.date.fromisoformat(str(v or "").strip()[:10])
    except ValueError:
        return None


IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))


def _dt(v):
    """Naive IST datetime from an ISO string (offset-aware values are converted to IST), or None."""
    try:
        d = datetime.datetime.fromisoformat(str(v or "").strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return d.astimezone(IST).replace(tzinfo=None) if d.tzinfo else d


def in_window(rx, call_ts, call_date, consult_ist, event, after_consult=None):
    """G2. rx/event are dates, call_ts/consult_ist naive IST datetimes (or None), call_date a date. Returns None if ok else a reason."""
    if rx is None or call_date is None:
        return "no_date"
    day = (call_date - rx).days
    if not 0 <= day <= WINDOW_LAST_DAY:
        return "window"
    if day == 0:
        # day 0: only a call after the consult. A call_ts is checked against consult_ist; with no call_ts the manifest's
        # upstream after_consult flag ('1') is the evidence; anything else fails closed.
        if call_ts is not None and consult_ist is not None:
            if not call_ts > consult_ist:
                return "window"
        elif after_consult is not True:
            return "window"
    if event is not None and not call_date < event:
        return "event"
    return None


def vet_rows(rows, manifest, guard, labels, audio_root=AUDIO_ROOT):
    """Refuse the whole run unless every row is in the manifest (same path), links to a D episode in labels (G1), falls in the
    call window (G2) and its patient is D. Messages carry counts only."""
    not_in, bad_path, no_pk, outside = 0, 0, 0, 0
    no_ep, not_d, no_date, out_win, after_ev = 0, 0, 0, 0, 0
    pks = []
    root = os.path.realpath(audio_root) + os.sep
    keys = [r["key_id"] for r in rows]
    dups = len(keys) - len(set(keys))
    if dups:
        refuse(f"shard has {dups} duplicate key_id row(s) (one transcript per object key)")
    for r in rows:
        m = manifest.get(r["key_id"])
        if m is None:
            not_in += 1
            continue
        if os.path.realpath(r["path"]) != os.path.realpath(m.get("path") or ""):
            bad_path += 1
        if not os.path.realpath(r["path"]).startswith(root):
            outside += 1
        pk = (m.get("patient_key") or "").strip().lower()
        if not KEY_RE.fullmatch(pk):
            no_pk += 1
        else:
            pks.append(pk)
        lab = labels.get((m.get("episode_id") or "").strip())
        if lab is None:
            no_ep += 1
            continue
        if lab["split"] != "D":
            not_d += 1
            continue
        ts = _dt(m.get("call_ts"))
        cd = ts.date() if ts else _date(m.get("call_date"))
        why = in_window(_date(lab["rx_date"]), ts, cd, _dt(lab.get("consult_ist")), _date(lab["event_date"]),
                        after_consult=(m.get("after_consult") or "").strip() == "1")
        if why == "no_date":
            no_date += 1
        elif why == "window":
            out_win += 1
        elif why == "event":
            after_ev += 1
    if not_in or bad_path or no_pk or outside or no_ep or not_d or no_date or out_win or after_ev:
        refuse(f"shard rows not matching the RL-3 manifest / spend guard: not_in_manifest={not_in} path_mismatch={bad_path} "
               f"outside_audio_root={outside} manifest_patient_key_missing_or_bad={no_pk} episode_not_in_labels={no_ep} "
               f"episode_not_D={not_d} call_date_missing={no_date} outside_rx_window={out_win} call_not_before_event={after_ev} of {len(rows)}")
    try:
        guard.require_dev(pks, "rl_stt")
    except Exception as e:  # HeldOutError / UnknownKeyError / GuardError: counts only
        refuse(f"split_guard: {type(e).__name__}: {str(e)[:120]}")


class Ledger:
    """One JSON line per job attempt; no text, no phones. Day file 0600 in a 0700 dir."""
    def __init__(self, d=LEDGER_DIR, clock=time.time):
        self.d, self.clock, self.lock = d, clock, threading.Lock()
        os.makedirs(d, mode=0o700, exist_ok=True)
        os.chmod(d, 0o700)

    def write(self, job_id, model, mode, audio_s, status, key_id, task="stt-diarize"):
        t = self.clock()
        line = json.dumps(dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(t)), caller="forest-runo", job_id=job_id,
                               model=model, mode=mode, task=task, audio_s=round(float(audio_s or 0), 2), status=status,
                               call_key_id=key_id), ensure_ascii=False) + "\n"
        path = os.path.join(self.d, time.strftime("%Y-%m-%d", time.localtime(t)) + ".jsonl")
        with self.lock:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                os.fchmod(fd, 0o600)
                os.write(fd, line.encode())
            finally:
                os.close(fd)

    def billed(self, keys):
        """(minutes billed, {key: attempts}) over every ledger day file, for the given keys. A line exists only for a job that was created
        at the gateway (ok or failed), i.e. a billed job. The ledger is the source of truth for spend across runs and restarts."""
        keys, minutes, attempts = set(keys), 0.0, {}
        for fn in sorted(os.listdir(self.d)):
            if not fn.endswith(".jsonl"):
                continue
            with open(os.path.join(self.d, fn)) as f:
                for line in f:
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    k = rec.get("call_key_id")
                    if k in keys:
                        minutes += float(rec.get("audio_s") or 0) / 60
                        attempts[k] = attempts.get(k, 0) + 1
                        if rec.get("status") in ("ok", "ok_recovered"):
                            attempts[k] = MAX_ATTEMPTS        # a billed success is never resent, even if its stt json went missing
        return minutes, attempts


    def billed_without_transcript(self, keys, stt_dir):
        """Minutes already billed (any status) on these keys that have no stt/<key>.json: failed, abandoned or halted attempts."""
        keys, minutes = set(keys), 0.0
        for fn in sorted(os.listdir(self.d)):
            if not fn.endswith(".jsonl"):
                continue
            with open(os.path.join(self.d, fn)) as f:
                for line in f:
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    k = rec.get("call_key_id")
                    if k in keys and not os.path.exists(os.path.join(stt_dir, f"{k}.json")):
                        minutes += float(rec.get("audio_s") or 0) / 60
        return minutes

    def failed_jobs(self, keys):
        """({key: [job_id, ...]} from 'failed' lines, set of keys already ok / ok_recovered). For download-only recovery."""
        keys, failed, done = set(keys), {}, set()
        for fn in sorted(os.listdir(self.d)):
            if not fn.endswith(".jsonl"):
                continue
            with open(os.path.join(self.d, fn)) as f:
                for line in f:
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    k = rec.get("call_key_id")
                    if k not in keys:
                        continue
                    if rec.get("status") in ("ok", "ok_recovered"):
                        done.add(k)
                    elif rec.get("status") == "failed" and rec.get("job_id"):
                        if rec["job_id"] not in failed.setdefault(k, []):
                            failed[k].append(rec["job_id"])
        return failed, done


def read_shard(path):
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f, delimiter="\t"))
    need = {"key_id", "path"}
    if not rows or not need <= set(rows[0]):
        raise SystemExit(f"shard needs columns {sorted(need)} (+episode_id, duration); got {list(rows[0]) if rows else 'empty'}")
    return rows


def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


def dur_of(v):
    """Seconds from a manifest duration: a number, 'MM:SS' / 'H:MM:SS', or '' -> 0. Never raises."""
    s = str(v or "").strip()
    if not s:
        return 0.0
    try:
        return float(s)
    except ValueError:
        pass
    try:
        t = 0.0
        for p in s.split(":"):
            t = t * 60 + float(p)
        return t
    except ValueError:
        return 0.0


def ffprobe_s(path):
    """Container duration in seconds via ffprobe, or None when unreadable."""
    try:
        p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                           capture_output=True, text=True, timeout=60)
        return float(p.stdout.strip()) if p.returncode == 0 and p.stdout.strip() else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def probe_rows(rows, probe=ffprobe_s):
    """G3: probe every object after the fetch; return (kept rows with probed duration, n_short, n_unprobeable). Unreadable audio is not sent."""
    kept, short, bad = [], 0, 0
    for r in rows:
        d = probe(r["path"])
        if d is None:
            bad += 1
        elif d < MIN_CALL_S:
            short += 1
        else:
            kept.append(dict(r, duration=str(round(d, 3))))
    return kept, short, bad


def read_go(path):
    """G5: 'GO <N_calls> <minutes>' from out/<lane>/GO. Refuses when absent or malformed."""
    if not os.path.isfile(path):
        refuse("no GO file for this lane (spend guard G5)")
    m = re.fullmatch(r"GO\s+(\d+)\s+([0-9]+(?:\.[0-9]+)?)", open(path).read().strip())
    if not m or int(m.group(1)) <= 0 or float(m.group(2)) <= 0:
        refuse("GO file malformed; expected 'GO <N_calls> <minutes>'")
    return int(m.group(1)), float(m.group(2))


def check_go(n_calls, minutes, go_calls, go_minutes):
    """Plan check: calls to send <= GO N, minutes to send (plus anything already billed, passed in by the caller) <= GO minutes.
    The +5% is NOT plannable (F6); it is only the hard stop's drift margin."""
    if n_calls > go_calls:
        refuse(f"shard has {n_calls} calls after skips, GO allows {go_calls}")
    if minutes > go_minutes:
        refuse(f"shard has {minutes:.1f} min to bill (incl. already billed), GO allows {go_minutes}")


class Budget:
    """Cumulative Sarvam minutes for the lane (prior = already billed in the ledger). reserve() is taken BEFORE a send and only against
    the cap (GO x 1.05); the +5% is not part of the plan (check_go plans against GO minutes), it only absorbs drift."""
    def __init__(self, go_minutes, prior=0.0):
        self.cap = go_minutes * CAP_FACTOR
        self.cum = float(prior)
        self.lock = threading.Lock()

    def reserve(self, minutes):
        with self.lock:
            if self.cum >= self.cap or self.cum + minutes > self.cap:
                return False
            self.cum += minutes
            return True

    def refund(self, minutes):
        with self.lock:
            self.cum = max(0.0, self.cum - minutes)



def mask_reason(text, keep_text=True):
    """Diagnostic text for FAILURES.jsonl / FAILED.tsv: URLs, bearer tokens, key=value secrets, 7+ digit runs and 20+ char tokens are
    masked, then cut to 140 chars. keep_text=False keeps nothing (used for non-gateway exceptions whose text we do not control)."""
    if not keep_text:
        return ""
    t = re.sub(r"https?://\S+", "<url>", str(text))
    t = re.sub(r"\?\S*", "?<q>", t)                    # query strings on bare paths too
    t = re.sub(r"(?i)bearer\s+\S+", "bearer <redacted>", t)
    t = re.sub(r"(?i)[\w.\-]*(?:key|token|sig|secret|passw\w*|authorization)[\w.\-]*\s*[=:]\s*\S+", "<redacted>", t)
    t = re.sub(r"\d{7,}", "<num>", t)
    t = re.sub(r"[A-Za-z0-9_.\-]{20,}", "<tok>", t)
    return t[:140]


def reason_of(e, gw_error):
    return type(e).__name__ + ": " + mask_reason(e, keep_text=isinstance(e, gw_error))


DONE_STATES = ("completed", "success", "succeeded", "done")
FAIL_STATES = ("failed", "error", "cancelled")


class Halted(RuntimeError):
    """The lane's halt flag (breaker / ledger error) is set: no new gateway work may start. Not a job failure."""


class JobFailed(RuntimeError):
    """The gateway says the job (or its file) itself failed: not transient, the job is dead."""


class ResilientGateway:
    """Wraps a sarvam_lane.Gateway and drives one batch job step by step (create, upload+put, start, poll, download).
    Every gateway call is retried on 429 / 5xx / timeouts / connection errors with exponential backoff and jitter (the client's own
    fixed 2-4-8 s retry is switched off with tries=1, so 8 workers do not retry in lock-step). Progress per audio path is kept in
    memory, so a retry after a failure RESUMES at the failed step with the same job_id instead of creating a new job."""
    def __init__(self, gw, gw_error, sleep=time.sleep, rand=random.random, tries=5, base=2.0, cap=60.0, poll_s=3.0, timeout_s=1800):
        self.gw, self.gw_error, self.sleep, self.rand = gw, gw_error, sleep, rand
        self.tries, self.base, self.cap, self.poll_s, self.timeout_s = tries, base, cap, poll_s, timeout_s
        self.jobs, self.lock, self.retries = {}, threading.Lock(), 0
        self.halted = lambda: False

    def set_halt(self, fn):
        self.halted = fn

    def resumable(self, wav):
        """True when a job for this audio path already exists (a retry will resume it, not create or bill a new one)."""
        with self.lock:
            st = self.jobs.get(wav)
            return bool(st and st.get("jid"))       # a stage-"new" entry (create never succeeded) has no job: it must reserve like any new send

    def _check_halt(self):
        if self.halted():
            raise Halted("lane halted")

    def transient(self, e):
        if isinstance(e, (JobFailed, Halted)):
            return False
        if isinstance(e, self.gw_error):
            s = getattr(e, "status", None)
            return s is None or s in (400, 408, 425, 429) or s >= 500
        return isinstance(e, (OSError, TimeoutError, ValueError))      # requests exceptions are OSErrors; ValueError = unparsable body

    def _retry(self, fn):
        n400 = 0
        for attempt in range(self.tries):
            try:
                return fn()
            except Exception as e:  # noqa: BLE001
                if not self.transient(e) or attempt + 1 >= self.tries:
                    raise
                if getattr(e, "status", None) == 400:
                    n400 += 1
                    if n400 > 2:                    # a 400 gets two more tries (client note, 08 Oct) before it counts as permanent
                        raise
                with self.lock:
                    self.retries += 1
                d = min(self.cap, self.base * 2 ** attempt)
                self.sleep(d / 2 + d / 2 * self.rand())      # equal jitter

    def _call(self, method, path, payload=None, gated=False):
        def go():
            if gated:
                self._check_halt()                  # gated calls (start) re-check halt before every attempt, backoff retries included
            return self.gw.call(method, path, payload, tries=1)
        return self._retry(go)

    def status(self, jid):
        return self._call("GET", f"/speech-to-text/job/v1/{jid}/status")

    @staticmethod
    def state_of(st):
        return str(st.get("job_state") or st.get("state") or "").lower()

    def download(self, jid, status):
        """Results of a Completed job: download-files + the result URLs. Never creates, uploads or starts anything."""
        for d in (status.get("job_details") or []):
            if isinstance(d, dict) and (d.get("error_message") or re.search(r"error|fail", str(d.get("state") or ""), re.I)):
                raise JobFailed("file failed: " + mask_reason(d.get("error_message") or d.get("state")))
        names = [o.get("file_name") for d in (status.get("job_details") or []) if isinstance(d, dict)
                 for o in (d.get("outputs") or []) if isinstance(o, dict)]
        dl = self._call("POST", "/speech-to-text/job/v1/download-files", {"job_id": jid, "files": [n for n in names if n] or ["0.json"]})
        raw = {n: self._retry(lambda v=v: self.gw.get_json(v.get("file_url"))) for n, v in (dl.get("download_urls") or {}).items()}
        if not raw:
            raise self.gw_error("no result files")
        return raw

    def recover(self, jid):
        """Download-only recovery: (raw, meta) when the job is Completed at the gateway, else (None, state)."""
        t = time.time()
        stt = self.status(jid)
        state = self.state_of(stt)
        if state not in DONE_STATES:
            return None, state or "unknown"
        raw = self.download(jid, stt)
        return raw, {"job_id": jid, "states": [state], "recovered": True, "wall_s": round(time.time() - t, 2),
                     "request_ids": sorted({str(v.get("request_id")) for v in raw.values() if isinstance(v, dict) and v.get("request_id")})}

    def transcribe(self, wav, params, poll_s=None, timeout_s=None, on_start=None):
        t = time.time()
        name = os.path.basename(wav)
        with self.lock:
            stt = self.jobs.setdefault(wav, dict(jid=None, stage="new", states=[], status=None))
        tl = getattr(self.gw, "_tl", None)
        if tl is not None:
            tl.hit = False
        try:
            if stt["stage"] == "new":
                def create():
                    self._check_halt()                # re-checked before EVERY create attempt, backoff retries included
                    job = self.gw.call("POST", "/speech-to-text/job/v1", {"job_parameters": params}, tries=1)
                    if not job.get("job_id"):
                        raise self.gw_error("no job_id")
                    return job["job_id"]
                stt["jid"] = self._retry(create)
                stt["stage"] = "created"
            jid = stt["jid"]
            if on_start:
                on_start(jid)                       # every attempt reports the job_id, a resumed one reports the SAME id
            if stt["stage"] == "created":
                def upload():
                    self._check_halt()
                    up = self.gw.call("POST", "/speech-to-text/job/v1/upload-files", {"job_id": jid, "files": [name]}, tries=1)
                    urls = up.get("upload_urls") or {}
                    self.gw.put_blob((urls.get(name) or next(iter(urls.values()), {})).get("file_url"), wav)
                self._retry(upload)
                stt["stage"] = "uploaded"
            if stt["stage"] == "uploaded":
                self._call("POST", f"/speech-to-text/job/v1/{jid}/start", {}, gated=True)
                stt["stage"] = "started"
            if stt["stage"] == "started":
                poll, limit = poll_s or self.poll_s, timeout_s or self.timeout_s
                t_poll = time.time()
                while True:
                    s = self._call("GET", f"/speech-to-text/job/v1/{jid}/status")
                    state = self.state_of(s)
                    if not stt["states"] or stt["states"][-1] != state:
                        stt["states"].append(state)
                    if state in DONE_STATES:
                        stt["status"], stt["stage"] = s, "completed"
                        break
                    if state in FAIL_STATES:
                        raise JobFailed(f"job {state}: " + mask_reason(s.get("error_message") or s.get("error") or ""))
                    if time.time() - t_poll > limit:
                        raise self.gw_error("job timeout")
                    self.sleep(poll)
            raw = self.download(jid, stt["status"])
        except JobFailed:
            with self.lock:
                self.jobs.pop(wav, None)            # the job is dead: the next attempt starts a new one
            raise
        except Exception:
            with self.lock:
                if not (self.jobs.get(wav) or {}).get("jid"):
                    self.jobs.pop(wav, None)        # create never produced a job: leave no half-made entry behind
            raise
        with self.lock:
            self.jobs.pop(wav, None)
        return raw, {"job_id": jid, "states": stt["states"], "wall_s": round(time.time() - t, 2),
                     "throttled": bool(getattr(getattr(self.gw, "_tl", None), "hit", False)),
                     "request_ids": sorted({str(v.get("request_id")) for v in raw.values() if isinstance(v, dict) and v.get("request_id")})}


class Breaker:
    """Stops the lane when failures >= max_fail in the last `window` finished jobs, or max_run in a row."""
    def __init__(self, window=20, max_fail=3, max_run=2):
        self.win, self.max_fail, self.max_run = collections.deque(maxlen=window), max_fail, max_run
        self.run, self.tripped, self.lock = 0, None, threading.Lock()

    def record(self, ok):
        with self.lock:
            self.win.append(0 if ok else 1)
            self.run = 0 if ok else self.run + 1
            fails = sum(self.win)
            if self.tripped is None and (fails >= self.max_fail or self.run >= self.max_run):
                self.tripped = dict(failures_in_window=fails, window=len(self.win), consecutive=self.run,
                                    ts=time.strftime("%Y-%m-%dT%H:%M:%S"))
            return self.tripped is not None


MAX_ATTEMPTS = 2                               # G4: first send plus one retry, counted per key across runs


def run_jobs(rows, gw, params, engine, gw_error, ledger, budget, stt_dir, workers=4, on_state=None, prior_attempts=None, fail_log=None, breaker=None, known_jobs=None):
    """Transcribe rows; skip existing outputs (G4); at most MAX_ATTEMPTS billed attempts per key counting earlier runs (prior_attempts);
    reserve minutes before each send (G5); stop sending at once if a ledger write fails. Returns (stats, [(row, reason)] still failing,
    [rows not sent because of the budget stop or a ledger halt])."""
    rows = list({r["key_id"]: r for r in reversed(rows)}.values())[::-1]      # belt and braces: one send per key even if vet_rows were bypassed
    lock = threading.Lock()
    st = dict(ok=0, skipped=0, failed=0, audio_s=0.0, retried=0, budget_stopped=0, given_up=0, ledger_error=0)
    stopped = []
    attempts = dict(prior_attempts or {})
    halt = threading.Event()
    breaker = breaker or Breaker()
    if hasattr(gw, "set_halt"):
        gw.set_halt(halt.is_set)                   # the gateway re-checks halt before each create / upload / start, backoff retries included
    known = set(known_jobs or ())              # job_ids already in the ledger (earlier runs + this one): re-using one costs nothing new

    def led(*a):
        """Ledger write that never raises: on failure set the halt flag so no further send happens."""
        try:
            ledger.write(*a)
            return True
        except Exception:  # noqa: BLE001
            halt.set()
            with lock:
                st["ledger_error"] += 1
            return False

    def one(r):
        key = r["key_id"]
        out = os.path.join(stt_dir, f"{key}.json")
        if os.path.exists(out):
            with lock:
                st["skipped"] += 1
            return None
        dur = dur_of(r.get("duration"))
        with lock:
            if halt.is_set():
                stopped.append(r)
                st["budget_stopped"] += 1
                return None
            if attempts.get(key, 0) >= MAX_ATTEMPTS:
                st["given_up"] += 1
                return None
            resume = bool(getattr(gw, "resumable", lambda p: False)(r["path"]))   # job already exists: nothing new to reserve or bill
            if not resume and not budget.reserve(dur / 60):
                stopped.append(r)
                st["budget_stopped"] += 1
                return None
            attempts[key] = attempts.get(key, 0) + 1
        jid, reused = [], []

        def started(j):
            jid.append(j)
            with lock:
                if j in known:                 # resumed job: the minutes were reserved/billed with its first ledger line
                    if not resume:
                        budget.refund(dur / 60)
                    reused.append(1)
                known.add(j)
        bill = lambda: 0.0 if reused else dur
        try:
            if not os.path.exists(r["path"]):
                raise gw_error("audio missing")
            raw, meta = gw.transcribe(r["path"], params, on_start=started)
            doc = dict(key_id=key, episode_id=r.get("episode_id"), duration_s=dur, engine=engine, params=params, meta=meta, result=raw)
            tmp = out + ".tmp"
            write_private(tmp, json.dumps(doc, ensure_ascii=False))
            os.replace(tmp, out)
        except Exception as e:  # noqa: BLE001 - reason only, no payload
            halted_out = isinstance(e, Halted)
            if fail_log and not halted_out:                 # live view of WHY jobs fail: class, http status, failing function, URL-masked message. No payload.
                try:
                    tb = traceback.extract_tb(e.__traceback__)
                    rec = dict(ts=time.strftime("%Y-%m-%dT%H:%M:%S"), key_id=key, job_id=jid[0] if jid else None, exc=type(e).__name__,
                               status=getattr(e, "status", None), where=tb[-1].name if tb else None, attempt=attempts.get(key),
                               dur_s=round(dur, 1), msg=mask_reason(e, keep_text=isinstance(e, gw_error)))
                    fd = os.open(fail_log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                    try:
                        os.fchmod(fd, 0o600)
                        os.write(fd, (json.dumps(rec) + "\n").encode())
                    finally:
                        os.close(fd)
                except Exception:  # noqa: BLE001 - diagnostics never block the run
                    pass
            if jid:                      # a job existed at the gateway: it stays reserved and gets a ledger line
                led(jid[0], engine, params.get("mode"), bill(), "failed", key)
            else:
                if not resume:
                    budget.refund(dur / 60)  # nothing was created, nothing was spent
                with lock:
                    attempts[key] -= 1
            if halted_out:
                return (r, "Halted: lane stopped before this job was started")     # not a job failure: breaker and failure log untouched
            if breaker.record(False):
                halt.set()               # breaker: no new job is created from here on
                st["breaker"] = breaker.tripped
            return (r, reason_of(e, gw_error))
        led(meta.get("job_id") or (jid[0] if jid else None), engine, params.get("mode"), bill(), "ok", key)   # outside the try: an OK job is never recorded as failed
        breaker.record(True)
        with lock:
            st["ok"] += 1
            st["audio_s"] += dur
        return None

    with ThreadPoolExecutor(workers) as ex:
        fails = [x for x in ex.map(one, rows) if x]
    st["retried"] = len(fails)
    still = []
    if on_state:
        on_state(st)
    with ThreadPoolExecutor(workers) as ex:      # retry once (attempts already enforce the per-key limit)
        for (r, why), res in zip(fails, ex.map(one, [f[0] for f in fails])):
            if res:
                still.append(res)
            elif not os.path.exists(os.path.join(stt_dir, f"{r['key_id']}.json")):
                still.append((r, why + " (retry not sent: attempt/budget/ledger limit)"))   # a blocked retry is still a failure
    st["failed"] = len(still)
    if breaker.tripped:
        st["breaker"] = breaker.tripped
    return st, still, stopped


def lane_lock(lane_dir):
    """Exclusive non-blocking lock held for the life of the process, so two rl_stt.py runs of one lane can never overlap."""
    fd = os.open(os.path.join(lane_dir, "rl_stt.lock"), os.O_WRONLY | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        refuse("another rl_stt.py is running for this lane (lane lock held)")
    return fd


def bind_go(go_calls, go_minutes, n_rows, share_min, wasted_min=0.0):
    """F4: the lane GO must be bound to this shard: N >= shard rows (and not wildly more), minutes within the shard's own audio (+5%)
    plus the minutes already billed on attempts that produced no transcript for this shard's keys (wasted_min: failed / abandoned / halted),
    which a restart must be able to cover. New sends get no plannable +5% from that allowance."""
    if go_calls < n_rows:
        refuse(f"GO N_calls {go_calls} is below the shard's {n_rows} rows")
    if go_calls > math.ceil(n_rows * CAP_FACTOR):
        refuse(f"GO N_calls {go_calls} is more than the shard's {n_rows} rows + 5%")
    if go_minutes > share_min * CAP_FACTOR + wasted_min:
        refuse(f"GO minutes {go_minutes} exceed this shard's {share_min:.1f} min + 5% + {wasted_min:.1f} min already billed without a transcript "
               f"(a global figure copied into a lane GO?)")


def write_budget(lane_dir, **kw):
    write_private(os.path.join(lane_dir, "BUDGET.json"), json.dumps(dict(kw, ts=time.strftime("%Y-%m-%dT%H:%M:%S")), sort_keys=True))


def make_gateway(sl):
    """The real sarvam_lane Gateway wrapped in ResilientGateway (jittered retries, job_id reuse). A test double that has no .call() is used as is."""
    raw = sl.Gateway()
    return ResilientGateway(raw, sl.GatewayError) if hasattr(raw, "call") else raw


def lane_dir_private(lane):
    d = os.path.join(OUT_ROOT, lane)
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)                                   # FAILURES.jsonl and friends live here
    return d


def recover_only(a):
    """Download-only recovery. For each ledger key with a 'failed' job_id and no stt/<key>.json: GET status; when the job is Completed,
    download-files + result URLs, write stt/<key>.json (tmp + rename, 0600) and append an ok_recovered ledger line (audio_s 0, same
    job_id). It never creates a job, uploads audio or starts anything, and needs no GO because it spends nothing."""
    shard = os.path.join(SHARD_DIR, f"shard_{a.lane[-1]}.tsv")      # the lane's configured shard, nothing else
    if a.shard and os.path.realpath(os.path.expanduser(a.shard)) != os.path.realpath(shard):
        refuse("--recover-only takes the shard only from the lane's configured path")
    if not a.dry_run:                                   # a dry run creates and writes nothing
        os.makedirs(STT_DIR, mode=0o700, exist_ok=True)
        lane_dir = lane_dir_private(a.lane)
        lock_fd = lane_lock(lane_dir)
    shard_rows = read_shard(shard)
    rows = {r["key_id"]: r for r in shard_rows}
    # same data gates as a send run, before any gateway call: manifest + same path, D episodes in labels, call window, split_guard (no H)
    vet_rows(shard_rows, read_manifest(), load_guard(), load_labels())
    ledger = Ledger()
    failed, done = ledger.failed_jobs(rows)
    todo = {k: j for k, j in failed.items() if k not in done and not os.path.exists(os.path.join(STT_DIR, f"{k}.json"))}
    sl = load_sl()
    gw = make_gateway(sl)
    if not hasattr(gw, "recover"):
        refuse("recovery needs the real gateway")
    counts = collections.Counter()
    for key, jids in sorted(todo.items()):
        got = None
        for jid in jids:
            try:
                if a.dry_run:
                    state = gw.state_of(gw.status(jid))
                    counts["completed" if state in DONE_STATES else (state or "unknown")] += 1
                    got = state in DONE_STATES
                    break
                raw, meta = gw.recover(jid)
            except Exception as e:  # noqa: BLE001 - class only
                counts["error:" + type(e).__name__] += 1
                continue
            if raw is None:
                counts[meta] += 1                          # meta is the state string here
                continue
            r = rows[key]
            doc = dict(key_id=key, episode_id=r.get("episode_id"), duration_s=dur_of(r.get("duration")), engine=sl.ENGINE,
                       params=sl.job_params("transcribe"), meta=meta, result=raw)
            out = os.path.join(STT_DIR, f"{key}.json")
            write_private(out + ".tmp", json.dumps(doc, ensure_ascii=False))
            os.replace(out + ".tmp", out)
            ledger.write(jid, sl.ENGINE, "transcribe", 0, "ok_recovered", key)
            counts["recovered"] += 1
            break
    summary = dict(lane=a.lane, dry_run=bool(a.dry_run), keys_failed_no_stt=len(todo), **dict(counts))
    if not a.dry_run:
        line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {a.lane} RECOVER-ONLY {json.dumps(summary, sort_keys=True)} sarvam_min_cum=0.0\n"
        with open(os.path.join(lane_dir, "PROGRESS.md"), "a") as f:
            f.write(line)
        os.close(lock_fd)
    print(json.dumps(summary, sort_keys=True))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("shard", nargs="?")
    ap.add_argument("--lane", required=True)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--progress-min", type=float, default=30)
    ap.add_argument("--wait", action="store_true", help="poll every 10 min until the shard file exists")
    ap.add_argument("--recover-only", action="store_true", help="download-only recovery of Completed jobs; creates no job, spends nothing")
    ap.add_argument("--dry-run", action="store_true", help="with --recover-only: only count job states, write nothing")
    a = ap.parse_args()
    if a.recover_only:
        return recover_only(a)
    if not a.shard:
        raise SystemExit("shard required")
    bt = os.path.join(OUT_ROOT, a.lane, "BREAKER.tripped")
    if os.path.exists(bt):
        refuse(f"BREAKER.tripped present for {a.lane}; a person must clear it after reading FAILURES.jsonl")
    while not os.path.exists(a.shard):
        if not a.wait:
            raise SystemExit(f"shard not found: {a.shard}")
        time.sleep(600)
    os.makedirs(STT_DIR, mode=0o700, exist_ok=True)
    lane_dir = lane_dir_private(a.lane)
    lock_fd = lane_lock(lane_dir)              # F1: one rl_stt.py per lane, for the whole run

    def say(msg, cum=0.0):
        with open(os.path.join(lane_dir, "PROGRESS.md"), "a") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {a.lane} {msg} sarvam_min_cum={cum:.1f}\n")
    prior_min = 0.0
    try:
        go_calls, go_minutes = read_go(os.path.join(lane_dir, "GO"))     # G5: no GO, no run
        rows = read_shard(a.shard)
        sl = load_sl()                                                  # pin asserted before the import
        vet_rows(rows, read_manifest(), load_guard(), load_labels())    # G1, G2, manifest, split, duplicates: all before any Gateway exists
        ledger = Ledger()
        prior_min, prior_att = ledger.billed(r["key_id"] for r in rows)   # F1: spend and attempts survive restarts
        probed, n_short, n_bad = probe_rows(rows)                       # G3
        share_min = sum(dur_of(r["duration"]) for r in probed) / 60
        bind_go(go_calls, go_minutes, len(rows), share_min,
                ledger.billed_without_transcript((r["key_id"] for r in rows), STT_DIR))   # F4
        todo = [r for r in probed if not os.path.exists(os.path.join(STT_DIR, f"{r['key_id']}.json"))]
        todo_att = [r for r in todo if prior_att.get(r["key_id"], 0) < MAX_ATTEMPTS]
        check_go(len({r['key_id'] for r in todo_att}), prior_min + sum(dur_of(r["duration"]) for r in todo_att) / 60, go_calls, go_minutes)
    except Refused as e:
        say(f"REFUSED {str(e)[:300]}", prior_min)
        raise
    say(f"GATES PASSED shard={os.path.basename(a.shard)} rows={len(rows)} to_send={len(todo_att)} skipped_lt{int(MIN_CALL_S)}s={n_short} "
        f"unprobeable={n_bad} given_up_prior={len(todo) - len(todo_att)} go_calls={go_calls} go_min={go_minutes} "
        f"cap_min={go_minutes * CAP_FACTOR:.1f} prior_billed_min={prior_min:.1f}", prior_min)
    budget = Budget(go_minutes, prior_min)
    gw = make_gateway(sl)
    params = sl.job_params("transcribe")
    known_jobs = {j for js in ledger.failed_jobs(r["key_id"] for r in rows)[0].values() for j in js}
    t0 = time.time()
    live = {}

    def progress(final=False):
        st = live.get("st", {})
        line = (f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {a.lane} shard={os.path.basename(a.shard)} total={len(rows)} ok={st.get('ok', 0)} "
                f"skipped_existing={st.get('skipped', 0)} budget_stopped={st.get('budget_stopped', 0)} given_up={st.get('given_up', 0)} "
                f"retried={st.get('retried', 0)} sarvam_min_cum={budget.cum:.1f} cap_min={budget.cap:.1f} "
                f"elapsed_min={(time.time()-t0)/60:.1f}{' FINAL' if final else ''}\n")
        with open(os.path.join(lane_dir, "PROGRESS.md"), "a") as f:
            f.write(line)
        write_budget(lane_dir, lane=a.lane, go_calls=go_calls, go_minutes=go_minutes, cap_minutes=budget.cap, cum_minutes=round(budget.cum, 3),
                     prior_billed_minutes=round(prior_min, 3), source="ledger forest-runo + this run")

    stop = threading.Event()

    def ticker():
        while not stop.wait(a.progress_min * 60):
            progress()

    threading.Thread(target=ticker, daemon=True).start()
    progress()
    st, still, stopped = run_jobs(todo, gw, params, sl.ENGINE, sl.GatewayError, ledger, budget, STT_DIR, a.workers,
                                  on_state=lambda s: live.__setitem__("st", s), prior_attempts=prior_att,
                                  fail_log=os.path.join(lane_dir, "FAILURES.jsonl"), known_jobs=known_jobs)
    live["st"] = st
    stop.set()
    if still:
        write_private(os.path.join(lane_dir, "FAILED.tsv"), "key_id\treason\n" + "".join(f"{r['key_id']}\t{why}\n" for r, why in still))
    progress(final=True)
    done = (f"# {a.lane} DONE\n\nModel: Sarvam saaras-v3 (diarization, auto language) via Even gateway; driver lane model per orchestrator.\n"
            f"Shard: {os.path.basename(a.shard)}\n\n- calls in shard: {len(rows)}\n- skipped under {int(MIN_CALL_S)} s (ffprobe): {n_short}\n"
            f"- unprobeable (not sent): {n_bad}\n- transcribed this run: {st['ok']}\n"
            f"- already present (skipped): {st['skipped']}\n- Sarvam minutes billed, lane cumulative: {budget.cum:.1f} (cap {budget.cap:.1f}, prior runs {prior_min:.1f})\n"
            f"- audio minutes transcribed this run: {st['audio_s']/60:.1f}\n- not sent, budget stop / ledger halt: {st['budget_stopped']}\n"
            f"- given up (2 billed attempts already): {st['given_up']}\n"
            f"- retried once: {st['retried']}\n- failures after retry: {st['failed']}"
            f"{' (see FAILED.tsv)' if st['failed'] else ''}\n- ledger write errors (run halted): {st['ledger_error']}\n"
            f"- transcripts: {STT_DIR}/<key_id>.json (0600)\n")
    if st.get("breaker"):
        done += f"- BREAKER TRIPPED: {json.dumps(st['breaker'], sort_keys=True)} (no new job created after the trip)\n"
        write_private(os.path.join(lane_dir, "BREAKER.tripped"), json.dumps(dict(st["breaker"], lane=a.lane, ok=st["ok"], failed=st["failed"])) + "\n")
        progress_line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {a.lane} BREAKER TRIPPED {json.dumps(st['breaker'], sort_keys=True)} sarvam_min_cum={budget.cum:.1f}\n"
        with open(os.path.join(lane_dir, "PROGRESS.md"), "a") as f:
            f.write(progress_line)
    write_private(os.path.join(lane_dir, "DONE.md"), done)
    print(json.dumps(st))
    os.close(lock_fd)
    if st.get("breaker"):
        raise SystemExit(3)


if __name__ == "__main__":
    main()
