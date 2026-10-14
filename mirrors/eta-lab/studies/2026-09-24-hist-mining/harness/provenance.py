#!/usr/bin/env python3
"""provenance.py — ruling 184 (LAB-RESULTS-VAULT-AND-VIEWER): what a HIST record must say about how it was made, taken from the RUNNING system (not from a setup script).
collect_stack(router) reads, READ-ONLY over ssh, once per router per process: the router's /healthz (version, engine_versions, backend urls); for the router, IndicConformer and SraVaani units of that stack: ActiveEnterTimestamp (process start),
sha256 of the .py file(s) the unit loads (+ mtime, so 'file newer than process start' is visible), git rev of the unit's WorkingDirectory if it is a repo, and a sha256 of the sorted Environment (a CONFIG HASH: values are never stored, they can hold key paths);
and, for the whisper node the router points at (matched by its VPC address), the whisper units' argv flags + shim script/lexicon sha256 + shim /healthz. Anything it cannot read is listed in `missing` and provenance_complete is false: nothing is invented.
  stack_provenance(router) -> dict (cached)        run_id(producer='hist-miner') -> 'hist-miner-<YYYYMMDDTHHMM>-<shortsha>'  (shortsha = sha256 of the harness files, first 7 hex)
  python3 provenance.py --selftest    |    python3 provenance.py :30100     (prints keys + hashes, no secrets)"""
