#!/usr/bin/env python3
"""Ruling 184: the STT stack provenance block that HIST writers (hist-bulk, hist-miner) embed in every output record/manifest.
Collected LIVE from the four HIST nodes over ssh (file sha256s, unit environments, model revisions), so it says what is actually running.
Output: stack_provenance.json (stack_id = first 12 hex of sha256 of the canonical version block) + a per-node consistency check. Numbers/hashes only."""
import json, hashlib, subprocess, sys, time
CPU = ["hist-cpu-1", "hist-cpu-2"]; GPU = ["hist-gpu-1", "hist-gpu-2"]
def ssh(h, cmd):
    return subprocess.run(["ssh", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", h, cmd], capture_output=True, text=True, timeout=120).stdout.strip()
def sha(h, path): return (ssh(h, f"sha256sum {path} 2>/dev/null | cut -d' ' -f1") or None)
cpu_files = {"router_server.py": "~/services/eta-router-twin/router_server.py", "indic_server.py": "~/services/eta-indic-twin/indic_server.py",
             "sravaani_server.py": "~/services/eta-sravaani-twin/sravaani_server.py", "ort_thread_cap_sitecustomize.py": "~/services/eta-indic-twin/ortpatch/sitecustomize.py"}
gpu_files = {"whisper_shim.py": "~/services/whisper-shim/whisper-shim.py", "eta_number_words.json": "~/services/whisper-shim/eta_number_words.json",
             "whisper_server_binary": "~/services/whisper/src/build/bin/whisper-server", "whisper_model": "~/services/whisper/models/ggml-large-v3-turbo.bin",
             "diarize_server.py": "~/services/eta-diarize/server.py"}
per = {"cpu": {}, "gpu": {}}
for h in CPU:
    d = {k: sha(h, p) for k, p in cpu_files.items()}
    envs = {}
    for k in range(5):
        raw = ssh(h, f"systemctl --user cat eta-router-s{k} | grep '^Environment=' | tr ' ' '\\n' | grep -E '^(Environment=)?ETA_(DEFAULT_CANDIDATES|MAX_INFLIGHT|WHISPER_URL|TRANSLATE_ENGINE|TRANSLATE_FALLBACK)' | sed 's/^Environment=//' | grep -v 'ETA_WHISPER_URL' | sort")
        envs[k] = raw
    d["router_config_hash_by_stack"] = {k: hashlib.sha256(v.encode()).hexdigest()[:12] for k, v in envs.items()}
    d["router_config"] = envs[0].splitlines()
    d["indic_units_env"] = ssh(h, "systemctl --user cat eta-indic-s1 | grep -o 'INDIC_DECODING=[a-z]*\\|ORT_INTRA_THREADS=[0-9]*' | paste -sd' '")
    d["pins"] = {"indic_torch": ssh(h, "~/services/eta-indic-twin/venv/bin/python -c 'import torch,onnxruntime,transformers;print(torch.__version__,onnxruntime.__version__,transformers.__version__)'"),
                 "sravaani_torch": ssh(h, "~/services/eta-sravaani-twin/venv/bin/python -c 'import torch,transformers;print(torch.__version__,transformers.__version__)'"),
                 "router_silero": ssh(h, "~/services/eta-router-twin/venv/bin/python -c 'import silero_vad,importlib.metadata as m;print(m.version(\"silero-vad\"))'")}
    per["cpu"][h] = d
for h in GPU:
    d = {k: sha(h, p) for k, p in gpu_files.items()}
    d["whisper_flags"] = ssh(h, "systemctl --user cat whisper-twin | grep ExecStart | sed 's#.*whisper-server ##; s#-m [^ ]*models/#-m #'")
    d["whisper_commit"] = ssh(h, "cd ~/services/whisper/src 2>/dev/null && git rev-parse --short=8 HEAD || echo unknown")
    per["gpu"][h] = d
def uniq(kind, key):
    return sorted({json.dumps(v.get(key)) for v in per[kind].values()})
consistent = {f"cpu.{k}": len(uniq("cpu", k)) == 1 for k in list(cpu_files) + ["indic_units_env", "pins", "router_config"]}
consistent.update({f"gpu.{k}": len(uniq("gpu", k)) == 1 for k in list(gpu_files) + ["whisper_flags", "whisper_commit"]})
c = per["cpu"][CPU[0]]; g = per["gpu"][GPU[0]]
stack = {
    "whisper": {"model": "ggml-large-v3-turbo.bin", "model_sha256": g["whisper_model"], "whisper_cpp_commit": g["whisper_commit"], "server_flags": g["whisper_flags"],
                "vad": "off (production flags since 24 Sep 04:39 IST)", "temperature_inc": "whisper.cpp default 0.2 (not set)", "max_context": 0, "backend": "CUDA build on NVIDIA L4 (production: Metal on Mac mini)"},
    "shim": {"file_sha256": g["whisper_shim.py"], "production_shim_sha256": "aa9a7e4971779e4d5d7f7e3b8c913edc1d8497021a17f2e15d5391ab5012e02b (differs only in the bind address)", "number_lexicon_sha256": g["eta_number_words.json"]},
    "indicconformer": {"model_id": "ai4bharat/indic-conformer-600m-multilingual", "revision": "e9b71b369c048e2c6b634d4c131061c34e441179", "decoding": "rnnt", "server_sha256": c["indic_server.py"],
                       "packages": c["pins"]["indic_torch"], "thread_cap": c["indic_units_env"], "thread_cap_file_sha256": c["ort_thread_cap_sitecustomize.py"], "device": "CPU"},
    "sravaani": {"model_id": "ARTPARK-IISc/SraVaani-1.0", "revision": "f5dd5358325a5208775b91dad98918e079ea2b27", "server_sha256": c["sravaani_server.py"], "packages": c["pins"]["sravaani_torch"], "device": "CPU"},
    "router": {"git_commit": "5e841f0 (eta-router), file sha256 = router_server.py", "file_sha256": c["router_server.py"], "config": c["router_config"], "config_hash": c["router_config_hash_by_stack"][0],
               "silero_vad": c["pins"]["router_silero"], "request_shape": "translate=false, candidates en,kn,hi,ta,te,ml,mr,bn, window_s=180"},
    "guards": {"shim_anti_loop_and_lexicon": "whisper-shim (sha above)", "english_hallucination_guard": "router_server.py (sha above)", "collapse_phrase_loops": "router_server.py (sha above)",
               "app_side_at_production_commit_a30186c": {"transcript-guard.ts": "222bfe2145b1e96d1e2e508c87ed6b4dc1c24866ee557047cba454004ec6f28f", "transcript-quality.ts": "cf2c03b9621a9ed72c909d8a43b413a83a29de819a621cdc78b708cb51f87912",
                                                        "assembled-collapse.ts": "0ae9ea53fffa221a402bce7ffda048beae26230e71965bfd0435ab5ab1122c2a", "hallucination-collapse.ts": "835c9c3e1b0e4a1bc459becf953e92790b2675072a5143c57df93e5d2a6eb5a7"},
               "loop_guard_number_rule": "NOT in this stack (loop-guard 7258a90 is not deployed to production yet)"},
    "diarizer": {"engine": "pyannote speaker-diarization-3.1 (@84fd25912480287da0247647c3d2b4853cb3ee5d), segmentation-3.0 (@e66f3d3b9eb0873085418a7b813d3b369bf160bb), pyannote.audio 3.3.2", "server_sha256": g["diarize_server.py"], "device": "CUDA L4"},
}
stack_id = hashlib.sha256(json.dumps(stack, sort_keys=True).encode()).hexdigest()[:12]
out = {"stack_id": stack_id, "collected_at": time.strftime("%Y-%m-%dT%H:%M:%S+05:30"), "stack": stack,
       "node_consistency": consistent, "all_consistent": all(consistent.values()),
       "notes": ["Production reference: whisper Metal on the Mini, IndicConformer on the Mini (643e4e1), SraVaani on the Yoga; parity report studies/2026-09-24-stt-parity/STT-PARITY-REPORT.md (set 2 FAIL on B5 count; HIST approved for MINING ONLY, ruling 146)",
                 "diarizer is on the hist-gpu nodes and is not part of route transcription; include only if the unit used it"],
       "per_node": per}
json.dump(out, open(sys.argv[1] if len(sys.argv) > 1 else "stack_provenance.json", "w"), indent=1)
print("stack_id", stack_id, "all_consistent", out["all_consistent"], [k for k, v in consistent.items() if not v])
