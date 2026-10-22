"""One consult end to end:

  ingest (transcript + role track) -> boundary pre-check -> Stage A (prompts/stageA-v2) -> role fallback ->
  boundary post-check (Stage A topic) -> guard (citations, doctor dose precedence, numeric support) -> mapper v2 ->
  Stage B (prompts/stageB-v9) -> sanitize_note -> validate (v0.2 schema + vendored G1-G6 + C1-C3) -> deterministic note
  fallback. An artifact that is still invalid is not written.

Outputs in <out>/<uid>/ (umask 077): stageA.raw.txt, encounter.json, note_text.llm.txt, artifact.json, artifact.v0.1.json
(the v0.1 projection), artifact.validation.json; a rejected consult writes artifact.rejected.json instead of artifact.json. Nothing is sent anywhere except the model calls, which go through the
client and phi_guard.
"""
from __future__ import annotations

import copy
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

from . import STAGE_A_VERSION, STAGE_B_VERSION
from . import boundary as B
from .guard import guard
from .ingest import Consult, apply_inferred_roles, format_transcript
from .mapper import build
from .models import ModelClient, cost_for_uid
from .note import FILLER, HEADINGS, combination_groups, flags_by_pointer, render_note, repair_note, sanitize_note_ex, span_errors
from .prompts import clean_text, code_paths, load_prompt, parse_json, prompt_path, sha
from .validate import check, to_v01
from .v10 import finalize as v10_final
from .v10 import meds as v10_meds
from .v10 import spans as v10_spans


@dataclass
class Options:
    model: str = "sonnet"
    stage_a: str = f"stageA-{STAGE_A_VERSION}"
    stage_b: str = f"stageB-{STAGE_B_VERSION}"
    stage_b_enabled: bool = True
    write_v01: bool = True


def _med_lines(art: dict):
    """FRX-V10: the Medication section, rendered from the confirm prompts."""
    return v10_meds.medication_lines(art.get("confirm_prompts") or [])


def _fallback_note(art: dict, flags: dict, banned: list[str]) -> str:
    return _fallback_note_ex(art, flags, banned)[0]


def _fallback_note_ex(art: dict, flags: dict, banned: list[str]) -> tuple[str, list]:
    """Deterministic note, and the spans the sanitiser removed from it. If carried-over free text still names a kept-out order, drop that free text and render again.
    The fallback must not fail C4: a C4 failure used to mean no artifact was written at all."""
    det, rem = sanitize_note_ex(render_note(art["gp_extraction"], flags, banned, combination_groups(art), _med_lines(art)))
    shadow = dict(art)
    shadow["note_text"] = det
    if not any(e.startswith("C4") for e in check(shadow)):
        return det, rem
    gx = copy.deepcopy(art["gp_extraction"])
    for m in gx.get("medicines") or []:
        m.pop("instructions", None)
    for inv in gx.get("further_investigations") or []:
        inv.pop("instruction", None)
    for ref in gx.get("referrals") or []:
        ref.pop("notes", None)
    return sanitize_note_ex(render_note(gx, flags, groups=combination_groups(art), med_lines=_med_lines(art)))


def spoken_brands_text(art: dict) -> str:
    """The "Spoken combination brands" list for Stage B: brand -> gp_extraction medicine indices, or "none"."""
    groups = combination_groups(art)
    return "\n".join(f"{b} -> medicines {idx}" for b, idx in groups) if groups else "none"


def role_context(c: Consult) -> str:
    if not c.role_track:
        return ("No role track for this consult. Speaker labels [S0], [S1] are NOT roles: infer each speaker's role from content "
                "and report it in speaker_roles with a confidence.")
    f = c.role_flags
    flags = {k: getattr(f, k) for k in ("attender_present", "two_consults", "diar_partial")} if f else {}
    return ("Speaker roles come from the REB role track and are shown after the label, e.g. [S0|doctor]. Treat them as given; "
            "echo them in speaker_roles with confidence 1.0 and do not reassign them. Role-track flags: " + json.dumps(flags))


def stage_a_prompt(c: Consult, pre: B.Boundary, version: str) -> tuple[str, str]:
    system, user = load_prompt(version)
    return system, (user.replace("{{TRANSCRIPT}}", format_transcript(c, pre.quarantined, spans=version.startswith("stageA-v3"))).replace("{{ROLE_CONTEXT}}", role_context(c)))


