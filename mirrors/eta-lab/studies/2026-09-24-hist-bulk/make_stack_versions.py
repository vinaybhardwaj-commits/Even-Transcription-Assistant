#!/usr/bin/env python3
"""make_stack_versions.py — map lab-mover's stack_provenance.json (eta-lab 73869b4, stack_id 0b12949986df) onto lab-viewer's schema-v1 leaves -> ~/eta-data/hist/stack_versions.json (0600).
Nothing is invented: every value is copied from lab-mover's file. Where the schema's leaf name does not match what lab-mover measured, the value states what it is (e.g. HF revision + server sha256).
Read from git (origin/main), so the shared checkout is not touched."""
import json, os, subprocess
COMMIT = "73869b4"
src = json.loads(subprocess.run(["git", "-C", os.path.expanduser("~/dev/eta-lab"), "show", f"{COMMIT}:studies/2026-09-24-stt-parity/stack_provenance.json"], capture_output=True, text=True, check=True).stdout)
s = src["stack"]; w, ic, sv, r, g = s["whisper"], s["indicconformer"], s["sravaani"], s["router"], s["guards"]; app = g["app_side_at_production_commit_a30186c"]
out = {"source": f"lab-mover studies/2026-09-24-stt-parity/stack_provenance.json @ eta-lab {COMMIT}", "collected_at": src["collected_at"], "all_consistent": src["all_consistent"],
 "stack": {
  "stack_id": src["stack_id"],
  "whisper": {"model": f"{w['model']} sha256 {w['model_sha256']} (whisper.cpp {w['whisper_cpp_commit']}, {w['backend']})",
              "flags": {"vad": w["vad"], "temperature_inc": w["temperature_inc"], "no_speech_thold": 0.7, "suppress_nst": True, "max_context": w["max_context"], "server_flags": w["server_flags"]}},
  "indic_conformer": {"model_id": ic["model_id"], "git_head": f"HF revision {ic['revision']}; eta-indic server sha256 {ic['server_sha256']}; decoding {ic['decoding']}; {ic['thread_cap']}; {ic['device']}"},
  "sravaani": {"version": f"{sv['model_id']} HF revision {sv['revision']}; server sha256 {sv['server_sha256']}; {sv['device']}"},
  "router": {"commit": r["git_commit"], "config_sha256": f"config_hash {r['config_hash']} (lab-mover's 12-hex hash of {'; '.join(r['config'])}); router_server.py sha256 {r['file_sha256']}"}},
 "guards": {
  "shim_anti_loop": f"whisper-shim sha256 {s['shim']['file_sha256']} (number lexicon sha256 {s['shim']['number_lexicon_sha256']})",
  "english_hallucination_guard": f"router_server.py sha256 {r['file_sha256']} (also collapse_phrase_loops)",
  "transcript_guard": f"lib/stt at production commit a30186c: transcript-guard.ts sha256 {app['transcript-guard.ts']}; transcript-quality.ts {app['transcript-quality.ts']}; hallucination-collapse.ts {app['hallucination-collapse.ts']}. NOTE: hist windows apply only assembled-collapse.ts ({app['assembled-collapse.ts']}, pinned prod 5970852 in run_window), not the other app-side guards",
  "loop_guard_number_rule": g["loop_guard_number_rule"]}}
p = os.path.expanduser("~/eta-data/hist/stack_versions.hist-bulk-draft.json"); open(p, "w").write(json.dumps(out, indent=1)); os.chmod(p, 0o600); print("wrote", p, "stack_id", src["stack_id"])
