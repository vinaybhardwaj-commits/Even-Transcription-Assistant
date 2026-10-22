"""role_votes.v1: the Encounter Brief phase-0a stored layer (newcat-orch, 17 Oct 2026). Record-only.

Ports the off-repo arm (c) and role-vote code (``~/oc/newcat/merge_c.py`` + ``merge_b.py``, 16 Oct) into the repo.
Spec: ENCOUNTER-BRIEF-SPEC-v2 §5.3, §5.6, §6.3, as amended by RULING-ENCOUNTER-BRIEF-OQ-17OCT (OQ-3, OQ-4, OQ-19, M3, N1, N3).

Per consult it writes one ``role_votes.v1.json`` (mode 0600) beside the palimpsest bundle's manifest.json, or under
``~/eta-data/role-votes/<same relative path>`` when that directory is not writable. It posts nothing: no HTTP or DB
client is imported, and ``POSTING_ENABLED`` is False and asserted on every write.

Backbone: the bundle ``diar_nemotron`` labels (``speaker_N``), times file-relative (t - manifest.t0_ms).
Voters, per label:
  1. the role track: majority role by overlapped speech time;
  2. Jev doctor-cue: recorded per-label probabilities; role = the recorded decision rule (merge_b.decide);
  3. Clef-omni: ``doctor`` on the doctor_slot label (role_clef.choose_slots on recorded probabilities), null elsewhere (M3).
Votes are mapped into bundle labels by time overlap; a consult whose mapping is not clean has voters 2 and 3 absent (OQ-3).
Voiceprint: per-label ECAPA vector (merge_c recipe), cosine to the logged-in doctor's enrolled centroid (merge_c method).
Arm (c) passes only with cos >= 0.65 AND margin_next_label >= 0.05 AND margin_runner_up_centroid >= 0.05 (OQ-4);
``armc_old`` keeps merge_c's one-margin definition for reproduction.

CLI (counts only on stdout):
  run     build and write the layer for every consult in a consult-set file.
  repro   score the written layers: the 37/60 baseline, arm (c) old and new, mapping and order-capable counts.
  prereg  synthetic false-doctor gate over merge_c's per-label vectors (every centroid tried as the logged-in doctor).
"""
from __future__ import annotations

import argparse
import base64
import collections
import datetime as dt
import glob
import hashlib
import json
import math
import os
import stat
import subprocess
import sys

import numpy as np

LAYER, ENGINE, VERSION = "role_votes", "role-votes", "v1"
FILE_NAME = "role_votes.v1.json"
POSTING_ENABLED = False  # N3: phase 0a never posts. Asserted on every write; there is no posting path to enable.

# Preregistered values, not tuned on real60: tools/timbre/slots.py:40-42 and lib/diarize-nemotron/identity.ts.
COS_MIN = 0.65
MARGIN_MIN = 0.05
MARGIN_EPS = 1e-9  # float slack for cos and margins: an exact 0.65 / 0.05 computed as 0.6499999999 still passes (fix1 L6)
# Recorded-vote decision rule: merge_b.decide == tools/timbre/role_clef.choose_slots.
P_DOC, DOC_MARGIN, P_PAT = 0.6, 0.2, 0.6
P_BLOCK = 0.6  # D2: a non-doctor p at or above this on the arm (c) label, in any vote row, blocks arm (c)
# merge_c / merge_b embedding recipe.
MIN_SEG_S, MIN_EMB_S, CROP_S, EMB_SR = 1.0, 2.0, 30.0, 16000
ECAPA_SOURCE = "speechbrain/spkrec-ecapa-voxceleb"
ECAPA_SAVEDIR = os.path.expanduser("~/.cache/spkmerge/ecapa")
# merge_c_needs_truth.py (reproduction only).
NEEDS_TRUTH_GAP = 0.15
# A bundle label needs this much speech for the mapping to have to cover it (§5.6).
MAP_MIN_SPEECH_MS = 2000

KEYS = ["p_doctor", "p_patient", "p_attender", "p_staff"]
ROLES = ["doctor", "patient", "attender", "staff"]
CLEF_SET = "timbre-role-v1"
NON_DOCTOR = {"patient", "attender", "attendant", "relative", "staff", "other", "unknown"}
# fix1 M2: a decided role that is not "doctor" blocks arm (c); these are the values that are not a decision.
NOT_DECIDED = {None, "", "undecided"}

DEFAULT_ETA = os.path.expanduser("~/eta-data")
DEFAULT_FALLBACK = os.path.expanduser("~/eta-data/role-votes")
DEFAULT_CENTROIDS = os.path.expanduser("~/timbre-nightly/centroids.json")
DEFAULT_CLIPS = os.path.expanduser("~/eta-data/consult/clips")


def norm_role(r):
    if isinstance(r, str):
        r = r.strip().lower()
    return {"attender": "attendant", "relative": "attendant"}.get(r, r)


def blocks_arm_c(role):
    """M2 (fix1): any decided role that is not doctor (case and whitespace folded) blocks arm (c)."""
    r = norm_role(role)
    return r not in NOT_DECIDED and r != "doctor"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------- voiceprint (merge_c method)

def unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / (np.linalg.norm(v) + 1e-12)


def load_centroids(path):
    out = {}
    for c in json.load(open(path)):
        v = np.frombuffer(base64.b64decode(c["b64"]), dtype=np.float32).astype(np.float64)
        out[c["pulse_doctor_uid"]] = v / (np.linalg.norm(v) + 1e-12)
    return out


def margin_ok(m):
    return m is not None and m >= MARGIN_MIN - MARGIN_EPS


def cos_ok(c):
    return c >= COS_MIN - MARGIN_EPS


def voiceprint(vecs, labels, cen, duid):
    """Per-label voiceprint block, the merge_c treating label (armc_old) and its reason, and the consult's degraded codes.

    ``vecs``: {label: vector} (labels without a vector are absent). ``cen``: {doctor_uid: unit centroid}.
    """
    per = {lab: {"logged_in_doctor_cos": None, "margin_next_label": None, "margin_runner_up_centroid": None,
                 "status": "absent", "armc": False, "armc_old": False, "n1_candidate": False} for lab in labels}
    old = {"treating_label": None, "treating_reason": None, "best_cos": None, "runner_up_cos": None}
    if not duid:
        for p in per.values():
            p["status"] = "no_doctor_uid"
        old["treating_reason"] = "no_centroid"
        return per, old, ["no_doctor_uid"]
    if duid not in cen:
        for p in per.values():
            p["status"] = "no_enrolment"
        old["treating_reason"] = "no_centroid"
        return per, old, ["no_enrolment"]
    have = [lab for lab in labels if lab in vecs]
    if not have:
        old["treating_reason"] = "no_label_vector"
        return per, old, ["no_vectors"]
    others = [u for u in cen if u != duid]
    cos = {lab: float(unit(vecs[lab]) @ cen[duid]) for lab in have}
    # fix2 LOW-9: any non-finite cosine makes every label's neighbourhood unknown: no arm (c) pass, whatever the row order.
    unknown = any(not math.isfinite(c) for c in cos.values())
    for lab in have:
        c = cos[lab]
        nxt = [cos[o] for o in have if o != lab]
        mn = c - max(nxt) if nxt else None
        mrc = c - max(float(unit(vecs[lab]) @ cen[u]) for u in others) if others else None
        if unknown or not math.isfinite(c) or (mrc is not None and not math.isfinite(mrc)):
            per[lab].update(status="abstain")
            continue
        old_pass = cos_ok(c) and (mn is None or margin_ok(mn))
        # No next label passes (merge_c, slots.py); no runner-up centroid abstains (decidePulseRoom, §5.6).
        new_pass = old_pass and margin_ok(mrc)
        # M1 (fable 20 Oct): the independent N1 candidate set uses cos and the runner-up-centroid margin only. The
        # next-label margin must not hide a second near-doctor label, so it is not part of this test.
        # fix1 L3: with one enrolled centroid there is no runner-up (mrc None): count the label, so it can still block.
        n1 = cos_ok(c) and (mrc is None or margin_ok(mrc))
        per[lab].update(logged_in_doctor_cos=round(c, 6), margin_next_label=None if mn is None else round(mn, 6),
                        margin_runner_up_centroid=None if mrc is None else round(mrc, 6),
                        status="match" if new_pass else "abstain", armc=new_pass, armc_old=old_pass, n1_candidate=n1)
    if unknown:
        old["treating_reason"] = "non_finite_cos"
        return per, old, []
    sims = sorted(((cos[lab], lab) for lab in have), reverse=True)
    b, top = sims[0]
    r = sims[1][0] if len(sims) > 1 else None
    old.update(best_cos=round(b, 6), runner_up_cos=None if r is None else round(r, 6))
    if not cos_ok(b):
        old["treating_reason"] = "below_cos_min"
    elif r is not None and not margin_ok(b - r):
        old["treating_reason"] = "inside_margin"
    else:
        old.update(treating_label=top, treating_reason="ok")
    return per, old, []


# ---------------------------------------------------------------- recorded voters (merge_b / merge_c rules)

def per_label_p(rows):
    """{slot: [p_doctor, p_patient, p_attender, p_staff]} from the first row per slot with a p_doctor (merge_c)."""
    out = {}
    for r in rows:
        if r.get("p_doctor") is not None and r["slot"] not in out:
            out[r["slot"]] = [r[k] for k in KEYS]
    return out


def max_nondoctor(rows):
    """{slot: max non-doctor p over EVERY row of the slot} (D2, M2). A row with p_doctor null counts; a null key is 0.0; NaN is 1.0."""
    out = {}
    for r in rows:
        nd = max(0.0 if r.get(k) is None else (1.0 if math.isnan(float(r[k])) else float(r[k])) for k in KEYS[1:])
        out[r["slot"]] = max(out.get(r["slot"], 0.0), nd)
    return out


