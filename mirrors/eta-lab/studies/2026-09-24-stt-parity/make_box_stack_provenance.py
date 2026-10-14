#!/usr/bin/env python3
"""BOX twin stack provenance (r370 item 5, asked by hist-bulk #2149). Collected LIVE on the E2E box (systemd SYSTEM units eta-*-twin, whisper-twin, whisper-shim-twin),
same schema/leaf names as stack_versions.0b12949986df.json, its own stack_id. Adds `differs_from_0b12949986df` (per leaf, against the stored per-node
values in stack_provenance.json from the deleted hist nodes). Hashes/versions only, no secrets (the key FILE PATH is named, never its content).
Usage: make_box_stack_provenance.py OUT.json"""
import hashlib, json, os, subprocess, sys, time, glob
H = os.path.expanduser("~"); S = H + "/services"
def sha(p):
    p = os.path.expanduser(p)
    return hashlib.sha256(open(p, "rb").read()).hexdigest() if os.path.exists(p) else None
def run(c): return subprocess.run(c, shell=True, capture_output=True, text=True).stdout.strip()
def unit_env(u): return sorted(l.split("=", 1)[1] for l in run(f"systemctl cat {u}").splitlines() if l.startswith("Environment="))
ref = json.load(open(os.path.dirname(os.path.abspath(__file__)) + "/stack_provenance.json"))
rc = ref["per_node"]["cpu"]["hist-cpu-1"]; rg = ref["per_node"]["gpu"]["hist-gpu-1"]
router_env = unit_env("eta-router-twin"); indic_env = unit_env("eta-indic-twin")
cfg_lines = sorted(l for l in router_env if l.split("=")[0] in ("ETA_DEFAULT_CANDIDATES", "ETA_MAX_INFLIGHT", "ETA_TRANSLATE_ENGINE", "ETA_TRANSLATE_FALLBACK"))
cfg_hash = hashlib.sha256("\n".join(cfg_lines).encode()).hexdigest()[:12]
pins = {"indic": run(f"{S}/eta-indic-twin/venv/bin/python -c 'import torch,onnxruntime,transformers;print(torch.__version__,onnxruntime.__version__,transformers.__version__)'"),
        "sravaani": run(f"{S}/eta-sravaani-twin/venv/bin/python -c 'import torch,transformers;print(torch.__version__,transformers.__version__)'"),
        "silero": run(f"{S}/eta-router-twin/venv/bin/python -c 'import silero_vad,importlib.metadata as m;print(m.version(\"silero-vad\"))'")}
whisper_flags = run("systemctl cat whisper-twin | grep ExecStart | sed 's#.*whisper-server ##; s#-m [^ ]*models/#-m #'")
wcommit = run(f"cd {S}/whisper/src && git rev-parse --short=8 HEAD")
gpu = run("nvidia-smi --query-gpu=name,driver_version --format=csv,noheader")
vals = {"router_server.py": sha(S + "/eta-router-twin/router_server.py"), "indic_server.py": sha(S + "/eta-indic-twin/indic_server.py"),
        "sravaani_server.py": sha(S + "/eta-sravaani-twin/sravaani_server.py"), "whisper_shim.py": sha(S + "/whisper-shim/whisper-shim.py"),
        "eta_number_words.json": sha(S + "/whisper-shim/eta_number_words.json"), "whisper_model": sha(S + "/whisper/models/ggml-large-v3-turbo.bin"),
        "whisper_server_binary": sha(S + "/whisper/src/build/bin/whisper-server"), "ort_thread_cap_sitecustomize.py": sha(S + "/eta-indic-twin/ortpatch/sitecustomize.py")}
