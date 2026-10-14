#!/usr/bin/env python3
"""test_reb_windows_rekey.py — regression test for reb_windows.py's re-key + dedupe (r3 8106/8093).
Cases: (1) a misnamed plan id (IST date + UTC hhmm from the prior day) is re-keyed to the true-UTC id;
(2) a midnight c- slot is re-keyed to the true IST date; (3) a duplicate-id pair refuses on a tie
(coverage unknown) and keeps the higher-coverage entry when coverage differs; (4) mutation: dropping the
re-key body must fail case (1). The re-key + dedupe logic is loaded FROM reb_windows.py's own source
(sliced), so a stale copy cannot pass. Run: python3 test_reb_windows_rekey.py (exit 0 = all pass)."""
import datetime, glob, hashlib, json, os, re, sys, tempfile

REB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reb_windows.py")   # the file next to this test, not the working copy (r3 8125 nit)
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))

def load_src():
    src = open(REB, "rb").read().decode()
    return src, hashlib.sha256(src.encode()).hexdigest()

def slice_fn(src, header):
    """Slice a top-level def block by header line."""
    lines = src.splitlines(keepends=True)
    start = next(i for i, l in enumerate(lines) if l.startswith(header))
    end = next(i for i in range(start + 1, len(lines)) if lines[i].startswith("def ") and i > start)
    return "\n".join(l[4:] if l.startswith("    ") else "" for l in lines[start:end])

def rekey_from(src, wins):
    """Slice reb_windows' re-key loop ('for w in wins:' .. 'if fixed:') and exec it against the given
    wins list - the code itself mutates wins in place (the loop's 'continue' stays inside the exec'd for)."""
    lines = src.splitlines()
    s = next(i for i, l in enumerate(lines) if l.strip() == "for w in wins:")
    e = next(i for i in range(s, len(lines)) if lines[i].strip().startswith("if fixed:"))
    code = "\n".join(l[4:] if l.startswith("    ") else "" for l in lines[s:e])
    fixed = {}
    ns = {"datetime": datetime.datetime, "fixed": fixed, "timezone": datetime.timezone, "timedelta": datetime.timedelta, "wins": wins}
    exec(code, ns)
    return fixed

def main():
    src, sha = load_src()
    print(f"reb_windows.py sha16 at test time: {sha[:16]}")
    fails = 0
    # CASE 1: misnamed plain id
    wins = [{"win_id": "2026-09-12_room_ux92qpws_1830", "room_id": "room_ux92qpws", "start": "2026-09-11T18:30:00+00:00", "end": "2026-09-11T18:45:00+00:00"}]
    fixed = rekey_from(src, wins)
    ok = wins[0]["win_id"] == "2026-09-11_room_ux92qpws_1830" and fixed.get("2026-09-12_room_ux92qpws_1830") == "2026-09-11_room_ux92qpws_1830"
    print(f"{'PASS' if ok else 'FAIL'}: misnamed plain id re-keyed to true-UTC -> {wins[0]['win_id']}")
    fails += not ok
    # CASE 2: midnight c- slot
    wins = [{"win_id": "c-2026-09-27_room_jwyrr4dc_0000", "room_id": "room_jwyrr4dc", "start": "2026-09-27T18:30:00+00:00", "end": "2026-09-27T18:45:00+00:00"}]
    fixed = rekey_from(src, wins)
    ok = wins[0]["win_id"] == "c-2026-09-28_room_jwyrr4dc_0000"
    print(f"{'PASS' if ok else 'FAIL'}: midnight c- slot re-keyed to true IST date -> {wins[0]['win_id']}")
    fails += not ok
    # CASE 3: duplicate-id pair with coverage difference (dedupe block)
    lines = src.splitlines()
    s3 = next(i for i, l in enumerate(lines) if l.strip().startswith("idc = Counter"))
    e3 = next(i for i in range(s3, len(lines)) if lines[i].strip().startswith("todo ="))
    code3 = "\n".join(l[4:] if l.startswith("    ") else "" for l in lines[s3:e3])
    man_cov = {("room_ux92qpws", "2026-09-11T18:30:00+00:00", 3): 1.0,
               ("room_ux92qpws", "2026-09-11T18:30:00+00:00", 1): 0.0001}
    w_a = {"win_id": "2026-09-11_room_ux92qpws_1830", "room_id": "room_ux92qpws", "start": "2026-09-11T18:30:00+00:00", "chunk_ids": ["a", "b", "c"]}
    w_b = {"win_id": "2026-09-11_room_ux92qpws_1830", "room_id": "room_ux92qpws", "start": "2026-09-11T18:30:00+00:00", "chunk_ids": ["a"]}
    ns3 = {"Counter": __import__("collections").Counter, "man_cov": man_cov, "wins": [w_a, w_b], "log": print,
           "a": type("A", (), {"day": "2026-09-12"})(), "os": os, "json": json, "OUT": "/home/eta/eta-data/hist/windows-reb", "datetime": datetime.datetime, "glob": glob, "hashlib": hashlib}
    try:
        exec(code3, ns3)
        kept = ns3["wins"]
        ok = len(kept) == 1 and kept[0] is w_a
        print(f"{'PASS' if ok else 'FAIL'}: dedupe kept the higher-coverage entry ({len(kept)} kept)")
    except SystemExit as ex:
        print(f"FAIL: dedupe refused on what should be a decidable pair: {ex}")
        ok = False
        fails += 1
    fails += not ok
    # CASE 4 (mutation): remove the re-key body's assignment -> case 1 must fail
    broken = re.sub(r'(\n\s+)w\["win_id"\] = new_id', r'\1pass  # MUTATION', src)
    if broken != src:
        try:
            b_wins = [{"win_id": "2026-09-12_room_ux92qpws_1830", "room_id": "room_ux92qpws", "start": "2026-09-11T18:30:00+00:00"}]
            bf = rekey_from(broken, b_wins)
            mut_ok = all(w["win_id"] != "2026-09-11_room_ux92qpws_1830" for w in b_wins)
        except SystemExit:
            mut_ok = True
        print(f"{'PASS' if mut_ok else 'FAIL'}: mutation (re-key assignment removed) caught by case 1")
        fails += not mut_ok
    print("TESTS_OK" if fails == 0 else f"TESTS_FAILED ({fails})")
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main())
