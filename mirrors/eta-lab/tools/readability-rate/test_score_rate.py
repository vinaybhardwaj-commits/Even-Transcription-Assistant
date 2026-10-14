#!/usr/bin/env python3
"""Tests for score_rate.py refusal paths (invented fixtures only; never touches the real seed).
Run: python3 test_score_rate.py"""
import hashlib, json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = {f"E{i}": {"indic": i % 2 == 0, "has_en": i % 3 == 0} for i in range(1, 5)}

def ans(i, readable="yes"):
    a = {"readable": readable if i % 4 else "no", "useful": "yes", "wrong_lang": "no", "garbled": "none"}
    if KEY[f"E{i}"]["has_en"]:
        a["en_ok"] = "yes"
    return a

def run(raters, seed_bytes=b'{"excerpts":[]}', extra=None, pin=None):
    d = tempfile.mkdtemp(prefix="srtest-")
    try:
        json.dump(KEY, open(os.path.join(d, "key.json"), "w"))
        open(os.path.join(d, "seed_docs.json"), "wb").write(seed_bytes)
        exp = os.path.join(d, "exp")
        os.makedirs(exp)
        for name, t in raters.items():
            json.dump(t, open(os.path.join(exp, name + ".json"), "w"))
        cmd = [sys.executable, os.path.join(HERE, "score_rate.py"),
               "--key", os.path.join(d, "key.json"), "--ratings", exp,
               "--seed-sha", pin if pin is not None else hashlib.sha256(seed_bytes).hexdigest()]
        if extra:
            cmd += extra
        return subprocess.run(cmd, capture_output=True, text=True)
    finally:
        shutil.rmtree(d)

def check(name, out, want_fail, needle):
    ok = (out.returncode != 0) == want_fail and needle in out.stdout + out.stderr
    print(("PASS " if ok else "FAIL ") + name)
    if not ok:
        print((out.stdout + out.stderr)[:400])
    return ok

good_vin = {f"E{i}": ans(i) for i in range(1, 5)}
good_sand = {f"E{i}": ans(i, "partly") for i in range(1, 5)}
allok = True
allok &= check("happy 2 raters", run({"vinay": good_vin, "sandhya": good_sand}),
               False, "agreement vinay vs sandhya")
allok &= check("vinay not first alphabetically still PRIMARY",
               run({"zzz_aardvark": good_vin, "vinay": good_sand}), False, "vinay (PRIMARY)")
allok &= check("no vinay -> refuse", run({"aa": good_vin, "bb": good_sand}), True, "no vinay")
allok &= check("3 raters -> refuse", run({"vinay": good_vin, "sandhya": good_sand, "x": good_vin}),
               True, "3 raters")
allok &= check("1 rater -> refuse", run({"vinay": good_vin}), True, "1 raters")
allok &= check("1 rater interim ok", run({"vinay": good_vin}, extra=["--allow-partial"]),
               False, "vinay (PRIMARY)")
bad = json.loads(json.dumps(good_vin)); bad["E99"] = bad["E1"]
allok &= check("unknown id refuses the RUN", run({"vinay": bad, "sandhya": good_sand}),
               True, "not in the pinned seed")
miss = json.loads(json.dumps(good_sand)); del miss["E2"]["useful"]
allok &= check("missing mandatory = row refused, run scores",
               run({"vinay": good_vin, "sandhya": miss}), False, "1 refused rows")
badv = json.loads(json.dumps(good_sand)); badv["E2"]["readable"] = "maybe"
allok &= check("invalid value = row refused", run({"vinay": good_vin, "sandhya": badv}),
               False, "bad readable")
eno = json.loads(json.dumps(good_sand)); eno["E2"]["en_ok"] = "yes"
allok &= check("en_ok without English = row refused", run({"vinay": good_vin, "sandhya": eno}),
               False, "en_ok without English")
unk = json.loads(json.dumps(good_sand)); unk["E2"]["junk"] = "x"
allok &= check("unknown key = row refused", run({"vinay": good_vin, "sandhya": unk}),
               False, "unknown key")
vin_m = {e: {**good_vin[e], "mode": "text"} for e in good_vin}
sand_m = {e: {**good_sand[e], "mode": "audio" if i % 2 else "text"} for i, e in enumerate(good_sand)}
allok &= check("mode accepted + separate report", run({"vinay": vin_m, "sandhya": sand_m}),
               False, "mode audio (n=")
badm = json.loads(json.dumps(good_sand)); badm["E2"]["mode"] = "loud"
allok &= check("bad mode = row refused", run({"vinay": good_vin, "sandhya": badm}), False, "bad mode")
allok &= check("seed drift -> refuse", run({"vinay": good_vin, "sandhya": good_sand},
                                           seed_bytes=b"aaa",
                                           pin=hashlib.sha256(b"bbb").hexdigest()),
               True, "seed drift")
d = tempfile.mkdtemp(prefix="srtest-")
try:
    json.dump(KEY, open(os.path.join(d, "key.json"), "w"))
    exp = os.path.join(d, "exp"); os.makedirs(exp)
    json.dump(good_vin, open(os.path.join(exp, "vinay.json"), "w"))
    out = subprocess.run([sys.executable, os.path.join(HERE, "score_rate.py"),
                          "--key", os.path.join(d, "key.json"), "--ratings", exp],
                         capture_output=True, text=True)
finally:
    shutil.rmtree(d)
allok &= check("no seed_docs beside key -> refuse", out, True, "cannot be verified")
print("ALL PASS" if allok else "SOME FAILED")
sys.exit(0 if allok else 1)
