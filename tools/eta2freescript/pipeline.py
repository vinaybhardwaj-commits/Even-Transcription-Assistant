"""One consult end to end:

  ingest (transcript + role track) -> boundary pre-check -> Stage A (prompts/stageA-v2) -> role fallback ->
  boundary post-check (Stage A topic) -> guard (citations, doctor dose precedence, numeric support) -> mapper v2 ->
  Stage B (prompts/stageB-v4) -> sanitize_note -> validate (v0.2 schema + vendored G1-G6 + C1-C3) -> deterministic note
  fallback. An artifact that is still invalid is not written.

Outputs in <out>/<uid>/ (umask 077): stageA.raw.txt, encounter.json, note_text.llm.txt, artifact.json, artifact.v0.1.json
(the v0.1 projection), artifact.validation.json. Nothing is sent anywhere except the model calls, which go through the
client and phi_guard.
"""
from __future__ import annotations

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
from .models import ModelClient
from .note import FILLER, HEADINGS, flags_by_pointer, render_note, sanitize_note
from .prompts import clean_text, code_paths, load_prompt, parse_json, prompt_path, sha
from .validate import check, to_v01


@dataclass
class Options:
    model: str = "sonnet"
    stage_a: str = f"stageA-{STAGE_A_VERSION}"
    stage_b: str = f"stageB-{STAGE_B_VERSION}"
    stage_b_enabled: bool = True
    write_v01: bool = True


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
    return system, (user.replace("{{TRANSCRIPT}}", format_transcript(c, pre.quarantined)).replace("{{ROLE_CONTEXT}}", role_context(c)))


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
    if not c.role_track:
        apply_inferred_roles(c.turns, enc.get("speaker_roles") or [])
    bnd = B.detect(c, enc.get("consult_boundary"))
    bnd.quarantined |= pre.quarantined
    for r in pre.reasons:
        if r not in bnd.reasons:
            bnd.reasons.append(r)
    bnd.suspected = bnd.suspected or pre.suspected
    enc = guard(enc, c.turns)
    secs_a = time.time() - t0
    (od / "encounter.json").write_text(json.dumps(enc, indent=1, ensure_ascii=False), encoding="utf-8")

    prompts = [prompt_path(opts.stage_a)] + ([prompt_path(opts.stage_b)] if opts.stage_b_enabled else [])
    art = build(c, enc, bnd, model_id, sha(*prompts), sha(*code_paths()), specialty)
    flags = flags_by_pointer(art)
    det = sanitize_note(render_note(art["gp_extraction"], flags))
    log = {"uid": c.uid, "speaker_source": c.speaker_source, "english_source": c.english_source,
           "boundary": art["clip_boundary"], "completion_required": len(art["completion_required"]),
           "guard_issues": enc["_guard"]["issues"]}
    t1 = time.time()
    llm_errs = None
    if opts.stage_b_enabled:
        sb, ub = load_prompt(opts.stage_b)
        try:
            txt = clean_text(client.chat(opts.model, ub.replace("{{GP_EXTRACTION}}", json.dumps(art["gp_extraction"], indent=1, ensure_ascii=False))
                                         .replace("{{FLAGS}}", json.dumps(flags, indent=1)), sb, max_tokens=2500, tag=f"{opts.stage_b}:{c.uid}"))
            (od / "note_text.llm.txt").write_text(txt + "\n", encoding="utf-8")
            log["raw_llm_note_has_filler"] = any(FILLER.match(l.partition(":")[2]) for l in txt.split("\n")
                                                 if l.partition(":")[0] in HEADINGS and l.partition(":")[2].strip())
            art["note_text"] = sanitize_note(txt)
            llm_errs = check(art)
        except Exception as e:  # a failed Stage B call falls back like an invalid note
            llm_errs = [f"stageB call failed: {type(e).__name__}"]
    if llm_errs is None or llm_errs:
        art["note_text"] = det
    log["llm_note_errors"] = llm_errs
    log["llm_note_valid"] = llm_errs == []
    log["note_source"] = f"llm_{opts.stage_b}" if llm_errs == [] else "deterministic_fallback"
    final = check(art)
    log.update({"final_errors": final, "final_valid": not final, "written": not final,
                "secs_stageA": round(secs_a, 1), "secs_stageB": round(time.time() - t1, 1), "secs_total": round(time.time() - t0, 1)})
    if not final:
        (od / "artifact.json").write_text(json.dumps(art, indent=1, ensure_ascii=False), encoding="utf-8")
        if opts.write_v01:
            (od / "artifact.v0.1.json").write_text(json.dumps(to_v01(art), indent=1, ensure_ascii=False), encoding="utf-8")
    (od / "artifact.validation.json").write_text(json.dumps(log, indent=1, ensure_ascii=False), encoding="utf-8")
    log["artifact"] = art if not final else None
    return log
