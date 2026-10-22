#!/usr/bin/env python3
"""Steward scrub: path deny, size, PHI field and host rules. Stdlib only.

Prints one line per hit: RULE<TAB>PATH:LINE<TAB>COMMIT. Never prints a matched value.
Modes: tree PATH | range REV_RANGE | staged
"""
import json
import hashlib
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

PHI_FIELDS |= {"mobileno", "abhanumber", "aadhaarnumber", "patientuhid", "pan", "patientid", "emailid", "phoneno"}
PHI_FIELDS = {re.sub(r"[^a-z0-9]", "", f) for f in PHI_FIELDS}

DATA_EXT = {".json", ".jsonl", ".ndjson", ".csv", ".tsv", ".yaml", ".yml"}
TEXT_DATA_EXT = {".txt", ".md"}
DATA_DIRS = {"data", "fixtures", "samples", "exports", "testdata"}
AUDIO_VIDEO = {".wav", ".webm", ".mp3", ".m4a", ".flac", ".ogg", ".mp4", ".opus", ".aac", ".mov"}
CHROME_RE = re.compile(r"(^|/)((default|profile [0-9]+)/(cookies|login data)|local state)$")

EMPTY = {"", "null", "none", "~", "false", "[]", "{}", '""', "''"}


def norm_key(k):
    k = k.replace("\ufeff", "")
    k = re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", k)
    k = k.strip().strip("\"'").lower()
    return re.sub(r"[^a-z0-9]", "", k)


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
    if (base.startswith(".env") or base.endswith(".env") or base in ("env.production", "env.local", "env.development", "env.staging", "env.prod", "env.test")) and base != ".env.example":
        hits.append("deny-env-file")
    if ext in (".pem", ".p12", ".key", ".p8", ".pfx"):
        hits.append("deny-key-file")
    if ext in AUDIO_VIDEO:
        hits.append("deny-media-file")
    if ext in (".sqlite", ".sqlite3", ".db", ".parquet") or base.endswith(("-wal", "-shm", "-journal", ".db-wal", ".db-shm")):
        hits.append("deny-db-file")
    if CHROME_RE.search(low):
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
        key = s.split("=", 1)[0].strip().replace("export ", "").upper()
        if re.search(r"_ID$", key):
            continue  # key ids, client ids and similar identifiers are not secrets
        if not re.search(r"SECRET|TOKEN|PASS|PWD|CRED|(^|_)KEY($|_)|KEY$|(DATABASE|DB|REDIS|MONGO|AMQP)_?(URL|URI)|DSN|AUTH|SALT|SIGNING", key):
            continue  # non-secret defaults (ports, flags, model names) are allowed
        v = s.split("=", 1)[1].strip()
        v = re.split(r"\s+#", " " + v, maxsplit=1)[0].strip().strip("\"'")
        if v and not v.startswith("#"):
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


JSON_TYPES = {"string", "number", "integer", "boolean", "object", "array", "null"}
SCHEMA_VOCAB = {"type", "$ref", "$id", "$schema", "$defs", "definitions", "properties", "items", "enum", "const", "description",
                "oneof", "anyof", "allof", "not", "format", "required", "default", "title", "example", "examples",
                "minlength", "maxlength", "minimum", "maximum", "pattern", "additionalproperties", "minitems", "maxitems",
                "uniqueitems", "nullable", "readonly", "writeonly", "deprecated", "contentencoding", "contentmediatype"}
SCHEMA_KEYS = {"type", "$ref", "properties", "items", "enum", "description", "oneof", "anyof", "allof", "format"}


