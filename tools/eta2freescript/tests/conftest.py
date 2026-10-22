"""Put the repo root on sys.path so ``tools.eta2freescript`` imports. Shared synthetic builders."""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

FIX = Path(__file__).resolve().parent / "fixtures"
CONSULTS = FIX / "consults"
MODEL = FIX / "model"
T0 = 1_790_000_000_000  # arbitrary synthetic epoch ms


def stage_a(uid: str) -> dict:
    return json.loads((MODEL / uid / "stageA.json").read_text(encoding="utf-8"))


def mk_consult(lines, roles=None, role_track=True, lang="en", flags=None, clip_s=None):
    """lines: [(t0_s, t1_s, speaker, text)]. roles: speaker -> artifact role."""
    from tools.eta2freescript.ingest import Consult, RoleFlags, Turn
    turns = []
    for i, line in enumerate(lines):
        a, b, sp, text = line[:4]
        native = line[4] if len(line) > 4 else None
        role = (roles or {}).get(sp, "unknown")
        turns.append(Turn(idx=i, t0_ms=T0 + int(a * 1000), t1_ms=T0 + int(b * 1000), speaker=sp, text=text, lang=lang,
                          native_text=native, native_lang=lang if native else None,
                          role=role if role_track else "unknown", role_source="role_track" if role_track else "none"))
    end = T0 + int((clip_s if clip_s is not None else lines[-1][1] + 1) * 1000)
    return Consult(uid="synth-unit", turns=turns, clip_t0_ms=T0, clip_t1_ms=end, language_code=lang,
                   english_source="native" if lang == "en" else f"none:native-{lang}", diarised=True, room="synth-room",
                   role_track=role_track, role_flags=flags if flags is not None else (RoleFlags() if role_track else None))


def empty_encounter(**kw) -> dict:
    enc = {"schema": "even.encounter.v2", "speaker_roles": [], "chief_complaint": {}, "hpi": [], "comorbidities": [], "history": [],
           "drug_history": [], "allergy_history": [], "examination": [], "vitals": [], "assessment": {}, "diagnoses": [], "plan": [],
           "prescription": [], "regimen_slots": [], "investigations": [], "advice": [], "follow_up": {}, "referrals": [],
           "red_flags_safety_net": [], "consult_boundary": {"suspected": False, "foreign_turns": [], "reason": None}, "uncertainties": []}
    enc.update(copy.deepcopy(kw))
    return enc


def build_artifact(c, enc, boundary=None):
    from tools.eta2freescript.boundary import Boundary
    from tools.eta2freescript.guard import guard
    from tools.eta2freescript.mapper import build
    from tools.eta2freescript.note import flags_by_pointer, render_note
    enc = guard(copy.deepcopy(enc), c.turns)
    art = build(c, enc, boundary or Boundary(), "anthropic.claude-test", "0" * 64, "0" * 64)
    art["note_text"] = render_note(art["gp_extraction"], flags_by_pointer(art))
    return art


@pytest.fixture
def replay_out(tmp_path):
    """Run the whole pipeline over the synthetic consults with stored model output."""
    from tools.eta2freescript.ingest import list_consults, load_consult
    from tools.eta2freescript.models import ReplayClient
    from tools.eta2freescript.pipeline import run_consult
    client = ReplayClient(MODEL)
    logs = {u: run_consult(load_consult(CONSULTS, u), client, tmp_path) for u in list_consults(CONSULTS)}
    return tmp_path, logs


# FRX-V10: pipeline 3.0.0 posts no medicine and no strength (confirm prompts instead). These test modules pin the retired 2.5.0 behaviour of the
# mapper's medicine rows; they run with the module constant v10.config.ACTIVE off. The constant is read by nothing in production
# (no env, no CLI option, no Options field sets it); test_v10_no_strength_path.py proves that.
LEGACY_V10_MODULES = {
    "test_frx", "test_brand_first", "test_medication_safety", "test_mapper", "test_visit_keep", "test_rescore_s3", "test_sanitize_span_reject",
    "test_exact_release", "test_pipeline", "test_reject_fixes", "test_pdqi9_attribution", "test_frx_pass", "test_schema_notes", "test_pdqi9_harness",
    "test_regressions", "test_printable_v1", "test_stage_a_from", "test_fixtures", "test_frxn1_source", "test_floor_scope", "test_floor_strict",
    "test_floor_ordered_not_supported", "test_pulse_replay", "test_oracle_fixtures",
}


@pytest.fixture(autouse=True)
def _legacy_medicine_path(request, monkeypatch):
    if request.module.__name__.split(".")[-1] in LEGACY_V10_MODULES:
        from tools.eta2freescript.v10 import config
        monkeypatch.setattr(config, "ACTIVE", False)
