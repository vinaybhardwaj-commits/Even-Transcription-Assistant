#!/usr/bin/env python3
"""run_window.py — HIST room-path harness (#331), the callable (hist-miner owns; hist-bulk imports). MINING ONLY (ruling 146): nothing produced here goes to a rater or a label without re-transcription on the production room path.
  run_window(chunks, start, end, router, out_path, window_id=..., room_id=...) -> record dict (also written to out_path, 0600)
    chunks   : bench_chunk rows of ONE room (id, idx, session_id, r2_key, started_at, ended_at, upload_state, source)
    start/end: aware datetimes (the window on the wall clock)
    router   : a key of ROUTERS, e.g. ":30100" (box forward port -> node + node-local port). ONE job in flight per router is the CALLER's rule (lab-mover): this function does not queue.
Steps: (1) chunks -> ~/eta-data/hist-mining/audio cache (R2 read key, ~/.venv-r2 python)  (2) cut_window: production join shape (libopus 32k 48 kHz mono webm)  (3) push to the router's OWN node over ssh stdin (0600); the node serves it on loopback
  (4) node_route.py: production request shape, polls to done  (5) pull the raw result  (6) PINNED production collapseAssembled (unmodified)  (7) English tags. The local window file is deleted after the push; the node deletes its copy.
Record carries dominant_language + transcript_native (raw) + transcript_native_collapsed + versions, so lab-mover's tag_english.py also runs on it unchanged. No text is printed by this module."""
import hashlib, json, os, re, subprocess, sys, time
from datetime import datetime, timedelta, timezone
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-encounter-first"))   # r2audio (lx)
import cut_window, collapse, tag, provenance
HM = os.path.expanduser("~/eta-data/hist-mining"); TMP = f"{HM}/tmp"
RESULTS_ROOT = os.path.expanduser(os.environ.get("HIST_RESULTS_ROOT", HM))      # where runs/ and manifests/ go (the vault uploader maps <root>/runs/... to runs/...); the audio cache and tmp stay under HM
# box forward port -> (ssh alias of the node, node-local router port). Node-local = 8083 + 100k (lab-mover #531/#522); ASSUMPTION for k>0 stays lab-mover's to confirm.
# 25 Sep 06:25 (Fable, V ordered): ALL GCP mining nodes are DELETED (hist-cpu-1..12, hist-gpu-1..4). No twin router exists any more: this table holds ONLY the Mini, so nothing here can target a deleted node
# (an unknown router is refused at the first statement of run_window). Do NOT re-add :301xx-:312xx / :38083 / :48083 without a new node and a new order.
ROUTERS = {}
# Per-router options. DEFAULT = the lab twins (Linux nodes: workdir 'histwork', python3, stack = the published HIST twin stack). The Mini (minibot #929) differs: macOS home dir 'hist-lab', the pyenv python that has `requests`,
# and its stack is the PRODUCTION stack, NOT the twin: a Mini window must never carry the twin's stack block (stack_kind 'mini-production' = no published stack doc yet -> stack/guards null, provenance_complete false, stated in notes).
ROUTER_OPTS = {":mini": {"workdir": "hist-lab", "python": "/Users/vinaybhardwaj/.pyenv/versions/3.13.9/bin/python3", "stack_kind": "mini-production",
                         "gate_file": os.path.expanduser("~/eta-data/hist-mining/MINI_READY"), "pause_file": os.path.expanduser("~/eta-data/hist/PAUSE.:mini")}}      # minibot #1061: their guard touches PAUSE.:mini on a confirmed flap; while it exists the harness refuses the Mini (no new window, no read)
_x = None      # HARD GATE: nothing is pushed to the Mini until this file exists; created only after minibot posts 'Mini ready' (minibot #929)
ROUTERS[":mini"] = ("mini", 8083)      # herdr-kit #933/#940, minibot #934: on the box 'ssh mini' = the Mini's LAB sshd (2224 -> 2223), key auth; NOT 'mini-bus' (forced command), NOT 'mini-legacy' (capped system sshd). Port forwards are OFF: node_route.py runs ON the Mini against its loopback router :8083 (8083 is the port ON the Mini).
def _opt(router, key, default): return ROUTER_OPTS.get(router, {}).get(key, default)

def remote_cmds(router, window_id, nport, tmo, translate=False):
    """The four remote commands for one window: (push, run, pull, cleanup). Default routers get exactly the commands used so far."""
    wd = _opt(router, "workdir", "histwork"); py = _opt(router, "python", "python3"); r = f"{wd}/{window_id}"
    return (f"umask 077; mkdir -p {wd}; cat > {r}.webm",
            f"{py} {wd}/node_route.py --router http://127.0.0.1:{nport} --audio {r}.webm --out {r}.json --timeout {tmo}" + (" --translate" if translate else ""),
            f"cat {r}.json; rm -f {r}.json {r}.webm",
            f"rm -f {r}.webm {r}.json")

WID = re.compile(r"^[A-Za-z0-9_\-]{1,80}$")