import hashlib, json, os, re, subprocess, sys, time
from datetime import datetime, timedelta, timezone
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
_CACHE = {}
NODE_SCRIPT = r'''
import json, os, subprocess, hashlib, glob, re, sys, urllib.request
k = int(sys.argv[1]); out = {"units": {}, "missing": []}
def sh(c):
    r = subprocess.run(c, shell=True, capture_output=True, text=True); return r.stdout.strip()
def sha(p):
    try: return hashlib.sha256(open(p, "rb").read()).hexdigest()[:16], int(os.stat(p).st_mtime)
    except Exception: return None, None
def get(url):
    try: return json.loads(urllib.request.urlopen(url, timeout=5).read().decode()[:2000])
    except Exception as e: return None
def _exists(u): return bool(sh(f"systemctl --user cat {u} 2>/dev/null | head -1"))
router_unit = next((u for u in ([f"eta-router-s{k}"] + (["eta-router-twin"] if k == 0 else [])) if _exists(u)), f"eta-router-s{k}")      # the GPU nodes' twin stack is eta-router-twin (port 8083); the packed CPU stacks are eta-router-s<k>
units = {"router": router_unit, "indic": "eta-indic-twin" if k == 0 else f"eta-indic-s{k}", "sravaani": "eta-sravaani-twin" if k == 0 else f"eta-sravaani-s{k}"}
for role, u in units.items():
    show = sh(f"systemctl --user show {u} -p ActiveEnterTimestamp -p WorkingDirectory -p Environment -p ExecStart")
    d = dict(l.split("=", 1) for l in show.splitlines() if "=" in l); wd = d.get("WorkingDirectory", "")
    files = sorted(set(re.findall(r"[^\s;={}]+\.py", d.get("ExecStart", ""))))
    files = [f if f.startswith("/") else os.path.join(wd, f) for f in files] + (sorted(glob.glob(os.path.join(wd, "*.py")))[:40] if wd else [])      # every top-level .py of the unit's WorkingDirectory (router_server.py + any patch_router_guard*.py that the process may load)
    fh = {}
    for f in sorted(set(files)):
        h, m = sha(f)
        if h: fh[os.path.basename(f)] = {"sha256_16": h, "mtime": m}
    env = sorted(d.get("Environment", "").split())
    rev = sh(f"git -C '{wd}' rev-parse --short HEAD 2>/dev/null") if wd else ""
    unit_text = sh(f"systemctl --user cat {u} 2>/dev/null")
    snaps = []
    for pat in ("hf-cache/models--*/snapshots/*", "hf-cache/*/models--*/snapshots/*", "hfhome/hub/models--*/snapshots/*"):
        for sd in glob.glob(os.path.join(wd, pat)) if wd else []:
            m = re.search(r"models--([^/]+)/snapshots/([0-9a-f]{7,40})", sd)
            if m: snaps.append({"model": m.group(1).replace("--", "/"), "revision": m.group(2)})
    guards = {}
    rs = os.path.join(wd, "router_server.py") if wd else ""
    if role == "router" and os.path.exists(rs):
        txt = open(rs, errors="ignore").read()
        guards = {"router_server_sha256": hashlib.sha256(open(rs, "rb").read()).hexdigest(), "english_hallucination_guard_refs": txt.count("english_hallucination_guard"), "collapse_phrase_loops_refs": txt.count("collapse_phrase_loops")}
    WL = ("ORT_INTRA_THREADS", "ORT_INTER_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "ETA_MAX_INFLIGHT", "ETA_DEFAULT_CANDIDATES", "INDIC_DECODING")      # values are config numbers/lists, never secrets
    envwl = {t.split("=", 1)[0]: t.split("=", 1)[1] for t in env if "=" in t and t.split("=", 1)[0] in WL}
    out["units"][role] = {"unit": u, "active_since": d.get("ActiveEnterTimestamp") or None, "env_whitelist": envwl, "files": fh, "git_rev": rev or None, "config_sha256": hashlib.sha256(unit_text.encode()).hexdigest() if unit_text else None,
                          "config_sha256_16": hashlib.sha256("\n".join(env).encode()).hexdigest()[:16] if env else None, "n_env_vars": len(env), "hf_snapshots": snaps, "guards": guards}
    if not fh: out["missing"].append(f"{role}: no readable .py file")
out["router_healthz"] = get(f"http://127.0.0.1:{8083 + 100 * k}/healthz")
out["indic_healthz"] = get(f"http://127.0.0.1:{8082 + 100 * k}/healthz") or get(f"http://127.0.0.1:{8082 + 100 * k}/health")
out["sravaani_healthz"] = get(f"http://127.0.0.1:{8085 + 100 * k}/healthz") or get(f"http://127.0.0.1:{8085 + 100 * k}/health")
print(json.dumps(out))
'''
WHISPER_SCRIPT = r'''
import json, subprocess, hashlib, os, re, urllib.request
def sh(c): return subprocess.run(c, shell=True, capture_output=True, text=True).stdout.strip()
def sha(p):
    try: return hashlib.sha256(open(p, "rb").read()).hexdigest()[:16]
    except Exception: return None
out = {"ips": sh("hostname -I").split(), "units": {}}
for u in sh("systemctl --user list-units --type=service --no-pager --plain | awk '{print $1}' | grep -i whisper").split():
    show = sh(f"systemctl --user show {u} -p ActiveEnterTimestamp -p ExecStart")
    d = dict(l.split("=", 1) for l in show.splitlines() if "=" in l); es = d.get("ExecStart", "")
    argv = re.search(r"argv\[\]=([^;]*)", es); argv = argv.group(1).strip() if argv else ""
    files = {os.path.basename(f): sha(os.path.expanduser(f)) for f in set(re.findall(r"[^\s;={}]+\.(?:py|json)", es))}
    model = re.search(r"-m\s+(\S+)", argv); mp = os.path.expanduser(model.group(1)) if model else None
    ms = {"path_basename": os.path.basename(mp), "size_bytes": os.stat(mp).st_size, "mtime": int(os.stat(mp).st_mtime)} if mp and os.path.exists(mp) else None      # a 1.6 GB model is identified by name+size+mtime, not hashed here
    out["units"][u] = {"active_since": d.get("ActiveEnterTimestamp") or None, "argv": argv[:400], "files": {k: v for k, v in files.items() if v}, "model_file": ms}
lex = os.path.expanduser("~/services/whisper-shim/eta_number_words.json"); out["number_words_json_sha256_16"] = sha(lex)
try:
    shim_src = open(os.path.expanduser("~/services/whisper-shim/whisper-shim.py"), errors="ignore").read()
    m = re.search(r'other_fields\["max_context"\]\s*=\s*"(\d+)"', shim_src); out["shim_max_context_default"] = int(m.group(1)) if m else None
    out["shim_mentions"] = {k: shim_src.count(k) for k in ("temperature", "vad", "no_speech", "suppress")}
except Exception: out["shim_max_context_default"] = None; out["shim_mentions"] = None
wt = out["units"].get("whisper-twin.service", {}).get("argv", "")
def flag(name, cast=None):
    m = re.search(r"--" + name + r"(?:\s+(\S+))?", wt)
    return None if not m else (cast(m.group(1)) if cast and m.group(1) else True)
out["server_flags"] = {"no_speech_thold": flag("no-speech-thold", float), "suppress_nst": bool(flag("suppress-nst")), "vad_flag_in_argv": bool(re.search(r"--vad", wt)), "temperature_inc_in_argv": flag("temperature-inc", float)}
try: out["shim_healthz"] = json.loads(urllib.request.urlopen("http://127.0.0.1:8081/healthz", timeout=5).read().decode()[:1500])
except Exception: out["shim_healthz"] = None
print(json.dumps(out))
'''
def _ssh_py(node, script, args=(), timeout=90):
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", node, "python3 - " + " ".join(map(str, args))], input=script, capture_output=True, text=True, timeout=timeout)
    if r.returncode: raise RuntimeError(f"provenance ssh {node} rc={r.returncode}")
    return json.loads(r.stdout)

