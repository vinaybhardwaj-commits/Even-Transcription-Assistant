#!/usr/bin/env python3
"""Stack provenance for a one-stack lab CPU node whose whisper backend is another host (r371: voice-lab-1 -> eta-lab-l4 shim). Live over ssh, hashes/versions only.
Usage: make_node_stack_provenance.py NODE WHISPER_HOST OUT.json   (e.g. voice-lab-1 gcp-l4). Same schema as stack_versions.0b12949986df.json + differs_from_0b12949986df."""
import hashlib, json, os, subprocess, sys, time
NODE, WH, OUT = sys.argv[1:4]; D = os.path.dirname(os.path.abspath(__file__))
def run(h, c): return subprocess.run(["ssh", "-o", "BatchMode=yes", h, c], capture_output=True, text=True, timeout=120).stdout.strip()
def sha(h, p): return run(h, f"sha256sum {p} 2>/dev/null | cut -d' ' -f1") or None
ref = json.load(open(D + "/stack_provenance.json")); rc = ref["per_node"]["cpu"]["hist-cpu-1"]; rg = ref["per_node"]["gpu"]["hist-gpu-1"]
S = "~/services"
env = lambda u: sorted(l.split("=", 1)[1] for l in run(NODE, f"systemctl --user cat {u}").splitlines() if l.startswith("Environment="))
router_env = " ".join(env("eta-router-s0")).split(); indic_env = " ".join(env("eta-indic-twin") + env("eta-indic-twin.service.d/pin.conf" if False else "eta-indic-twin")).split()
dropin = run(NODE, "cat ~/.config/systemd/user/eta-indic-twin.service.d/pin.conf | grep Environment=").replace("Environment=", "")
cfg_lines = sorted(x for x in router_env if x.split("=")[0] in ("ETA_DEFAULT_CANDIDATES", "ETA_MAX_INFLIGHT", "ETA_TRANSLATE_ENGINE", "ETA_TRANSLATE_FALLBACK"))
cfg_hash = hashlib.sha256("\n".join(cfg_lines).encode()).hexdigest()[:12]
whisper_url = [x for x in router_env if x.startswith("ETA_WHISPER_URL=")][0]
pins = {"indic": run(NODE, f"{S}/eta-indic-twin/venv/bin/python -c 'import torch,onnxruntime,transformers;print(torch.__version__,onnxruntime.__version__,transformers.__version__)'"),
        "sravaani": run(NODE, f"{S}/eta-sravaani-twin/venv/bin/python -c 'import torch,transformers;print(torch.__version__,transformers.__version__)'"),
        "silero": run(NODE, f"{S}/eta-router-twin/venv/bin/python -c 'import silero_vad,importlib.metadata as m;print(m.version(\"silero-vad\"))'")}
irev = run(NODE, f"cat {S}/eta-indic-twin/hf-cache/models--ai4bharat--indic-conformer-600m-multilingual/refs/main"); srev = run(NODE, f"cat {S}/eta-sravaani-twin/hf-cache/models--ARTPARK-IISc--SraVaani-1.0/refs/main")
wflags = run(WH, "systemctl --user cat whisper-twin | grep ExecStart | sed 's#.*whisper-server ##; s#-m [^ ]*models/#-m #'"); wcommit = run(WH, f"cd {S}/whisper/src && git rev-parse --short=8 HEAD")
gpu = run(WH, "nvidia-smi --query-gpu=name --format=csv,noheader")
v = {"router": sha(NODE, f"{S}/eta-router-twin/router_server.py"), "indic": sha(NODE, f"{S}/eta-indic-twin/indic_server.py"), "sravaani": sha(NODE, f"{S}/eta-sravaani-twin/sravaani_server.py"),
     "shim": sha(WH, f"{S}/whisper-shim/whisper-shim.py"), "lex": sha(WH, f"{S}/whisper-shim/eta_number_words.json"), "wmodel": sha(WH, f"{S}/whisper/models/ggml-large-v3-turbo.bin"),
     "wbin": sha(WH, f"{S}/whisper/bin/whisper-server") or sha(WH, f"{S}/whisper/src/build/bin/whisper-server"), "cap": sha(NODE, f"{S}/eta-indic-twin/ortpatch/sitecustomize.py")}
