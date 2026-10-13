#!/usr/bin/env python3
"""Steward scrub: path deny, size, PHI field and host rules. Stdlib only.

Prints one line per hit: RULE<TAB>PATH:LINE<TAB>COMMIT. Never prints a matched value.
Modes: tree PATH | range REV_RANGE | staged
"""
import json
import os
import re
import subprocess
import sys

MAX_BYTES = 1024 * 1024

PHI_FIELDS = {
    "patient_name", "patientname", "patient_id", "patientid", "uhid", "mrn", "member_id", "memberid",
    "individual_key", "individualkey", "abha", "abha_id", "aadhaar", "aadhar", "dob", "date_of_birth",
    "dateofbirth", "phone", "phone_number", "mobile", "mobile_number", "email", "email_address", "address",
    "transcript", "transcript_text", "note_text", "prescription", "rx_text", "audio_url", "encounter_text",
}

DATA_EXT = {".json", ".jsonl", ".ndjson", ".csv", ".tsv", ".yaml", ".yml"}
TEXT_DATA_EXT = {".txt", ".md"}
DATA_DIRS = {"data", "fixtures", "samples", "exports"}
AUDIO_VIDEO = {".wav", ".webm", ".mp3", ".m4a", ".flac", ".ogg", ".mp4"}
BINARY_DENY = {".pem", ".p12", ".key", ".sqlite", ".db", ".parquet"}
CHROME_DENY = ("default/cookies", "local state", "login data")

EMPTY = {"", "null", "none", "~", "false", "[]", "{}", '""', "''"}


def norm_key(k):
    k = re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", k)
    return k.strip().strip("\"'").lower().replace("-", "_").replace(" ", "_")


def is_synthetic(path):
    return "/fixtures/synthetic/" in "/" + path.replace("\\", "/")


def allowed_fixture_path(path):
    if os.environ.get("STEWARD_SCRUB_NO_ALLOW") == "1":
        return False
    return path.replace("\\", "/").startswith("tests/steward-scrub/fixtures/")


def path_rules(path, size):
    p = path.replace("\\", "/")
    low = p.lower()
    base = os.path.basename(low)
    ext = os.path.splitext(base)[1]
    hits = []
    if (base.startswith(".env") or base.endswith(".env")) and base != ".env.example":
        hits.append("deny-env-file")
    if ext in (".pem", ".p12", ".key"):
        hits.append("deny-key-file")
    if ext in AUDIO_VIDEO:
        hits.append("deny-media-file")
    if ext in (".sqlite", ".db", ".parquet"):
        hits.append("deny-db-file")
    if any(low.endswith(c) or ("/" + c) in low or low == c for c in CHROME_DENY):
        hits.append("deny-chrome-profile")
    if size > MAX_BYTES:
        hits.append("deny-large-file")
    return hits


def env_example_nonempty(text):
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        v = s.split("=", 1)[1].strip().strip("\"'")
        if v:
            out.append(i)
    return out


def phi_applies(path):
    p = path.replace("\\", "/")
    ext = os.path.splitext(p.lower())[1]
    if ext in DATA_EXT:
        return True
    if ext in TEXT_DATA_EXT:
        parts = set(x.lower() for x in p.split("/")[:-1])
        return bool(parts & DATA_DIRS)
    return False


def nonempty_scalar(v):
    if v is None or v is False:
        return False
    if isinstance(v, str):
        return v.strip() != ""
    if isinstance(v, (int, float)):
        return True
    return False


def walk_json(obj, found):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if norm_key(str(k)) in PHI_FIELDS:
                if nonempty_scalar(v):
                    found.append(str(k))
                elif isinstance(v, list) and any(nonempty_scalar(x) for x in v):
                    found.append(str(k))
            walk_json(v, found)
    elif isinstance(obj, list):
        for v in obj:
            walk_json(v, found)


def line_of(lines, key, start=0):
    needle = key.lower()
    for i in range(start, len(lines)):
        if needle in lines[i].lower():
            return i + 1
    for i in range(0, len(lines)):
        if needle in lines[i].lower():
            return i + 1
    return 1