def choose_slots(ps, order):
    """(doctor_slot, patient_slot, reason_code): role_clef.choose_slots on recorded probabilities. Ties break by ``order``."""
    ok = [lab for lab in order if ps.get(lab)]
    if not ok:
        return None, None, "no_input"
    # fix2 LOW-8: a non-finite p_doctor cannot be doctor and cannot pass the margin; fail closed.
    if any(not math.isfinite(float(ps[lab][0])) for lab in ok):
        return None, None, "non_finite_p"
    ranked = sorted(ok, key=lambda k: (-ps[k][0], order.index(k)))
    best = ranked[0]
    second = ps[ranked[1]][0] if len(ranked) > 1 else 0.0
    if ps[best][0] < P_DOC:
        return None, None, "doctor_p_low"
    if ps[best][0] - second < DOC_MARGIN:
        return None, None, "doctor_margin"
    pats = sorted((k for k in ok if k != best), key=lambda k: (-ps[k][1], order.index(k)))
    if not pats or ps[pats[0]][1] < P_PAT:
        return None, None, "patient_p_low"
    return best, pats[0], "decided"


def decide_recorded(ps, order):
    """merge_b.decide: the decision rule the recorded voters used. {label: role | 'undecided'}."""
    doc, pat, code = choose_slots(ps, order)
    out = {}
    for lab in order:
        p = ps.get(lab)
        if code != "decided" or not p:
            out[lab] = "undecided"
        elif lab == doc:
            out[lab] = "doctor"
        elif lab == pat:
            out[lab] = "patient"
        else:
            out[lab] = ROLES[int(np.argmax(p))]
    return out


def decide_c(labels, ps, T):
    """merge_c.decide_c: a voter's decisions given the treating label T (reproduction only)."""
    if T is None:
        return {lab: "undecided" for lab in labels}
    out = {}
    pt = ps.get(T)
    out[T] = "doctor" if pt and pt[0] >= P_DOC else "undecided"
    for lab in labels:
        if lab != T and ps.get(lab) and ps[lab][0] >= P_DOC:
            out[lab] = "other_clinician"
    rest = [lab for lab in labels if lab not in out and ps.get(lab)]
    pat = max(rest, key=lambda k: ps[k][1], default=None)
    if pat is not None and ps[pat][1] >= P_PAT:
        out[pat] = "patient"
    for lab in labels:
        if lab not in out:
            p = ps.get(lab)
            out[lab] = ROLES[int(np.argmax(p))] if p else "undecided"
    return out


def doctor_ranks(ps, order):
    """{label: rank by p_doctor, 1 = top}; ties break by first appearance in the backbone. Labels without p are absent."""
    ok = [lab for lab in order if ps.get(lab)]
    return {lab: i + 1 for i, lab in enumerate(sorted(ok, key=lambda k: (-ps[k][0], order.index(k))))}


# ---------------------------------------------------------------- time overlap

def ov(a0, a1, b0, b1):
    return max(0, min(a1, b1) - max(a0, b0))


def map_labels(vote_segs, bundle_segs, min_speech_ms=MAP_MIN_SPEECH_MS):
    """Map vote-side labels onto bundle labels by time overlap (OQ-3, M5).

    clean: every bundle label with >= min_speech_ms of speech and every vote label pair up by mutual largest overlap,
    one-to-one. ambiguous: overlaps exist but the pairing is not one-to-one. failed: no vote segments or no overlap.
    Returns {"status", "vote_labels": {bundle_label: vote_label}, "reason"}.
    """
    if not vote_segs:
        return {"status": "failed", "vote_labels": {}, "reason": "no_vote_segments"}
    O = collections.defaultdict(lambda: collections.defaultdict(int))
    for v in vote_segs:
        for b in bundle_segs:
            o = ov(v["t0_ms"], v["t1_ms"], b["t0_ms"], b["t1_ms"])
            if o > 0:
                O[v["slot"]][b["speaker"]] += o
    if not O:
        return {"status": "failed", "vote_labels": {}, "reason": "no_overlap"}
    fwd = {v: max(d, key=lambda b: (d[b], b)) for v, d in O.items()}
    back = collections.defaultdict(dict)
    for v, d in O.items():
        for b, o in d.items():
            back[b][v] = o
    bwd = {b: max(d, key=lambda v: (d[v], v)) for b, d in back.items()}
    speech = collections.Counter()
    for b in bundle_segs:
        speech[b["speaker"]] += max(0, b["t1_ms"] - b["t0_ms"])
    vote_labels = {fwd[v]: v for v in fwd if bwd.get(fwd[v]) == v}
    one_to_one = len(set(fwd.values())) == len(fwd) and all(bwd[fwd[v]] == v for v in fwd)
    covered = all(lab in vote_labels for lab, ms in speech.items() if ms >= min_speech_ms)
    if one_to_one and covered:
        return {"status": "clean", "vote_labels": dict(sorted(vote_labels.items())), "reason": None}
    return {"status": "ambiguous", "vote_labels": dict(sorted(vote_labels.items())),
            "reason": "not_one_to_one" if not one_to_one else "label_not_covered"}