def run_consult(c: Consult, client: ModelClient, out_dir: Path, opts: Options | None = None, specialty: str | None = None) -> dict:
    opts = opts or Options()
    os.umask(0o077)
    od = Path(out_dir) / c.uid
    od.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    model_id, _ = client.resolve(opts.model)
    pre = B.detect(c)
    system, user = stage_a_prompt(c, pre, opts.stage_a)
    raw = client.chat(opts.model, user, system, max_tokens=16000, tag=f"{opts.stage_a}:{c.uid}")
    (od / "stageA.raw.txt").write_text(raw, encoding="utf-8")
    enc = parse_json(raw)
    enc = v10_spans.cite_to_turns(enc)  # Stage A v3 cites span ids ("s12"); the mapper reads the integer turn index
    if not c.role_track:
        apply_inferred_roles(c.turns, enc.get("speaker_roles") or [])
    bnd = B.detect(c, enc.get("consult_boundary"))
    # A pre-Stage-A quarantine must not put back a turn Stage A left as this patient (the long-gap bug).
    cb = enc.get("consult_boundary") if isinstance(enc.get("consult_boundary"), dict) else None
    if cb is not None and "foreign_turns" in cb:
        foreign = {t for t in (cb.get("foreign_turns") or []) if isinstance(t, int) and 0 <= t < len(c.turns)}
        pre_keep = pre.quarantined - (set(range(len(c.turns))) - foreign)
    else:
        pre_keep = pre.quarantined
    bnd.quarantined |= pre_keep
    for r in pre.reasons:
        if r not in bnd.reasons:
            bnd.reasons.append(r)
    bnd.suspected = bnd.suspected or pre.suspected
    enc = guard(enc, c.turns)
    secs_a = time.time() - t0
    (od / "encounter.json").write_text(json.dumps(enc, indent=1, ensure_ascii=False), encoding="utf-8")

    prompts = [prompt_path(opts.stage_a)] + ([prompt_path(opts.stage_b)] if opts.stage_b_enabled else [])
    ctx: dict = {}
    art = build(c, enc, bnd, model_id, sha(*prompts), sha(*code_paths()), specialty, ctx)
    gate, bl = ctx.get("gate"), ctx.get("builder")
    flags = flags_by_pointer(art)
    banned = [n for p in art["provenance"] if not p.get("json_pointer") for n in (p.get("names") or []) if n]
    det, det_rem = _fallback_note_ex(art, flags, banned)
    log = {"uid": c.uid, "speaker_source": c.speaker_source, "english_source": c.english_source,
           "boundary": art["clip_boundary"], "completion_required": len(art["completion_required"]),
           "guard_issues": enc["_guard"]["issues"]}

    def view_of(note: str) -> tuple[dict, list[str]]:
        """The artifact as it would be written with this note: slot values written back and FRX-T1 run (rules 4 and 12). Returns (artifact, FRX-T1 errors)."""
        v = copy.deepcopy(art)
        failed = v10_final.gp_final(gate, v, c)
        v["provenance"] = v10_final.writeback_tree(gate, v["provenance"])
        v["completion_required"] = v10_final.writeback_tree(gate, v["completion_required"])
        v["slots"] = v10_final.writeback_tree(gate, v["slots"])
        for key in ("doctor_words", "red_flags"):
            v[key] = v10_final.writeback_tree(gate, v[key])
        final, bad = v10_final.note_final(gate, v, c, note)
        v["note_text"] = final
        return v, [f"FRX-T1 gp {f}:{r}" for f, r, _u, _p in failed] + [f"FRX-T1 note {h}:{r}" for h, r in bad.items()]

    t1 = time.time()
    llm_errs = None
    if opts.stage_b_enabled:
        sb, ub = load_prompt(opts.stage_b)
        try:
            txt = clean_text(client.chat(opts.model, ub.replace("{{GP_EXTRACTION}}", json.dumps(art["gp_extraction"], indent=1, ensure_ascii=False))
                                         .replace("{{FLAGS}}", json.dumps(flags, indent=1))
                                         .replace("{{COMBINATION_BRANDS}}", spoken_brands_text(art)), sb, max_tokens=2500, tag=f"{opts.stage_b}:{c.uid}"))
            (od / "note_text.llm.txt").write_text(txt + "\n", encoding="utf-8")
            log["raw_llm_note_has_filler"] = any(FILLER.match(l.partition(":")[2]) for l in txt.split("\n")
                                                 if l.partition(":")[0] in HEADINGS and l.partition(":")[2].strip())
            note, llm_rem = sanitize_note_ex(txt)
            view, t1errs = view_of(note)
            llm_errs = check(view) + span_errors(llm_rem) + t1errs
            if llm_errs and not span_errors(llm_rem):  # a note that lost a span on an order line is not repaired: it goes to the fallback
                note, llm_rem = sanitize_note_ex(repair_note(txt, art["gp_extraction"], flags, banned, combination_groups(art), _med_lines(art)))
                view, t1errs = view_of(note)
                repaired = check(view) + span_errors(llm_rem) + t1errs
                log["note_repaired"] = not repaired
                llm_errs = [] if not repaired else repaired
        except Exception as e:  # a failed Stage B call falls back like an invalid note
            llm_errs = [f"stageB call failed: {type(e).__name__}"]
    if llm_errs is None or llm_errs:
        note, llm_rem = det, det_rem
    log["llm_note_errors"] = llm_errs
    log["llm_note_valid"] = llm_errs == []
    log["note_source"] = f"llm_{opts.stage_b}" if llm_errs == [] else "deterministic_fallback"
    log["cost_usd"] = cost_for_uid(getattr(client, "ledger", None), c.uid)
    from .recover import recover_medicine_rules, soften_f2_m3
    recovered = soften_f2_m3(art)
    recovered += recover_medicine_rules(art)
    if recovered:
        flags = flags_by_pointer(art)
        banned = [n for p in art["provenance"] if not p.get("json_pointer") for n in (p.get("names") or []) if n]
        note, llm_rem = _fallback_note_ex(art, flags, banned)
        log["field_recovery"] = recovered
    # FRX-V10: whatever still fails FRX-T1 on the deterministic note is withheld (rule 8): the unit is blanked and a record, a provenance item and a prompt written
    view, t1errs = view_of(note)
    if t1errs and bl is not None:
        v0 = copy.deepcopy(art)
        failed = v10_final.gp_final(gate, v0, c)
        _final_note, bad = v10_final.note_final(gate, v0, c, note)
        v10_final.drop_units(art, failed)
        for fld, reason, _u, _p in failed:
            bl.withhold(fld, reason, [], stage="floor")
        for h, reason in bad.items():
            bl.withhold(next((k for k, v in bl.SECTION.items() if v == h), "plan"), reason, [], stage="floor")
        log["frx_t1_withheld"] = [{"field": f, "reason": r} for f, r, _u, _p in failed] + [{"section": h, "reason": r} for h, r in bad.items()]
        flags = flags_by_pointer(art)
        note, llm_rem = _fallback_note_ex(art, flags, banned)
        view, t1errs = view_of(note)
    final = check(view) + span_errors(llm_rem)
    served = (getattr(client, "served_ids", {}) or {}).get(opts.model)
    view["generator"]["served_model_id"] = served
    if served:
        view["generator"]["model"] = served  # A52: the id the provider response named, not the alias-table id
    view["generator"]["model_id_source"] = "provider_response" if served else "request_alias_unverified"
    view["generator"]["stage_a_version"], view["generator"]["stage_b_version"] = opts.stage_a, opts.stage_b
    art = view
    if llm_rem:  # only when a span was removed, so a consult with none keeps a byte-identical log
        log["sanitize_removed"] = len(llm_rem)
    log.update({"final_errors": final, "final_valid": not final, "written": not final,
                "secs_stageA": round(secs_a, 1), "secs_stageB": round(time.time() - t1, 1), "secs_total": round(time.time() - t0, 1)})
    if not final:
        (od / "artifact.json").write_text(json.dumps(art, indent=1, ensure_ascii=False), encoding="utf-8")
        if opts.write_v01:
            (od / "artifact.v0.1.json").write_text(json.dumps(to_v01(art), indent=1, ensure_ascii=False), encoding="utf-8")
    else:
        # A rejected artifact is kept for diagnosis only: the artifact as built, with the final note. Posting reads artifact.json
        # and artifact.v0.1.json, never this file.
        rej = od / "artifact.rejected.json"
        rej.write_text(json.dumps(art, indent=1, ensure_ascii=False), encoding="utf-8")
        os.chmod(rej, 0o600)
    (od / "artifact.validation.json").write_text(json.dumps({k: v for k, v in log.items() if k != "artifact"}, indent=1, ensure_ascii=False), encoding="utf-8")
    log["artifact"] = art
    return log
