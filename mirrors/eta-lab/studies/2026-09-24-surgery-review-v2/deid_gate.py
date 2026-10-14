#!/usr/bin/env python3
"""deid_gate.py — ruling 274: no real-text Jev scoring on the surgery path unless the v7.15b blanket capitalised-token rule (deid.py --cap-rule, a53717d or its successor) ran on THAT de-identified file before the pre-Jev screen.
deid_gpu.py records, per output file, {sha256 of the output, cap_rule true/false, sha256 of the deid.py that ran, cap_rule tags} in <deid_dir>/_manifest.json (0600). Every surgery-path Jev caller (build_v3.jev_one, build_v4.score,
build_v5.score, scan_pool) calls require() FIRST; it REFUSES when the manifest, the entry or the file hash is missing or wrong, or cap_rule is not true. There is no override: a file edited or regenerated after recording must be
recorded again by running deid_gpu.py --cap-rule. NOTE: cap_rule_tags counts every tag in every processed field; deid.py processes orig, en and text, and in the surgery sets orig == en, so the recorded count is 2x the tags on the English text (24-25 Sep regeneration: 950 recorded = 475 real = 18.4 per 1000 turns, #1538/#1545). The gate does not use it.
AFTER the successor freeze (ruling 316) the 84 cap-rule-only files (final-v5fresh/delta/rater deid/) FAIL this gate until regenerated with the successor.
Not gated (dev scripts, never to be run on real text): rerun_v23.py, score_v1.py, scan_anchors.py and the v*_trial / v*_fixtures / v3_devcheck scripts (invented text or old CT fixtures)."""
import hashlib, json, os, sys

MANIFEST = "_manifest.json"
# Which deid.py may have run: sha256 of the FROZEN SUCCESSOR deid.py bytes (v7.15b + partial-DOB v2: cap rule a53717d plus 2c54ce7 + 0e9d530 + d1e957b, git blob b8b793507a566fc116fd3058e95a7c5dbbc115a0; rulings 307/316, eta-refuter-2 #1691).
# REPLACED, not added to: nothing made without the successor may be used for real-text Jev scoring after the freeze. A later successor is added/replaced here only by a reviewed commit, never at run time.
FROZEN_DEID_SHA256 = "bc375f78d4f0e1bef4965fee4570e50f506003e1605a1ebbd338f8ac44678f02"
CAP_RULE_ONLY_DEID_SHA256 = "f092bf43347c51aae77d14ade3f6ac06090c74704a585d94bad1ff2497caa492"  # the earlier cap-rule-only deid.py (a53717d, blob 5527f920): REFUSED since the successor freeze
ALLOWED_DEID_SHA256 = {FROZEN_DEID_SHA256}


def file_sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def record(deid_dir, item, cap_rule, deid_py_sha, cap_tags=0):
    p = f"{deid_dir}/{MANIFEST}"
    m = json.load(open(p)) if os.path.exists(p) else {"files": {}}
    m["files"][item] = {"sha256": file_sha(f"{deid_dir}/{item}.json"), "cap_rule": bool(cap_rule), "deid_py_sha256": deid_py_sha, "cap_rule_tags": int(cap_tags)}
    json.dump(m, open(p, "w"), indent=1); os.chmod(p, 0o600)


def require(deid_dir, item):
    p = f"{deid_dir}/{MANIFEST}"
    if not os.path.exists(p):
        raise SystemExit(f"REFUSED {item}: no {MANIFEST} in {deid_dir}; de-identify with deid_gpu.py --cap-rule first (ruling 274)")
    e = json.load(open(p)).get("files", {}).get(item)
    if not e:
        raise SystemExit(f"REFUSED {item}: not recorded in {MANIFEST}; de-identify with deid_gpu.py --cap-rule first (ruling 274)")
    if e.get("cap_rule") is not True:
        raise SystemExit(f"REFUSED {item}: the cap rule did not run on this file (ruling 274)")
    if e.get("deid_py_sha256") not in ALLOWED_DEID_SHA256:
        raise SystemExit(f"REFUSED {item}: it was de-identified by a deid.py that is not the frozen one (v7.15b); re-run deid_gpu.py --cap-rule with the frozen deid.py")
    if e.get("sha256") != file_sha(f"{deid_dir}/{item}.json"):
        raise SystemExit(f"REFUSED {item}: the de-identified file changed after it was recorded; re-run deid_gpu.py --cap-rule")


def selftest():
    import tempfile
    d = tempfile.mkdtemp()
    for i in ("A", "B", "C"):
        json.dump({"turns": [{"i": 0, "en": i}]}, open(f"{d}/{i}.json", "w"))

    def refused(item):
        try:
            require(d, item)
        except SystemExit:
            return True
        return False
    assert refused("A"), "no manifest: refused"
    record(d, "A", True, FROZEN_DEID_SHA256, 3); record(d, "B", False, FROZEN_DEID_SHA256)
    assert not refused("A"), "recorded with the cap rule: allowed"
    assert refused("B"), "cap_rule false: refused"
    assert refused("C"), "file not recorded: refused"
    json.dump({"turns": [{"i": 0, "en": "edited"}]}, open(f"{d}/A.json", "w"))
    assert refused("A"), "file changed after recording: refused"
    record(d, "A", True, FROZEN_DEID_SHA256, 4); assert not refused("A"), "re-recorded: allowed again"
    record(d, "A", True, "y" * 64, 4); assert refused("A"), "cap_rule true but a deid.py that is not the frozen one: refused"
    record(d, "A", True, CAP_RULE_ONLY_DEID_SHA256, 4); assert refused("A"), "the cap-rule-only deid.py (no date rule) is refused after the successor freeze"
    record(d, "A", True, None, 4); assert refused("A"), "no deid.py hash recorded: refused"
    record(d, "A", True, FROZEN_DEID_SHA256, 4); assert not refused("A")
    assert oct(os.stat(f"{d}/{MANIFEST}").st_mode & 0o777) == "0o600"
    m = json.load(open(f"{d}/{MANIFEST}")); m["files"]["A"]["cap_rule"] = "yes"; json.dump(m, open(f"{d}/{MANIFEST}", "w"))
    assert refused("A"), "cap_rule must be exactly true, not a truthy string"
    # the constant must be the sha256 of the deid.py that sits next to this file (the landed successor): a mistyped or stale constant is caught here
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "deid.py")
    assert file_sha(here) == FROZEN_DEID_SHA256, "FROZEN_DEID_SHA256 does not equal the sha256 of the deid.py in this directory (land the successor first, or the constant is wrong)"
    print("deid_gate selftest OK: no manifest / unrecorded / cap_rule false / changed file / truthy-string / a deid.py other than the frozen one are refused; recorded with the rule is allowed; manifest 0600")


if __name__ == "__main__":
    selftest() if sys.argv[1:] == ["--selftest"] else print(__doc__)
