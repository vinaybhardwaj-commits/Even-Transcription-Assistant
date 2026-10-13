"""Pool OUT/eval/results.csv and OUT/usage.jsonl into OUT/eval/headline.json (micro-averages over consults).

  python -m tools.eta2freescript aggregate --out OUT
"""
from __future__ import annotations

import collections
import csv
import json
from pathlib import Path

from ..validate import schema_v03


def _i(r, k) -> int:
    try:
        return int(float(r.get(k) or 0))
    except ValueError:
        return 0


def pct(a: int, b: int) -> str:
    return f"{a}/{b} ({100 * a / b:.0f}%)" if b else "n/a"


# The kinds come from the v0.3 schema enum, never a hand-kept list.
COMPLETION_KINDS = tuple(schema_v03()["properties"]["completion_required"]["items"]["properties"]["kind"]["enum"])


def head(rs: list[dict]) -> dict:
    if not rs:
        return {"consults": 0}
    s = lambda k: sum(_i(r, k) for r in rs)
    nd, na, nro, ns = s("n_drugs_signed"), s("n_signed_named_aloud"), s("n_signed_regimen_only"), s("n_signed_silent")
    dx, icd, fu = (collections.Counter(r.get(k) for r in rs) for k in ("dx_match", "icd_match", "follow_up_match"))
    fu_typed = [r for r in rs if r.get("follow_up_has_type") in ("True", "False", True, False)]
    return {
        "consults": len(rs), "signed_drugs": nd, "named_aloud": na, "regimen_only": nro, "silent": ns,
        "share_never_named_aloud": pct(nro + ns, nd),
        "drug_recall_all_signed_strict": pct(s("strict_hits"), nd),
        "drug_recall_named_aloud": pct(s("named_aloud_hits"), na),
        "drug_precision": pct(s("drug_pred_matched"), s("n_drugs_pred_judged")),
        "drugs_sent_without_tape_support": s("drug_pred_unsupported"),
        "regimen_slots_emitted": s("n_regimen_slots"), "slot_capture_all_unnamed": pct(s("slots_captured"), nro + ns),
        "slot_capture_regimen_only": pct(s("slots_captured_regimen_only"), nro),
        "dose_fields_matched": pct(s("dose_fields_matched"), s("dose_fields_compared")),
        "dose_fields_mismatch": s("dose_fields_mismatch"), "dose_fields_unconfirmed_null": s("dose_fields_unconfirmed"),
        "comorbidity_precision": pct(s("comorbidities_valid"), s("n_comorbidities_pred")),
        "order_status_errors": s("order_status_errors"),
        "held_back_inferred_orders": s("n_held_back"), "held_back_true_orders": s("held_true_order"),
        "held_back_hallucinations_prevented": s("held_halluc_prevented"), "held_back_unclear": s("held_unclear"),
        "boundary_quarantined_items": s("n_quarantined"),
        "completion_required_items": s("n_completion_required"),
        "completion_required_by_type": {k: s(f"n_completion_{k}") for k in COMPLETION_KINDS},
        "completion_required_needed": pct(s("completion_needed"), s("n_completion_required")),
        "completion_required_unneeded": s("completion_unneeded"),
        "dx_per_consult": round(s("n_dx_pred") / len(rs), 2), "dx_oversplit_consults": sum(1 for r in rs if r.get("dx_oversplit") in ("True", True)),
        "dx_exact_or_partial": pct(dx["exact"] + dx["partial"], len(rs)), "icd_exact_or_category": pct(icd["exact"] + icd["category"], len(rs)),
        "inv_recall": pct(s("inv_ref_hit"), s("n_inv_ref")), "inv_precision": pct(s("inv_pred_hit"), s("n_inv_pred")),
        "advice_recall": pct(s("adv_ref_hit"), s("n_adv_ref")), "advice_tape_supported": pct(s("adv_pred_supported"), s("n_adv_pred")),
        "advice_chars_mean": round(s("advice_chars") / len(rs), 1), "advice_too_long_consults": sum(1 for r in rs if r.get("advice_too_long") in ("True", True)),
        "follow_up_match_or_close": pct(fu["match"] + fu["close"], sum(v for k, v in fu.items() if k not in ("ref_missing", None, ""))),
        "follow_up_with_type": pct(sum(1 for r in fu_typed if r.get("follow_up_has_type") in ("True", True)), len(fu_typed)),
        "hallucinations": s("hallucinations"), "hallucinations_per_consult": round(s("hallucinations") / len(rs), 2),
        "omissions_said_aloud": s("omissions_said_aloud"), "omissions_not_said_aloud": s("omissions_not_said_aloud"),
        "stage_b_additions": s("stage_b_additions"), "filler_lines_in_note": s("filler_lines_in_note"),
        "validator_pass_final": pct(sum(1 for r in rs if r.get("artifact_valid") in ("True", True)), len(rs)),
        "llm_note_text_pass": pct(sum(1 for r in rs if str(r.get("note_source", "")).startswith("llm_")), len(rs)),
    }


def cost(ledger: Path) -> dict:
    if not ledger.exists():
        return {}
    recs = [json.loads(l) for l in ledger.read_text(encoding="utf-8").splitlines() if l.strip()]
    by = collections.defaultdict(list)
    for r in recs:
        by[r["tag"].split(":")[0]].append(r)
    return {k: {"calls": len(v), "input_tokens": sum(r["in"] for r in v), "output_tokens": sum(r["out"] for r in v),
                "usd": round(sum(r["usd"] for r in v), 4), "model_secs_sum": round(sum(r["secs"] for r in v), 1)} for k, v in sorted(by.items())}


def aggregate(out_dir: Path) -> dict:
    out_dir = Path(out_dir)
    path = out_dir / "eval" / "results.csv"
    rows = list(csv.DictReader(open(path, encoding="utf-8"))) if path.exists() else []
    res = {"all": head(rows),
           "by_speaker_source": {k: head([r for r in rows if r.get("speaker_source") == k]) for k in sorted({r.get("speaker_source") for r in rows})},
           "cost": cost(out_dir / "usage.jsonl"),
           "pricing_assumption": "USD/1M tokens in/out: Sonnet 3/15, Opus 5/25, Haiku 1/5 (list); the Bedrock bill may differ"}
    (out_dir / "eval").mkdir(parents=True, exist_ok=True)
    (out_dir / "eval" / "headline.json").write_text(json.dumps(res, indent=1), encoding="utf-8")
    return res
