#!/usr/bin/env python3
"""c4_build_stack.py — ORDERS-C4-STACK-2: assemble ~/eta-data/hist/stack_versions.c4.json ONLY from c4_measured-<date>.json (produced by c4_collect.py run ON e2e-c4, read-only).
No leaf is read from stack_versions.c3.json / .c4.DRAFT.json. Write-once (O_EXCL), mode 0600."""
import hashlib, json, os, sys
m = json.load(open(sys.argv[1])); out = sys.argv[2]
U = m["units"]; W = m["whisper"]; S = m["shim"]; ind = m["hf_snapshots"]["indic_conformer"]; sra = m["hf_snapshots"]["sravaani"]
rs0, rs1, i0, s0 = U["eta-router-s0"], U["eta-router-s1"], U["eta-indic-twin"], U["eta-sravaani-twin"]
assert rs0["served_file_sha256"] == rs1["served_file_sha256"] and i0["served_file_sha256"] == U["eta-indic-twin-s1"]["served_file_sha256"] and s0["served_file_sha256"] == U["eta-sravaani-twin-s1"]["served_file_sha256"]
a = W["argv"]; flag = lambda f: a[a.index(f) + 1] if f in a else None
stack = {
 "whisper": {"model": f"ggml-large-v3-turbo.bin sha256 {W['model_sha256']} (whisper.cpp {W['whispercpp_git_head']}, CPU build, whisper-server -t {flag('-t')}, binary sha256 {W['exe_sha256']}, on e2e-c4; production Metal)",
             "flags": {"vad": "off" if "--vad" not in a else "on", "temperature_inc": "0.2 (whisper.cpp default, not set in argv)", "no_speech_thold": flag("--no-speech-thold"), "suppress_nst": "true" if "--suppress-nst" in a else "false",
                       "max_context": "0 (set by the shim on every request unless the caller sends max_context; served shim source, 'if \"max_context\" not in other_fields')"}},
 "indic_conformer": {"model_id": f"{ind['repo']}@{ind['revision']} (rnnt, CPU, ONNX thread cap ORT_INTRA_THREADS={i0['env'].get('ORT_INTRA_THREADS')}, onnxruntime {i0['packages']['onnxruntime']}, torch {i0['packages']['torch']}, transformers {i0['packages']['transformers']})",
                     "git_head": f"no git repo on c4 (snapshot revision {ind['revision']}); running file indic_server.py sha256 {i0['served_file_sha256']}"},
 "sravaani": {"version": f"{sra['repo']}@{sra['revision']} (CPU torch {s0['packages']['torch']}, transformers {s0['packages']['transformers']}); running file sravaani_server.py sha256 {s0['served_file_sha256']}"},
 "router": {"commit": f"no git repo on c4; running file router_server.py sha256 {rs0['served_file_sha256']} (eta_number_words.py sha256 {rs0['eta_number_words.py_sha256']})",
            "config_sha256": rs0["unit_cat_sha256"]}}
guards = {
 "shim_anti_loop": f"whisper-shim served file {os.path.basename(S['served_file'])} sha256 {S['served_file_sha256']} (via the whisper-shim-twin unit; drop-ins {sorted(S['dropin_files'])}); unpatched whisper-shim.py on disk sha256 {S['whisper-shim.py_sha256 (unpatched copy on disk, not served)']}; number lexicon eta_number_words.json sha256 {S['eta_number_words.json_sha256']}",
 "english_hallucination_guard": f"inside router_server.py sha256 {rs0['served_file_sha256']} (1 reference, grep count measured on c4)",
 "transcript_guard": m["transcript-guard.ts"],
 "loop_guard_number_rule": "collapse_phrase_loops with the number lexicon runs inside the router (3 references in router_server.py) and the served shim (4 references), grep counts measured on c4; loop-guard 7258a90 itself is not identifiable on c4 (no git repo)"}
core = {"stack": stack, "guards": guards}
doc = {**core, "stack_id": hashlib.sha256(json.dumps(core, sort_keys=True).encode()).hexdigest()[:12], "collected_at": m["measured_at"],
 "host": f"eta-ci-c4 ({m['hostname']}, {m['private_ip'].strip()}): TWO packed stacks on {m['nproc']} vCPU + the c4 CPU whisper twin; measured ON c4 by c4_collect.py",
 "source": "studies/2026-09-24-hist-bulk c4_collect.py (backfill-now, ORDERS-C4-STACK-2): read-only live measurement over ssh e2e-c4 (/proc/<MainPID>/{cwd,exe,cmdline,environ}, systemctl show/cat, sha256 of every served file, importlib.metadata in each venv)",
 "missing_leaves": [], "per_leaf_non_null": True,
 "measured": {"kernel": m["kernel"], "os": m["os"], "ffmpeg_sha256": m["ffmpeg_sha256"], "ffprobe_sha256": m["ffprobe_sha256"], "whisper": W, "shim": S,
              "units": {u: {k: v for k, v in d.items()} for u, d in U.items()},
              "hf_snapshots": {k: {"repo": v["repo"], "revision": v["revision"], "n_files": v["n_files"], "files_sha256": v["files_sha256"]} for k, v in m["hf_snapshots"].items()},
              "sitecustomize_sha256": i0["sitecustomize_sha256"]},
 "ports": {"stack0": {"router": 8083, "indic": 8082, "sravaani": 8085}, "stack1": {"router": 8088, "indic": 8087, "sravaani": 8089}, "whisper_shim": 8081, "whisper_server": 8080,
           "note": "ports read from the units' argv/ETA_*_URL env in c4_measured"},
 "revision_note": "c4 rev1 (ORDERS-C4-STACK-2, 8 Oct 2026): every leaf measured on e2e-c4 itself; nothing copied from stack_versions.c3.json or the .c4.DRAFT file. Leaves not measurable on c4 (git commits, production shim sha, transcript-guard.ts) are stated as such, not copied."}
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f: json.dump(doc, f, indent=1, ensure_ascii=False)
print("wrote", out, hashlib.sha256(open(out, "rb").read()).hexdigest()[:16], "stack_id", doc["stack_id"])