import contextlib, fcntl, threading
_T = threading.Lock()
@contextlib.contextmanager
def _fetch_lock():
    """Thread lock + flock on ~/eta-data/hist-mining/audio/.fetch.lock (0600): serialises R2 downloads across every process that uses this harness (stage 1, hist-bulk)."""
    os.makedirs(f"{HM}/audio", mode=0o700, exist_ok=True)
    with _T, open(f"{HM}/audio/.fetch.lock", "a") as f:
        os.chmod(f.name, 0o600); fcntl.flock(f, fcntl.LOCK_EX)
        try: yield
        finally: fcntl.flock(f, fcntl.LOCK_UN)

def _ssh(node, cmd, stdin=None, timeout=60):
    return subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", node, cmd], stdin=stdin, capture_output=True, timeout=timeout)

def build_record(res, meta):
    """res: node_route's JSON ({ok, elapsed_s, router, result}); meta: fields carried through. PURE except for the pinned collapse subprocess."""
    j = (res or {}).get("result") or {}
    native = j.get("transcript_native") or ""
    rec = dict(meta); rec.update({"ok": bool(res and res.get("ok")), "state": j.get("state"), "error": (j.get("error") or None), "elapsed_s": (res or {}).get("elapsed_s"),
        "dominant_language": j.get("dominant_language"), "transcript_native": native, "language_timeline": j.get("language_timeline"), "segments": j.get("segments"),
        "router_status": j.get("status"), "mining_only": True})
    col, cmeta = collapse.collapse([native, j.get("transcript_english")])
    if j.get("transcript_english"): rec["transcript_english"] = j["transcript_english"]; rec["transcript_english_collapsed"] = col[1]["text"]; rec["english_assembled_collapse"] = {k: col[1][k] for k in ("units_collapsed", "lines_dropped", "changed")}
    rec["transcript_native_collapsed"] = col[0]["text"]; rec["assembled_collapse"] = {k: col[0][k] for k in ("units_collapsed", "lines_dropped", "changed")}
    rec["versions"] = {"pinned_prod_sha": cmeta["pinned_sha"], "assembled_collapse_sha256_16": cmeta["file_sha256"], "number_words_sha12": cmeta["numwords_sha"], "router_served_by": (res or {}).get("router")}
    rec.update(tag.tag(rec["dominant_language"], native, rec["language_timeline"]))
    return rec

RUN_ID = os.environ.get("HIST_RUN_ID") or provenance.run_id("hist-miner")      # one run_id per process (ruling 184); a NEW process = a NEW run_id = new files, never an overwrite
IST = timezone(timedelta(hours=5, minutes=30))

def vault_path(run_id, room_id, ist_date, window_id):
    """Box original, in the vault key layout: runs/<run_id>/<room_id>/<ist_date>/<window_id>.json (LAB-RESULTS-VAULT-AND-VIEWER)."""
    return f"{RESULTS_ROOT}/runs/{run_id}/{room_id or 'room_unknown'}/{ist_date}/{window_id}.json"

SCHEMA = "eta-lab-result/1"
IST_TZ = timezone(timedelta(hours=5, minutes=30))

def _flat(d, pre=""):
    out = []
    for k, v in d.items(): out += _flat(v, pre + k + ".") if isinstance(v, dict) else [(pre + k, v)]
    return out

def _leaves(d):
    for v in d.values():
        if isinstance(v, dict): yield from _leaves(v)
        else: yield v

def producer_of(run_id):
    """The producer is the run_id prefix: '<producer>-<YYYYMMDDTHHMM>-<sha7>' or '<producer>-backfill-<date>'. The vault rejects (422) a provenance.producer that differs from the key's."""
    m = re.match(r"^(.+?)-(?:\d{8}T\d{4}-[0-9a-f]{7}|backfill-\d{8})$", run_id or "")
    if not m: raise ValueError(f"run_id not in <producer>-<YYYYMMDDTHHMM>-<sha7> form: {run_id!r}")
    return m.group(1)

_MINI_LIVE = {"t": 0.0, "live": None, "err": None}
def _mini_live(router, ttl=600):
    """The Mini's running units, read read-only over `ssh mini`, cached 10 min per process (drift during the night is still caught; a failure is cached too so a dead ssh does not stall every window)."""
    gate = _opt(router, "gate_file", None)
    if gate and not os.path.exists(gate): return None, "gated: MINI_READY absent, the Mini is not read before minibot posts 'Mini ready'"
    pause = _opt(router, "pause_file", None)
    if pause and os.path.exists(pause): return None, "paused: PAUSE.:mini exists (minibot's flap signal); the Mini is not read"      # the collector obeys the SAME gate as the window path: no ssh to the Mini at all
    if time.time() - _MINI_LIVE["t"] > ttl:
        try: _MINI_LIVE.update(t=time.time(), live=provenance.collect_mini(ROUTERS[router][0]), err=None)
        except Exception as e: _MINI_LIVE.update(t=time.time(), live=None, err=f"{type(e).__name__}")
    return _MINI_LIVE["live"], _MINI_LIVE["err"]

