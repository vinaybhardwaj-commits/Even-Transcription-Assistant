import subprocess, sys, pathlib
W = pathlib.Path(sys.argv[1]); PY = sys.argv[2]
F = "tools/eta2freescript/r1_floors.py"; PL = "tools/eta2freescript/pipeline.py"
M = {
 "Y1 PREFIXES drop levo": (F, 'PREFIXES = {"hydroxy", "methyl", "levo", "es",', 'PREFIXES = {"hydroxy", "methyl", "es",'),
 "Y2 next-drug refusal off": (F, "if nxt and (nxt in v.strong or ph[-1] + nxt in v.strong) and nxt not in (own or set()):", "if False:"),
 "Y3 negated-clause refusal off": (F, 'if _NOT_USE & set(seq[max(0, j - 3):j]) or {"not", "no", "stop", "avoid"} & set(seq[j + n:j + n + 3]):', "if False:"),
 "Y4 everyday-brand adjacency off": (F, "if n == 1 and ph[0] in v.everyday:", "if False:"),
 "Y5 fuzzy off": (F, "if len(t) < 6 or t in self.plain:", "if True:"),
 "Y6 two-word join off": (F, "if two and t not in v.strong and (two in v.strong or v.fuzzy_hit(two)):", "if False:"),
 "Y7 qualifier phrase scan off": (F, "for ph in known_phr:", "for ph in []:"),
 "Y8 letter-strength code off": (F, "out += [(m.group(1).lower() + m.group(2),) for m in _PX.finditer(line)", "out += [(m.group(1).lower() + m.group(2),) for m in _PX.finditer('')"),
 "Y9 F5 always claims /general_advice": (F, '"json_pointer": None if owned else "/general_advice"', '"json_pointer": "/general_advice"'),
 "Y10 pipeline keeps note naming unposted drug": (PL, '                moved_err = ["FRX-R1 note_text names a drug that is not posted"]', '                moved_err = []'),
 "Y11 PCM abbreviation dropped": (F, 'DRUG_ABBREVIATIONS = {"pcm"}', 'DRUG_ABBREVIATIONS = set()'),
 "Y12 R1-5 before allowlist (F4 order)": (F, "    r1_allowlist(out, c, names)\n    r1_red_flags(out, turns, c, names + out[_KNOWN])\n", "    r1_red_flags(out, turns, c, names + out[_KNOWN])\n    r1_allowlist(out, c, names)\n"),
}
for name, (f, a, b) in M.items():
    p = W / f; src = p.read_text()
    assert src.count(a) == 1, (name, src.count(a))
    p.write_text(src.replace(a, b))
    r = subprocess.run([PY, "-m", "pytest", "-c", "tools/eta2freescript/pytest.ini", "tools/eta2freescript/tests/test_r2_fixes.py",
                        "tools/eta2freescript/tests/test_r1_floors.py", "tools/eta2freescript/tests/test_r3_fixes.py", "-q", "-x", "-n", "4", "-p", "no:cacheprovider"], cwd=W, capture_output=True, text=True)
    p.write_text(src)
    out = r.stdout.strip().splitlines()
    failed = [l for l in out if l.startswith("FAILED")]
    print(f"{name}: {'KILLED' if r.returncode else 'SURVIVED'} | {(failed[0][7:110] if failed else out[-1][:100])}", flush=True)
