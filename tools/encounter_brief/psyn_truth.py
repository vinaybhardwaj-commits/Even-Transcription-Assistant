"""Turn raw P-SYN truth rows into the fa-check truth format. Offline; counts only on stdout.

Raw rows (jsonl): {consult_id, label, role, treating_doctor?}
  role: any word. treating_doctor: true only on the one label that is the logged-in doctor.
Output rows (jsonl, mode 0600): {consult_id, label, true_role}, true_role in
  doctor | patient | attender | staff | translator | other | other_clinician

Mapping rules (when in doubt, never "doctor"):
  - "doctor" is written only for a row with treating_doctor == true, and at most one such row per consult.
  - a doctor-like word (doctor, physician, consultant, surgeon, resident, registrar, other_clinician, ...) on any other row
    becomes other_clinician. A treating_doctor row whose role word is not doctor-like is a contradiction: the run refuses (exit 2).
  - patient -> patient; attender/attendant/relative/family/caregiver -> attender; staff/nurse/receptionist/technician -> staff;
    translator/interpreter -> translator; every other word -> other.

  python3 tools/encounter_brief/psyn_truth.py --in raw.jsonl --out truth.jsonl
"""
import argparse
import json
import os
import sys

DOCTOR_LIKE = {"doctor", "physician", "consultant", "surgeon", "resident", "registrar", "clinician", "other_clinician", "other clinician", "specialist", "dr"}
MAP = {
    "patient": "patient",
    "attender": "attender", "attendant": "attender", "relative": "attender", "family": "attender", "caregiver": "attender",
    "staff": "staff", "nurse": "staff", "receptionist": "staff", "technician": "staff",
    "translator": "translator", "interpreter": "translator",
}


def norm(x):
    return "" if x is None else str(x).strip().lower()


def map_rows(rows):
    """Return (truth rows, counts). Raises ValueError on a contradiction."""
    out, treating, n_other_clin, n_unknown = [], {}, 0, 0
    for r in rows:
        cid, lab, role = r["consult_id"], r["label"], norm(r.get("role"))
        is_treating = r.get("treating_doctor") is True
        if is_treating:
            if role not in DOCTOR_LIKE:
                raise ValueError("treating_doctor row has a non-doctor role word")
            if cid in treating:
                raise ValueError("more than one treating doctor in a consult")
            treating[cid] = lab
            true = "doctor"
        elif role in DOCTOR_LIKE:
            true = "other_clinician"
            n_other_clin += 1
        elif role in MAP:
            true = MAP[role]
        else:
            true = "other"
            n_unknown += 1
        out.append({"consult_id": cid, "label": lab, "true_role": true})
    return out, {"rows": len(out), "doctor": len(treating), "other_clinician": n_other_clin, "other_unknown_word": n_unknown}


def main(argv=None):
    p = argparse.ArgumentParser(prog="psyn_truth")
    p.add_argument("--in", dest="src", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args(argv)
    try:
        with open(a.src) as f:
            rows = [json.loads(line) for line in f if line.strip()]
        out, counts = map_rows(rows)
    except (ValueError, KeyError, OSError) as e:
        print("error: cannot map truth (" + type(e).__name__ + ")", file=sys.stderr)
        return 2
    fd = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("".join(json.dumps(r, sort_keys=True) + "\n" for r in out))
    print(json.dumps(counts, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