def _unpublished_stack_provenance(router, rec, run_id, producer, kind):
    """Provenance for a router whose stack has NO published stack_versions (the Mini's production stack): stack and guards are all null, provenance_complete is FALSE (the vault refuses a non-backfill file like that with 422: honest, and lab-viewer wants to know),
    and nothing from the twin stack is borrowed. Everything else the writer knows (run id, keys, time, temperature_fallback, served_by) is recorded."""
    cut = rec.get("cut") or {}
    if kind == "mini-production":      # a committed Mini stack doc that the RUNNING Mini agrees with -> use it; anything else -> the honest null block below, with the reason
        live, err = _mini_live(router)
        doc, dsha, dpath, det = provenance.published_mini_stack(live) if live else (None, None, None, f"the Mini could not be read ({err})")
        if doc:
            st2 = json.loads(json.dumps(doc["stack"])); st2.setdefault("whisper", {}).setdefault("flags", {})["temperature_fallback"] = "on"
            pvm = {"run_id": run_id, "producer": producer or producer_of(run_id), "temperature_fallback": "on", "created_at": datetime.now(IST_TZ).isoformat(timespec="seconds"), "not_run": ["diarizer"], "stack": st2, "guards": doc["guards"], "diarizer": None,
                   "stack_versions_sha256": dsha, "source_audio_keys": cut.get("chunk_keys", []), "source_chunks": cut.get("chunks_used", []), "stack_id": doc.get("stack_id"), "served_by": {"node": "mini-production", "router_port": router},
                   "live_check": {"unit_active_since": {r: (u or {}).get("started_at_epoch") for r, u in (live.get("units") or {}).items()}, "collected_at": live.get("collected_at")},
                   "notes": {"derived": ["stack.whisper.flags.temperature_fallback = 'on' ADDED to the embedded copy (ruling 196); the published file is unchanged"], "gaps": [], "source": f"minibot stack_versions {os.path.basename(dpath)} (sha256 {dsha}), a blob committed on origin/main", "cross_check_against_running_mini": det},
                   "harness": {"code_sha7": provenance.code_sha(), "request_shape": {"translate": bool(rec.get("translate")), "candidates": "en,kn,hi,ta,te,ml,mr,bn", "window_s": 180}}}
            if rec.get("translate"): pvm["notes"]["derived"].append("translate=true: the router produced transcript_english in the same job; its translation model and prompt are internal to the router and NOT exposed, so they are not recorded here")
            pvm["provenance_complete"] = all(v is not None and v != "" for v in _leaves(pvm["stack"])) and all(v is not None and v != "" for v in _leaves(pvm["guards"]))
            if not pvm["provenance_complete"]: pvm["incomplete_reason"] = "a stack or guards leaf of the published Mini stack file is empty"
            return pvm
        reason_extra = f" (looked for a committed doc: {det})"
    else: reason_extra = ""
    stack = {"whisper": {"model": None, "flags": {"vad": None, "temperature_inc": None, "no_speech_thold": None, "suppress_nst": None, "max_context": None, "temperature_fallback": "on"}}, "indic_conformer": {"model_id": None, "git_head": None}, "sravaani": {"version": None}, "router": {"commit": None, "config_sha256": None}}
    guards = {"shim_anti_loop": None, "english_hallucination_guard": None, "transcript_guard": None, "loop_guard_number_rule": None}
    sv = {"router": router, "stack_kind": kind, "published": False}
    return {"run_id": run_id, "producer": producer or producer_of(run_id), "temperature_fallback": "on", "created_at": datetime.now(IST_TZ).isoformat(timespec="seconds"), "not_run": ["diarizer"], "stack": stack, "guards": guards, "diarizer": None,
            "stack_versions_sha256": hashlib.sha256(json.dumps(sv, sort_keys=True).encode()).hexdigest(), "source_audio_keys": cut.get("chunk_keys", []), "source_chunks": cut.get("chunks_used", []), "stack_id": None, "served_by": {"node": kind, "router_port": router},
            "notes": {"derived": [], "gaps": [f"router {router} runs a '{kind}' stack: NO usable published stack_versions exists for it, so stack and guards are null and provenance_complete is false; the twin stack block is deliberately NOT used" + reason_extra]},
            "harness": {"code_sha7": provenance.code_sha(), "request_shape": {"translate": bool(rec.get("translate")), "candidates": "en,kn,hi,ta,te,ml,mr,bn", "window_s": 180}}, "provenance_complete": False, "missing": [f"no published stack_versions for stack_kind {kind}"], "incomplete_reason": f"no usable published stack_versions for stack_kind {kind}" + reason_extra}