missing = [k for k, x in {**v, "irev": irev, "srev": srev}.items() if not x]
diff = {}
def cmp(n, a, b): diff[n] = {"same": (a == b and b is not None), "this": a, "hist": b}
cmp("router_server.py sha256", v["router"], rc["router_server.py"]); cmp("indic_server.py sha256", v["indic"], rc["indic_server.py"]); cmp("sravaani_server.py sha256", v["sravaani"], rc["sravaani_server.py"])
cmp("whisper_shim.py sha256 (on the whisper host)", v["shim"], rg["whisper_shim.py"]); cmp("number lexicon sha256", v["lex"], rg["eta_number_words.json"]); cmp("whisper model sha256", v["wmodel"], rg["whisper_model"])
cmp("whisper-server binary sha256", v["wbin"], rg["whisper_server_binary"]); cmp("whisper.cpp commit", wcommit, rg["whisper_commit"]); cmp("whisper flags", wflags, rg["whisper_flags"])
cmp("indic packages", pins["indic"], rc["pins"]["indic_torch"]); cmp("sravaani packages", pins["sravaani"], rc["pins"]["sravaani_torch"]); cmp("silero-vad", pins["silero"], rc["pins"]["router_silero"])
cmp("indic HF rev", irev, ref["stack"]["indicconformer"]["revision"]); cmp("sravaani HF rev", srev, ref["stack"]["sravaani"]["revision"])
cmp("indic thread cap", " ".join(x for x in dropin.split() if x.startswith("ORT_INTRA")), rc["indic_units_env"].split()[-1] if rc["indic_units_env"] else "")
cmp("router config lines", cfg_lines, rc["router_config"]); cmp("sitecustomize thread-cap file sha256", v["cap"], rc["ort_thread_cap_sitecustomize.py"])
stack = {"whisper": {"model": f"ggml-large-v3-turbo.bin sha256 {v['wmodel']} (whisper.cpp {wcommit}, CUDA build on {gpu} on {WH}; production Metal)",
                     "flags": {"vad": "off", "temperature_inc": "0.2 (whisper.cpp default, not set)", "no_speech_thold": "0.7", "suppress_nst": "true", "max_context": "0 (set by the shim on every request)"}},
         "indic_conformer": {"model_id": f"ai4bharat/indic-conformer-600m-multilingual@{irev} (rnnt, CPU, ONNX thread cap {' '.join(x for x in dropin.split() if x.startswith('ORT_INTRA'))})",
                             "git_head": f"643e4e1 (production eta-indic); running file indic_server.py sha256 {v['indic']}"},
         "sravaani": {"version": f"ARTPARK-IISc/SraVaani-1.0@{srev} (CPU torch {pins['sravaani'].split()[0]}); running file sravaani_server.py sha256 {v['sravaani']}"},
         "router": {"commit": f"5e841f0 (eta-router); running file router_server.py sha256 {v['router']}", "config_sha256": hashlib.sha256("\n".join(cfg_lines).encode()).hexdigest()}}
guards = dict(json.load(open(D + "/stack_versions.0b12949986df.json"))["guards"])
guards["shim_anti_loop"] = f"whisper-shim twin file sha256 {v['shim']} (production shim sha256 aa9a7e4971779e4d5d7f7e3b8c913edc1d8497021a17f2e15d5391ab5012e02b, differs only in the bind address); number lexicon sha256 {v['lex']}"
guards["english_hallucination_guard"] = f"inside router_server.py sha256 {v['router']}"
sid = hashlib.sha256(json.dumps({"stack": stack, "guards": guards}, sort_keys=True).encode()).hexdigest()[:12]
out = {"stack": stack, "guards": guards, "stack_id": sid, "collected_at": time.strftime("%Y-%m-%dT%H:%M:%S+05:30"), "host": f"{NODE} (one packed stack, 16 vCPU), whisper backend {whisper_url} on {WH}",
       "source": "studies/2026-09-24-stt-parity/make_node_stack_provenance.py (lab-mover, live collection over ssh)", "missing_leaves": missing, "per_leaf_non_null": not missing,
       "differs_from_0b12949986df": {k: x for k, x in diff.items() if not x["same"]}, "same_as_0b12949986df": [k for k, x in diff.items() if x["same"]]}
json.dump(out, open(OUT, "w"), indent=1); os.chmod(OUT, 0o600)
print("stack_id", sid, "| non-null:", not missing, missing); print("DIFFERS:", list(out["differs_from_0b12949986df"])); print("SAME:", len(out["same_as_0b12949986df"]))
