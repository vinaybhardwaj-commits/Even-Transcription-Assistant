"""Mutation check for link3_nameleak.py. Each mutant is applied to a TEMP COPY (never the real file) and the suite is run against it with `python -B`
(no bytecode cache, so an in-place edit cannot be masked by a stale .pyc). A mutant must be KILLED: the suite must FAIL. Every anchor must match once.
Run from p1/:  python3 -B tests/mutate_nameleak.py"""
import os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__)); P1 = os.path.dirname(HERE)
SRC = open(os.path.join(P1, "link3_nameleak.py")).read()

MUTANTS = [
    ("drop the seed", "rng = random.Random(seed)", "rng = random.Random(0)"),
    ("drop the pre-draw sort", 'return sorted((r for r in deid if r.get("q") == "ok" and r.get("dropped") is not True), key=sort_key)',
     'return [r for r in deid if r.get("q") == "ok" and r.get("dropped") is not True]'),
    ("drop the output sort", "return sorted(pool[:n], key=sort_key)", "return pool[:n]"),
    ("no randomness in the choice", "k = j + int(rng.random() * (len(pool) - j))", "k = j"),
    ("gate never fails (verdict)", 'PASS" if s["total_missed"] == 0 and s["second_total_missed"] == 0 else "FAIL"', 'PASS" if True else "FAIL"'),
    ("gate never fails (exit code)", 'return 0 if s["gate"] == "PASS" else 1', "return 0"),
    ("second reader does not gate", 's["total_missed"] == 0 and s["second_total_missed"] == 0', 's["total_missed"] == 0'),
    ("q no longer required to be ok", 'r.get("q") == "ok" and r.get("dropped") is not True', 'r.get("dropped") is not True'),
    ("q only rejected when garbled", 'r.get("q") == "ok" and r.get("dropped") is not True', 'r.get("q") != "garbled" and r.get("dropped") is not True'),
    ("q not-ok records not counted", "records_q_not_ok=sum(r.get(\"q\") != \"ok\" for r in deid)", "records_q_not_ok=0"),
    ("dropped true no longer excluded", 'r.get("dropped") is not True', "True"),
    ("missing dropped key becomes ineligible", 'r.get("dropped") is not True', 'r.get("dropped") is False'),
    ("null count accepted as never-looked=ok", "unfilled = sum(1 for k in keys if k in c and c[k] is None)", "unfilled = 0"),
    ("bool accepted as a count", "or isinstance(c[k], bool) or c[k] < 0", "or c[k] < 0"),
    ("missing turn accepted", "missing, extra = len(set(keys) - c.keys()), len(c.keys() - set(keys))", "missing, extra = 0, len(c.keys() - set(keys))"),
    ("extra key accepted", "missing, extra = len(set(keys) - c.keys()), len(c.keys() - set(keys))", "missing, extra = len(set(keys) - c.keys()), 0"),
    ("cross-check ignores a changed `en`", 'changed = sum(1 for k in t.keys() & d.keys() if t[k] != d[k])', "changed = 0"),
    ("cross-check ignores key-set difference", "if only_t or only_d or changed:", "if changed:"),
    ("duplicate keys accepted", "if dup:", "if False:"),
    ("draw may overwrite", "os.O_WRONLY | os.O_CREAT | os.O_EXCL", "os.O_WRONLY | os.O_CREAT | os.O_TRUNC"),
    ("sheet/draw files world-readable", "os.O_EXCL, 0o600)", "os.O_EXCL, 0o644)"),
    ("short pool not refused", "if len(pool) < n and not allow_short:", "if False:"),
    ("summary drops the deid hash", 'deid_sha256=meta["deid_sha256"], ', ""),
    ("summary hash taken from the wrong file", 'deid_sha256=meta["deid_sha256"]', 'deid_sha256=meta["translated_sha256"]'),
    ("second reader optional again", 's.add_argument("--second", required=True)', 's.add_argument("--second")'),
    ("second pin optional again", 's.add_argument("--second-pin", required=True)', 's.add_argument("--second-pin", default="0" * 64)'),
    ("first pin optional again", 's.add_argument("--counts-pin", required=True)', 's.add_argument("--counts-pin", default="0" * 64)'),
    ("first salt optional again", 's.add_argument("--counts-salt", required=True)', 's.add_argument("--counts-salt", default="00" * 32)'),
    ("first reader's pin never checked", '    check_pin(counts_path, counts_pin, counts_salt, "--counts-pin", "--counts-salt", "first")\n', ""),
    ("second reader's pin never checked", '    check_pin(second_path, second_pin, second_salt, "--second-pin", "--second-salt", "second")\n', ""),
    ("first reader's plain hash accepted (pin = plain sha256 of the file)", 'check_pin(counts_path, counts_pin, counts_salt,', 'check_pin(counts_path, sha256_file(counts_path), counts_salt,'),
    ("first pin/salt not recorded", "counts_pin=counts_pin, counts_salt=counts_salt, ", ""),
    ("second salt optional again", 's.add_argument("--second-salt", required=True)', 's.add_argument("--second-salt", default="00" * 32)'),
    ("pin not compared (either reader)", "if salted_pin(path, salt) != pin:", "if False:"),
    ("pin/salt format not checked", "if not isinstance(v, str) or not HEX64.fullmatch(v):", "if False:"),
    ("salt ignored: pin is the plain sha256", "hashlib.sha256(bytes.fromhex(salt_hex) + f.read()).hexdigest()", "hashlib.sha256(f.read()).hexdigest()"),
    ("salt hashed as hex text, not bytes", "bytes.fromhex(salt_hex) + f.read()", "salt_hex.encode() + f.read()"),
    ("salt appended after the file, not before", "bytes.fromhex(salt_hex) + f.read()", "f.read() + bytes.fromhex(salt_hex)"),
    ("salt is not random (constant)", "salt_hex = secrets.token_bytes(32).hex()", 'salt_hex = "00" * 32'),
    ("salt is short (16 bytes)", "salt_hex = secrets.token_bytes(32).hex()", "salt_hex = secrets.token_bytes(16).hex().ljust(64, '0')"),
    ("pin prints the salt", 'print(f"pin (post this on the bus): {pin}")', 'print(f"pin (post this on the bus): {pin} salt {salt_hex}")'),
    ("pin prints the plain counts hash", 'print("counts file sha256 is NOT the pin and must not be posted', 'print(sha256_file(counts_path)); print("counts file sha256 is NOT the pin and must not be posted'),
    ("salt file not private (0644)", "os.O_EXCL, 0o600)", "os.O_EXCL, 0o644)"),
    ("salt not recorded in the summary", "second_pin=second_pin, second_salt=second_salt, ", "second_pin=second_pin, "),
    ("pin field not recorded in the summary", "second_pin=second_pin, second_salt=second_salt, ", "second_salt=second_salt, "),
    ("write_private has no git guard", "    refuse_in_git(path)\n    fd = os.open", "    fd = os.open"),
    ("draw makes the dir before the git check", '    refuse_in_git(os.path.join(out_dir, "draw.json"))\n    os.makedirs(out_dir, mode=0o700, exist_ok=True)', '    os.makedirs(out_dir, mode=0o700, exist_ok=True)'),
    ("git guard fails open when git is missing", "    except OSError:\n        return True", "    except OSError:\n        return False"),
    ("git guard fails open on other git errors", 'return "not a git repository" not in r.stderr', "return False"),
    ("git guard ignores .git markers", "        if os.path.lexists(os.path.join(d, \".git\")):\n            return True\n", ""),
    ("git guard does not walk to missing dirs", "while not os.path.isdir(probe):", "while False:"),
    ("sheet header gets the old role list back", "              *FROZEN_DEFINITION,", '              "Count every personal name (patient, relative, doctor, staff) still readable in the EN_DEID column.",'),
    ("sheet header drops the frozen quote", "              *FROZEN_DEFINITION,\n", ""),
    ("frozen v7.15a wording altered", '"counts of missed names per turn, missed transliterated names included".   [v7.15a N2 step 2]', '"count the missed names per turn".   [v7.15a N2 step 2]'),
    ("v7.15b: public figure dropped from the definition", "any other individual, \"\n    \"and a public figure.", "any other individual.\"\n    \""),
    ("v7.15b: brand/place/drug exclusion dropped", "A brand, a place, a drug, a day or a month is not a person's name. ", ""),
    ("v7.15b: garble rule dropped", "A garbled token that does not function as a name in its context is not \"\n    \"counted, and is listed by turn key in the reader's notes.", "\"\n    \""),
    ("v7.15b: role list narrowed", "whatever the role: patient, relative, doctor, staff, any other individual", "whatever the role: patient, relative, doctor, staff"),
    ("agree list wrong", "agree=[k for k in keys if first[k] == second[k]]", "agree=[k for k in keys if first[k] != second[k]]"),
    ("text printed to stdout", 'print("keys: " + " ".join(keys))', 'print("keys: " + " ".join(keys) + " " + chosen[0]["en"])'),
]


def run(path):
    env = dict(os.environ, NAMELEAK_PATH=path, PYTHONDONTWRITEBYTECODE="1")
    return subprocess.run([sys.executable, "-B", "-m", "unittest", "tests.test_nameleak"], cwd=P1, env=env, capture_output=True, text=True).returncode


def main():
    with tempfile.TemporaryDirectory() as d:
        base = os.path.join(d, "base.py"); open(base, "w").write(SRC)
        if run(base) != 0:
            sys.exit("baseline suite FAILS on an unmodified copy: fix that first")
        survived = []
        for name, old, new in MUTANTS:
            assert SRC.count(old) == 1, f"anchor for {name!r} matches {SRC.count(old)} times"
            assert old != new
            p = os.path.join(d, "m.py"); open(p, "w").write(SRC.replace(old, new))
            killed = run(p) != 0
            print(("KILLED   " if killed else "SURVIVED ") + name)
            if not killed:
                survived.append(name)
        print(f"{len(MUTANTS) - len(survived)} of {len(MUTANTS)} killed")
        sys.exit(1 if survived else 0)


if __name__ == "__main__":
    main()