def _node_config(router, st):
    """What differs PER NODE inside the one published stack (lab-mover #1027), read from the RUNNING units where possible: the whisper source (the node's own loopback shim vs the paired L4 host's VPC shim), the ORT/OMP thread caps and max in-flight."""
    st = st or {}; units = st.get("units") or {}; w = st.get("whisper") or {}; node = ROUTERS.get(router, (None,))[0]
    ienv = (units.get("indic") or {}).get("env_whitelist") or {}; renv = (units.get("router") or {}).get("env_whitelist") or {}
    return {"node": node, "whisper_source": ("own loopback shim" if w.get("node") == node else (f"VPC shim on {w.get('node')}" if w.get("node") else None)),
            "ort_intra_threads": ienv.get("ORT_INTRA_THREADS", "none (default pools)" if units else None), "omp_num_threads": ienv.get("OMP_NUM_THREADS"), "eta_max_inflight": renv.get("ETA_MAX_INFLIGHT"), "eta_default_candidates": renv.get("ETA_DEFAULT_CANDIDATES")}

def make_provenance(router, rec, run_id, producer=None):
    """Provenance in lab-viewer's schema v1 (kit/lab-vault/SCHEMA.md). Every value comes from the RUNNING system (provenance.stack_provenance); nothing is guessed. Where a leaf cannot be read it stays null,
    provenance_complete goes false (the vault rejects a non-backfill file with 422, and lab-viewer wants to know), and `notes` says what was derived and what is missing."""
    producer = producer or producer_of(run_id)
    cut = rec.get("cut") or {}; ver = rec.get("versions") or {}; missing = []; notes = {"derived": [], "gaps": []}
    kind = _opt(router, "stack_kind", "hist-twin")
    if kind != "hist-twin":      # e.g. the Mini's PRODUCTION stack: different from the twin stack, so the twin's published stack_versions must NOT be stamped on it
        return _unpublished_stack_provenance(router, rec, run_id, producer, kind)
    try: st = provenance.stack_provenance(router)
    except Exception as e: st = None; missing.append(f"stack unreadable: {type(e).__name__}")
    st = st or {}; units = st.get("units") or {}; ru, iu, su = (units.get(k) or {} for k in ("router", "indic", "sravaani")); w = st.get("whisper") or {}; sf = w.get("server_flags") or {}
    missing += st.get("missing", [])
    rs = (ru.get("guards") or {}); rsha = rs.get("router_server_sha256")
    def rev(u): return ((u.get("hf_snapshots") or [{}])[0]).get("revision")
    pub = provenance.published_stack_versions()
    if pub:
        doc, dsha, dpath = pub
        ok_x, det = provenance.cross_check(doc, st)
        if not ok_x: missing.append("stack drift: the running units' script hashes are not all in the published stack_versions (" + ", ".join(k for k, v in det.items() if not v) + ")")
    stack = {"whisper": {"model": st.get("whisper_model"), "flags": {"vad": (False if sf and not sf.get("vad_flag_in_argv") else None),
                         "temperature_inc": (sf.get("temperature_inc_in_argv") if sf.get("temperature_inc_in_argv") is not None else ("server default (no --temperature-inc in argv; the shim does not set it)" if sf else None)),
                         "no_speech_thold": sf.get("no_speech_thold"), "suppress_nst": sf.get("suppress_nst"), "max_context": w.get("shim_max_context_default")}},
             "indic_conformer": {"model_id": ((iu.get("hf_snapshots") or [{}])[0]).get("model") or None, "git_head": rev(iu)},
             "sravaani": {"version": st.get("sravaani_version")},
             "router": {"commit": (f"router_server.py sha256:{rsha[:16]}" if rsha else None), "config_sha256": ru.get("config_sha256")}}
    notes["derived"] += ["indic_conformer.git_head = the HF snapshot revision on disk (the unit dir is not a git repo)", "whisper.flags.vad = false because no --vad flag is in the server argv; temperature_inc = server default because neither the argv nor the shim sets it",
                         "whisper.flags.max_context = the shim's per-request default (source line reads other_fields['max_context'] = '0')", "router.config_sha256 = sha256 of `systemctl --user cat` of the router unit (unit + drop-ins incl. Environment)"]
    notes["gaps"] += ["router.commit is NOT a git commit: the node holds no repo; the value is the sha256 of the router_server.py the process loaded (lab-mover to supply the commit)"]
    shim_sha = (((w.get("units") or {}).get("whisper-shim-vpc.service") or {}).get("files") or {}).get("whisper-shim.py")
    guards = {"shim_anti_loop": (f"whisper-shim.py sha256_16:{shim_sha}" if shim_sha else None),
              "english_hallucination_guard": (f"router_server.py sha256_16:{rsha[:16]} (guard present, {rs.get('english_hallucination_guard_refs')} refs)" if rsha and rs.get("english_hallucination_guard_refs") else None),
              "transcript_guard": "not applied on the room-window path (encounter-process guard); the room path uses collapseAssembled + the router guards",
              "loop_guard_number_rule": (f"assembled-collapse.ts@{ver.get('pinned_prod_sha')} sha256_16:{ver.get('assembled_collapse_sha256_16')}; number_words sha12:{ver.get('number_words_sha12')}" if ver.get("pinned_prod_sha") else None)}
    if pub:      # lab-mover's published, sha-verified stack_versions is the source of truth; my live read is the cross-check
        stack, guards = doc["stack"], doc["guards"]; sv_sha = dsha; notes = {"derived": [], "gaps": [], "source": f"lab-mover stack_versions (sha256 {dsha}), stack_id {doc.get('stack_id')}", "cross_check_against_running_system": det, "stack_versions_file": os.path.basename(dpath)}
        sv = {"stack_id": doc.get("stack_id"), "sha256": dsha}
    else:
        sv = {"collected_by": "hist-miner provenance.py (read-only ssh)", "router": router, "stack": st}
        sv_sha = hashlib.sha256(json.dumps(sv, sort_keys=True, default=str).encode()).hexdigest()
        notes["gaps"].append("no stack_versions*.json with a PUBLISHED sha256 was found: values above are the live read of the running system")
    if rec.get("translate"): notes["derived"].append("translate=true: the ROUTER produced transcript_english in the same job; its translation model and prompt are internal to the router and are NOT exposed, so they are not recorded here (transcript_english is mining-only text like the rest)")
    notes["derived"].append("temperature_fallback: on (ruling 196): the whisper server's temperature-fallback ladder is ACTIVE (requests send temperature 0.0, the server default temperature_inc 0.2 applies), so output is non-deterministic run to run; accepted for mining under rulings 131/146")
    stack = json.loads(json.dumps(stack)); stack.setdefault("whisper", {}).setdefault("flags", {})["temperature_fallback"] = "on"      # lab-viewer #789 wants it here; stack_versions_sha256 stays the sha256 of the UNMODIFIED published file
    notes["derived"].append("stack.whisper.flags.temperature_fallback = 'on' was ADDED to the embedded copy of the stack (lab-viewer #789, ruling 196); the published file itself is unchanged")
    prov = {"run_id": run_id, "producer": producer, "temperature_fallback": "on", "created_at": datetime.now(IST_TZ).isoformat(timespec="seconds"), "not_run": ["diarizer"], "stack": stack, "guards": guards, "diarizer": None,
            "stack_versions_sha256": sv_sha, "source_audio_keys": cut.get("chunk_keys", []), "source_chunks": cut.get("chunks_used", []), "node_config": _node_config(router, st), "stack_id": (sv or {}).get("stack_id"), "served_by": {"node": st.get("node"), "router_port": router}, "live_check": {"unit_active_since": {r: (u or {}).get("active_since") for r, u in units.items()}, "collected_at": st.get("collected_at")}, "notes": notes,
            "harness": {"code_sha7": provenance.code_sha(), "request_shape": {"translate": bool(rec.get("translate")), "candidates": "en,kn,hi,ta,te,ml,mr,bn", "window_s": 180, "audio": "libopus 32k 48 kHz mono webm (production join shape)"}}}
    prov["provenance_complete"] = (not missing) and all(v is not None for v in _leaves(stack)) and all(v is not None for v in _leaves(guards))
    if missing: prov["missing"] = missing
    if not prov["provenance_complete"]: prov["incomplete_reason"] = "; ".join(missing) or "a stack or guards leaf is null"      # lab-viewer #1062: required, non-empty, whenever provenance_complete is false
    return prov