def role_majority(label_segs, role_segs):
    """(role, share): the role track's majority role by overlapped speech time for this label's segments."""
    tot = collections.Counter()
    for s in label_segs:
        for r in role_segs:
            o = ov(s["t0_ms"], s["t1_ms"], r["t0_ms"], r["t1_ms"])
            if o > 0:
                tot[norm_role(r["role"]) or "undecided"] += o  # fix2 LOW-10: a None role is "undecided"
    if not tot:
        return None, None
    role, ms = max(tot.items(), key=lambda kv: (kv[1], kv[0]))
    if sum(1 for v in tot.values() if v == ms) > 1 and "undecided" in tot and tot["undecided"] == ms:
        role = "undecided"  # a tie that includes the unknown role fails closed
    return role, round(ms / sum(tot.values()), 4)


def segment_role(seg, role_segs):
    """score_real60 / score_armc_real60: the role of the single best-overlapping role segment, else 'undecided'."""
    if not role_segs:
        return "undecided"
    b = max(role_segs, key=lambda r: ov(r["t0_ms"], r["t1_ms"], seg["t0_ms"], seg["t1_ms"]))
    return norm_role(b["role"]) if ov(b["t0_ms"], b["t1_ms"], seg["t0_ms"], seg["t1_ms"]) > 0 else "undecided"


# ---------------------------------------------------------------- §6.3 order capability

def order_capable(d3, c, cands):
    """(order-capable labels, conflict codes) from the §6.3 table (M3, M4) plus ruling N1 (M1).

    d3: labels decided doctor by rule A (3/3). c: the label named by rule B (arm c), or None.
    cands: every N1 voiceprint candidate (cos and runner-up-centroid margin, no next-label margin). A candidate
    outside the returned order-capable set blocks all (two 3/3 labels that are both near-doctor: none is order-capable).
    """
    d3, cands = set(d3), set(cands)
    conflicts = []
    if not d3:
        out = {c} if c else set()
    elif len(d3) == 1:
        (a,) = d3
        if c is None or c == a:
            out = {a}
        else:
            out = set()
            conflicts.append("doctor_conflict")
    else:
        conflicts.append("second_doctor")
        if c is None:
            out = set()
        elif c in d3:
            out = {c}
        else:
            out = set()
            conflicts.append("doctor_conflict")
    # fix1 M1: any near-doctor candidate outside the returned set blocks (the more conservative reading).
    if out and cands - out:
        out = set()
        conflicts.append("doctor_conflict")
    return out, sorted(set(conflicts))


# ---------------------------------------------------------------- the layer

def build_layer(*, bundle_segs, role_segs, clef_rows, jev_rows, doctor_uid, vecs, cen, role_engine, meta):
    """One consult's role_votes.v1 layer. All segments are file-relative ms. Pure: no I/O."""
    order = []
    for s in bundle_segs:
        if s["speaker"] not in order:
            order.append(s["speaker"])
    labels = sorted(order)
    degraded = []
    if role_engine and not str(role_engine).startswith("llm"):
        degraded.append("role_track_not_llm")  # OQ-2

    mapping = map_labels(clef_rows, bundle_segs)
    clean = mapping["status"] == "clean"
    if not clean:
        degraded.append(f"mapping_{mapping['status']}")
    vmap = mapping["vote_labels"] if clean else {}
    clef_v, jev_v = per_label_p(clef_rows), per_label_p(jev_rows)
    clef_ps = {lab: clef_v.get(vmap.get(lab)) for lab in order} if clean else {}
    jev_ps = {lab: jev_v.get(vmap.get(lab)) for lab in order} if clean else {}

    vp, old, vp_degraded = voiceprint(vecs, labels, cen, doctor_uid)
    degraded += vp_degraded

    clef_doc, clef_pat, clef_code = choose_slots(clef_ps, order) if clean else (None, None, "absent")
    clef_rec = decide_recorded(clef_ps, order) if clean else {}
    jev_rec = decide_recorded(jev_ps, order) if clean else {}
    clef_rank, jev_rank = (doctor_ranks(clef_ps, order), doctor_ranks(jev_ps, order)) if clean else ({}, {})

    by_label = collections.defaultdict(list)
    for s in bundle_segs:
        by_label[s["speaker"]].append(s)

    armc_on = clean and not vp_degraded
    vp_label = next((lab for lab in labels if vp[lab]["armc"]), None)  # at most one label can pass (S2)
    cands = {lab for lab in labels if vp[lab]["n1_candidate"]} if armc_on else set()  # M1
    clef_nd = {lab: max_nondoctor(clef_rows).get(vmap.get(lab), 0.0) for lab in order} if clean else {}
    jev_nd = {lab: max_nondoctor(jev_rows).get(vmap.get(lab), 0.0) for lab in order} if clean else {}
    out_labels, d3, c = [], [], None
    for lab in labels:
        v1, v1_share = role_majority(by_label[lab], role_segs)
        jp, cp = jev_ps.get(lab), clef_ps.get(lab)
        jrole = jev_rec.get(lab) if jp else None
        jev = {"role": None if jrole in (None, "undecided") else norm_role(jrole), "doctor_rank": jev_rank.get(lab),
               "status": "ok" if jp else "absent", "decision": jrole, "p": dict(zip(KEYS, jp)) if jp else None}
        clef = {"role": "doctor" if lab == clef_doc else None, "doctor_rank": 1 if lab == clef_doc else None,
                "status": ("ok" if clef_code == "decided" else "undecided") if cp else "absent",
                "reason_code": clef_code if cp else None, "decision": clef_rec.get(lab) if cp else None,
                "p_doctor_rank": clef_rank.get(lab), "p": dict(zip(KEYS, cp)) if cp else None}
        rule_a = clean and v1 == "doctor" and jev["role"] == "doctor" and clef["role"] == "doctor"
        rule_b = armc_on and vp[lab]["armc"] and clef["doctor_rank"] == 1 and jev["doctor_rank"] == 1
        if rule_a:
            d3.append(lab)
        if rule_b:
            c = lab
        out_labels.append({"label": lab, "voter1_role_track": {"role": v1, "share": v1_share}, "jev": jev,
                           "clef_omni": clef, "voiceprint": vp[lab], "rule_a": rule_a, "rule_b": rule_b})
    conflicts = []
    if c is not None:
        rec = next(x for x in out_labels if x["label"] == c)
        # OQ-5: voter 1 or 2 calls the arm (c) label non-doctor -> unknown, no order.
        # D2 (M2): the max non-doctor p over all of the label's rows in either vote also blocks.
        if (blocks_arm_c(rec["voter1_role_track"]["role"]) or blocks_arm_c(rec["jev"]["role"])
                or max(clef_nd[c], jev_nd[c]) >= P_BLOCK):
            conflicts.append("doctor_conflict")
            rec["rule_b"] = False
            rec["unknown"] = True
            c = None
    oc, more = order_capable(d3, c, cands)
    conflicts = sorted(set(conflicts + more))
    for x in out_labels:
        x["order_capable"] = x["label"] in oc
    return {
        "layer": LAYER, "engine": ENGINE, "version": VERSION, "status": "ok", "label_space": "diar_nemotron",
        "mapping": {"status": mapping["status"], "vote_labels": mapping["vote_labels"], "reason": mapping["reason"]},
        "armc_on": armc_on, "voiceprint_match_label": vp_label, "n1_candidates": sorted(cands), "rule_a_labels": sorted(d3), "rule_b_label": c,
        "order_capable_labels": sorted(oc), "conflicts": conflicts, "degraded": sorted(set(degraded)),
        "labels": out_labels, "reproduction": {"armc_old": old, "first_appearance": order},
        "metadata": meta,
    }