def has_content(v):
    """True when v holds a real value. Booleans and schema-shaped dicts do not count."""
    if isinstance(v, bool) or v is None:
        return False
    if isinstance(v, (str, int, float)):
        return nonempty_scalar(v)
    if isinstance(v, list):
        return any(has_content(x) for x in v)
    if isinstance(v, dict):
        t = v.get("type")
        if (isinstance(t, str) and t in JSON_TYPES or isinstance(t, list) and t and all(x in JSON_TYPES for x in t) or "$ref" in v) \
                and set(k.lower() for k in v) <= SCHEMA_VOCAB and not any(k in v for k in ("default", "example", "const")):
            return False
        if v and set(k.lower() for k in v) <= SCHEMA_KEYS | {"required", "default", "title", "example", "examples"}:
            return False
        return any(has_content(x) for x in v.values())
    return False


def nonempty_scalar(v):
    if v is None or isinstance(v, bool):
        return False
    if isinstance(v, str):
        return v.strip() != ""
    if isinstance(v, (int, float)):
        return True
    return False


def walk_json(obj, found):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if norm_key(str(k)) in PHI_FIELDS and has_content(v):
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
        import csv
        for delim in (",", ";", "\t", "|"):
            rows = list(csv.reader(lines, delimiter=delim))
            for hi in range(min(5, len(rows))):
                cols = [i for i, h in enumerate(rows[hi]) if norm_key(h) in PHI_FIELDS]
                if not cols:
                    continue
                for ri, row in enumerate(rows[hi + 1:], hi + 2):
                    if any(c < len(row) and row[c].strip().lower() not in EMPTY and row[c].strip().lower() not in ("true", "false") for c in cols):
                        hits.append(ri)
                break
        return sorted(set(hits))
    # yaml, md, txt, and unparsable json: line patterns "field: value" / "field = value" / "field": value
    def indent(l):
        return len(l) - len(l.lstrip())

    def nested_content(i):
        base = indent(lines[i])
        for j in range(i + 1, min(i + 60, len(lines))):
            t = lines[j]
            if not t.strip():
                continue
            if indent(t) <= base and not t.lstrip().startswith("- "):
                return False
            body = t.strip().lstrip("-").strip()
            if ":" in body:
                body = body.split(":", 1)[1].strip()
            if body and body.lower() not in EMPTY and body.lower() not in ("true", "false"):
                return True
        return False

    pat = re.compile(r"""^\s*(?:[-*]\s+)?["']?([A-Za-z][A-Za-z0-9_ -]*?)["']?\s*[:=]\s*(.*)$""")
    for i, ln in enumerate(lines, 1):
        mm = re.match(r"""^\s*(?:-\s+)?["']?([A-Za-z][A-Za-z0-9_ -]*?)["']?\s*:\s*(?:[|>][-+]?)?\s*(?:#.*)?$""", ln)
        if mm and norm_key(mm.group(1)) in PHI_FIELDS and nested_content(i - 1):
            hits.append(i)
            continue
        fm = re.match(r"""^\s*(?:-\s+)?["']?([A-Za-z][A-Za-z0-9_ -]*?)["']?\s*:\s*([\[{].*)$""", ln)
        if fm and norm_key(fm.group(1)) in PHI_FIELDS:
            inner = re.sub(r"[\[\]{},\s\"']", "", fm.group(2))
            if inner and not re.search(r"\btype\s*:\s*(string|number|integer|boolean|object|array|null)", fm.group(2)) \
                    and inner.lower() not in ("true", "false", "null", "none", "~"):
                hits.append(i)
                continue
        for m in re.finditer(r"""["']?([A-Za-z][A-Za-z0-9_]*)["']?\s*:\s*("[^"]+"|'[^']+'|[^\s,{}\[\]#][^,{}\]#]*)""", ln):
            if norm_key(m.group(1)) in PHI_FIELDS and m.group(2).strip().lower() not in EMPTY and m.group(2).strip().lower() not in ("true", "false"):
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
        raw = [l.strip() for l in open(p) if l.strip() and not l.startswith("#")]
    except OSError:
        return []
    names = []
    for n in raw:
        if n.lower().startswith("re:"):
            names.append("re:" + n[3:])  # regex lines keep their case (\D \S \W \B are case-sensitive)
        else:
            names.append(n.lower())
    out = []
    for n in names:
        if n.startswith("re:"):
            try:
                re.compile(n[3:])
            except re.error as e:
                print("scrub: invalid regex in HOSTS file (line starting 're:'): %s" % e, file=sys.stderr)
                sys.exit(1)
            out.append(n)
        elif len(n) >= 3:
            out.append(n)
    return out