def collect_stack(router):
    import run_window as rw
    node, nport = rw.ROUTERS[router]; k = (nport - 8083) // 100
    d = _ssh_py(node, NODE_SCRIPT, [k]); missing = list(d.get("missing", []))
    rh = d.get("router_healthz") or {}
    if not rh: missing.append("router /healthz unreadable")
    w = None; wurl = (rh.get("urls") or {}).get("whisper")
    ip = re.search(r"//([\d.]+)", wurl or "")
    if ip and ip.group(1).startswith("127."):      # the router's whisper is its OWN node's shim (the GPU nodes' twin stacks): read the whisper units on the router's node
        try: w = {"node": node, **_ssh_py(node, WHISPER_SCRIPT)}
        except Exception: w = None
    elif ip:
        for g in ():      # 25 Sep 06:25: every whisper L4 host (hist-gpu-1..4) is DELETED; nothing here may ssh to one. Do not re-add without a new node and a new order.
            try:
                cand = _ssh_py(g, WHISPER_SCRIPT)
                if ip.group(1) in cand["ips"]: w = {"node": g, **cand}; break
            except Exception: continue
    if not w: missing.append("whisper node/flags not found")
    ev = rh.get("engine_versions") or {}
    return {"router_url_port": router, "node": node, "stack_k": k, "router_version": rh.get("version"), "whisper_model": ev.get("whisper"), "indicconformer_id": ev.get("indicconformer"), "sravaani_version": ev.get("sravaani"),
            "units": d.get("units"), "router_healthz": rh, "indic_healthz": d.get("indic_healthz"), "sravaani_healthz": d.get("sravaani_healthz"), "whisper": w,
            "collected_at": datetime.now(timezone.utc).isoformat(), "missing": missing}

