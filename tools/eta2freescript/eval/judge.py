"""Judge each artifact against the consult's signed note and tape, and turn the audit into one metrics row.

  python -m tools.eta2freescript eval --data DIR --out OUT [--judge opus] [--client bedrock|gateway|replay]

Reference: <data>/<uid>/signed.json, the signed Pulse note already normalised to
  {"medicines": [{"name", "strength", "frequency", "duration"}], "diagnoses": [""], "icd_codes": [""],
   "investigations": [""], "comorbidities": [""], "advice": "", "plan": "", "follow_up": {"type", "date", "text"}}
Unknown keys are passed through. A consult with no signed.json is skipped.

Writes OUT/eval/judge-v3/<uid>.json (cached; --force re-judges) and OUT/eval/results.csv. Judge calls go through the same
client and phi_guard as the pipeline.
"""
from __future__ import annotations

import csv
import json
import os
from pathlib import Path

from ..ingest import Consult, format_transcript
from ..models import ModelClient
from ..note import filler_lines
from ..prompts import load_prompt, parse_json
from ..validate import check

JUDGE = "judge-v3"
REF_KEYS = ("medicines", "diagnoses", "icd_codes", "investigations", "comorbidities", "advice", "plan", "follow_up")


def ratio(a: int, b: int):
    return round(a / b, 3) if b else None


def norm_reference(signed: dict) -> dict:
    ref = {k: signed[k] for k in REF_KEYS if k in signed}
    ref.update({k: v for k, v in signed.items() if k not in ref and not k.startswith("_")})
    return ref


def prediction(art: dict) -> dict:
    kept = [p for p in art["provenance"] if p["json_pointer"] is None]
    return {"gp_extraction": art["gp_extraction"],
            "kept_out": [{"k": i, **{k: p[k] for k in ("kind", "text", "status", "flags")}} for i, p in enumerate(kept)],
            "completion_required": [{"c": i, **c} for i, c in enumerate(art.get("completion_required") or [])],
            "clip_boundary": art.get("clip_boundary")}


def judge_one(c: Consult, art: dict, client: ModelClient, out_dir: Path, judge_model: str = "opus", force: bool = False) -> dict | None:
    jp = Path(out_dir) / "eval" / JUDGE / f"{c.uid}.json"
    if jp.exists() and not force:
        return json.loads(jp.read_text(encoding="utf-8"))
    if not c.signed:
        return None
    pred = prediction(art)
    ref = norm_reference(c.signed)
    s, u = load_prompt(JUDGE)
    u = (u.replace("{{TRANSCRIPT}}", format_transcript(c)).replace("{{REFERENCE}}", json.dumps(ref, indent=1, ensure_ascii=False))
          .replace("{{PREDICTION}}", json.dumps(pred, indent=1, ensure_ascii=False)).replace("{{STAGE_B}}", art["note_text"]))
    audit = parse_json(client.chat(judge_model, u, s, max_tokens=12000, tag=f"{JUDGE}:{c.uid}"))
    rec = {"uid": c.uid, "judge": judge_model, "prompt": JUDGE, "kept_out": pred["kept_out"],
           "completion_required": pred["completion_required"], "audit": audit}
    os.umask(0o077)
    jp.parent.mkdir(parents=True, exist_ok=True)
    jp.write_text(json.dumps(rec, indent=1, ensure_ascii=False), encoding="utf-8")
    return rec


