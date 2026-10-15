"""Fixtures are synthetic, reproducible from build_fixtures.py, and carry none of the identity shapes the repo bans."""
import importlib.util
import re
from pathlib import Path

from conftest import FIX

PKG = Path(__file__).resolve().parents[1]

# The shapes from tests/unit/no-identity-literals.test.ts and tests/unit/no-real-clinician-ids.test.ts, plus phone and
# Indian id numbers. Reported by file and rule only, never the value.
PERSON_FIELD = (r"full_?name|fullName|display_?name|displayName|doctor_?name|doctorName|clinician_?name|clinicianName|patient_?name|"
                r"patientName|first_?name|firstName|last_?name|lastName|surname|published_?by|publishedBy")
RULES = {
    "doctor-slug": re.compile(r"\bdr-[a-z]+(?:-[a-z]+)*-[a-z0-9]{4}\b"),
    "identity-field": re.compile(r"\b(?:" + PERSON_FIELD + r")\b[\"']?\s*[:=]\s*([\"'`])(?!\1)[^\"'`\n]+\1"),
    "dr-title": re.compile(r"[\"'`][^\"'`\n]*\b(?:Dr\.?|Doctor)\s+[A-Z][a-z]+"),
    "email": re.compile(r"[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net|test)\b)[A-Za-z0-9-]+\.[A-Za-z]{2,}"),
    "clinician-id": re.compile(r"(?<![A-Za-z0-9_])doc_[a-z0-9]{8}(?![A-Za-z0-9_])"),
    "phone": re.compile(r"(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)"),
    "aadhaar": re.compile(r"(?<!\d)\d{4}\s\d{4}\s\d{4}(?!\d)"),
}


def offenders(paths):
    out = []
    for f in paths:
        for i, line in enumerate(f.read_text(encoding="utf-8", errors="replace").split("\n"), 1):
            out += [f"{f.relative_to(PKG)}:{i} {r}" for r, rx in RULES.items() if rx.search(line)]
    return out


def test_rules_catch_planted_shapes():
    # Built at runtime, so this file carries none of the shapes it plants.
    q = '"'
    planted = {"doctor-slug": "x = " + q + "-".join(["dr", "jane", "planted", "ab2c"]) + q,
               "identity-field": "{" + q + "patient" + "_name" + q + ": " + q + "Planted" + q + "}",
               "dr-title": "room = " + q + "OPD " + "Dr" + " Planted" + q, "email": "e = " + q + "jane" + "@" + "hospital.in" + q,
               "clinician-id": "doc_" + "q7mz9kx4", "phone": "call 98" + "76543210", "aadhaar": "1234 " + "5678 9012"}
    for rule, line in planted.items():
        assert RULES[rule].search(line), rule
    assert not any(rx.search('e = "fake@example.test"') for rx in RULES.values())


def test_no_identity_shapes_anywhere_in_the_tool():
    files = [p for p in PKG.rglob("*") if p.is_file() and p.suffix in (".py", ".json", ".md", ".txt", ".tsv", ".yml", ".ini")
             and "__pycache__" not in p.parts and p.name != "test_fixtures.py"]
    assert len(files) > 20
    assert offenders(files) == []


def test_fixture_uids_and_rooms_are_synthetic():
    for d in (FIX / "consults").iterdir():
        assert d.name.startswith("synth-")
        assert "synth-room" in (d / "meta.json").read_text()


def test_fixtures_regenerate_identically(tmp_path):
    spec = importlib.util.spec_from_file_location("build_fixtures", FIX / "build_fixtures.py")
    bf = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bf)
    bf.HERE = tmp_path
    bf.main()
    gen = sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*") if p.is_file())
    hand = {"bundle", "pulse", "pdqi9", "oracles"}  # hand-authored fixture dirs, not produced by build_fixtures.py
    have = sorted(p.relative_to(FIX) for p in FIX.rglob("*") if p.is_file() and p.parent != FIX and p.relative_to(FIX).parts[0] not in hand and "__pycache__" not in p.parts)
    assert gen == have
    for rel in gen:
        assert (tmp_path / rel).read_bytes() == (FIX / rel).read_bytes(), rel
