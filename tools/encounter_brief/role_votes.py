"""Encounter Brief phase 0a: role_votes.v1 builder (library plus CLI).

Offline and file-driven. Ported from the record-only arm (c) code (merge_c.py vote logic); the audio-embedding stage is
not ported, per-label vectors are an input. No network, no DB, nothing from lib/ or app/.

Label space is the bundle's Nemotron `speaker_N` labels. The app spkN mapping (OQ-3) is deferred.

Modes (all print counts only):
  build      write one role_votes.v1.json per consult under --out-dir (mode 0600)
  reproduce  count consults with zero order-capable segments, read back from --in-dir
  fa-check   needs --truth; counts voiceprint matches and order-capable labels whose true role is not the treating doctor; exit 1 if > 0, 2 if refused
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
import re
import stat
import sys

import numpy as np

COS_MIN, MARGIN_MIN = 0.65, 0.05
P_DOC, P_BLOCK, SHARE_BLOCK = 0.6, 0.6, 0.6
EPS = 1e-9  # float slack for the new rule only; armc_old stays raw like merge_c
KEYS = ["p_doctor", "p_patient", "p_attender", "p_staff"]
ROLES = ["doctor", "patient", "attender", "staff"]
KNOWN_ROLES = {"doctor", "patient", "attender", "staff", "translator", "other"}
TRUE_ROLES = KNOWN_ROLES
SEG_BLOCK_MS = 2000
CLEF_SET = "timbre-role-v1"
SCHEMA = "role_votes.v1"
OUT_NAME = "role_votes.v1.json"
CASE_LOG = {1: None, 2: "voiceprint_unconfirmed", 3: "arm_c_only", 4: "both", 5: "doctor_conflict", 6: "rule_a_only", 7: "case7_no_voiceprint"}


# ---------------------------------------------------------------- loading

def code_sha256():
    with open(os.path.abspath(__file__), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / (np.linalg.norm(v) + 1e-12)


def load_centroids(path):
    with open(path, "rb") as f:
        raw = f.read()
    out = {}
    for c in json.loads(raw):
        v = np.frombuffer(base64.b64decode(c["b64"]), dtype=np.float32).astype(np.float64)
        out[c["pulse_doctor_uid"]] = v / (np.linalg.norm(v) + 1e-12)
    return out, hashlib.sha256(raw).hexdigest()


def read_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def per_label_p(rows):
    """merge_c.per_label_p: first row per (consult, slot) with a non-null p_doctor."""
    out = {}
    for r in rows:
        k = (r["consult_id"], r["slot"])
        if r.get("p_doctor") is not None and k not in out:
            out[k] = [0.0 if r.get(x) is None else float(r[x]) for x in KEYS]
    return out


def norm_role(x):
    return "" if x is None else str(x).strip().lower()


class ConsultIn:
    def __init__(self):
        self.vecs = {}             # label -> vector
        self.vecs_present = False  # consult appears in the vecs file (F2)
        self.uid_present = False   # consult appears in the doctor-uids file (F2)
        self.doctor_uid = None
        self.clef_slot_present = False
        self.clef_slot = None
        self.jev_p = {}            # label -> [4]
        self.clef_p = {}
        self.jev_nd = {}           # label -> max non-doctor p over ALL its rows (F8)
        self.clef_nd = {}
        self.timeline = []         # (label, t0_ms, t1_ms), unique
        self.jev_rows = 0
        self.role_segments = []    # (t0_ms, t1_ms, role, p|None)


def load_inputs(vecs_path, doctor_uids_path, clef_votes_path, jev_votes_path, clef_slot_path, role_segments_path):
    ins = {}

    def get(cid):
        return ins.setdefault(cid, ConsultIn())

    with open(vecs_path) as f:
        for cid, labs in json.load(f).items():
            c = get(cid)
            c.vecs, c.vecs_present = {lab: unit(v) for lab, v in labs.items()}, True
    with open(doctor_uids_path) as f:
        for cid, uid in json.load(f).items():
            c = get(cid)
            c.doctor_uid, c.uid_present = uid or None, True
    with open(clef_slot_path) as f:
        for cid, slot in json.load(f).items():
            c = get(cid)
            c.clef_slot_present, c.clef_slot = True, slot
    clef_rows, jev_rows = read_jsonl(clef_votes_path), read_jsonl(jev_votes_path)
    seen = set()
    for r in clef_rows + jev_rows:
        k = (r["consult_id"], r["slot"], r["t0_ms"], r["t1_ms"])
        if k not in seen:
            seen.add(k)
            get(r["consult_id"]).timeline.append((r["slot"], r["t0_ms"], r["t1_ms"]))
    for r in jev_rows:
        get(r["consult_id"]).jev_rows += 1
    for rows, attr in ((clef_rows, "clef_nd"), (jev_rows, "jev_nd")):
        for r in rows:
            if r.get("p_doctor") is not None:
                nd = max(0.0 if r.get(x) is None else float(r[x]) for x in KEYS[1:])
                d = getattr(get(r["consult_id"]), attr)
                d[r["slot"]] = max(d.get(r["slot"], 0.0), nd)
    for (cid, lab), p in per_label_p(clef_rows).items():
        get(cid).clef_p[lab] = p
    for (cid, lab), p in per_label_p(jev_rows).items():
        get(cid).jev_p[lab] = p
    with open(role_segments_path) as f:
        if role_segments_path.endswith(".jsonl"):
            rows = [json.loads(line) for line in f if line.strip()]
        else:
            d = json.load(f)
            rows = d if isinstance(d, list) else [dict(r, consult_id=cid) for cid, rs in d.items() for r in rs]
    for r in rows:
        role = norm_role(r.get("role"))
        if role:
            p = r.get("p")
            get(r["consult_id"]).role_segments.append((r["t0_ms"], r["t1_ms"], role, None if p is None else float(p)))
    return ins


# ---------------------------------------------------------------- logic

def merge_intervals(iv):
    out = []
    for a, b in sorted(iv):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def place_roles(timeline, role_segments):
    """Place each role segment on the label with the largest time overlap.
    Returns ({label: {role: ms}}, n_unplaceable, {label: [(segment_ms, role, p)]}).
    Zero overlap or a tie for the largest = unplaceable."""
    by = {}
    for lab, a, b in timeline:
        by.setdefault(lab, []).append((a, b))
    by = {lab: merge_intervals(iv) for lab, iv in by.items()}
    ms, bad, segs = {}, 0, {}
    for a, b, role, p in role_segments:
        ov = {}
        for lab, ivs in by.items():
            o = sum(max(0, min(b, y) - max(a, x)) for x, y in ivs)
            if o > 0:
                ov[lab] = o
        if not ov:
            bad += 1
            continue
        top = max(ov.values())
        winners = [lab for lab, o in ov.items() if o == top]
        if len(winners) > 1:
            bad += 1
            continue
        ms.setdefault(winners[0], {})
        ms[winners[0]][role] = ms[winners[0]].get(role, 0) + top
        segs.setdefault(winners[0], []).append((b - a, role, p))
    return ms, bad, segs


def treating_old(vecs, cen, duid):
    """merge_c.treating(): label whose cos to the logged-in doctor >= COS_MIN and best - runner-up label >= MARGIN."""
    if not duid or duid not in cen or not vecs:
        return None
    sims = sorted(((float(unit(v) @ cen[duid]), lab) for lab, v in vecs.items()), reverse=True)
    b, lab = sims[0]
    r = sims[1][0] if len(sims) > 1 else None
    if b < COS_MIN:
        return None
    if r is not None and b - r < MARGIN_MIN:
        return None
    return lab


def voiceprint_stats(vecs, cen, duid):
    """Per label: (cos, margin_next_label, margin_runner_up_centroid). None margin = no comparator exists."""
    D = cen[duid]
    cos = {lab: float(unit(v) @ D) for lab, v in vecs.items()}
    others = [(u, C) for u, C in cen.items() if u != duid]
    out = {}
    for lab, v in vecs.items():
        nl = [c for l2, c in cos.items() if l2 != lab]
        mnl = cos[lab] - max(nl) if nl else None
        oc = [float(unit(v) @ C) for _, C in others]
        mrc = cos[lab] - max(oc) if oc else None
        out[lab] = (cos[lab], mnl, mrc)
    return out


def vp_match(cos, mnl, mrc):
    """Spec 5.6: next-label margin vacuous when alone; a one-centroid set (no runner-up) abstains."""
    return cos >= COS_MIN - EPS and (mnl is None or mnl >= MARGIN_MIN - EPS) and (mrc is not None and mrc >= MARGIN_MIN - EPS)


def resolve_order(three, armc, v, vp_state):
    """Ruling 6 with the F2 rule. three: labels where all three voters say doctor. armc: armc_new label or None.
    v: voiceprint_match_label or None. vp_state: "ok" (check ran), "unavailable" (no uid, no enrolment or an empty
    vector set: case 7 applies), "missing" (consult absent from the uid or vector file: nothing orders).
    Returns (order_capable list, case 1..7 or None, extra flags)."""
    three = sorted(three)
    if vp_state == "missing":
        return [], None, ["voiceprint_missing"]
    if vp_state != "ok":
        if len(three) == 1:
            return three, 7, []
        return [], (None if len(three) > 1 else 1), (["multiple_3of3"] if len(three) > 1 else [])
    if len(three) == 0:
        if armc:
            return [armc], 3, []
        return [], (2 if v else 1), []
    if len(three) == 1:
        a = three[0]
        if v and v != a:
            return [], 5, []
        return [a], (4 if armc == a else 6), []
    if armc in three:
        return [armc], None, ["multiple_3of3"]
    return [], None, ["multiple_3of3"]


def jev_vote(p):
    """F6: a role is called only when its p >= P_DOC and strictly exceeds every other p. Ties are not doctor."""
    top = max(p)
    if top >= P_DOC and sum(1 for x in p if x == top) == 1:
        return ROLES[p.index(top)]
    return None


def compute_consult(cin, cen, cid=None):
    """Return the consult's role_votes.v1 dict minus metadata."""
    labels = sorted({lab for lab, _, _ in cin.timeline} | set(cin.vecs) | set(cin.jev_p) | set(cin.clef_p))
    n_seg = {lab: 0 for lab in labels}
    for lab, _, _ in cin.timeline:
        n_seg[lab] += 1
    degraded, flags = [], []

    # voiceprint availability (F2): absent from a file is "missing", an explicit null or empty entry is "unavailable"
    missing = not cin.uid_present or not cin.vecs_present
    if missing:
        degraded.append("voiceprint_missing")
    else:
        if not cin.doctor_uid:
            degraded.append("no_doctor_uid")
        elif cin.doctor_uid not in cen:
            degraded.append("no_enrolment")
        if not cin.vecs:
            degraded.append("no_vectors")
    vp_ok = not degraded
    vp_state = "ok" if vp_ok else ("missing" if missing else "unavailable")

    # role layer placement and mapping status
    role_segments = [(a, b, norm_role(r), p) for a, b, r, p in cin.role_segments if norm_role(r)]
    ms, n_bad, seg_roles = place_roles(cin.timeline, role_segments)
    no_data = [name for name, has in (("role_track", bool(role_segments)), ("jev", bool(cin.jev_rows)), ("clef", cin.clef_slot_present)) if not has]
    if no_data:
        mapping = {"status": "failed", "app_labels": {}, "reason": "voter_no_data:" + "+".join(no_data)}
        degraded.append("mapping_failed")
    elif n_bad:
        mapping = {"status": "ambiguous", "app_labels": {}, "reason": "role_segment_unplaceable"}
        degraded.append("mapping_ambiguous")
    else:
        mapping = {"status": "clean", "app_labels": {}, "reason": None}
    clean = mapping["status"] == "clean"
    if any(r[2] not in KNOWN_ROLES for r in role_segments):
        flags.append("unknown_role_word")

    stats = voiceprint_stats(cin.vecs, cen, cin.doctor_uid) if vp_ok else {}
    t_old = treating_old(cin.vecs, cen, cin.doctor_uid) if vp_ok else None
    # F7: with other labels present, every label needs a vector or the next-label margin is not computable
    incomplete = vp_ok and len(labels) > 1 and any(l not in cin.vecs for l in labels)
    if incomplete:
        flags.append("next_label_margin_incomplete")

    jev_rank = {lab: i + 1 for i, lab in enumerate(sorted(cin.jev_p, key=lambda l: (-cin.jev_p[l][0], l)))}
    out_labels, three, armc_new_l, v_label, routes = [], [], None, None, {}
    for lab in labels:
        # voter 1: role layer majority by speech time; only the exact word "doctor" is doctor (F1)
        rm = ms.get(lab, {})
        if rm:
            tot = sum(rm.values())
            role, rms = sorted(rm.items(), key=lambda kv: (-kv[1], kv[0]))[0]
            r1 = {"role": role, "share": rms / tot, "status": "ok"}
        else:
            r1 = {"role": None, "share": None, "status": "absent"}
        # voter 2: Jev
        jp, cp = cin.jev_p.get(lab), cin.clef_p.get(lab)
        if clean and jp:
            jev = {"role": jev_vote(jp), "doctor_rank": jev_rank[lab], "p_doctor": jp[0], "status": "ok"}
        else:
            jev = {"role": None, "doctor_rank": None, "p_doctor": None, "status": "absent"}
        # voter 3: Clef-omni, doctor only on doctor_slot (ruling 3)
        if not clean:
            clef = {"role": None, "doctor_rank": None, "status": "absent", "reason_code": "mapping_" + mapping["status"]}
        elif cin.clef_slot is None:
            clef = {"role": None, "doctor_rank": None, "status": "undecided", "reason_code": "no_doctor_slot"}
        elif lab == cin.clef_slot:
            clef = {"role": "doctor", "doctor_rank": 1, "status": "ok", "reason_code": "decided"}
        else:
            clef = {"role": None, "doctor_rank": None, "status": "ok", "reason_code": "not_doctor_slot"}
        is3 = clean and r1["role"] == "doctor" and jev["role"] == "doctor" and clef["role"] == "doctor"
        if is3:
            three.append(lab)

        # voiceprint and arm (c)
        vp = {"logged_in_doctor_cos": None, "margin_next_label": None, "margin_runner_up_centroid": None, "status": None}
        match = False
        if not vp_ok:
            vp["status"] = next(x for x in ("voiceprint_missing", "no_doctor_uid", "no_enrolment", "no_vectors") if x in degraded)
        elif lab not in stats:
            vp["status"] = "absent"
        else:
            c, mnl, mrc = stats[lab]
            vp.update(logged_in_doctor_cos=c, margin_next_label=mnl, margin_runner_up_centroid=mrc)
            match = clean and not incomplete and vp_match(c, mnl, mrc)
            vp["status"] = "match" if match else ("abstain" if clean else "absent")
        # D2 (F1, F8): any non-"doctor" role at p >= 0.6 blocks; Clef and Jev use the max over every row of the label
        contr = []
        if r1["role"] is not None and r1["role"] != "doctor" and r1["share"] >= SHARE_BLOCK:
            contr.append("role")
        elif any(role != "doctor" and dur >= SEG_BLOCK_MS and p is not None and p >= P_BLOCK for dur, role, p in seg_roles.get(lab, [])):
            contr.append("role")
        for name, p, nd in (("clef", cp, cin.clef_nd.get(lab, 0.0)), ("jev", jp, cin.jev_nd.get(lab, 0.0))):
            if max(max(p[1:]) if p else 0.0, nd) >= P_BLOCK:
                contr.append(name)
        armc_new = bool(match and not contr)
        if match:
            v_label = lab
        if armc_new:
            armc_new_l = lab
        out_labels.append({"label": lab, "n_segments": n_seg[lab], "role_track": r1, "jev": jev, "clef_omni": clef, "voiceprint": vp,
                           "three_of_three": is3, "armc_old": lab == t_old, "armc_new": armc_new,
                           "armc_contradiction": contr if match and contr else []})
    if any(l["armc_contradiction"] for l in out_labels):
        flags.append("armc_contradiction")
    if clean and cin.clef_slot is not None and cin.clef_slot not in labels:
        flags.append("clef_slot_unknown_label")

    order, case, extra = resolve_order(three, armc_new_l, v_label if clean else None, vp_state if clean else ("missing" if missing else "unavailable"))
    flags += extra
    if case and CASE_LOG[case]:
        flags.append(CASE_LOG[case])
    for x in order:
        routes[x] = "case7" if case == 7 else "3of3" if x in three else "arm_c"
    # record-only reproduction of the earlier numbers: 3/3 OR armc_old, no N1 or D2 gating
    order_old = sorted(set(three) | ({t_old} if t_old else set()))
    return {
        "layer": "role_votes", "engine": "role-votes", "version": "v1", "status": "ok", "label_space": "diar_nemotron", "consult_id": cid,
        "mapping": mapping, "labels": out_labels,
        "three_of_three": three, "armc_old_label": t_old, "armc_new_label": armc_new_l, "voiceprint_match_label": v_label if clean else None,
        "order_capable": order, "order_routes": routes, "order_capable_armc_old": order_old, "case": case, "case_flags": flags, "degraded": degraded,
    }


