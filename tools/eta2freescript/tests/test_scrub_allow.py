"""Fix1 M6: the scrub allowance is exact path + sha256, contract_v1 only, no globs."""
import hashlib
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def _rules(tmp_path, lines):
    spec = importlib.util.spec_from_file_location("scrub_rules_t", ROOT / "scripts/steward/scrub_rules.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    f = tmp_path / "allow.txt"
    f.write_text("\n".join(lines) + "\n")
    m.ALLOW_FILE = str(f)
    m.RULE_ALLOW = m.load_rule_allow()
    return m


SHA = hashlib.sha256(b"x").hexdigest()
P = "tools/eta2freescript/contract_v1/examples/a.json"


def test_exact_path_and_sha_is_allowed_and_nothing_else(tmp_path, capsys):
    m = _rules(tmp_path, [f"phi-field {P} {SHA} # r", "phi-field tools/eta2freescript/contract_v1/** " + SHA + " # glob",
                          f"phi-field tools/other/a.json {SHA} # outside", f"phi-field {P} nothex # bad sha", "phi-field tools/eta2freescript/contract_v1/examples/b.json # no sha"])
    assert m.rule_allowed("phi-field", P, b"x")
    assert not m.rule_allowed("phi-field", P, b"y")                       # the file changed: the sha no longer matches
    assert not m.rule_allowed("deny-large-file", P, b"x")                 # another rule
    assert not m.rule_allowed("phi-field", "tools/eta2freescript/contract_v1/examples/c.json", b"x")   # no dir/** exemption
    assert not m.rule_allowed("phi-field", "tools/other/a.json", b"x")    # outside contract_v1
    assert capsys.readouterr().err.count("ignored allow line") == 3


def test_every_committed_entry_is_inside_contract_v1_and_matches_its_file():
    m = _rules(Path("/tmp"), [])
    lines = [l for l in (ROOT / "steward/scrub-allow.txt").read_text().split("\n") if l.split(" #")[0].split()[:1] in (["phi-field"], ["deny-large-file"])]
    assert len(lines) >= 218
    for ln in lines:
        rule, path, sha = ln.split(" #")[0].split()
        assert path.startswith("tools/eta2freescript/contract_v1/") and "*" not in path
        assert hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == sha, path