# lab-mover owns the stack facts (ruling 184): ~/eta-data/hist/stack_versions*.json, write-once. A file is trusted ONLY if its sha256 is one lab-mover PUBLISHED on the bus (the stack_id alone is not enough:
# an overwritten copy kept the same stack_id and different bytes). Add a new published sha here (or via HIST_STACK_VERSIONS_SHA256, comma-separated) when lab-mover announces a new file.
PUBLISHED_STACK_SHAS = ("da63154514c45e39254a5d76d8048d1462261b54553f95420387afcdf40023b6",)      # lab-mover #763: byte-identical to the immutable git copy studies/2026-09-24-stt-parity/stack_versions.0b12949986df.json @76d08f2 (I verified the hash against origin/main). The earlier ba2eaf1c... (#734) was overwritten and is gone.
STACK_DIR = os.path.expanduser(os.environ.get("HIST_STACK_VERSIONS_DIR", "~/eta-data/hist"))

def git_published_shas():
    """sha256 of every stack_versions.*.json COMMITTED on origin/main (lab-mover's immutable copies), read from the git objects: the anchor is the blob, not a sha quoted on the bus (eta-refuter-2 #775). Local refs only; no fetch here."""
    repo = os.path.expanduser(os.environ.get("HIST_STACK_GIT_REPO", "~/dev/eta-lab")); ref = os.environ.get("HIST_STACK_GIT_REF", "origin/main"); d = os.environ.get("HIST_STACK_GIT_DIR", "studies/2026-09-24-stt-parity")
    out = set()
    try:
        names = subprocess.run(["git", "-C", repo, "ls-tree", "--name-only", ref, d.rstrip("/") + "/"], capture_output=True, text=True, timeout=30).stdout.split()
        for n in names:
            if re.fullmatch(r"stack_versions\.[A-Za-z0-9_.\-]+\.json", os.path.basename(n)):
                b = subprocess.run(["git", "-C", repo, "show", f"{ref}:{n}"], capture_output=True, timeout=30).stdout
                if b: out.add(hashlib.sha256(b).hexdigest())
    except Exception: pass
    return out

def published_stack_versions():
    """-> (doc, sha256, path) for the first stack_versions*.json whose sha256 is published: the sha256 of a stack_versions.*.json committed on origin/main (preferred), or a fallback value from PUBLISHED_STACK_SHAS / HIST_STACK_VERSIONS_SHA256."""
    import glob
    shas = set(PUBLISHED_STACK_SHAS) | git_published_shas() | {x.strip() for x in os.environ.get("HIST_STACK_VERSIONS_SHA256", "").split(",") if x.strip()}
    for f in sorted(glob.glob(os.path.join(STACK_DIR, "stack_versions*.json"))):
        try: b = open(f, "rb").read()
        except OSError: continue
        h = hashlib.sha256(b).hexdigest()
        if h in shas:
            try: return json.loads(b), h, f
            except ValueError: continue
    return None

def cross_check(doc, live):
    """Does the RUNNING system (my live read) agree with the published stack_versions? For each script the units loaded, its sha256 8-hex prefix must appear in the published document. -> (ok, details)."""
    text = json.dumps(doc)
    det, ok = {}, True
    for role, u in ((live.get("units") or {}).items()):
        for fn, v in (u.get("files") or {}).items():
            if fn in ("router_server.py", "indic_server.py", "sravaani_server.py"):
                found = (v.get("sha256_16") or "")[:8] in text; det[fn] = found; ok = ok and found
    if not det: ok = False
    return ok, det

def stack_provenance(router):
    if router not in _CACHE: _CACHE[router] = collect_stack(router)
    return _CACHE[router]

def code_sha():
    h = hashlib.sha256()
    for f in sorted(os.listdir(HERE)):
        if f.endswith((".py", ".mts", ".mjs")): h.update(f.encode()); h.update(open(os.path.join(HERE, f), "rb").read())
    return h.hexdigest()[:7]

def run_id(producer="hist-miner", now=None):
    """<producer>-<YYYYMMDDTHHMM>-<shortsha>, the time in IST (lab-viewer's schema example pairs run_id T1912 with created_at 19:12:03+05:30)."""
    ist = timezone(timedelta(hours=5, minutes=30))
    return f"{producer}-{(now or datetime.now(ist)).astimezone(ist).strftime('%Y%m%dT%H%M')}-{code_sha()}"

