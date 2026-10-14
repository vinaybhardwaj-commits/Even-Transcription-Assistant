# READ-ONLY measurement on e2e-ci (runs there, stdin). No audio, no writes, no service touched. Output: JSON only (shas, versions, paths).
import os, subprocess, hashlib, json, glob, time
H = os.path.expanduser("~")
def sh(c, t=120):
    r = subprocess.run(["bash", "-lc", c], capture_output=True, text=True, timeout=t); return r.stdout.strip()
def sha(p):
    p = os.path.realpath(p); h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 22), b""): h.update(b)
    return h.hexdigest()
def shas(s): return hashlib.sha256(s.encode()).hexdigest()
out = {"measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "hostname": sh("hostname"), "private_ip": sh("ip -4 -o addr show scope global | awk '{print $4}' | head -2 | tr '\\n' ' '"), "public_ip_note": "not measured from the node itself",
       "nproc": sh("nproc"), "kernel": sh("uname -r"), "os": sh("grep PRETTY_NAME /etc/os-release | cut -d= -f2"), "units": {}}
WL = ("ETA_", "ORT_", "OMP_", "MKL_", "HF_HUB_OFFLINE", "HF_HOME", "HF_HUB_CACHE")
def proc(pid):
    cwd = os.readlink(f"/proc/{pid}/cwd"); argv = open(f"/proc/{pid}/cmdline").read().split("\0")[:-1]
    env = dict(x.split("=", 1) for x in open(f"/proc/{pid}/environ").read().split("\0") if "=" in x)
    keep = {k: v for k, v in env.items() if k.startswith(WL) and "TOKEN" not in k and "KEY" not in k}
    keep["PATH_has_services_bin"] = "services/bin" in env.get("PATH", "")
    return cwd, argv, keep
def pkgs(venv_py, names):
    code = "import importlib.metadata as m,json;o={}\nfor n in %r:\n  try:o[n]=m.version(n)\n  except Exception:o[n]=None\nprint(json.dumps(o))" % (names,)
    r = subprocess.run([venv_py, "-c", code], capture_output=True, text=True); return json.loads(r.stdout) if r.returncode == 0 else {"error": r.stderr[-120:]}
for u in ("eta-router-s0", "eta-router-s1", "eta-indic-twin", "eta-indic-twin-s1", "eta-sravaani-twin", "eta-sravaani-twin-s1"):
    pid = int(sh(f"systemctl --user show {u} -p MainPID --value")); cwd, argv, env = proc(pid); cat = sh(f"systemctl --user cat {u}")
    d = {"main_pid": pid, "active_since": sh(f"systemctl --user show {u} -p ActiveEnterTimestamp --value"), "unit_cat_sha256": shas(cat), "cwd": cwd, "argv": argv, "env": env, "interpreter_exe": os.path.realpath(f"/proc/{pid}/exe")}
    pyfile = {"eta-router": "router_server.py", "eta-indic": "indic_server.py", "eta-sravaani": "sravaani_server.py"}[u.rsplit("-", 1)[0] if u.endswith(("-s0", "-s1")) and u.startswith("eta-router") else u.replace("-s1", "").replace("-twin", "")]
    d["served_file"] = os.path.join(cwd, pyfile); d["served_file_sha256"] = sha(d["served_file"])
    if u.startswith("eta-router"):
        d["eta_number_words.py_sha256"] = sha(os.path.join(cwd, "eta_number_words.py"))
        d["packages"] = pkgs(argv[0], ["torch", "onnxruntime", "numpy", "fastapi", "uvicorn", "starlette", "httpx", "requests", "soundfile", "silero-vad", "pydantic"])
    elif u.startswith("eta-indic"):
        d["packages"] = pkgs(argv[0], ["torch", "onnxruntime", "numpy", "transformers", "huggingface_hub", "soundfile", "torchaudio", "fastapi", "uvicorn", "sentencepiece"])
        d["sitecustomize_sha256"] = sha(os.path.join(cwd, "ortpatch/sitecustomize.py"))
    else:
        d["packages"] = pkgs(argv[0], ["torch", "numpy", "transformers", "huggingface_hub", "soundfile", "torchaudio", "fastapi", "uvicorn", "sentencepiece"])
    out["units"][u] = d
# HF snapshots: sha256 of every file actually in the snapshot dirs the indic/sravaani units read
out["hf_snapshots"] = {}
for name, root in (("indic_conformer", f"{H}/services/eta-indic-twin/hf-cache"), ("sravaani", f"{H}/services/eta-sravaani-twin/hf-cache")):
    for snap in sorted(glob.glob(f"{root}/models--*/snapshots/*")):
        files = {}
        for dp, _, fns in os.walk(snap):
            for fn in sorted(fns):
                p = os.path.join(dp, fn); files[os.path.relpath(p, snap)] = sha(p)
        out["hf_snapshots"][name] = {"repo": snap.split("models--")[1].split("/")[0].replace("--", "/"), "revision": os.path.basename(snap), "n_files": len(files), "files_sha256": files}
# whisper
wp = int(sh("systemctl show whisper-twin -p MainPID --value")); cwd, argv, env = proc(wp); mi = argv.index("-m")
out["whisper"] = {"main_pid": wp, "argv": argv, "exe_sha256": sha(f"/proc/{wp}/exe"), "model_path": argv[mi + 1], "model_sha256": sha(argv[mi + 1]), "unit_cat_sha256": shas(sh("systemctl cat whisper-twin")),
                  "whispercpp_git_head": sh(f"git -C {H}/services/whisper/src rev-parse --short=8 HEAD"), "build_sh_sha256": sha(f"{H}/services/whisper/build.sh")}
sp = int(sh("systemctl show whisper-shim-twin -p MainPID --value")); cwd, argv, env = proc(sp)
out["shim"] = {"main_pid": sp, "argv": argv, "served_file": os.path.realpath(argv[1] if len(argv) > 1 else ""), "served_file_sha256": sha(argv[1]), "unit_cat_sha256": shas(sh("systemctl cat whisper-shim-twin")),
               "dropin_files": {os.path.basename(p): sha(p) for p in glob.glob("/etc/systemd/system/whisper-shim-twin.service.d/*")}, "eta_number_words.json_sha256": sha(f"{H}/services/whisper-shim/eta_number_words.json"),
               "whisper-shim.py_sha256 (unpatched copy on disk, not served)": sha(f"{H}/services/whisper-shim/whisper-shim.py"), "mini-original_sha256 (on disk, not served)": sha(f"{H}/services/whisper-shim/whisper-shim.py.mini-original")}
out["ffmpeg_sha256"] = sha(f"{H}/services/bin/ffmpeg"); out["ffprobe_sha256"] = sha(f"{H}/services/bin/ffprobe")
out["transcript-guard.ts"] = "not measured on c3 (production source file; not executed by the HIST route path; recursive home search skipped: ~/eta-data-ro is a large read mount)"
print(json.dumps(out))
