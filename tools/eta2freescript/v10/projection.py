"""FRX-V10 Fix2 H2: what a completion_required entry may show. The heard words of a prompt (a slot's form, frequency, duration, timing, a drug name, a quote) are C4
values: they live in confirm_internal["completion"][item_id], never in completion_required. A public entry is {kind, item_id, prompt_id, prompt}, with a fixed
generic prompt per kind."""
from __future__ import annotations

GENERIC_PROMPT = {
    "pick_drug": "Name this drug",
    "inferred_confirm": "Confirm this item",
    "exam_missing": "Enter the examination finding",
    "dose_unstated": "Enter the missing dose parts",
    "drug_history": "Check this drug history item",
    "surgery_confirm": "Confirm this procedure",
    "follow_up_missing": "Set the follow-up",
    "follow_up_unstated": "Set the follow-up date",
    "boundary_review": "Check the clip for another patient's consult",
    "allergy_check": "Check this allergy",
    "lab_dx_conflict": "Review diagnosis against the heard HbA1c",
    "field_withheld": "Check the recording",
}
PUBLIC_KEYS = ("kind", "item_id", "prompt_id", "prompt")


def split_completion(art: dict) -> None:
    """Idempotent. Rewrites art["completion_required"] to the public shape and files the original prompt and the detail under confirm_internal.completion."""
    comp = art.get("completion_required")
    if not isinstance(comp, list):
        return
    store = art.setdefault("confirm_internal", {}).setdefault("completion", {})
    out = []
    for c in comp:
        if not isinstance(c, dict):
            out.append(c)
            continue
        kind, iid = c.get("kind"), c.get("item_id")
        generic = GENERIC_PROMPT.get(kind, "Check the recording")
        prompt = c.get("prompt")
        # a "Red flag said at mm:ss, confirm" prompt and the section prompts of field_withheld hold no heard word: they stay
        keep = kind == "field_withheld" and isinstance(prompt, str) and ("withheld: check the recording" in prompt or "withheld: confirm medicines in the Medication section" in prompt or prompt.startswith("Red flag said"))
        pub = {"kind": kind, "item_id": iid, "prompt_id": c.get("prompt_id") or iid, "prompt": prompt if keep else generic}
        extra = {k: v for k, v in c.items() if k not in PUBLIC_KEYS}
        if (not keep and prompt and prompt != generic) or extra:
            rec = {"kind": kind, **({"prompt": prompt} if not keep and prompt and prompt != generic else {}), **extra}
            if rec not in store.setdefault(str(iid), []):
                store[str(iid)].append(rec)
        out.append(pub)
    art["completion_required"] = out