def metadata(centroids_sha, jev_set_id, created_at, jev_question_id=None, jev_model=None):
    return {"jev_question_set": jev_set_id, "jev_question_id": jev_question_id, "jev_model": jev_model, "clef_set": CLEF_SET,
            "cos_min": COS_MIN, "margin_min": MARGIN_MIN,
            "thresholds": {"cos_min": COS_MIN, "margin_min": MARGIN_MIN, "p_doctor": P_DOC, "p_block": P_BLOCK, "role_share_block": SHARE_BLOCK,
                           "role_segment_block_ms": SEG_BLOCK_MS},
            "port_source": "merge_c.py+merge_b.py", "code_sha256": code_sha256(), "centroids_sha256": centroids_sha, "created_at": created_at}


def build_all(ins, cen, centroids_sha, jev_set_id=None, created_at=None, jev_question_id=None, jev_model=None):
    if not created_at:
        raise ValueError("created_at is required (--created-at or SOURCE_DATE_EPOCH); wall-clock time is never used")
    meta = metadata(centroids_sha, jev_set_id, created_at, jev_question_id, jev_model)
    meta_flags = [f"{k}_missing" for k, v in (("jev_set_id", jev_set_id), ("jev_question_id", jev_question_id), ("jev_model", jev_model)) if not v]
    res = {}
    for cid in sorted(ins):
        d = compute_consult(ins[cid], cen, cid)
        d["metadata"] = meta
        d["case_flags"] = d["case_flags"] + meta_flags
        res[cid] = d
    return res


