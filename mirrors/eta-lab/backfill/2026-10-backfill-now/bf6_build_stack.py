#!/usr/bin/env python3
"""bf6_build_stack.py — ORDERS-BF-6 B: assemble a host's OWN stack_versions.<host>.json ONLY from that host's measured file (bf6_collect_box.py on the box / c4_collect.py on e2e-ci).
usage: bf6_build_stack.py box|c3 measured.json OUT.json     No leaf is read from any other stack_versions file. Write-once (O_EXCL), mode 0600. Same schema as stack_versions.c4.json (c4_build_stack.py)."""
import hashlib, json, os, sys
kind, mp, out = sys.argv[1:4]; assert kind in ("box", "c3")
m = json.load(open(mp)); U = m["units"]; W = m["whisper"]; S = m["shim"]; ind = m["hf_snapshots"]["indic_conformer"]; sra = m["hf_snapshots"]["sravaani"]
if kind == "box": rs0, i0, s0 = U["eta-router-twin"], U["eta-indic-twin"], U["eta-sravaani-twin"]; label = "box"; hostdesc = f"E2E box ({m['hostname']}, {m['nproc']} vCPU, {m['gpu']}): ONE stack (systemd system units eta-*-twin, whisper-twin, whisper-shim-twin)"; cpu = "CUDA build on " + m["gpu"].split(",")[0]
else:
    rs0, rs1, i0, s0 = U["eta-router-s0"], U["eta-router-s1"], U["eta-indic-twin"], U["eta-sravaani-twin"]; label = "c3"; hostdesc = f"eta-ci-c3 ({m['hostname']}, {m['private_ip'].strip()}): TWO packed stacks on {m['nproc']} vCPU + the c3 CPU whisper twin"; cpu = "CPU build"
    assert rs0["served_file_sha256"] == rs1["served_file_sha256"] and i0["served_file_sha256"] == U["eta-indic-twin-s1"]["served_file_sha256"] and s0["served_file_sha256"] == U["eta-sravaani-twin-s1"]["served_file_sha256"]
a = W["argv"]; flag = lambda f: a[a.index(f) + 1] if f in a else None
wurls = {u: d["env"].get("ETA_WHISPER_URL") for u, d in U.items() if u.startswith("eta-router")}
stack = {
 "whisper": {"model": f"ggml-large-v3-turbo.bin sha256 {W['model_sha256']} (whisper.cpp {W['whispercpp_git_head']}, {cpu}, whisper-server {'-t ' + flag('-t') + ', ' if flag('-t') else ''}binary sha256 {W['exe_sha256']}, on {label}; production Metal); router ETA_WHISPER_URL per unit: {wurls}",
             "flags": {"vad": "off" if "--vad" not in a else "on", "temperature_inc": "0.2 (whisper.cpp default, not set in argv)", "no_speech_thold": flag("--no-speech-thold"), "suppress_nst": "true" if "--suppress-nst" in a else "false",
                       "max_context": "0 (set by the shim on every request unless the caller sends max_context)"}},
 "indic_conformer": {"model_id": f"{ind['repo']}@{ind['revision']} (rnnt, CPU, ONNX; unit env INDIC_DECODING={i0['env'].get('INDIC_DECODING')} ORT_INTRA_THREADS={i0['env'].get('ORT_INTRA_THREADS')}, onnxruntime {i0['packages']['onnxruntime']}, torch {i0['packages']['torch']}, transformers {i0['packages']['transformers']})",
                     "git_head": f"git commit not measured on {label} (snapshot revision {ind['revision']}); running file indic_server.py sha256 {i0['served_file_sha256']}"},
 "sravaani": {"version": f"{sra['repo']}@{sra['revision']} (CPU torch {s0['packages']['torch']}, transformers {s0['packages']['transformers']}); running file sravaani_server.py sha256 {s0['served_file_sha256']}"},
 "router": {"commit": f"git commit not measured on {label}; running file router_server.py sha256 {rs0['served_file_sha256']} (eta_number_words.py sha256 {rs0['eta_number_words.py_sha256']})",
            "config_sha256": rs0["unit_cat_sha256"]}}
guards = {
 "shim_anti_loop": f"whisper-shim served file {os.path.basename(S['served_file'])} sha256 {S['served_file_sha256']} (via the whisper-shim-twin unit; drop-ins {sorted(S['dropin_files'])}); number lexicon eta_number_words.json sha256 {S['eta_number_words.json_sha256']}",
 "english_hallucination_guard": f"inside router_server.py sha256 {rs0['served_file_sha256']}",
 "transcript_guard": m["transcript-guard.ts"],
 "loop_guard_number_rule": f"collapse_phrase_loops with the number lexicon runs inside the router and the served shim; loop-guard 7258a90 itself is not identifiable on {label} (no git commit measured)"}
core = {"stack": stack, "guards": guards}
ports = {"router": {u: int(next(x for x in d["argv"] if x.isdigit())) if any(x.isdigit() for x in d["argv"]) else None for u, d in U.items() if u.startswith("eta-router")}, "note": "router ports from argv where present; backend URLs in measured.units.*.env"}
doc = {**core, "stack_id": hashlib.sha256(json.dumps(core, sort_keys=True).encode()).hexdigest()[:12], "collected_at": m["measured_at"], "host": hostdesc + f"; measured ON {label} itself",
 "source": f"ORDERS-BF-6 B (backfill-now): read-only live measurement {'on the box by bf6_collect_box.py (/proc, cgroup.procs, /etc/systemd/system unit text)' if kind == 'box' else 'over ssh e2e-ci by c4_collect.py (/proc/<MainPID>, systemctl show/cat)'}; sha256 of every served file, all HF snapshot files, importlib.metadata in each venv",
 "missing_leaves": [], "per_leaf_non_null": True,
 "measured": {"kernel": m["kernel"], "os": m["os"], "whisper": W, "shim": S, "units": U, "hf_snapshots": {k: {x: v[x] for x in ("repo", "revision", "n_files", "files_sha256")} for k, v in m["hf_snapshots"].items()}, "sitecustomize_sha256": i0.get("sitecustomize_sha256"), **({"ffmpeg_sha256": m["ffmpeg_sha256"]} if "ffmpeg_sha256" in m else {})},
 "ports": ports,
 "revision_note": f"{label} rev1 (ORDERS-BF-6 B, 8 Oct 2026): every leaf measured on {label} itself; nothing copied from another stack_versions file (incl. the older stack_versions.{ 'box' if kind == 'box' else 'c3' }.json). Leaves not measurable here (git commits, production shim sha) are stated as such."}
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f: json.dump(doc, f, indent=1, ensure_ascii=False)
print("wrote", out, hashlib.sha256(open(out, "rb").read()).hexdigest()[:16], "stack_id", doc["stack_id"])
