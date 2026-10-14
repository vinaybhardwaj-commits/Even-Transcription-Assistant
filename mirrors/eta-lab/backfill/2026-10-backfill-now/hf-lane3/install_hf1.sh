#!/bin/bash
# install_hf1.sh — HF-3: idempotent install of lane 3 into /data/lane3 on HF-1 (Space vrbeven/eta-hf-1, python3.10, no ffmpeg needed: PyAV bundles its libs). NO audio is touched.
# Layout: /data/lane3/{venv-indic,venv-sra,hf_home,audio,work,out,bin}. Two venvs because the two models were measured on c4 with different library sets (indic: transformers 5.12.0 + onnxruntime; SraVaani: transformers 4.57.6).
# Re-running is safe: venvs/pip/snapshots are reused. Models: OFFLINE FIRST (HF-3b): pinned snapshots staged into /data/lane3/hf_home are verified byte-for-byte and no token is read; only if they are missing does the fallback ask for a READ-ONLY fine-grained token in /data/lane3/.hf_ro_token (0600, never the account token).
set -euo pipefail
umask 077
L=${L3_ROOT:-/data/lane3}
mkdir -p "$L"/{hf_home,audio,work,out,bin,uv-python,uv-cache}
export UV_PYTHON_INSTALL_DIR="$L/uv-python" UV_CACHE_DIR="${UV_CACHE_DIR:-$L/uv-cache}"   # HF-3c: with L3_ROOT=<local disk> (stage_local.sh) the cache stays on /data (UV_CACHE_DIR), everything else is local
# HF-1 has python3.10, but onnxruntime 1.26.0 (indic) needs >=3.11 (pip says: versions stop at 1.23.2). c4's measured venvs use uv-managed 3.11 (indic) and 3.14 (SraVaani): same here.
if ! command -v uv >/dev/null 2>&1; then [ -x "$L/uvboot/bin/uv" ] || { python3 -m venv "$L/uvboot"; "$L/uvboot/bin/pip" install --quiet uv; }; export PATH="$L/uvboot/bin:$PATH"; fi
IDX=(--index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple --index-strategy unsafe-best-match)
mk() { n=$1; py=$2; shift 2; [ -x "$L/$n/bin/python" ] || uv venv --python "$py" "$L/$n"; uv pip install --quiet --python "$L/$n/bin/python" "${IDX[@]}" "$@"; }
mk venv-indic 3.11 torch==2.12.0 torchaudio onnxruntime==1.26.0 transformers==5.12.0 "numpy<2.3" soundfile av sentencepiece huggingface_hub
mk venv-sra   3.14 torch==2.14.0 transformers==4.57.6 huggingface_hub==0.36.2 numpy==2.5.3 soundfile av sentencepiece
for v in venv-indic venv-sra; do
  echo "== $v"; "$L/$v/bin/python" - <<'PYV'