def metrics(rec: dict, art: dict, log: dict | None = None) -> dict:
    j, kept = rec["audit"], rec["kept_out"]
    gx = art["gp_extraction"]
    dr, dp = j.get("drugs_ref", []), j.get("drugs_pred", [])
    named = [x for x in dr if x.get("said_aloud") == "named"]
    unnamed = [x for x in dr if x.get("said_aloud") in ("regimen_only", "silent")]
    regonly = [x for x in dr if x.get("said_aloud") == "regimen_only"]
    hit = lambda x, lv=("exact", "same_generic"): x.get("matched_pred_idx") is not None and x.get("match") in lv
    used = set()
    for x in dr:  # one slot counts for one reference drug
        if x.get("slot_k") is not None:
            if x["slot_k"] in used:
                x["slot_k"] = None
            else:
                used.add(x["slot_k"])
    slots = [k for k in kept if k["text"].startswith("[regimen_slot]")]
    held = [k for k in kept if "[held_back_inferred_order]" in k["text"]]
    quarantined = [k for k in kept if "[boundary_quarantine]" in k["text"]]
    kor, cr = j.get("kept_out_review", []), j.get("completion_review", [])
    com = j.get("comorbidities_pred", [])
    dose = [(x.get("dose") or {}).get(f) for x in dr if x.get("matched_pred_idx") is not None for f in ("strength", "frequency", "duration")]
    dose = [v for v in dose if v in ("match", "close", "mismatch", "pred_missing")]
    ir, ip, rp = j.get("investigations_ref", []), j.get("investigations_pred", []), j.get("referrals_pred", [])
    ar, ap = j.get("advice_ref", []), j.get("advice_pred", [])
    dx, fu = j.get("diagnosis", {}), j.get("follow_up") or {}
    status_err = [x for x in dp + ip + rp if x.get("order_status_ok") is False]
    log = log or {}
    return {
        "uid": rec["uid"], "speaker_source": art["encounter"]["transcript"].get("speaker_source"),
        "n_drugs_signed": len(dr), "n_signed_named_aloud": len(named), "n_signed_regimen_only": len(regonly),
        "n_signed_silent": len(dr) - len(named) - len(regonly), "n_meds_pred": len(gx.get("medicines", [])),
        "drug_recall_strict": ratio(sum(hit(x) for x in dr), len(dr)), "strict_hits": sum(hit(x) for x in dr),
        "drug_recall_named_aloud": ratio(sum(hit(x) for x in named), len(named)), "named_aloud_hits": sum(hit(x) for x in named),
        "drug_pred_matched": sum(1 for p in dp if p.get("matched_ref_idx") is not None), "n_drugs_pred_judged": len(dp),
        "drug_pred_unsupported": sum(1 for p in dp if p.get("tape_supported") == "no"),
        "n_regimen_slots": len(slots), "slots_captured": sum(1 for x in unnamed if x.get("slot_k") is not None),
        "slots_captured_regimen_only": sum(1 for x in regonly if x.get("slot_k") is not None),
        "n_held_back": len(held), "n_quarantined": len(quarantined),
        "held_true_order": sum(1 for x in kor if x.get("verdict") == "true_order_held_back"),
        "held_halluc_prevented": sum(1 for x in kor if x.get("verdict") == "hallucination_prevented"),
        "held_unclear": sum(1 for x in kor if x.get("verdict") == "unclear"),
        "n_completion_required": len(art.get("completion_required") or []),
        "completion_needed": sum(1 for x in cr if x.get("verdict") == "needed"),
        "completion_unneeded": sum(1 for x in cr if x.get("verdict") == "unneeded"),
        "n_comorbidities_pred": len(com), "comorbidities_valid": sum(1 for x in com if x.get("valid")),
        "order_status_errors": len(status_err),
        "dose_fields_compared": len(dose), "dose_fields_matched": sum(1 for d in dose if d in ("match", "close")),
        "dose_fields_unconfirmed": sum(1 for d in dose if d == "pred_missing"), "dose_fields_mismatch": sum(1 for d in dose if d == "mismatch"),
        "n_dx_pred": len((gx.get("presenting_complaints") or {}).get("diagnoses", [])),
        "dx_match": dx.get("match"), "icd_match": dx.get("icd_match"), "dx_oversplit": bool(dx.get("dx_oversplit")),
        "n_inv_ref": len(ir), "inv_ref_hit": sum(1 for x in ir if x.get("matched")),
        "n_inv_pred": len(ip), "inv_pred_hit": sum(1 for x in ip if x.get("matched_ref")),
        "n_adv_ref": len(ar), "adv_ref_hit": sum(1 for x in ar if x.get("matched")),
        "n_adv_pred": len(ap), "adv_pred_supported": sum(1 for x in ap if x.get("tape_supported") in ("yes", "partial")),
        "advice_chars": len(gx.get("general_advice") or ""), "advice_too_long": bool(j.get("advice_too_long")),
        "follow_up_match": fu.get("match"), "follow_up_type_ok": fu.get("type_ok"),
        "follow_up_has_type": bool((gx.get("follow_up") or {}).get("followup_type")) if gx.get("follow_up") else None,
        "hallucinations": len(j.get("hallucinations", [])),
        "omissions_said_aloud": len(j.get("omissions_said_aloud", [])),
        "omissions_not_said_aloud": len(j.get("omissions_not_said_aloud", [])),
        "stage_b_additions": len(j.get("stage_b_additions", [])),
        "filler_lines_in_note": filler_lines(art["note_text"]),
        "artifact_valid": not check(art), "note_source": log.get("note_source", ""),
    }


def write_rows(rows: list[dict], path: Path) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    old = list(csv.DictReader(open(path, encoding="utf-8"))) if path.exists() else []
    uids = {r["uid"] for r in rows}
    keep = [r for r in old if r["uid"] not in uids]
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()), extrasaction="ignore")
        w.writeheader()
        w.writerows(keep + rows)
