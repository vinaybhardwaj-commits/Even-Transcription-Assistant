#!/usr/bin/env python3
"""ETA-internal. Privacy and internal-name sweep over the Pulse-facing bundle (S7/S8 of fix round 1).
Usage: privacy_sweep.py [BUNDLE_DIR]. Exit 1 when any hit is not an allowed placeholder.
Kept outside the Pulse folder because S12 lists internal names."""
import collections, os, re, sys

BUNDLE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "eta-freescript-v1.0")
ZERO_UUID = re.compile(r"^00000000-0000-4000-8000-00000000000[1-7]$")
SWEEPS = {
    "S1 email": (r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", None),
    "S2 phone": (r"(?<!\d)(?:\+91[\s-]?)?[6-9]\d{9}(?!\d)", None),
    "S3 uuid": (r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", lambda m: bool(ZERO_UUID.match(m))),
    "S4 digits10+": (r"(?<!\d)\d{10,}(?!\d)", lambda m: set(m) <= {"0"} or re.fullmatch(r"0+[1-7]", m) is not None),
    "S5 hex20+": (r"\b[0-9a-f]{20,}\b", lambda m: set(m) <= {"0"}),
    "S6 doc-id": (r"\b(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{20,28}\b", None),
    "S7 uid-value": (r"\"\w*_?uid\"\s*:\s*\"", None),
    "S8 aadhaar": (r"\b\d{4}\s\d{4}\s\d{4}\b", None),
    "S9 url": (r"https?://\S+", lambda m: m.startswith(("http://json-schema.org/draft-07/schema#", "https://eta.lab/schemas/"))),
    "S10 honorific": (r"\b(?:Dr|Mr|Mrs|Ms)\.?\s+[A-Z][a-z]+", None),
    "S11 real-model": (r"(?i)\b(?:gemini|gpt|claude|sonnet|opus|haiku|whisper|sarvam|bedrock|vertex|openai|anthropic|deepgram)\b", None),
    "S12 internal-name": (r"(?i)\b(?:fable|newcat|cloudpane|refuter|scout|orchestrator|kush|vinay|steward)\b|\b(?:origin|claude|cloudpane)/[\w./-]+|\bV's\b", None),
}


DICTIONARIES = {"scowl_words.json", "english_words_min.json"}


def main():
    hits, bad = collections.Counter(), 0
    for root, dirs, fs in os.walk(BUNDLE):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for f in sorted(fs):
            p = os.path.join(root, f)
            t = open(p, encoding="utf-8").read()
            if f == "SCOWL-LICENSE.txt":  # third-party licence: its authors' copyright notices must stay verbatim
                continue
            if f == "HANDOFF-INDEX.md":  # its sha256 column is file hashes, not ids
                t = re.sub(r"`[0-9a-f]{64}`", "`HASH`", t)
            for k, (rx, ok) in SWEEPS.items():
                if k.startswith(("S11", "S12")) and f in DICTIONARIES:  # dictionary words, not names in prose
                    continue
                for m in re.finditer(rx, t):
                    hits[k] += 1
                    if not (ok and ok(m.group(0))):
                        bad += 1
                        print("UNEXPLAINED %s in %s: %r" % (k, os.path.relpath(p, BUNDLE), m.group(0)[:40]))
    for k in SWEEPS:
        print("%-18s %d hits" % (k, hits[k]))
    print("unexplained hits: %d" % bad)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
