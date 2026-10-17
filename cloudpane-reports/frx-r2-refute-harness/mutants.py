import subprocess, sys, pathlib
W = pathlib.Path(sys.argv[1]); PY = sys.argv[2]
F = "tools/eta2freescript/r1_floors.py"; PL = "tools/eta2freescript/pipeline.py"
M = {
 "X1 GUARD_ALIASES emptied": (F, 'GUARD_ALIASES: dict[str, tuple[str, ...]] = {"paracetamol": ("calpol", "pcm", "crocin", "dolo")}', 'GUARD_ALIASES: dict[str, tuple[str, ...]] = {}'),
 "X2 guard ignores owner names": (F, '+ list(owner_names or [])', ''),
 "X3 R1-2b single pass": (F, 'for _ in range(20):', 'for _ in range(1):'),
 "X4 lone qualifier counts": (F, 'elif len(comp) >= 2:', 'elif len(comp) >= 1:'),
 "X5 _NOT_A_NAME filter off": (F, 'if phrases and not all(set(ph) <= _NOT_A_NAME for ph in phrases):', 'if phrases:'),
 "X6 question check off": (F, 'if s.strip() and not s.strip().endswith("?") and is_red_flag(s)]', 'if s.strip() and is_red_flag(s)]'),
 "X7 red-flag cue not required": (F, 'and bool(RED_FLAG_CUE.search(sentence))', ''),
 "X8 NEGATION need-not dropped": (F, "|need\\s*n[o']?t|", '|'),
 "X9 stored-note fallback off": (F, '        if moved_in_note(moved, note):\n', '        if False:\n'),
 "X10 pipeline keeps a note naming a moved drug": (PL, '                moved_err = ["FRX-R1 note_text names a drug moved to pick_drug"]', '                moved_err = []'),
 "X11 d3 not a qualifier": (F, '"vit", "d3", "d",', '"vit", "d",'),
 "X12 guard skips molecule brands": (F, '    names += [b for b, ms in BRANDS.items() if ms in mols]\n', ''),
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
