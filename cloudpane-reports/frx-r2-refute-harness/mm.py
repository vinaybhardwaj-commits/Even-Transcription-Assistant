import subprocess, sys, pathlib
W = pathlib.Path(sys.argv[1]); PY = sys.argv[2]
F = "tools/eta2freescript/r1_floors.py"; PL = "tools/eta2freescript/pipeline.py"
M = {
 "M2 4-letter prefix": (F, "any(tuple(toks[i:i + n]) == phrase for i in range(len(toks) - n + 1))", "any(all(x == y or (len(x) >= 4 and len(y) >= 4 and x[:4] == y[:4]) for x, y in zip(toks[i:i + n], phrase)) for i in range(len(toks) - n + 1))"),
 "M5 coverage 0.5": (F, "any(overlap(clause, x) >= 0.6 for x in texts)", "any(overlap(clause, x) >= 0.5 for x in texts)"),
}
for name, (f, a, b) in M.items():
    p = W / f; src = p.read_text()
    assert src.count(a) == 1, (name, src.count(a))
    p.write_text(src.replace(a, b))
    r = subprocess.run([PY, "-m", "pytest", "-c", "tools/eta2freescript/pytest.ini", "tools/eta2freescript/tests/test_r2_fixes.py",
                        "tools/eta2freescript/tests/test_r1_floors.py", "-q", "-x", "-n", "4", "-p", "no:cacheprovider"], cwd=W, capture_output=True, text=True)
    p.write_text(src)
    out = r.stdout.strip().splitlines()
    failed = [l for l in out if l.startswith("FAILED")]
    print(f"{name}: {'KILLED' if r.returncode else 'SURVIVED'} | {(failed[0][7:110] if failed else out[-1][:100])}", flush=True)