def fallback_dir(bundle_dir, eta_root, fallback_root):
    """W2: fallback_root/<bundle_dir relative to eta_root>, refused if it would leave fallback_root."""
    rel = os.path.relpath(bundle_dir, eta_root)
    if os.path.isabs(rel) or rel == os.pardir or rel.startswith(os.pardir + os.sep):
        raise ValueError("bundle directory is outside the ETA root")
    d = os.path.normpath(os.path.join(fallback_root, rel))
    root = os.path.normpath(fallback_root)
    if d != root and not d.startswith(root + os.sep):
        raise ValueError("fallback path escapes its root")
    return d


def make_private_dirs(d, root):
    """W1, W2: create root and each missing level down to d at 0700 (explicit chmod, umask-proof); refuse a symlink."""
    d, root = os.path.normpath(d), os.path.normpath(root)
    cur = root
    parts = [] if d == root else os.path.relpath(d, root).split(os.sep)
    for part in [None] + parts:
        if part is not None:
            cur = os.path.join(cur, part)
        if os.path.islink(cur):
            raise PermissionError("refusing a symlinked fallback directory")
        if os.path.isdir(cur):
            st = os.lstat(cur)
            if stat.S_IMODE(st.st_mode) != 0o700:  # fix1 L5: tighten an existing directory, or refuse one we do not own
                if st.st_uid != os.getuid():
                    raise PermissionError("refusing a fallback directory owned by another user")
                os.chmod(cur, 0o700)
        else:
            if cur == root:
                os.makedirs(os.path.dirname(cur), mode=0o700, exist_ok=True)
            os.mkdir(cur, 0o700)
            os.chmod(cur, 0o700)


def write_layer(layer, bundle_dir, eta_root=DEFAULT_ETA, fallback_root=DEFAULT_FALLBACK):
    """Write role_votes.v1.json (0600) beside manifest.json, or under fallback_root/<relative path>. Returns (path, fallback)."""
    assert POSTING_ENABLED is False, "phase 0a never posts"
    fallback = not os.access(bundle_dir, os.W_OK)
    if fallback:
        d = fallback_dir(bundle_dir, eta_root, fallback_root)
        make_private_dirs(d, fallback_root)
    else:
        d = bundle_dir
    path = os.path.join(d, FILE_NAME)
    tmp = f"{path}.{os.getpid()}.{os.urandom(4).hex()}.tmp"
    # W3: O_EXCL | O_NOFOLLOW, so a planted file or symlink at the temp name is refused, never followed.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as f:
            fd = None
            json.dump(dict(layer, storage={"fallback": fallback}), f)
        os.replace(tmp, path)
    finally:
        if fd is not None:
            os.close(fd)
        if os.path.exists(tmp):
            os.unlink(tmp)
    return path, fallback


