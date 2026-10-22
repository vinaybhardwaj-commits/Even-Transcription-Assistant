"""Addendum A cases from the L0C work file (tests/fixtures_private/l0c-unsup.json, gitignored, 0600). Skipped when the file is absent. Reads item text but
prints only uid8 and counts."""
import json
from pathlib import Path

import pytest

from conftest import empty_encounter, mk_consult
from tools.eta2freescript.models import FakeClient
from tools.eta2freescript.pipeline import run_consult

F = Path(__file__).resolve().parent / "fixtures_private" / "l0c-unsup.json"
F1 = {"2l9171f6", "8tmar7qm", "hk2g0pnj", "db8a5mu7", "7s815msg"}
pytestmark = pytest.mark.skipif(not F.exists(), reason="private L0C fixtures not present")


def test_f1_cases_are_not_posted_as_advice_when_no_doctor_turn_carries_them(tmp_path):
    items = [i for i in json.loads(F.read_text(encoding="utf-8")) if i["uid"][-8:] in F1 or i["uid"][:8] in F1 or any(u in i["uid"] for u in F1)]
    items = [i for i in items if i["itype"] == "advice"]
    assert len(items) >= 3
    leaked = []
    for n, it in enumerate(items):
        c = mk_consult([(0, 6, "0", str(it["eng"])[:200]), (7, 9, "1", "okay")], roles={}, role_track=False)
        enc = empty_encounter(advice=[{"text": str(it["eng"])[:120], "basis": "said", "source_turns": [0]}])
        a = run_consult(c, FakeClient({"stageA": json.dumps(enc), "stageB": "x"}), tmp_path / str(n))["artifact"]
        if a["gp_extraction"].get("general_advice"):
            leaked.append(it["uid"][:8])
    assert leaked == []