def run_window(chunks, start, end, router, out_path, window_id, room_id=None, files=None, timeout=None, run_id=None, allow_overwrite=True, translate=False):
    """out_path=None -> the VAULT layout under runs/<run_id>/... and NEVER overwrites (FileExistsError: use a new window_id, e.g. a '-a2' retry suffix). An explicit out_path keeps its old behaviour for callers that own their naming (allow_overwrite=True default)."""
    if router not in ROUTERS: raise SystemExit(f"unknown router {router}")
    if not WID.match(window_id): raise SystemExit("bad window_id")
    gate = _opt(router, "gate_file", None)
    if gate and not os.path.exists(gate): raise RuntimeError(f"router {router} is GATED: nothing is pushed until {gate} exists (created only after minibot posts 'Mini ready')")
    pause = _opt(router, "pause_file", None)
    if pause and os.path.exists(pause): raise RuntimeError(f"router {router} is PAUSED: {pause} exists (minibot's flap signal); no new window until it is removed")
    run_id = run_id or RUN_ID
    if out_path is None:
        out_path = vault_path(run_id, room_id, start.astimezone(IST).date().isoformat(), window_id); allow_overwrite = False
    node, nport = ROUTERS[router]; os.makedirs(TMP, mode=0o700, exist_ok=True)
    meta = {"translate": bool(translate), "run_id": run_id, "window_id": window_id, "room_id": room_id, "start": start.isoformat(), "end": end.isoformat(), "router": router, "node": node, "started_at": datetime.utcnow().isoformat() + "Z"}
    local = f"{TMP}/{window_id}.webm"; t0 = time.time()
    try:
        if files is None:
            import r2audio; r2audio.CACHE = f"{HM}/audio"
            with _fetch_lock():        # r2audio.fetch writes a shared '<key>.part': two threads/processes on one key race (hist-bulk hit a FileNotFoundError); one download at a time, across processes
                paths = r2audio.fetch([c["r2_key"] for c in chunks], 4)
            files = {c["id"]: paths[c["r2_key"]] for c in chunks}
        meta["cut"] = cut_window.cut(chunks, start, end, local, files)
        if not meta["cut"]["n_chunks"]:
            return _write(out_path, allow_overwrite, router, run_id, build_record({"ok": False, "result": {"state": "failed", "error": "no_audio_in_window"}}, meta))
        tmo_ = int(timeout or max(1800, 4 * meta["cut"]["duration_s"])); c_push, c_run, c_pull, c_clean = remote_cmds(router, window_id, nport, tmo_, translate)
        with open(local, "rb") as f: p = _ssh(node, c_push, stdin=f, timeout=300)
        if p.returncode: return _write(out_path, allow_overwrite, router, run_id, build_record({"ok": False, "result": {"state": "failed", "error": f"push_rc_{p.returncode}"}}, meta))
    finally:
        try: os.unlink(local)          # patient voice: gone from the box's tmp whatever happens
        except OSError: pass
    tmo = tmo_
    p = _ssh(node, c_run, timeout=tmo + 120)
    if p.returncode:
        _ssh(node, c_clean)
        return _write(out_path, allow_overwrite, router, run_id, build_record({"ok": False, "result": {"state": "failed", "error": f"node_route_rc_{p.returncode}"}}, meta))
    g = _ssh(node, c_pull, timeout=120)
    try: res = json.loads(g.stdout)
    except Exception: res = {"ok": False, "result": {"state": "failed", "error": "pull_failed"}}
    meta["wall_s"] = round(time.time() - t0, 1)
    return _write(out_path, allow_overwrite, router, run_id, build_record(res, meta))

