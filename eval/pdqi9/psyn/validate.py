"""`validate DIR`: re-check a built P-SYN directory against the spec and the manifest."""

import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

from . import schema, strata
from .build import load_config
from .names import DENYLIST
from .strata import s_m, s_r, s_v

WORD = re.compile(r"[a-z]+")
NGRAM = 5


def _load(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))


def ngrams(text, n=NGRAM):
    w = WORD.findall(text.lower())
    return {tuple(w[i:i + n]) for i in range(len(w) - n + 1)}


def load_dir(d):
    d = Path(d)
    man = _load(d / "manifest.json")
    bundles = []
    for e in man["scripts"]:
        sd = d / e["dir"]
        b = {"script": _load(sd / "script.json"), "truth": _load(sd / "truth.json"), "twin": _load(sd / "twin.json"),
             "twin_defect": _load(sd / "twin_defect.json") if (sd / "twin_defect.json").exists() else None,
             "dir": e["dir"]}
        bundles.append(b)
    return man, _load(d / "enrolment" / "pseudo_doctors.json"), bundles


# ---- individual checks; each returns a list of error strings ----

def check_manifest(d, man):
    errs = [f"manifest: {e.message}" for e in schema.validator("manifest").iter_errors(man)]
    listed = {f["path"]: f for f in man["files"]}
    for path, f in listed.items():
        p = Path(d) / path
        if not p.exists():
            errs.append(f"missing {path}")
            continue
        data = p.read_bytes()
        if hashlib.sha256(data).hexdigest() != f["sha256"] or len(data) != f["bytes"]:
            errs.append(f"hash mismatch {path}")
    on_disk = {str(p.relative_to(d)) for p in Path(d).rglob("*") if p.is_file()} - {"manifest.json"}
    for extra in sorted(on_disk - set(listed)):
        errs.append(f"unlisted file {extra}")
    if "test/README.md" not in listed:
        errs.append("test/README.md guard missing")
    return errs


def check_schemas(bundles, enrol):
    errs = [f"enrolment: {e.message}" for e in schema.validator("enrolment").iter_errors(enrol)]
    vs = {k: schema.validator(k) for k in ("script", "truth", "twin")}
    for b in bundles:
        sid = b["script"].get("script_id")
        for key, name in (("script", "script"), ("truth", "truth"), ("twin", "twin"), ("twin_defect", "twin")):
            if b[key] is None:
                continue
            for e in vs[name].iter_errors(b[key]):
                errs.append(f"{sid} {key}: {e.json_path}: {e.message}")
    return errs


def check_counts(bundles, cfg=None):
    cfg = cfg or load_config()
    errs = []
    scripts = [b["script"] for b in bundles]
    c = Counter(s["stratum"] for s in scripts)
    if dict(c) != strata.EXPECTED_COUNTS:
        errs.append(f"stratum counts {dict(c)} != {strata.EXPECTED_COUNTS}")
    if len(scripts) != strata.TOTAL:
        errs.append(f"total {len(scripts)} != {strata.TOTAL}")
    dev = Counter(s["stratum"] for s in scripts if s["split"] == "dev")
    if dict(dev) != cfg["dev_counts"]:
        errs.append(f"dev counts {dict(dev)} != {cfg['dev_counts']}")
    n_dev = sum(dev.values())
    if (n_dev, len(scripts) - n_dev) != (cfg["dev_total"], cfg["test_total"]):
        errs.append(f"split {n_dev}/{len(scripts) - n_dev} != {cfg['dev_total']}/{cfg['test_total']}")
    for b in bundles:
        s = b["script"]
        if not b["dir"].startswith(s["split"] + "/") or b["truth"]["split"] != s["split"]:
            errs.append(f"{s['script_id']}: split directory mismatch")
    groups = defaultdict(set)
    for s in scripts:
        groups[s["split_group"]].add(s["split"])
    errs += [f"group {g} split across {sorted(v)}" for g, v in groups.items() if len(v) > 1]
    return errs