import importlib.metadata as m, sys
print("python", sys.version.split()[0], {n: (m.version(n) if n in {d.metadata["Name"].lower() for d in m.distributions()} else None) for n in ("torch", "torchaudio", "onnxruntime", "transformers", "huggingface_hub", "numpy", "soundfile", "av", "sentencepiece")})
PYV
done
echo "cpu: $(nproc) vCPU; free: $(free -g | awk '/Mem/{print $2}') GB; disk $L: $(df -h "$L" | awk 'NR==2{print $4}') free"
# ---- models: OFFLINE FIRST (HF-3b). If the two pinned snapshots were staged into $L/hf_home (box: stage_snapshots.sh | ... tar -C $L/hf_home -xf -) and verify, nothing touches HF or any token.
JOB="$L/bin/lane3_cpu_job.py"; [ -f "$JOB" ] || { echo "STOP: copy lane3_cpu_job.py to $JOB first (the pins live in it)"; exit 4; }
check_offline() {   # $1 family  $2 venv ; exit 0 only if snapshot dir + code pins + FULL file manifest verify and the venv's huggingface_hub resolves it with local_files_only
  HF_HUB_OFFLINE=1 L3_OFFLINE=1 L3_ROOT="$L" FAM=$1 "$L/$2/bin/python" - <<'PYO'
import os, sys, json, importlib.util
L = os.environ["L3_ROOT"]; fam = os.environ["FAM"]
spec = importlib.util.spec_from_file_location("j", f"{L}/bin/lane3_cpu_job.py"); j = importlib.util.module_from_spec(spec); spec.loader.exec_module(j)
snap = j.snapshot_path(f"{L}/hf_home", fam)
if not os.path.isdir(snap): print(f"offline check {fam}: snapshot dir missing ({os.path.basename(snap)[:12]})"); sys.exit(1)
try:
    man = json.load(open(f"{L}/hf_home/lane3-pins/pinned_snapshots.json"))["families"][fam]
    if man["revision"] != j.MODELS[fam][1] or man["repo"] != j.MODELS[fam][0]: raise SystemExit("REFUSED: manifest is for another repo/revision")
    j.verify_snapshot(fam, snap); j.verify_manifest(snap, man["files"])
    from huggingface_hub import snapshot_download
    got = snapshot_download(j.MODELS[fam][0], revision=j.MODELS[fam][1], cache_dir=f"{L}/hf_home/hub", local_files_only=True)
    assert os.path.realpath(got) == os.path.realpath(snap)
except SystemExit as e: print(f"offline check {fam}: {e}"); sys.exit(1)
except Exception as e: print(f"offline check {fam}: {type(e).__name__}"); sys.exit(1)
print(f"snapshot {fam}: {j.MODELS[fam][0]}@{j.MODELS[fam][1][:12]} OFFLINE OK: {len(man['files'])} files byte-verified against the manifest, code pins OK, code_sha16 {j.code_sha16(fam)}")
PYO
}
if check_offline indic venv-indic && check_offline sravaani venv-sra; then
  echo "INSTALL-OK (snapshots verified OFFLINE; no token read, no HF call, no audio touched)"; exit 0
fi
echo "-- offline snapshots not complete/verified (see above): falling back to the TOKEN path"
TOK="$L/.hf_ro_token"
if [ ! -s "$TOK" ]; then
  echo "STOP: stage the pinned snapshots (preferred, no token: bash stage_snapshots.sh on the box, piped into 'tar -C $L/hf_home -xf -') OR, as fallback, create a READ-ONLY fine-grained HF token"
  echo "      (read access to the two gated public repos ai4bharat/indic-conformer-600m-multilingual and ARTPARK-IISc/SraVaani-1.0; nothing else), put it in $TOK (chmod 600), NEVER the account token, and re-run."; exit 3
fi
[ "$(stat -c %a "$TOK")" = "600" ] || { echo "REFUSED: $TOK must be mode 600"; exit 3; }
for fam in indic sravaani; do
  v=venv-indic; [ $fam = sravaani ] && v=venv-sra
  L3_ROOT="$L" FAM=$fam "$L/$v/bin/python" - <<'PYS'
import os, sys, importlib.util
L = os.environ["L3_ROOT"]; fam = os.environ["FAM"]
os.environ["HF_TOKEN"] = open(f"{L}/.hf_ro_token").read().strip()          # in-process only, never printed, never argv
spec = importlib.util.spec_from_file_location("j", f"{L}/bin/lane3_cpu_job.py"); j = importlib.util.module_from_spec(spec); spec.loader.exec_module(j)
from huggingface_hub import snapshot_download
repo, rev = j.MODELS[fam]; snap = snapshot_download(repo, revision=rev, cache_dir=f"{L}/hf_home/hub")
j.verify_snapshot(fam, snap)                                                  # pinned revision dir + sha256 of every pinned code/config file, or SystemExit
print(f"snapshot {fam}: {repo}@{rev} OK (token path); code files verified against the pins:", {k: v[:12] for k, v in j.CODE_PINS[fam].items()}, "code_sha16", j.code_sha16(fam))
PYS
done
echo "INSTALL-OK (token path; no audio touched)"