def resolve_created_at(flag):
    """F5: --created-at, else SOURCE_DATE_EPOCH, else None (the caller refuses). Never the wall clock."""
    if flag:
        return flag
    sde = os.environ.get("SOURCE_DATE_EPOCH")
    if sde:
        try:
            return datetime.datetime.fromtimestamp(int(sde), datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except (ValueError, OverflowError, OSError):
            return None
    return None


# ---------------------------------------------------------------- output

def dumps(d):
    return json.dumps(d, sort_keys=True, indent=1) + "\n"


def make_private_dirs(path):
    """F3: create path and every missing parent at 0700 (explicit chmod, umask-proof). An existing directory
    at or below the first created level, or the leaf itself, must already be 0700-or-tighter, else PermissionError."""
    path = os.path.abspath(path)
    todo = []
    cur = path
    while not os.path.isdir(cur):
        todo.append(cur)
        cur = os.path.dirname(cur)
    if not todo and stat.S_IMODE(os.stat(path).st_mode) & 0o077:
        raise PermissionError("existing directory is wider than 0700: " + path)
    for d in reversed(todo):
        os.mkdir(d, 0o700)
        os.chmod(d, 0o700)


def write_private(path, text, root=None):
    """Write at 0600. Directories under root (default: the file's own directory) are created or checked at 0700."""
    d = os.path.dirname(os.path.abspath(path))
    root = os.path.abspath(root) if root else d
    make_private_dirs(root)
    rel = os.path.relpath(d, root)
    cur = root
    if rel != ".":
        for part in rel.split(os.sep):
            cur = os.path.join(cur, part)
            make_private_dirs(cur)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as f:
            fd = None
            f.write(text)
    finally:
        if fd is not None:
            os.close(fd)


def rel_dir(cid, layout):
    rel = layout.get(cid, cid)
    if os.path.isabs(rel) or ".." in rel.split("/") or not re.fullmatch(r"[A-Za-z0-9._/-]+", rel) or rel in ("", "."):
        raise ValueError("unsafe output path for a consult")
    return rel


def write_all(res, out_dir, layout=None):
    layout = layout or {}
    for cid, d in res.items():
        write_private(os.path.join(out_dir, rel_dir(cid, layout), OUT_NAME), dumps(d), root=out_dir)


# ---------------------------------------------------------------- truth (F4)

def load_truth(path):
    """{(consult_id, label): true_role}. Raises ValueError on an unknown role word."""
    out = {}
    for r in read_jsonl(path):
        role = norm_role(r.get("true_role"))
        if role not in TRUE_ROLES:
            raise ValueError("unknown true_role in truth file")
        out[(r["consult_id"], r["label"])] = role
    return out


def truth_counts(docs, truth):
    """docs: iterable of role_votes dicts. Counts only. A label with no truth row counts as not the treating doctor."""
    n_lab = unl = vp_wrong = yield_n = 0
    wrong = {"3of3": 0, "arm_c": 0, "case7": 0}
    for d in docs:
        cid = d["consult_id"]
        for l in d["labels"]:
            n_lab += 1
            role = truth.get((cid, l["label"]))
            unl += role is None
            is_doc = role == "doctor"
            vp_wrong += l["voiceprint"]["status"] == "match" and not is_doc
            if l["label"] in d["order_capable"]:
                if is_doc:
                    yield_n += 1
                else:
                    wrong[d["order_routes"][l["label"]]] += 1
    return {"labels": n_lab, "unlabelled_labels": unl, "voiceprint_match_not_doctor": vp_wrong,
            "order_capable_not_doctor": dict(wrong, total=sum(wrong.values())), "order_capable_yield_on_true_doctor": yield_n}


# ---------------------------------------------------------------- CLI

def add_inputs(p):
    p.add_argument("--vecs", required=True, help="vecs.json {consult_id: {speaker_N: [floats]}}")
    p.add_argument("--centroids", required=True, help="centroids.json [{pulse_doctor_uid, b64}]")
    p.add_argument("--doctor-uids", required=True, help="json {consult_id: doctor_uid|null}")
    p.add_argument("--clef-votes", required=True, help="jsonl per segment: consult_id,t0_ms,t1_ms,slot,voter,p_*")
    p.add_argument("--jev-votes", required=True, help="jsonl, same fields as --clef-votes")
    p.add_argument("--clef-doctor-slot", required=True, help="json {consult_id: speaker_N|null}")
    p.add_argument("--role-segments", required=True, help="jsonl rows consult_id,t0_ms,t1_ms,role[,p] (or json {consult_id: [rows]})")
    p.add_argument("--jev-set-id", default=None)
    p.add_argument("--jev-question-id", default=None)
    p.add_argument("--jev-model", default=None)
    p.add_argument("--created-at", default=None, help="timestamp for the output; else SOURCE_DATE_EPOCH; else the run refuses")


def run_inputs(a, need_created_at=True):
    created = resolve_created_at(a.created_at)
    if need_created_at and not created:
        raise ValueError("refusing to run: no --created-at and no valid SOURCE_DATE_EPOCH")
    cen, sha = load_centroids(a.centroids)
    ins = load_inputs(a.vecs, a.doctor_uids, a.clef_votes, a.jev_votes, a.clef_doctor_slot, a.role_segments)
    return build_all(ins, cen, sha, a.jev_set_id, created or "n/a", a.jev_question_id, a.jev_model)


def count_summary(res):
    mp, dg = {}, {}
    for d in res.values():
        mp[d["mapping"]["status"]] = mp.get(d["mapping"]["status"], 0) + 1
        for x in d["degraded"]:
            dg[x] = dg.get(x, 0) + 1
    return mp, dg


def cmd_build(a):
    try:
        res = run_inputs(a)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 2
    layout = json.load(open(a.layout)) if a.layout else {}
    write_all(res, a.out_dir, layout)
    mp, dg = count_summary(res)
    print(json.dumps({"consults": len(res), "written": len(res), "mapping": mp, "degraded": dg}, sort_keys=True))
    return 0


def zero_counts(docs):
    z3 = zold = znew = 0
    for d in docs:
        n = {l["label"]: l["n_segments"] for l in d["labels"]}
        z3 += sum(n[x] for x in d["three_of_three"]) == 0
        zold += sum(n[x] for x in d["order_capable_armc_old"]) == 0
        znew += sum(n[x] for x in d["order_capable"]) == 0
    return z3, zold, znew


def exit_report(docs, truth=None):
    """Monday exit report: counts only. Ids never appear here."""
    z3, zold, znew = zero_counts(docs)
    cnt = lambda f: sum(1 for d in docs if f(d))
    rep = {"consults": len(docs),
           "zero_order_3of3_alone": z3,
           "zero_order_with_armc_one_margin": zold,
           "zero_order_with_armc_both_margins": znew,
           "case7_consults": cnt(lambda d: d["case"] == 7),
           "mapping_ambiguous_consults": cnt(lambda d: d["mapping"]["status"] == "ambiguous"),
           "mapping_failed_consults": cnt(lambda d: d["mapping"]["status"] == "failed"),
           "voiceprint_missing": cnt(lambda d: "voiceprint_missing" in d["degraded"])}
    if truth is not None:
        rep["truth"] = truth_counts(docs, truth)
    return rep


def cmd_reproduce(a):
    docs = []
    for root, _, files in os.walk(a.in_dir):
        if OUT_NAME in files:
            docs.append(json.load(open(os.path.join(root, OUT_NAME))))
    docs.sort(key=lambda d: d["consult_id"] or "")
    try:
        truth = load_truth(a.truth) if a.truth else None
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 2
    print(json.dumps(exit_report(docs, truth), sort_keys=True))
    if a.ids_out:
        ids = {"case7": [d["consult_id"] for d in docs if d["case"] == 7],
               "mapping_ambiguous": [d["consult_id"] for d in docs if d["mapping"]["status"] == "ambiguous"],
               "mapping_failed": [d["consult_id"] for d in docs if d["mapping"]["status"] == "failed"],
               "voiceprint_missing": [d["consult_id"] for d in docs if "voiceprint_missing" in d["degraded"]]}
        write_private(a.ids_out, dumps(ids))
    return 0


def cmd_fa_check(a):
    if not a.truth:
        print("refusing to run: --truth is required", file=sys.stderr)
        return 2
    try:
        truth = load_truth(a.truth)
        res = run_inputs(a, need_created_at=False)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 2
    t = truth_counts(res.values(), truth)
    print(json.dumps(t, sort_keys=True))
    return 0 if t["voiceprint_match_not_doctor"] == 0 and t["order_capable_not_doctor"]["total"] == 0 else 1


def main(argv=None):
    p = argparse.ArgumentParser(prog="role_votes")
    sub = p.add_subparsers(dest="mode", required=True)
    b = sub.add_parser("build")
    add_inputs(b)
    b.add_argument("--out-dir", required=True)
    b.add_argument("--layout", default=None, help="optional json {consult_id: relative dir}; default <consult_id>/")
    r = sub.add_parser("reproduce")
    r.add_argument("--in-dir", required=True, help="the build --out-dir")
    r.add_argument("--truth", default=None, help="truth.jsonl {consult_id,label,true_role}; adds the F4 counts")
    r.add_argument("--ids-out", default=None, help="write consult ids per category here (mode 0600); stdout stays counts only")
    f = sub.add_parser("fa-check")
    add_inputs(f)
    f.add_argument("--truth", default=None, help="truth.jsonl {consult_id,label,true_role}; required")
    a = p.parse_args(argv)
    return {"build": cmd_build, "reproduce": cmd_reproduce, "fa-check": cmd_fa_check}[a.mode](a)


if __name__ == "__main__":
    sys.exit(main())