def check_traps(bundles):
    errs = []
    sv = Counter(s["split_cell"] for s in (b["script"] for b in bundles) if s["stratum"] == "S-V")
    if dict(sv) != dict(s_v.CATEGORIES):
        errs.append(f"S-V trap mix {dict(sv)} != {dict(s_v.CATEGORIES)}")
    sm = Counter(s["split_cell"] for s in (b["script"] for b in bundles) if s["stratum"] == "S-M")
    if dict(sm) != dict(s_m.SUBTYPES):
        errs.append(f"S-M mix {dict(sm)} != {dict(s_m.SUBTYPES)}")
    sr = Counter(s["split_cell"] for s in (b["script"] for b in bundles) if s["stratum"] == "S-R")
    if set(sr) != set(s_r.TRAPS) or set(sr.values()) != {5}:
        errs.append(f"S-R trap mix {dict(sr)}")
    for b in bundles:
        s, t = b["script"], b["truth"]
        if s["stratum"] == "S-V" and s["split_cell"].startswith("translator"):
            ev = Counter(r["expected_event"] for r in s["relays"])
            sub = s["split_cell"]
            if ev["relay"] < 1 or (sub == "translator_changed_dose") != (ev["relay_conflict"] == 1) or \
                    (sub == "translator_added") != (ev["translator_added"] == 1):
                errs.append(f"{s['script_id']}: relay events {dict(ev)} wrong for {sub}")
        if s["stratum"] == "S-M":
            errs += check_sm(s, t)
    return errs


def check_sm(s, t):
    errs = []
    other = s["notes"]["merged_other_speaker_id"]
    lc = t["treating_label"]
    if not all(sp["intended_diar_label"] == lc for sp in s["speakers"] if sp["speaker_id"] in (other, s["treating_speaker_id"])):
        errs.append(f"{s['script_id']}: other voice not on the treating label")
    oi = [i for i in t["items"] if i["trap"] == "merged_other_voice"]
    kinds = {i["kind"] for i in oi}
    names = {a["name"] for i in oi for a in i["attributes"]}
    if not {"medicine", "investigation", "referral"} <= kinds or not {"drug", "dose"} <= names:
        errs.append(f"{s['script_id']}: merged other voice lacks drug/dose/test/referral")
    fdr_needed = s["split_cell"] in ("patient", "attender_fdr")
    if fdr_needed and not {"frequency", "duration", "route"} <= names:
        errs.append(f"{s['script_id']}: [v7] frequency/duration/route missing")
    for i in oi:
        for a in i["attributes"]:
            if set(a["allowed_labels"]) != {"h_unattrib", "unaligned"} or "supported" not in a["forbidden_labels"] \
                    or not a["t28e_counted"] or a["label_by_cited_source"].get("armc") != "h_unattrib":
                errs.append(f"{s['script_id']} {i['item_id']}.{a['name']}: wrong merged expectation")
    short = [i for i in t["items"] if i["trap"] == "doctor_short_segment"]
    short_attrs = [a for i in short for a in i["attributes"] if a["segcheck_expected_fail"] == "duration"]
    if len(short_attrs) < 3 or not all(a["label_by_cited_source"].get("armc") == "h_unattrib"
                            and a["label_by_cited_source"].get("3of3") == "supported"
                            for a in short_attrs):
        errs.append(f"{s['script_id']}: doctor short-segment items missing or wrong")
    if s["notes"]["est_other_voice_share_of_label"] > s_m.CONTRADICTION_SHARE_MAX:
        errs.append(f"{s['script_id']}: other-voice share above the A4.1a.5 bound")
    return errs


