#!/usr/bin/env python3
"""ETA-internal. Writes eta-freescript-v1.0/HANDOFF-INDEX.md: sha256 of every bundle file, the excluded list and the
privacy sweep summary (patterns S11/S12 are described, not listed, so the index itself names nothing internal)."""
import hashlib, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
B = os.path.join(HERE, "..", "eta-freescript-v1.0")
ORDER = ["README-FOR-PULSE.md", "CHANGELOG-v0.1-to-v1.0.md", "eta-freescript-artifact.v1.0.schema.json", "validate_artifact.py", "run_checks.sh"]
files = []
for root, dirs, fs in os.walk(B):
    dirs[:] = [d for d in dirs if d != "__pycache__"]
    files += [os.path.relpath(os.path.join(root, f), B) for f in fs]
files = [f for f in files if f != "HANDOFF-INDEX.md"]
files.sort(key=lambda p: (ORDER.index(p) if p in ORDER else 10 + p.startswith("examples/") + 2 * p.startswith("tests/"), p))
sweep = subprocess.run([sys.executable, os.path.join(HERE, "privacy_sweep.py"), B], capture_output=True, text=True)
counts = {l.split()[0] + " " + l.split()[1]: l.split()[2] for l in sweep.stdout.splitlines() if l.startswith("S")}
rows = "\n".join("| %s | %d | `%s` |" % (p, os.path.getsize(os.path.join(B, p)), hashlib.sha256(open(os.path.join(B, p), "rb").read()).hexdigest()) for p in files)
n_mut = sum(p.startswith("tests/mutants/") for p in files)
c = lambda k: counts.get(k, "?")
doc = f"""# HANDOFF-INDEX: eta.freescript.v1.0

Bundle: `handoff/eta-freescript-v1.0/` ({len(files) + 1} files including this index). Schema version `eta.freescript.v1.0`, superseding `eta.freescript.v0.1` (29 Sep). Built 17 Oct 2026, fix round 1. Every artifact in the bundle is invented; no real patient, doctor, room, encounter or Pulse id appears.

## Files and sha256

This index cannot hash itself, so it is not listed. Verify with `sha256sum <file>` from the bundle folder. Every file here is for Pulse.

| File | Bytes | sha256 |
|---|---|---|
{rows}

## Excluded

| Excluded | Why |
|---|---|
| Any real artifact, transcript, audio, span quote or note | Patient and doctor data. The bundle is synthetic only. |
| Any real `pulse_link` id (individual, hospital, consult, prescription, doctor uid) | Every id in the examples is null or an all-zero placeholder. |
| Review scores, cohort metrics and PDQI-9 results from real consults | Not for the Pulse-facing bundle. |
| The generator code, its prompts and its run outputs | Not part of the contract; Pulse needs only the artifact shape and the validator. |
| Real model, STT and MT names and provider details | Examples use invented `example-*` names. |
| ETA's design rationale and its sweep word list | ETA-internal; kept outside this folder. |
| `__pycache__/` and other build leftovers | `run_checks.sh` sets `PYTHONDONTWRITEBYTECODE=1`. |

## Privacy sweep

Twelve patterns were run over every file in this folder, including all {n_mut} mutants. A hit passes only if it is one of the allowed placeholders below; the sweep found {sweep.stdout.strip().splitlines()[-1].split(': ')[1]} unexplained hits.

| Sweep | What it looks for | Hits | Explanation |
|---|---|---|---|
| S1 | email addresses | {c('S1 email')} | none |
| S2 | Indian phone numbers | {c('S2 phone')} | none |
| S3 | UUIDs | {c('S3 uuid')} | only the seven invented ids `00000000-0000-4000-8000-00000000000N` (N = 1 to 7), one per example and per mutant |
| S4 | runs of 10+ digits | {c('S4 digits10+')} | only all-zero runs: the zero UUID tails and the all-zero 64-digit placeholder hashes |
| S5 | hex ids of 20+ characters | {c('S5 hex20+')} | only the all-zero placeholder hashes (`code_sha256`, `prompt_sha256s`) |
| S6 | document-id shapes (mixed case and digits, 20 to 28 characters) | {c('S6 doc-id')} | none |
| S7 | `*_uid` fields with a value | {c('S7 uid-value')} | none; every uid is null |
| S8 | Aadhaar-shaped numbers | {c('S8 aadhaar')} | none |
| S9 | URLs | {c('S9 url')} | only the schema's `$schema` (json-schema.org) and `$id` (a non-resolving namespace id) |
| S10 | an honorific followed by a name | {c('S10 honorific')} | none |
| S11 | real model and vendor names | {c('S11 real-model')} | none; the word list is kept by ETA |
| S12 | internal agent, person and branch names | {c('S12 internal-name')} | none; the word list is kept by ETA |

Speakers are `speaker_N`, rooms are `EXAMPLE-ROOM` and encounters are `EXAMPLE-ENC-N`.
"""
open(os.path.join(B, "HANDOFF-INDEX.md"), "w", encoding="utf-8").write(doc)
print("index: %d files" % len(files))
