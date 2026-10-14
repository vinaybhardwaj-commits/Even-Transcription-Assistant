"""Mutation test for translate_segments.py (invented data only). Control run first (must pass), then each mutant (must FAIL the suite). The file is restored after every run."""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "..", "translate_segments.py")
TESTS = os.path.join(HERE, "test_translate_segments.py")
MUTANTS = [
    ("und is sent", 'LANGS = ("kn", "hi", "ta", "ml", "bn", "gu", "te", "mr")', 'LANGS = ("kn", "hi", "ta", "ml", "bn", "gu", "te", "mr", "und")'),
    ("mr is dropped", 'LANGS = ("kn", "hi", "ta", "ml", "bn", "gu", "te", "mr")', 'LANGS = ("kn", "hi", "ta", "ml", "bn", "gu", "te")'),
    ("oldest date first", 'jobs.sort(key=lambda j: j["date"], reverse=True)', 'jobs.sort(key=lambda j: j["date"])'),
    ("done ignores the source sha", ' and "err" not in it and it["src_sha256"] == sha256_text(t):', ' and "err" not in it:'),
    ("a failure item counts as done", 'if it and "en" in it and "err" not in it and it["src_sha256"]', 'if it and it["src_sha256"]'),
    ("first item wins, not the last", 'last[(it["k"], it["i"])] = it', 'last.setdefault((it["k"], it["i"]), it)'),
    ("garbled lines become failures", 'if r["q"] == "mt_failed":\n            it["err"]', 'if r["q"] != "ok":\n            it["err"]'),
    ("failure reason not closed", 'it["err"] = "isolated_line_failed"', 'it["err"] = "some free text"'),
    ("failed windows leave no items", 'items, provs, models = failure_items(job, todo, e.status), [], []', 'items, provs, models = [], [], []'),
    ("minute never bumped", '                if not os.path.exists(path):\n                    break', '                if True:\n                    break'),
    ("directories not private", '        if not os.path.isdir(cur):\n            os.mkdir(cur, 0o700)\n        os.chmod(cur, 0o700)\n', '        if not os.path.isdir(cur):\n            os.mkdir(cur)\n'),
    ("max_windows ignored", 'if max_windows is not None and c["attempted"] >= max_windows:', 'if False:'),
    ("src_sha256 is of the English", 'src_sha256=sha256_text(src[r["i"]])', 'src_sha256=sha256_text(r["en"])'),
    ("record sha not stored", 'g["sources"][job["k"]] = job["rec_sha"]', 'g["sources"][job["k"]] = ""'),
    ("only the first commit bound", 'for k, v in prov.items()) or', 'for k, v in list(prov.items())[:1]) or'),
    ("model not checked in the preflight file", 'or pf.get("model_returned") != L.MODEL', ''),
    ("blank lines sent", 'isinstance(s.get("text"), str) and s["text"].strip()', 'isinstance(s.get("text"), str)'),
    ("line isolation off", 'L.translate_item(rows, send, log, isolate=True, stats=stats)', 'L.translate_item(rows, send, log, isolate=False, stats=stats)'),
    ("segment index off by one", 'for i, s in enumerate(segs):', 'for i, s in enumerate(segs, 1):'),
    ("windows without a room id kept", 'if not w.get("room_id"):', 'if False:'),
    ("k keeps runs/", 'return key[len("runs/"):-len(".json")]', 'return key[:-len(".json")]'),
    ("created_at not IST", 'created_at=now.astimezone(IST).isoformat()', 'created_at=now.isoformat()'),
    ("zdr false", 'zdr=True,', 'zdr=False,'),
    ("oldest view index chosen", 'return fs[-1]', 'return fs[0]'),
    ("hist before hist-mining", 'ROOTS = (HOME + "hist-mining/", HOME + "hist/", HOME + "lab-vault/staged/")', 'ROOTS = (HOME + "hist/", HOME + "hist-mining/", HOME + "lab-vault/staged/")'),
    ("index file not recorded", 'script_commit=script, index_file=index_name),', 'script_commit=script, index_file=None),'),
    ("A2 not bound", '"PREREG-337b-A1.md", "PREREG-337b-A2.md", "PREREG-337b-A3.md")', '"PREREG-337b-A1.md", "PREREG-337b-A3.md")'),
    ("sources renamed back to records", 'sources={k: g["sources"][k] for k in ks[n:n + MAX_K]}', 'records={k: g["sources"][k] for k in ks[n:n + MAX_K]}'),
    ("limit is 500", 'MAX_K = 400', 'MAX_K = 500'),
    ("no split", 'for n in range(0, len(ks), MAX_K):', 'for n in range(0, len(ks), max(len(ks), 1)):'),
    ("filed by the index room", 'jobs.append(dict(key=w["key"], k=k, room=room_k, date=date_k,', 'jobs.append(dict(key=w["key"], k=k, room=w["room_id"], date=w["ist_date"],'),
    ("mismatch not counted", 'stats["k_mismatch"] += 1', 'pass'),
    ("A3 not bound", '"PREREG-337b-A2.md", "PREREG-337b-A3.md")', '"PREREG-337b-A2.md")'),
    ("last flush dropped", '    c["files"] += flush(pending, ann, script, L.prompt_sha256(), clock(), index_name)\n    return dict(c)', '    return dict(c)'),
]


def run_suite():
    return subprocess.run([sys.executable, TESTS], capture_output=True, text=True, cwd=HERE).returncode


def main():
    orig = open(TARGET).read()
    assert run_suite() == 0, "CONTROL FAILED: the unmutated suite does not pass"
    print("control: suite passes on the unmutated file")
    survived = []
    try:
        for name, old, new in MUTANTS:
            assert orig.count(old) == 1, f"mutant '{name}': pattern found {orig.count(old)} times"
            open(TARGET, "w").write(orig.replace(old, new, 1))
            rc = run_suite()
            print(("killed  " if rc else "SURVIVED"), name)
            if not rc: survived.append(name)
    finally:
        open(TARGET, "w").write(orig)
    assert run_suite() == 0
    print(f"{len(MUTANTS) - len(survived)} of {len(MUTANTS)} killed")
    sys.exit(1 if survived else 0)


if __name__ == "__main__":
    main()