sr = glob.glob(S + "/eta-sravaani-twin/hf-cache/models--ARTPARK-IISc--SraVaani-1.0/refs/main"); ir = glob.glob(S + "/eta-indic-twin/hf-cache/models--ai4bharat--indic-conformer-600m-multilingual/refs/main")
srev = open(sr[0]).read().strip() if sr else None; irev = open(ir[0]).read().strip() if ir else None
missing = [k for k, v in {**vals, "sravaani_rev": srev, "indic_rev": irev}.items() if not v and k != "ort_thread_cap_sitecustomize.py"]
diff = {}
def cmp(name, box, hist): diff[name] = {"same": box == hist, "box": box, "hist": hist}
cmp("router_server.py sha256", vals["router_server.py"], rc["router_server.py"]); cmp("indic_server.py sha256", vals["indic_server.py"], rc["indic_server.py"])
cmp("sravaani_server.py sha256", vals["sravaani_server.py"], rc["sravaani_server.py"]); cmp("whisper_shim.py sha256", vals["whisper_shim.py"], rg["whisper_shim.py"])
cmp("eta_number_words.json sha256", vals["eta_number_words.json"], rg["eta_number_words.json"]); cmp("whisper model sha256", vals["whisper_model"], rg["whisper_model"])
cmp("whisper-server binary sha256 (built per host)", vals["whisper_server_binary"], rg["whisper_server_binary"]); cmp("whisper.cpp commit", wcommit, rg["whisper_commit"])
cmp("whisper server flags", whisper_flags, rg["whisper_flags"]); cmp("indic packages torch/onnxruntime/transformers", pins["indic"], rc["pins"]["indic_torch"])
cmp("sravaani packages torch/transformers", pins["sravaani"], rc["pins"]["sravaani_torch"]); cmp("silero-vad", pins["silero"], rc["pins"]["router_silero"])
cmp("indic HF revision", irev, ref["stack"]["indicconformer"]["revision"]); cmp("sravaani HF revision", srev, ref["stack"]["sravaani"]["revision"])
cmp("indic thread cap (units env)", " ".join(x for x in indic_env if x.startswith(("INDIC_DECODING", "ORT_INTRA"))), rc["indic_units_env"])
cmp("router config lines (excl. WHISPER_URL)", cfg_lines, rc["router_config"]); cmp("router config hash", cfg_hash, rc["router_config_hash_by_stack"]["0"])
cmp("sitecustomize thread-cap file present", vals["ort_thread_cap_sitecustomize.py"], rc["ort_thread_cap_sitecustomize.py"])
stack = {
 "whisper": {"model": f"ggml-large-v3-turbo.bin sha256 {vals['whisper_model']} (whisper.cpp {wcommit}, CUDA build on {gpu.split(',')[0]}; production Metal)",
             "flags": {"vad": "off", "temperature_inc": "0.2 (whisper.cpp default, not set)", "no_speech_thold": "0.7", "suppress_nst": "true", "max_context": "0 (set by the shim on every request)"}},
 "indic_conformer": {"model_id": f"ai4bharat/indic-conformer-600m-multilingual@{irev} (rnnt, CPU, ONNX; unit env: {' '.join(x for x in indic_env if x.startswith(('INDIC_DECODING','ORT_INTRA'))) or 'no ORT thread cap'})",
                     "git_head": f"643e4e1 (production eta-indic); running file indic_server.py sha256 {vals['indic_server.py']}"},
 "sravaani": {"version": f"ARTPARK-IISc/SraVaani-1.0@{srev} (CPU torch {pins['sravaani'].split()[0]}); running file sravaani_server.py sha256 {vals['sravaani_server.py']}"},
 "router": {"commit": f"5e841f0 (eta-router); running file router_server.py sha256 {vals['router_server.py']}", "config_sha256": hashlib.sha256("\n".join(cfg_lines).encode()).hexdigest()}}
guards = dict(json.load(open(os.path.dirname(os.path.abspath(__file__)) + "/stack_versions.0b12949986df.json"))["guards"])
guards["shim_anti_loop"] = f"whisper-shim twin file sha256 {vals['whisper_shim.py']} (production shim sha256 aa9a7e4971779e4d5d7f7e3b8c913edc1d8497021a17f2e15d5391ab5012e02b, differs only in the bind address); number lexicon sha256 {vals['eta_number_words.json']}"
guards["english_hallucination_guard"] = f"inside router_server.py sha256 {vals['router_server.py']}"
sid = hashlib.sha256(json.dumps({"stack": stack, "guards": guards}, sort_keys=True).encode()).hexdigest()[:12]
out = {"stack": stack, "guards": guards, "stack_id": sid, "collected_at": time.strftime("%Y-%m-%dT%H:%M:%S+05:30"), "host": "eta-lab-t4 (E2E box), systemd system units eta-*-twin/whisper-*-twin",
       "source": "studies/2026-09-24-stt-parity/make_box_stack_provenance.py (lab-mover, live collection on the box)", "missing_leaves": missing, "per_leaf_non_null": not missing,
       "router_env_lines_shown": cfg_lines, "router_translate_note": "box router unit sets ETA_TRANSLATE_ENGINE/FALLBACK and a key FILE PATH; irrelevant to output when the request uses translate=false (the HIST request shape)",
       "differs_from_0b12949986df": {k: v for k, v in diff.items() if not v["same"]}, "same_as_0b12949986df": [k for k, v in diff.items() if v["same"]]}
json.dump(out, open(sys.argv[1], "w"), indent=1); os.chmod(sys.argv[1], 0o600)
print("box stack_id", sid, "| per-leaf non-null:", not missing, missing); print("DIFFERS:", list(out["differs_from_0b12949986df"])); print("SAME:", len(out["same_as_0b12949986df"]))