def phi_hits(path, text):
    ext = os.path.splitext(path.lower())[1]
    lines = text.splitlines()
    hits = []
    if ext in (".json", ".jsonl", ".ndjson"):
        docs = []
        try:
            if ext == ".json":
                docs = [(0, json.loads(text))]
            else:
                for i, ln in enumerate(lines):
                    if ln.strip():
                        docs.append((i, json.loads(ln)))
        except Exception:
            docs = None
        if docs is not None:
            for start, d in docs:
                found = []
                walk_json(d, found)
                for k in found:
                    hits.append(line_of(lines, '"' + k + '"', start) if ext == ".json" else start + 1)
            return sorted(set(hits))
    if ext in (".csv", ".tsv"):
        delim = "\t" if ext == ".tsv" else ","
        import csv
        rows = list(csv.reader(lines, delimiter=delim))
        if rows:
            cols = [i for i, h in enumerate(rows[0]) if norm_key(h) in PHI_FIELDS]
            for ri, row in enumerate(rows[1:], 2):
                if any(c < len(row) and row[c].strip().lower() not in EMPTY for c in cols):
                    hits.append(ri)
        return hits
    # yaml, md, txt, and unparsable json: line patterns "field: value" / "field = value" / "field": value
    pat = re.compile(r"""^\s*(?:[-*]\s+)?["']?([A-Za-z][A-Za-z0-9_ -]*?)["']?\s*[:=]\s*(.*)$""")
    for i, ln in enumerate(lines, 1):
        for m in re.finditer(r"""["']?([A-Za-z][A-Za-z0-9_]*)["']?\s*:\s*("[^"]+"|'[^']+'|[^\s,{}\[\]#][^,{}\]#]*)""", ln):
            if norm_key(m.group(1)) in PHI_FIELDS and m.group(2).strip().lower() not in EMPTY:
                hits.append(i)
                break
        else:
            m = pat.match(ln)
            if m and norm_key(m.group(1)) in PHI_FIELDS and m.group(2).strip().lower() not in EMPTY \
                    and not m.group(2).strip().startswith(("{", "[", "|", ">", "&", "*")):
                hits.append(i)
    return hits


def load_hosts():
    p = os.environ.get("STEWARD_HOSTS_FILE") or os.path.expanduser("~/oc/git-steward/scrub/HOSTS.local")
    try:
        names = [l.strip().lower() for l in open(p) if l.strip() and not l.startswith("#")]
    except OSError:
        return []
    return [n for n in names if len(n) >= 3]


def host_hits(text, hosts):
    if not hosts:
        return []
    out = []
    for i, ln in enumerate(text.lower().splitlines(), 1):
        if any(h in ln for h in hosts):
            out.append(i)
    return out


def check(path, data, commit, hosts, report):
    size = len(data)
    low = path.replace("\\", "/")
    if allowed_fixture_path(low):
        return
    for r in path_rules(path, size):
        report(r, path, 0, commit)
    if size > MAX_BYTES or b"\0" in data[:4096]:
        return
    text = data.decode("utf-8", "replace")
    base = os.path.basename(low.lower())
    if base == ".env.example":
        for n in env_example_nonempty(text):
            report("env-example-nonempty", path, n, commit)
    if phi_applies(low) and not is_synthetic(low):
        for n in phi_hits(low, text):
            report("phi-field", path, n, commit)
    for n in host_hits(text, hosts):
        report("host-deny", path, n, commit)


def git(*a):
    return subprocess.run(["git"] + list(a), capture_output=True).stdout


def main():
    mode = sys.argv[1]
    hosts = load_hosts()
    count = [0]

    def report(rule, path, line, commit):
        count[0] += 1
        print("%s\t%s:%d\t%s" % (rule, path, line, commit))

    if mode == "tree":
        root = sys.argv[2]
        if os.path.isfile(root):
            walk = [(os.path.dirname(root) or ".", [], [os.path.basename(root)])]
            base = os.path.dirname(root) or "."
        else:
            walk = os.walk(root)
            base = root
        for d, dirs, files in walk:
            dirs[:] = [x for x in dirs if x not in (".git", "node_modules")]
            for f in files:
                full = os.path.join(d, f)
                if os.path.islink(full):
                    continue
                rel = os.path.relpath(full, base) if not os.path.isfile(root) else os.path.basename(full)
                if os.path.isdir(root) and os.environ.get("STEWARD_TREE_PREFIX"):
                    rel = os.environ["STEWARD_TREE_PREFIX"].rstrip("/") + "/" + rel
                try:
                    data = open(full, "rb").read()
                except OSError:
                    continue
                check(rel, data, "-", hosts, report)
    elif mode == "staged":
        for p in git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").split(b"\0"):
            if not p:
                continue
            path = p.decode()
            data = git("show", ":" + path)
            check(path, data, "staged", hosts, report)
    elif mode == "range":
        rng = sys.argv[2]
        commits = git("rev-list", "--reverse", rng).decode().split()
        for c in commits:
            out = git("diff-tree", "--root", "-r", "--no-commit-id", "--name-only", "--diff-filter=ACMR", "-z", c)
            for p in out.split(b"\0"):
                if not p:
                    continue
                path = p.decode("utf-8", "replace")
                data = git("show", "%s:%s" % (c, path))
                check(path, data, c[:10], hosts, report)
    else:
        print("usage: scrub_rules.py tree PATH | range REV | staged", file=sys.stderr)
        return 2
    return 1 if count[0] else 0


if __name__ == "__main__":
    sys.exit(main())