# ---------------------------------------------------------------- embedding (merge_c recipe; run mode only)

def load_encoder(threads=6):
    os.environ["HF_HUB_OFFLINE"] = "1"  # weights come from the local savedir only
    import torch
    from speechbrain.inference.speaker import EncoderClassifier
    torch.set_num_threads(threads)
    return EncoderClassifier.from_hparams(source=ECAPA_SOURCE, savedir=ECAPA_SAVEDIR, run_opts={"device": "cpu"})


def embed_labels(audio, sr, segs, enc):
    """{label: vector}: segments >= 1 s, >= 2 s total, first 30 s of the concatenation, 16 kHz (merge_c embed_stage)."""
    import torch
    import torchaudio
    by = collections.defaultdict(list)
    for s in segs:
        by[s["speaker"]].append(s)
    out = {}
    for lab, ss in by.items():
        pieces = [audio[int(s["t0_ms"] * sr / 1000):int(s["t1_ms"] * sr / 1000)] for s in ss if (s["t1_ms"] - s["t0_ms"]) / 1000 >= MIN_SEG_S]
        if not pieces or sum(len(p) for p in pieces) / sr < MIN_EMB_S:
            continue
        x = torch.from_numpy(np.concatenate(pieces)[: int(CROP_S * sr)])
        if sr != EMB_SR:
            x = torchaudio.functional.resample(x, sr, EMB_SR)
        out[lab] = [float(v) for v in enc.encode_batch(x[None, :]).reshape(-1)]
    return out


def load_audio(path):
    import soundfile as sf
    a, sr = sf.read(path, dtype="float32")
    if a.ndim > 1:
        a = a.mean(axis=1)
    return a, sr


# ---------------------------------------------------------------- consult inputs

def consult_rows(consults_path):
    d = json.load(open(consults_path))
    return d["consults"] if "consults" in d else next(v for v in d.values() if isinstance(v, list))


def bundle_inputs(row, eta_root=DEFAULT_ETA):
    """(bundle_dir, manifest, bundle_segs, role_segs, doctor_uid), times file-relative."""
    nem_path = os.path.join(eta_root, row["layers"]["diar_nemotron"])
    bundle_dir = os.path.dirname(os.path.dirname(nem_path))
    man = json.load(open(os.path.join(bundle_dir, "manifest.json")))
    t0 = int(man["t0_ms"])
    shift = lambda segs: [dict(s, t0_ms=int(s["t0_ms"]) - t0, t1_ms=int(s["t1_ms"]) - t0) for s in segs]
    bundle = [{"t0_ms": s["t0_ms"], "t1_ms": s["t1_ms"], "speaker": s["speaker"]} for s in shift(json.load(open(nem_path))["segments"])]
    rp = row["layers"].get("role")
    role = shift(json.load(open(os.path.join(eta_root, rp)))["segments"]) if rp and os.path.exists(os.path.join(eta_root, rp)) else []
    c = man.get("consult", {})
    duid = (man.get("cutter_row") or {}).get("doctor_uid") or c.get("doctor_uid") or (c.get("attribution") or {}).get("doctor_uid")
    return bundle_dir, man, bundle, role, duid


