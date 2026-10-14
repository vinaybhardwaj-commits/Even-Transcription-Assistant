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
    ("second pin optional again", 's.add_argument("--second-sha256", required=True)', 's.add_argument("--second-sha256", default="")'),
    ("pin not compared", "if actual != second_sha256:", "if False:"),
    ("pin format not checked", "or not HEX64.fullmatch(second_sha256)", ""),
    ("write_private has no git guard", "    refuse_in_git(path)\n    fd = os.open", "    fd = os.open"),
    ("draw makes the dir before the git check", '    refuse_in_git(os.path.join(out_dir, "draw.json"))\n    os.makedirs(out_dir, mode=0o700, exist_ok=True)', '    os.makedirs(out_dir, mode=0o700, exist_ok=True)'),
    ("git guard fails open when git is missing", "    except OSError:\n        return True", "    except OSError:\n        return False"),
    ("git guard fails open on other git errors", 'return "not a git repository" not in r.stderr', "return False"),
    ("git guard ignores .git markers", "        if os.path.lexists(os.path.join(d, \".git\")):\n            return True\n", ""),
    ("git guard does not walk to missing dirs", "while not os.path.isdir(probe):", "while False:"),
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
