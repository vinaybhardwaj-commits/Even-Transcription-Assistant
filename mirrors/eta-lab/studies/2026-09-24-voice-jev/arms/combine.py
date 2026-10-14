"""Combine rules (COMBINE_RULE.md). The rule FILE is the source of truth: the threshold is parsed from it and its sha256 is verified before use."""
import re
import common as C

DOCTOR, NOT_DOCTOR, UNSURE = "doctor", "not_doctor", "unsure"


def load_rule(path, expect_sha):
    """Refuse to combine unless the rule file's sha256 equals the one that was posted before real data."""
    full = C.sha256_file(path)
    if expect_sha and not full.startswith(expect_sha.lower()):
        raise SystemExit(f"combine rule sha {full[:12]} != expected {expect_sha}: the rule changed after it was hashed")
    m = re.search(r"^CONF_THRESHOLD = ([0-9.]+)\s*$", open(path).read(), re.M)
    if not m: raise SystemExit("CONF_THRESHOLD line missing from the rule file")
    return {"sha256": full, "conf_threshold": float(m.group(1))}


def q1_to_final(q1, threshold):
    """R3.2: choice != cannot_tell and confidence >= threshold -> doctor/not_doctor (D3), else UNSURE."""
    if not q1 or q1.get("choice") in (None, "cannot_tell"): return UNSURE
    conf = q1.get("confidence")
    if conf is None or conf < threshold: return UNSURE
    return DOCTOR if q1["choice"] == "doctor" else NOT_DOCTOR


def l1_to_final(row):
    """R4.2."""
    return {"marked_middle_speaker": DOCTOR, "not_marked_middle_speaker": NOT_DOCTOR}.get((row or {}).get("answer"), UNSURE)


def raw_final(arm, out_row, rule):
    """The arm's own answer on a turn, before combining with arm 1 (UNSURE when missing or errored)."""
    if not out_row or "error" in out_row: return UNSURE
    return l1_to_final(out_row) if arm == 4 else q1_to_final(out_row.get("q1"), rule["conf_threshold"])


def combine(arm, a1, out_row, rule):
    """R3.1 / R4.1: CONFIDENT keeps arm 1. DOUBTFUL takes the arm's answer, else UNSURE."""
    if not a1["doubtful"]: return DOCTOR if a1["is_doctor"] else NOT_DOCTOR
    return raw_final(arm, out_row, rule)