RANGES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "steward", "scrub-allow-ranges.txt")
DOC_ADDR = re.compile(r"\b(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}\b|2001:db8::?[0-9a-f:]*", re.I)


def load_range_allow():
    """path -> exact network-range literals (steward/scrub-allow-ranges.txt, Fable ruling 16 Oct 2026). Path-scoped; never a host address."""
    out = {}
    try:
        for l in open(RANGES_FILE):
            l = l.split("#", 1)[0].strip()
            parts = l.split()
            if len(parts) == 2:
                out.setdefault(parts[0], []).append(parts[1])
    except OSError:
        pass
    return out


RANGE_ALLOW = load_range_allow()


def strip_range_literals(path, text):
    lits = RANGE_ALLOW.get(path.replace("\\", "/"))
    if not lits:
        return text
    for lit in sorted(lits, key=len, reverse=True):
        text = text.replace(lit, " ")
    return DOC_ADDR.sub(" ", text)


def host_hits(text, hosts):
    if not hosts:
        return []
    plain = [h for h in hosts if not h.startswith("re:")]
    rx = [re.compile(h[3:], re.I) for h in hosts if h.startswith("re:")]
    out = []
    for i, ln in enumerate(text.splitlines(), 1):
        low = ln.lower()
        if any(h in low for h in plain) or any(r.search(ln) for r in rx):
            out.append(i)
    return out


IPV4 = re.compile(r"(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d]|\.\d)")


def is_public_ipv4(a, b, c, d):
    if any(x > 255 for x in (a, b, c, d)):
        return False
    if a in (0, 10, 127) or a >= 224:
        return False
    if a == 100 and 64 <= b <= 127:
        return False  # tailnet CGNAT: the ts-cgnat-ip gitleaks rule owns it
    if a == 172 and 16 <= b <= 31:
        return False
    if a == 192 and b == 168:
        return False
    if a == 169 and b == 254:
        return False
    if (a, b, c) in ((192, 0, 2), (198, 51, 100), (203, 0, 113)):
        return False  # documentation ranges
    return True


def public_ipv4_hits(text):
    out = []
    for i, ln in enumerate(text.splitlines(), 1):
        for m in IPV4.finditer(ln):
            if is_public_ipv4(*[int(x) for x in m.groups()]):
                out.append(i)
                break
    return out


STAFF_DOMAINS = ("even.in", "evenhealthcare.com", "evenos.app", "evenscribe.app")
EMAIL = re.compile(r"([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)")
EMAIL_OK_LOCALS = ("staff-redacted",)


def load_email_domains():
    """Named staff domains plus an optional private list (git author domains), never committed."""
    p = os.environ.get("STEWARD_EMAIL_DOMAINS_FILE") or os.path.expanduser("~/oc/git-steward/scrub/EMAIL-DOMAINS.local")
    extra = []
    try:
        extra = [l.strip().lower() for l in open(p) if l.strip() and not l.lstrip().startswith("#")]
    except OSError:
        pass
    return set(STAFF_DOMAINS) | set(d for d in extra if "." in d)


def staff_email_hits(text, domains):
    out = []
    for i, ln in enumerate(text.splitlines(), 1):
        for m in EMAIL.finditer(ln):
            local, d = m.group(1).lower(), m.group(2).lower().rstrip(".")
            if d in ("example.com", "example.test", "example.org", "example.net"):
                continue
            if local in EMAIL_OK_LOCALS or set(local) <= {"%"}:
                continue  # redaction placeholder, or a SQL LIKE pattern such as %@even.in
            if d in domains or any(d.endswith("." + x) for x in domains):
                out.append(i)
                break
    return out