def code_meta(args, cen_path, jev_path, clef_path):
    here = os.path.abspath(__file__)
    try:
        git = subprocess.run(["git", "-C", os.path.dirname(here), "log", "-1", "--format=%H", "--", here],
                             capture_output=True, text=True, timeout=10).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        git = None
    return {"code_sha256": sha256_file(here), "code_git_sha": git,
            "port_source": "merge_c.py+merge_b.py (newcat, 16 Oct)",
            "port_source_sha256": sha256_file(args.port_source) if args.port_source and os.path.exists(args.port_source) else None,
            "centroids_sha256": sha256_file(cen_path),
            "jev_question_set": args.jev_question_set, "jev_question_id": args.jev_question_id, "jev_model": args.jev_model,
            "jev_voter": "jev_cue", "jev_votes_sha256": sha256_file(jev_path),
            "clef_set": CLEF_SET, "clef_votes_sha256": sha256_file(clef_path),
            "cos_min": COS_MIN, "margin_min": MARGIN_MIN, "margin_eps": MARGIN_EPS,
            "p_doctor_min": P_DOC, "doctor_margin_min": DOC_MARGIN, "p_patient_min": P_PAT,
            "embedding": {"model": ECAPA_SOURCE, "min_seg_s": MIN_SEG_S, "min_emb_s": MIN_EMB_S, "crop_s": CROP_S, "sr": EMB_SR},
            "created_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}


def group_by_consult(path, key="consult_id"):
    out = collections.defaultdict(list)
    for line in open(path):
        r = json.loads(line)
        out[r[key]].append(r)
    return out


def cmd_run(args):
    assert POSTING_ENABLED is False
    cen = load_centroids(args.centroids)
    clef, jev = group_by_consult(args.clef_votes), group_by_consult(args.jev_slot_votes)
    cached = json.load(open(args.vecs_json)) if args.vecs_json else None
    enc = None if cached is not None else load_encoder(args.threads)
    meta = code_meta(args, args.centroids, args.jev_slot_votes, args.clef_votes)
    meta["vectors"] = "cached:" + sha256_file(args.vecs_json) if cached is not None else "recomputed_on_box"
    stats = collections.Counter()
    vec_out = {}
    for row in consult_rows(args.consults):
        uid = row["consult_uid"]
        bundle_dir, man, bundle, role, duid = bundle_inputs(row, args.eta_root)
        if cached is not None:
            vecs = cached.get(uid, {})
        else:
            audio, sr = load_audio(os.path.join(args.clips, man["audio"]["r2_key"].replace("consult-clips/", "", 1)))
            vecs = embed_labels(audio, sr, bundle, enc)
        vec_out[uid] = vecs
        layer = build_layer(bundle_segs=bundle, role_segs=role, clef_rows=clef.get(uid, []), jev_rows=jev.get(uid, []),
                            doctor_uid=duid, vecs=vecs, cen=cen, role_engine=row.get("role_engine"), meta=meta)
        stats["consults"] += 1
        stats["label_vectors"] += len(vecs)
        stats["mapping_" + layer["mapping"]["status"]] += 1
        if not args.dry_run:
            _, fb = write_layer(layer, bundle_dir, args.eta_root, args.fallback_root)
            stats["written"] += 1
            stats["written_fallback"] += fb
    if args.vecs_out:
        fd = os.open(args.vecs_out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(vec_out, f)
    print(json.dumps(dict(stats)))


# ---------------------------------------------------------------- repro: score the written layers

def read_layer(bundle_dir, eta_root, fallback_root):
    try:
        fb = fallback_dir(bundle_dir, eta_root, fallback_root)
    except ValueError:
        fb = None
    for d in (bundle_dir, fb):
        p = d and os.path.join(d, FILE_NAME)
        if p and os.path.exists(p):
            return json.load(open(p))
    return None


def score_consult(layer, bundle, role):
    """Per-consult counts from one layer: the baseline, armc_old and the both-margins variant of the merge_c scorer."""
    labels = [x["label"] for x in layer["labels"]]
    L = {x["label"]: x for x in layer["labels"]}
    order = layer["reproduction"]["first_appearance"]
    ps = {v: {lab: (list(L[lab][k]["p"].values()) if L[lab][k]["p"] else None) for lab in labels} for v, k in (("clef", "clef_omni"), ("jev", "jev"))}
    cos = {lab: L[lab]["voiceprint"]["logged_in_doctor_cos"] for lab in labels if L[lab]["voiceprint"]["logged_in_doctor_cos"] is not None}
    top = {v: next((lab for lab, r in doctor_ranks(ps[v], order).items() if r == 1), None) for v in ps}

    def armc(T):
        dec = {v: decide_c(labels, ps[v], T) for v in ps}
        indep = T is not None and top["clef"] == T and top["jev"] == T
        nt = False
        if T is not None:
            sims = sorted(((c, lab) for lab, c in cos.items()), reverse=True)
            oc = {lab for v in dec for lab, d in dec[v].items() if d == "other_clinician"}
            nt = len(sims) > 1 and sims[1][1] in oc and sims[0][0] - sims[1][0] < NEEDS_TRUTH_GAP
        conf = 0
        if indep and not nt:
            for s in bundle:
                if s["t1_ms"] - s["t0_ms"] <= 0:
                    continue
                if s["speaker"] == T and segment_role(s, role) == "doctor" and dec["clef"][s["speaker"]] == "doctor" and dec["jev"][s["speaker"]] == "doctor":
                    conf += 1
        return conf, nt, indep

    base = 0
    for s in bundle:
        if s["t1_ms"] - s["t0_ms"] <= 0:
            continue
        llm = segment_role(s, role)
        cv = norm_role(L[s["speaker"]]["clef_omni"]["decision"] or "undecided")
        jv = norm_role(L[s["speaker"]]["jev"]["decision"] or "undecided")
        if "undecided" not in (llm, cv, jv) and llm == cv == jv == "doctor":
            base += 1
    t_old = layer["reproduction"]["armc_old"]["treating_label"]
    old_conf, old_nt, old_indep = armc(t_old)
    new_conf, new_nt, new_indep = armc(layer["voiceprint_match_label"] if layer["armc_on"] else None)
    return {"labels": len(labels), "base_conf_doc": base, "old_conf": old_conf, "old_needs_truth": old_nt, "old_indep": old_indep,
            "new_conf": new_conf, "new_needs_truth": new_nt, "reason_old": layer["reproduction"]["armc_old"]["treating_reason"],
            "mapping": layer["mapping"]["status"], "order_capable": len(layer["order_capable_labels"]),
            "voiceprint_match": layer["voiceprint_match_label"] is not None, "conflicts": layer["conflicts"],
            "degraded": layer["degraded"]}


def cmd_repro(args):
    rows = []
    for row in consult_rows(args.consults):
        bundle_dir, _, bundle, role, _ = bundle_inputs(row, args.eta_root)
        layer = read_layer(bundle_dir, args.eta_root, args.fallback_root)
        if layer is None:
            rows.append({"missing": True, "room": row.get("room_id")})
            continue
        rows.append(dict(score_consult(layer, bundle, role), room=row.get("room_id")))
    have = [r for r in rows if not r.get("missing")]
    rooms = {room: f"room{i + 1}" for i, room in enumerate(sorted({r["room"] for r in have}))}
    cats = {"ALL": have, ">=3 labels": [r for r in have if r["labels"] >= 3], "<3 labels": [r for r in have if r["labels"] < 3]}
    for room, name in rooms.items():
        cats[name] = [r for r in have if r["room"] == room]
    out = {
        "consults": len(rows), "missing_layers": len(rows) - len(have),
        "baseline_zero_confident_doctor": sum(r["base_conf_doc"] == 0 for r in have),
        "armc_old_zero_confident_doctor": sum(r["old_conf"] == 0 for r in have),
        "armc_old_needs_truth": sum(r["old_needs_truth"] for r in have),
        "armc_old_indep": sum(r["old_indep"] for r in have),
        "armc_old_reasons": dict(collections.Counter(r["reason_old"] for r in have)),
        "armc_new_zero_confident_doctor": sum(r["new_conf"] == 0 for r in have),
        "armc_new_needs_truth": sum(r["new_needs_truth"] for r in have),
        "voiceprint_match_consults": sum(r["voiceprint_match"] for r in have),
        "mapping": dict(collections.Counter(r["mapping"] for r in have)),
        "conflicts": dict(collections.Counter(c for r in have for c in r["conflicts"])),
        "degraded": dict(collections.Counter(d for r in have for d in r["degraded"])),
        "no_order_capable_share": {k: [sum(r["order_capable"] == 0 for r in v), len(v)] for k, v in cats.items()},
    }
    print(json.dumps(out))


# ---------------------------------------------------------------- prereg: synthetic false-doctor gate

def cmd_prereg(args):
    """Every synthetic label is tried against every enrolled centroid as the logged-in doctor, with Clef and Jev forced
    to doctor_rank 1 (worst case). Synthetic voices are not enrolled doctors, so any voiceprint match or arm (c)
    order-capable label is a false doctor."""
    cen = load_centroids(args.centroids)
    out = {}
    for path in sorted(glob.glob(args.vecs_glob)):
        cond = os.path.basename(os.path.dirname(path))
        vecs = json.load(open(path))
        n_lab = vp_match = armc_old = oc = 0
        for cid, labs in vecs.items():
            labels = sorted(labs)
            n_lab += len(labels)
            for duid in cen:
                per, old, _ = voiceprint(labs, labels, cen, duid)
                vp_match += sum(p["armc"] or p["n1_candidate"] for p in per.values())
                armc_old += old["treating_label"] is not None
                vp = next((lab for lab in labels if per[lab]["armc"]), None)
                got, _ = order_capable(set(), vp, {lab for lab in labels if per[lab]["n1_candidate"]})
                oc += len(got)
        out[cond] = {"labels": n_lab, "trials": n_lab * len(cen), "voiceprint_matched": vp_match,
                     "armc_old_treating": armc_old, "order_capable": oc}
    total = sum(v["voiceprint_matched"] + v["order_capable"] + v["armc_old_treating"] for v in out.values())
    print(json.dumps({"conditions": out, "false_doctor_total": total, "gate": "PASS" if total == 0 and out else "FAIL"}))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("run", "repro"):
        p = sub.add_parser(name)
        p.add_argument("--consults", required=True, help="consult-set JSON (real60.json shape); read by path, never copied")
        p.add_argument("--eta-root", default=DEFAULT_ETA)
        p.add_argument("--fallback-root", default=DEFAULT_FALLBACK)
    r = sub.choices["run"]
    r.add_argument("--clef-votes", required=True)
    r.add_argument("--jev-slot-votes", required=True)
    r.add_argument("--centroids", default=DEFAULT_CENTROIDS)
    r.add_argument("--clips", default=DEFAULT_CLIPS)
    r.add_argument("--vecs-json", help="reuse per-label vectors instead of recomputing (comparison only)")
    r.add_argument("--vecs-out", help="also write the recomputed vectors here (0600; stays on the box)")
    r.add_argument("--threads", type=int, default=6)
    r.add_argument("--port-source", default=os.path.expanduser("~/oc/newcat/merge_c.py"))
    r.add_argument("--jev-question-set")
    r.add_argument("--jev-question-id")
    r.add_argument("--jev-model")
    r.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("prereg")
    p.add_argument("--vecs-glob", required=True, help="merge_c synthetic vectors, e.g. ~/oc/newcat/merge/c/{clean,c1..}/vecs.json")
    p.add_argument("--centroids", default=DEFAULT_CENTROIDS)
    args = ap.parse_args(argv)
    {"run": cmd_run, "repro": cmd_repro, "prereg": cmd_prereg}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
