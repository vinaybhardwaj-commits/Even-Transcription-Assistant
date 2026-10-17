"""Project P-SYN script truth onto Nemotron labels, in the fa-check truth format. Offline; counts only on stdout.

Schema source: eval/pdqi9/psyn/schema.py (cloud-psyn-gen/v1, eb08e73). A script.json holds
  speakers[{speaker_id, role, is_treating, intended_diar_label (L0, L1, ...)}] and
  turns[{turn_id, speaker_id, est_seconds, overlap_with, ...}].
role is one of treating_doctor, other_clinician, staff, translator, patient, attender; exactly one speaker has
is_treating == true and that speaker's role is treating_doctor.

Inputs
  --scripts-dir DIR   every script.json under DIR (the generator's dev/ and test/ output)
  --nemotron FILE     jsonl {consult_id, label, t0_ms, t1_ms}: the box's Nemotron segments for each synthetic consult;
                      consult_id is the script_id
  --turn-times FILE   jsonl {consult_id, turn_id, t0_ms, t1_ms}: where each script turn actually sits in the audio
  --est-timeline      instead of --turn-times: place turns back to back by est_seconds (a turn with overlap_with starts
                      where the turn it overlaps starts). A rough stand-in when no turn times exist.
Output (jsonl, mode 0600) {consult_id, label, true_role}, one row per (consult, Nemotron label):
  each label takes the truth role holding the majority of its overlapped ms. If no role holds 60% or more, or the
  label overlaps no turn, it is "mixed". Only the is_treating speaker is ever "doctor".
  true_role in doctor | patient | attender | staff | translator | other_clinician | mixed

  python3 tools/encounter_brief/psyn_truth.py --scripts-dir D --nemotron N.jsonl (--turn-times T.jsonl | --est-timeline) --out truth.jsonl
"""
import argparse
import json
import os
import sys

MAJORITY = 0.6
DOCTOR_LIKE = {"doctor", "treating_doctor", "physician", "consultant", "surgeon", "resident", "registrar", "clinician", "other_clinician", "specialist", "dr"}
ROLE_MAP = {"patient": "patient", "attender": "attender", "staff": "staff", "translator": "translator", "other_clinician": "other_clinician"}


def norm(x):
    return "" if x is None else str(x).strip().lower()


def speaker_roles(script):
    """{speaker_id: true_role}. Raises ValueError unless exactly one is_treating speaker holds role treating_doctor."""
    roles, n_treat = {}, 0
    for s in script["speakers"]:
        role, treating = norm(s["role"]), s.get("is_treating") is True
        if treating != (role == "treating_doctor"):
            raise ValueError("is_treating and role disagree")
        n_treat += treating
        roles[s["speaker_id"]] = "doctor" if treating else ROLE_MAP.get(role, "other_clinician" if role in DOCTOR_LIKE else "other")
    if n_treat != 1:
        raise ValueError("a script needs exactly one treating speaker")
    return roles


def est_timeline(script):
    """{turn_id: (t0_ms, t1_ms)}: back to back by est_seconds; an overlapping turn starts with the turn it overlaps.
    A forward or unknown overlap_with is refused (S2) rather than silently treated as back to back."""
    pos, out = 0.0, {}
    for t in script["turns"]:
        ov = t.get("overlap_with")
        if ov is not None and ov not in out:
            raise ValueError("overlap_with names a later or unknown turn")
        start = out[ov][0] / 1000.0 if ov is not None else pos
        end = start + float(t["est_seconds"])
        out[t["turn_id"]] = (int(round(start * 1000)), int(round(end * 1000)))
        pos = max(pos, end)
    return out


def project(script, times, segs):
    """times {turn_id: (t0, t1)}, segs [(label, t0, t1)] -> ({label: true_role}, n_no_overlap)."""
    roles = speaker_roles(script)
    turn_role = {}
    for t in script["turns"]:
        if t["speaker_id"] not in roles:
            raise ValueError("turn speaker is not in the speaker list")
        if t["turn_id"] in times:
            turn_role[t["turn_id"]] = roles[t["speaker_id"]]
    ms = {}
    for lab, a, b in segs:
        ms.setdefault(lab, {})
        for tid, (x, y) in times.items():
            o = min(b, y) - max(a, x)
            if o > 0 and tid in turn_role:
                ms[lab][turn_role[tid]] = ms[lab].get(turn_role[tid], 0) + o
    out, none = {}, 0
    for lab, d in ms.items():
        tot = sum(d.values())
        if not tot:
            out[lab], none = "mixed", none + 1
            continue
        role, top = sorted(d.items(), key=lambda kv: (-kv[1], kv[0]))[0]
        out[lab] = role if top / tot >= MAJORITY else "mixed"
    return out, none


def read_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def run(scripts_dir, nem_path, turn_times_path, use_est):
    if bool(turn_times_path) == bool(use_est):
        raise ValueError("give exactly one of --turn-times and --est-timeline")
    scripts = {}
    for root, _, files in os.walk(scripts_dir):
        if "script.json" in files:
            with open(os.path.join(root, "script.json")) as f:
                d = json.load(f)
            scripts[d["script_id"]] = d
    segs = {}
    for r in read_jsonl(nem_path):
        segs.setdefault(r["consult_id"], []).append((r["label"], r["t0_ms"], r["t1_ms"]))
    if set(segs) - set(scripts):
        raise ValueError("a Nemotron consult has no script")
    tt = {}
    if turn_times_path:
        for r in read_jsonl(turn_times_path):
            tt.setdefault(r["consult_id"], {})[r["turn_id"]] = (r["t0_ms"], r["t1_ms"])
    rows, counts = [], {"consults": 0, "labels": 0, "no_overlap_labels": 0}
    for cid in sorted(segs):
        times = est_timeline(scripts[cid]) if use_est else tt.get(cid)
        if not times:
            raise ValueError("a consult has Nemotron segments but no turn times")
        if not use_est:  # S1: a dropped turn can flip a majority, so refuse instead of projecting short
            missing = sum(1 for t in scripts[cid]["turns"] if t["turn_id"] not in times)
            if missing:
                raise ValueError(f"{missing} script turns missing from the turn times")
        roles, none = project(scripts[cid], times, segs[cid])
        counts["consults"] += 1
        counts["no_overlap_labels"] += none
        for lab in sorted(roles):
            rows.append({"consult_id": cid, "label": lab, "true_role": roles[lab]})
            counts["labels"] += 1
            counts[roles[lab]] = counts.get(roles[lab], 0) + 1
    return rows, counts


def main(argv=None):
    p = argparse.ArgumentParser(prog="psyn_truth")
    p.add_argument("--scripts-dir", required=True)
    p.add_argument("--nemotron", required=True)
    p.add_argument("--turn-times", default=None)
    p.add_argument("--est-timeline", action="store_true")
    p.add_argument("--out", required=True)
    a = p.parse_args(argv)
    try:
        rows, counts = run(a.scripts_dir, a.nemotron, a.turn_times, a.est_timeline)
    except (ValueError, KeyError, OSError) as e:
        print("error: cannot project truth (" + type(e).__name__ + "): " + str(e).split(":")[0][:80], file=sys.stderr)
        return 2
    fd = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("".join(json.dumps(r, sort_keys=True) + "\n" for r in rows))
    print(json.dumps(counts, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