def selftest():
    utc = datetime(2026, 9, 24, 13, 5, tzinfo=timezone.utc)      # = 18:35 IST
    r = run_id(now=utc); assert re.fullmatch(r"hist-miner-20260924T1835-[0-9a-f]{7}", r), r
    assert run_id("hist-bulk", utc).startswith("hist-bulk-20260924T1835-")
    assert run_id(now=datetime(2026, 9, 24, 20, 0, tzinfo=timezone.utc)).startswith("hist-miner-20260925T0130-"), "crosses midnight in IST"
    print("selftest OK (offline): run_id shape", r)

if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest()
    elif len(sys.argv) > 1:
        p = stack_provenance(sys.argv[1]); u = p["units"]
        print(json.dumps({"router": p["router_url_port"], "node": p["node"], "router_version": p["router_version"], "whisper_model": p["whisper_model"], "indicconformer_id": p["indicconformer_id"], "sravaani_version": p["sravaani_version"],
                          "units": {r: {"active_since": v["active_since"], "git_rev": v["git_rev"], "config_sha256_16": v["config_sha256_16"], "files": {f: x["sha256_16"] for f, x in v["files"].items()}} for r, v in u.items()},
                          "whisper_node": (p["whisper"] or {}).get("node"), "whisper_units": {k: {"active_since": v["active_since"], "argv_head": v["argv"][:200], "files": v["files"], "model_file": v.get("model_file")} for k, v in ((p["whisper"] or {}).get("units") or {}).items()},
                          "missing": p["missing"]}, indent=1))
    else: print(__doc__)


# ---------------------------------------------------------------------------------------------------------------------------------------------------
# THE MINI (production stack; ruling 228, minibot #941/#955). Its stack description is published by minibot as an IMMUTABLE git file
# studies/2026-09-24-redundancy/stack_versions.mini-<stack_id>.json (same shape as the twin's). Trust rule is the twin's: a doc counts only if it is a blob COMMITTED on origin/main (read from the git objects),
# and the RUNNING Mini processes must agree with it: each script's sha256 8-hex prefix must appear in the doc, and each script file must be OLDER than the process that runs it (a stale-file check).
# Read-only over `ssh mini` (the lab sshd, herdr-kit #933): shasum, stat, ps, launchctl print, curl /healthz. NOTHING is run on the Mini until minibot posts 'Mini ready' (MINI_READY gate in run_window).
MINI_UNITS = {   # role -> (launchd label, script/binary path on the Mini), from minibot #941
    "whisper": ("uk.llmvinayminihome.whisper", "/Users/vinaybhardwaj/whisper.cpp/build/bin/whisper-server"),
    "shim": ("uk.llmvinayminihome.whisper-shim", "/Users/vinaybhardwaj/.local/bin/whisper-shim.py"),
    "indic": ("com.vinaybhardwaj.eta-indic", "/Users/vinaybhardwaj/eta-indic/indic_server.py"),
    "router": ("com.vinaybhardwaj.eta-router", "/Users/vinaybhardwaj/eta-router/router_server.py"),
}
MINI_SCRIPT = "\n".join(
    ['for spec in ' + " ".join(f'"{r}|{l}|{p}"' for r, (l, p) in MINI_UNITS.items()) + '; do',
     '  role=${spec%%|*}; rest=${spec#*|}; label=${rest%%|*}; path=${rest#*|}',
     '  sha=$(shasum -a 256 "$path" 2>/dev/null | cut -c1-64); mt=$(stat -f %m "$path" 2>/dev/null)',
     "  pid=$(launchctl print gui/$(id -u)/$label 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}')",
     '  st=""; [ -n "$pid" ] && st=$(ps -o lstart= -p "$pid" 2>/dev/null)',
     '  echo "UNIT|$role|$label|$sha|$mt|$pid|$st"',
     'done',
     'echo "HEALTH|$(curl -s -m 5 http://127.0.0.1:8083/healthz | head -c 500)"']) + "\n"