def _next_attempt(path):
    base = path[:-5] if path.endswith(".json") else path
    n = 1
    while os.path.exists(f"{base}.attempt{n}.json"): n += 1
    return f"{base}.attempt{n}.json"

VAULT_PUSH = next((f for f in (os.path.expanduser("~/.local/share/lab-vault/vault-push.py"), os.path.expanduser("~/dev/eta-lab/kit/vault-push.py")) if os.path.exists(f)), os.path.expanduser("~/.local/share/lab-vault/vault-push.py"))      # lab-viewer's installed copy first (#764)
def _vault_push(path):
    """End-of-unit push (ruling 184). Non-blocking and failure-proof: a missing uploader or a non-zero exit only means 'still pending' (the 15-min timer retries)."""
    if not os.path.exists(VAULT_PUSH): return False
    try: subprocess.Popen([sys.executable, VAULT_PUSH, "--path", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True); return True
    except Exception: return False

def _write(path, allow_overwrite, router, run_id, rec):
    rec["schema"] = SCHEMA
    rec["provenance"] = make_provenance(router, rec, run_id)      # every record, including failed ones, says how it was (not) made
    vault_mode = not allow_overwrite
    if vault_mode and not (rec.get("ok") or rec.get("error") == "no_audio_in_window"): path = _next_attempt(path)      # a failed attempt is <unit>.attempt<N>.json; only an ok (or no-tape) outcome takes the plain name
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f: json.dump(rec, f, ensure_ascii=False)
    os.chmod(tmp, 0o600)
    if allow_overwrite: os.replace(tmp, path)
    else:
        try: os.link(tmp, path)             # atomic create-only: fails if the file exists (never overwrite)
        finally: os.unlink(tmp)
    rec["_path"] = path
    if vault_mode: _vault_push(path)
    return rec

# ---- manifests (write-once: .start.json at run start, .json at run end) ----
def manifest_path(run_id, end=False): return f"{RESULTS_ROOT}/manifests/{run_id}{'' if end else '.start'}.json"

def write_manifest(run_id, router, payload, end=False):
    path = manifest_path(run_id, end); os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    meta = collapse.collapse([""])[1]      # the pinned production collapse's versions, so a manifest's guards are as complete as a window's
    body = {"schema": SCHEMA, "provenance": make_provenance(router, {"versions": {"pinned_prod_sha": meta["pinned_sha"], "assembled_collapse_sha256_16": meta["file_sha256"], "number_words_sha12": meta["numwords_sha"]}}, run_id), **payload}
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f: json.dump(body, f, ensure_ascii=False)
    os.chmod(tmp, 0o600)
    try: os.link(tmp, path)          # once: a second call for the same run_id/phase raises FileExistsError
    finally: os.unlink(tmp)
    _vault_push(path); return path

def selftest():
    dev = "यह एक परीक्षण वाक्य है"   # synthetic Devanagari (no patient text)
    res = {"ok": True, "elapsed_s": 12.0, "router": "http://127.0.0.1:8083", "result": {"state": "done", "dominant_language": "hi", "transcript_native": dev + " thank you thank you thank you thank you thank you take five five five tablets",
           "language_timeline": {"spans": [{"start_s": 0, "end_s": 30, "lang": "hi"}, {"start_s": 30, "end_s": 60, "lang": "en"}]}, "segments": []}}
    r = build_record(res, {"window_id": "t"})
    assert r["transcript_native_collapsed"] == dev + " thank you take five five five tablets" and r["assembled_collapse"]["units_collapsed"] == 1, r["assembled_collapse"]
    assert r["english_span_share"] == 0.5 and r["indic_script_share"] > 0.10 and r["english_dominant"] is False, (r["english_span_share"], r["indic_script_share"], r["english_dominant"])
    assert r["versions"]["pinned_prod_sha"] == "5970852" and r["mining_only"] is True
    lat = build_record({"ok": True, "result": {"state": "done", "dominant_language": "kn", "transcript_native": "all latin script here", "language_timeline": {"spans": []}}}, {})
    assert lat["english_dominant"] is True and lat["english_span_share"] is None, "lab-mover's rule: non-empty transcript with <10% Indic script is English-dominant, even when the router says kn"
    en = build_record({"ok": True, "result": {"state": "done", "dominant_language": "en", "transcript_native": "hello there", "language_timeline": {"spans": [{"start_s": 0, "end_s": 10, "lang": "en"}]}}}, {})
    assert en["english_dominant"] and en["english_span_share"] == 1.0
    fail = build_record({"ok": False, "result": {"state": "failed", "error": "x"}}, {})
    assert fail["ok"] is False and fail["transcript_native_collapsed"] == "" and fail["english_dominant"] is False
    assert ROUTERS == {":mini": ("mini", 8083)}, ROUTERS      # 25 Sep 06:25: every twin node is deleted; only the Mini remains
    for gone in (":30100", ":30204", ":30604", ":31204", ":38083", ":48083"):
        try: run_window([], None, None, gone, None, "w"); raise AssertionError("a deleted router must be refused")
        except SystemExit as e: assert "unknown router" in str(e)
        ROUTERS[":30100"] = ("hist-cpu-1", 8083)      # TEST ONLY (a fake node for the fixtures below): the real table is Mini-only since 25 Sep 06:25
    # --- ruling 184 / schema v1 (no ssh: the stack collector is stubbed) ---
    import tempfile
    _saved_sd = provenance.STACK_DIR; provenance.STACK_DIR = tempfile.mkdtemp()      # isolate from any real published stack_versions on this box: this section tests the FALLBACK path (the published path is test_provenance_published.py)
    fake_units = {"router": {"config_sha256": "c" * 64, "files": {"router_server.py": {"sha256_16": "400710eeb45cf095", "mtime": 1}}, "guards": {"router_server_sha256": "400710eeb45cf095" + "0" * 48, "english_hallucination_guard_refs": 1, "collapse_phrase_loops_refs": 3}},
                  "indic": {"hf_snapshots": [{"model": "ai4bharat/indic-conformer-600m-multilingual", "revision": "e9b71b369c048e2c6b634d4c131061c34e441179"}]}, "sravaani": {"hf_snapshots": [{"model": "ARTPARK-IISc/SraVaani-1.0", "revision": "f5dd5358"}]}}
    fake = {"router_url_port": ":30100", "node": "hist-cpu-1", "router_version": "3.1-sravaani", "whisper_model": "large-v3-turbo", "indicconformer_id": "600M", "sravaani_version": "SraVaani-1.0", "collected_at": "t", "missing": [], "units": fake_units,
            "whisper": {"node": "hist-gpu-1", "units": {"whisper-shim-vpc.service": {"files": {"whisper-shim.py": "c24fd097996e8ddd"}}}, "server_flags": {"no_speech_thold": 0.7, "suppress_nst": True, "vad_flag_in_argv": False, "temperature_inc_in_argv": None}, "shim_max_context_default": 0}}
    assert producer_of("hist-miner-20260924T1305-abcdef0") == "hist-miner" and producer_of("hist-bulk-20260924T1912-ab12cd3") == "hist-bulk" and producer_of("hist-bulk-backfill-20260924") == "hist-bulk" and producer_of("vj-20260925T0900-0123abc") == "vj"
    try: producer_of("bad_run_id"); raise AssertionError("a malformed run_id must be refused")
    except ValueError: pass
    RID = "hist-miner-20260924T1305-abcdef0"
    provenance._CACHE[":30100"] = fake
    rec = build_record(res, {"window_id": "t", "cut": {"chunk_keys": ["k1", "k2"], "n_chunks": 2}})
    pv = make_provenance(":30100", rec, "hist-miner-20260924T1305-abcdef0")
    assert make_provenance(":30100", rec, "hist-bulk-20260924T1912-ab12cd3")["producer"] == "hist-bulk", "a hist-bulk run must not be stamped hist-miner"
    assert pv["run_id"].startswith("hist-miner-") and pv["producer"] == "hist-miner" and pv["source_audio_keys"] == ["k1", "k2"] and pv["diarizer"] is None and pv["not_run"] == ["diarizer"], pv
    assert pv["provenance_complete"] is True, pv.get("missing") or [k for k, v in _flat(pv["stack"]) + _flat(pv["guards"]) if v is None]
    assert pv["stack"]["whisper"]["flags"] == {"vad": False, "temperature_inc": "server default (no --temperature-inc in argv; the shim does not set it)", "no_speech_thold": 0.7, "suppress_nst": True, "max_context": 0, "temperature_fallback": "on"}
    assert pv["stack"]["indic_conformer"]["git_head"].startswith("e9b71b36") and pv["stack"]["router"]["config_sha256"] == "c" * 64 and pv["guards"]["loop_guard_number_rule"].startswith("assembled-collapse.ts@5970852")
    assert len(pv["stack_versions_sha256"]) == 64 and pv["created_at"].endswith("+05:30"), pv["created_at"]
    assert pv["temperature_fallback"] == "on" and any("temperature_fallback" in n for n in pv["notes"]["derived"]), "ruling 196: every run records temperature_fallback: on"
    assert pv["stack"]["whisper"]["flags"]["temperature_fallback"] == "on", "lab-viewer #789: also inside stack.whisper.flags"
    assert pv["source_chunks"] == [] and "node_config" in pv and pv["node_config"]["node"] == "hist-cpu-1", pv["node_config"]      # this fake record has no chunks_used; node_config comes from the (fake) running units
    provenance._CACHE[":30100"] = {**fake, "units": {**fake_units, "indic": {"hf_snapshots": []}}}
    assert make_provenance(":30100", rec, RID)["provenance_complete"] is False, "an unreadable leaf (indic git_head) must flip provenance_complete: the vault rejects it, lab-viewer wants to know"
    provenance._CACHE[":30100"] = fake
    vp = vault_path("hist-miner-20260924T1305-abcdef0", "room_x", "2026-09-10", "w1"); assert vp.endswith("/runs/hist-miner-20260924T1305-abcdef0/room_x/2026-09-10/w1.json"), vp
    with tempfile.TemporaryDirectory() as d:
        pth = f"{d}/a/w1.json"; ok_rec = dict(rec, ok=True)
        _write(pth, False, ":30100", RID, dict(ok_rec)); first = open(pth).read()
        assert json.loads(first)["schema"] == "eta-lab-result/1"
        try: _write(pth, False, ":30100", RID, dict(ok_rec, window_id="OTHER")); raise AssertionError("an ok record must not overwrite the existing file")
        except FileExistsError: pass
        assert open(pth).read() == first and not [f for f in os.listdir(f"{d}/a") if f.endswith(".tmp")], "original untouched, no tmp left behind"
        fail = dict(rec, ok=False, error="node_route_rc_1")
        r = _write(f"{d}/a/w2.json", False, ":30100", RID, dict(fail)); assert r["_path"].endswith("w2.attempt1.json"), r["_path"]
        r = _write(f"{d}/a/w2.json", False, ":30100", RID, dict(fail)); assert r["_path"].endswith("w2.attempt2.json"), r["_path"]
        r = _write(f"{d}/a/w2.json", False, ":30100", RID, dict(ok_rec)); assert r["_path"].endswith("w2.json"), "the final ok outcome takes the plain name; failed attempts stay as attempt files"
        r = _write(f"{d}/a/w3.json", False, ":30100", RID, dict(rec, ok=False, error="no_audio_in_window")); assert r["_path"].endswith("w3.json"), "no-tape is a final outcome, not an attempt"
        _write(f"{d}/x.json", True, ":30100", RID, dict(rec, window_id="explicit")); assert json.load(open(f"{d}/x.json"))["window_id"] == "explicit"
        _write(f"{d}/x.json", True, ":30100", RID, dict(rec, window_id="explicit2")); assert json.load(open(f"{d}/x.json"))["window_id"] == "explicit2", "explicit-path callers keep their overwrite behaviour"
        assert oct(os.stat(pth).st_mode & 0o777) == "0o600"
        global RESULTS_ROOT
        saved = RESULTS_ROOT; RESULTS_ROOT = d
        try:
            m1 = write_manifest("hist-miner-20260924T1305-abcdef0", ":30100", {"counts": {"planned": 3}}); assert m1.endswith("manifests/hist-miner-20260924T1305-abcdef0.start.json")
            m2 = write_manifest("hist-miner-20260924T1305-abcdef0", ":30100", {"counts": {"ok": 3}}, end=True); assert m2.endswith("manifests/hist-miner-20260924T1305-abcdef0.json")
            try: write_manifest("hist-miner-20260924T1305-abcdef0", ":30100", {}, end=True); raise AssertionError("a manifest is write-once")
            except FileExistsError: pass
            assert json.load(open(m1))["schema"] == "eta-lab-result/1" and json.load(open(m1))["provenance"]["run_id"] == "hist-miner-20260924T1305-abcdef0"
            assert json.load(open(m1))["provenance"]["guards"]["loop_guard_number_rule"], "a manifest must not lack guards.loop_guard_number_rule (the 1845 start manifest was rejected for this)"
        finally: RESULTS_ROOT = saved
    assert _vault_push("/nonexistent") in (True, False), "the uploader hook never raises"
    provenance._CACHE.pop(":30100", None); provenance.STACK_DIR = _saved_sd
    print("selftest OK: record fields, span share, Latin-script rule, failed-job record, router table; schema v1 provenance (complete / incomplete when a leaf is unreadable), vault path, never-overwrite, attempt files, write-once manifests, explicit-path compat, 0600")

if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest()
    else: print(__doc__)