def check_variants(bundles):
    errs = []
    for b in bundles:
        s, t = b["script"], b["truth"]
        for name, vs in (("script", s["metadata_variants"]), ("truth", t["variants"])):
            ids = [v["variant_id"] for v in vs]
            if ids != ["v1", "v2", "v3", "v4", "v5"]:
                errs.append(f"{s['script_id']} {name}: variants {ids}")
        prim = [v["variant_id"] for v in t["variants"] if v["scored_in_primary"]]
        if prim != ["v1"]:
            errs.append(f"{s['script_id']}: primary-scored variants {prim} (must be only v1)")
        if any("T1-T22" in v["used_for"] for v in t["variants"] if v["variant_id"] != "v1"):
            errs.append(f"{s['script_id']}: a non-default variant feeds T1-T22")
        v2 = t["variants"][1]
        if v2["expected_armc"]["fires"] or v2["expected_armc"]["must_not_fire_on_label"] != t["treating_label"] \
                or v2["logged_in_pseudo_doctor_id"] == v2["treating_pseudo_doctor_id"]:
            errs.append(f"{s['script_id']}: v2 expectation wrong")
        for v in t["variants"][2:]:
            sp = v["expected_doctor_spans"]
            if v["expected_armc"]["fires"] or sp["armc"] or sp["both"] or not v["fallback_equals_3of3_only"]:
                errs.append(f"{s['script_id']} {v['variant_id']}: must fall back to 3/3")
    return errs


def check_decoys(bundles):
    errs = []
    tot = Counter()
    for b in bundles:
        s = b["script"]
        c = Counter(x["kind"] for x in s["claims"])
        tot.update(c)
        if c["decoy"] * 4 != c["decoy"] + c["present"]:
            errs.append(f"{s['script_id']}: decoys {c['decoy']} of {sum(c.values())}")
        text = " ".join(x["text"] for x in s["turns"]).lower()
        for x in s["claims"]:
            if x["kind"] == "decoy" and x["probe"].lower() in text:
                errs.append(f"{s['script_id']}: decoy {x['canonical_key']} is said in the consult")
    if tot["decoy"] * 4 != sum(tot.values()):
        errs.append(f"overall decoy share {tot['decoy']}/{sum(tot.values())}")
    return errs


def check_enrolment(bundles, enrol):
    consult = set()
    for b in bundles:
        for t in b["script"]["turns"]:
            consult |= ngrams(t["text"])
    errs = []
    texts = []
    for pd in enrol["pseudo_doctors"]:
        for u in pd["enrolment"]:
            texts.append(u["text"])
            if ngrams(u["text"]) & consult:
                errs.append(f"enrolment {u['utterance_id']} overlaps consult text")
    if len(set(texts)) != len(texts):
        errs.append("duplicate enrolment utterances")
    alltext = " ".join(t["text"] for b in bundles for t in b["script"]["turns"]).lower()
    errs += [f"enrolment {t[:20]}... appears verbatim" for t in texts if t.lower().rstrip(".") in alltext]
    return errs


def check_names(bundles, enrol):
    errs = []
    strings = [p["display_name"] for p in enrol["pseudo_doctors"]]
    for b in bundles:
        strings += [sp["display_name"] for sp in b["script"]["speakers"]]
        strings += [t["text"] for t in b["script"]["turns"]]
        for tw in (b["twin"], b["twin_defect"]):
            if tw:
                strings += [e["text"] for sec in tw["sections"] for e in sec["entries"]]
    for st in strings:
        hits = set(WORD.findall(st.lower())) & set(DENYLIST)
        if hits:
            errs.append(f"denylist hit {sorted(hits)}")
    return sorted(set(errs))


def validate(d):
    d = Path(d)
    man, enrol, bundles = load_dir(d)
    errs = check_manifest(d, man)
    errs += check_schemas(bundles, enrol)
    errs += check_counts(bundles)
    errs += check_traps(bundles)
    errs += check_variants(bundles)
    errs += check_decoys(bundles)
    errs += check_enrolment(bundles, enrol)
    errs += check_names(bundles, enrol)
    return errs