def parse_mini_output(text):
    """-> {'units': {role: {label, sha256, mtime, pid, started_at_epoch|None, older_than_process}}, 'router_healthz': dict|None}. Pure."""
    units, health = {}, None
    for line in text.splitlines():
        if line.startswith("UNIT|"):
            _, role, label, sha, mt, pid, st = (line.split("|", 6) + [""] * 7)[:7]
            ep = None
            if st.strip():
                try: ep = int(time.mktime(time.strptime(st.strip(), "%a %b %d %H:%M:%S %Y")))       # the Mini's local clock, read by the box in ITS timezone: only used for the file-vs-process ORDER check, and the box and Mini are both IST
                except Exception: ep = None
            units[role] = {"label": label, "sha256": sha or None, "mtime": int(mt) if mt.strip().isdigit() else None, "pid": pid or None, "started_at_epoch": ep,
                           "older_than_process": (int(mt) <= ep) if (mt.strip().isdigit() and ep) else None}
        elif line.startswith("HEALTH|"):
            try: health = json.loads(line[len("HEALTH|"):])
            except Exception: health = None
    return {"units": units, "router_healthz": health}

def collect_mini(ssh_alias="mini"):
    """Read-only. Returns parse_mini_output(...) + collected_at."""
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ssh_alias, "sh -s"], input=MINI_SCRIPT, capture_output=True, text=True, timeout=90)
    if r.returncode: raise RuntimeError(f"collect_mini ssh rc={r.returncode}")
    d = parse_mini_output(r.stdout); d["collected_at"] = datetime.now(timezone.utc).isoformat(); return d

def git_docs(dir_rel, name_regex):
    """[(git path, sha256 of the blob, parsed doc)] for every blob under dir_rel on origin/main whose file name matches name_regex. Local refs only."""
    repo = os.path.expanduser(os.environ.get("HIST_STACK_GIT_REPO", "~/dev/eta-lab")); ref = os.environ.get("HIST_STACK_GIT_REF", "origin/main"); out = []
    try:
        names = subprocess.run(["git", "-C", repo, "ls-tree", "--name-only", ref, dir_rel.rstrip("/") + "/"], capture_output=True, text=True, timeout=30).stdout.split()
        for n in names:
            if re.fullmatch(name_regex, os.path.basename(n)):
                b = subprocess.run(["git", "-C", repo, "show", f"{ref}:{n}"], capture_output=True, timeout=30).stdout
                if b:
                    try: out.append((n, hashlib.sha256(b).hexdigest(), json.loads(b)))
                    except ValueError: pass
    except Exception: pass
    return out

def published_mini_stack(live):
    """Pick the git-committed Mini stack doc that the RUNNING Mini agrees with. -> (doc, sha256, path, details) or (None, None, None, reason).
    Agreement = every collected script's sha256 8-hex prefix appears in the doc AND every script file is older than the process running it."""
    docs = git_docs(os.environ.get("HIST_MINI_STACK_DIR", "studies/2026-09-24-redundancy"), r"stack_versions\.mini-[A-Za-z0-9_.\-]+\.json")
    if not docs: return None, None, None, "no stack_versions.mini-*.json is committed on origin/main yet"
    units = (live or {}).get("units") or {}
    if not units: return None, None, None, "the Mini's running units could not be read"
    for path, sha, doc in sorted(docs, reverse=True):
        text = json.dumps(doc); det = {}
        for role, u in units.items():
            if u.get("sha256"): det[role] = {"in_doc": u["sha256"][:8] in text, "older_than_process": u.get("older_than_process")}
        if det and all(v["in_doc"] and v["older_than_process"] is not False for v in det.values()): return doc, sha, path, det
    return None, None, None, "no committed Mini stack doc agrees with the running processes (stack drift or a stale file)"