ALLOW_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "steward", "scrub-allow.txt")
RULE_IDS = {"phi-field", "deny-large-file"}
ALLOW_PREFIX = "tools/eta2freescript/contract_v1/"


def load_rule_allow():
    """{(rule id, exact path, sha256 of the file's bytes)} from steward/scrub-allow.txt lines `<rule-id> <exact path> <sha256> # reason`. No globs. A path must start with
    tools/eta2freescript/contract_v1/ (checked here, in code; any other line is ignored and reported on stderr). Gitleaks fingerprint lines are not read here.
    Off under STEWARD_SCRUB_NO_ALLOW=1. Merge-owner reviewed, like the rest of the file."""
    out = set()
    if os.environ.get("STEWARD_SCRUB_NO_ALLOW") == "1":
        return out
    try:
        lines = open(ALLOW_FILE, encoding="utf-8").read().split("\n")
    except OSError:
        return out
    for ln in lines:
        parts = ln.split(" #", 1)[0].split()
        if len(parts) == 3 and parts[0] in RULE_IDS:
            if parts[1].startswith(ALLOW_PREFIX) and "*" not in parts[1] and re.fullmatch(r"[0-9a-f]{64}", parts[2]):
                out.add((parts[0], parts[1], parts[2]))
            else:
                print("scrub: ignored allow line (path outside %s, a glob, or a bad sha256)" % ALLOW_PREFIX, file=sys.stderr)
    return out


RULE_ALLOW = load_rule_allow()


def rule_allowed(rule, path, data):
    return (rule, path.replace("\\", "/"), hashlib.sha256(data).hexdigest()) in RULE_ALLOW


def check(path, data, commit, hosts, report):
    size = len(data)
    low = path.replace("\\", "/")
    if allowed_fixture_path(low):
        return
    for r in path_rules(path, size):
        if not rule_allowed(r, low, data):
            report(r, path, 0, commit)
    if size > MAX_BYTES:
        return
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        text = data.decode("utf-16", "replace")
    elif b"\0" in data[:4096]:
        head = data[:4096]
        if head[1::2].count(0) > len(head) // 4:
            text = data.decode("utf-16-le", "replace")
        elif head[0::2].count(0) > len(head) // 4:
            text = data.decode("utf-16-be", "replace")
        else:
            return
    else:
        text = data.decode("utf-8-sig", "replace")
    base = os.path.basename(low.lower())
    if base == ".env.example":
        for n in env_example_nonempty(text):
            report("env-example-nonempty", path, n, commit)
    if phi_applies(low) and not is_synthetic(low):
        for n in ([] if rule_allowed("phi-field", low, data) else phi_hits(low, text)):
            report("phi-field", path, n, commit)
    for n in host_hits(strip_range_literals(low, text), hosts):
        report("host-deny", path, n, commit)
    if "/mirrors/" in "/" + low or os.environ.get("STEWARD_PUBLIC_IPV4") == "1":
        for n in public_ipv4_hits(text):
            report("public-ipv4", path, n, commit)
        for n in staff_email_hits(text, EMAIL_DOMAINS):
            report("staff-email", path, n, commit)


def git(*a):
    return subprocess.run(["git"] + list(a), capture_output=True).stdout


EMAIL_DOMAINS = load_email_domains()


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
                elif os.path.isdir(root):
                    parts = os.path.abspath(root).split(os.sep)
                    if "mirrors" in parts:
                        rel = "/".join(parts[parts.index("mirrors"):] + [rel])
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
        rl = subprocess.run(["git", "rev-list", "--reverse", rng], capture_output=True)
        if rl.returncode != 0:
            print("scrub: invalid range", file=sys.stderr)
            return 2
        commits = rl.stdout.decode().split()
        for c in commits:
            out = git("diff-tree", "--root", "-r", "--cc", "--no-commit-id", "--name-only", "--diff-filter=ACMR", "-z", c)
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
