"""M5 (A52/D8): Bedrock is called through InvokeModel; the served model id is read from each response body and kept per call (Stage A and Stage B apart)."""
import io
import json
from pathlib import Path

import pytest

from tools.eta2freescript.models import BedrockClient, UsageLedger
from tools.eta2freescript.phi_guard import PhiGuardError, assert_phi_safe

FIX = Path(__file__).resolve().parent / "bedrock_fixtures"


class StubRuntime:
    """A recorded-response stand-in for boto3 bedrock-runtime. No network, no AWS."""

    def __init__(self, files):
        self.files, self.calls = list(files), []

    def invoke_model(self, **kw):
        self.calls.append(kw)
        name = self.files.pop(0)
        return {"body": io.BytesIO((FIX / name).read_bytes()),
                "ResponseMetadata": {"RequestId": "req-" + name[:10], "HTTPHeaders": {"x-amzn-requestid": "hdr-" + name[:10]}}}

    def converse(self, **kw):  # the old route must never be used
        raise AssertionError("converse called")


def client(files, tmp_path=None):
    c = BedrockClient(UsageLedger(tmp_path / "u.jsonl" if tmp_path else None))
    c._rt = StubRuntime(files)
    return c


def test_invoke_model_body_and_text(tmp_path):
    c = client(["invoke_stage_a.json"], tmp_path)
    out = c.chat("sonnet", "user text", "system text", max_tokens=777, tag="stageA-v3:u1")
    call = c._rt.calls[0]
    body = json.loads(call["body"])
    assert call["modelId"] == "global.anthropic.claude-sonnet-4-6"
    assert body["anthropic_version"] == "bedrock-2023-05-31" and body["max_tokens"] == 777 and body["temperature"] == 0.0
    assert body["system"] == "system text" and body["messages"] == [{"role": "user", "content": "user text"}]
    assert out == '{"schema": "synthetic"}'
    rec = json.loads((tmp_path / "u.jsonl").read_text().splitlines()[0])
    assert rec["in"] == 1200 and rec["out"] == 340 and rec["stop"] == "end_turn" and rec["usd"] > 0


def test_served_id_is_per_call_and_stage_a_is_not_overwritten():
    c = client(["invoke_stage_a.json", "invoke_stage_b_no_model.json"])
    c.chat("sonnet", "a", "s", tag="stageA-v3:u1")
    c.chat("sonnet", "b", "s", tag="stageB-v10:u1")
    assert c.served_for("stageA-v3:u1") == {"id": "claude-sonnet-4-6-20260101-synthetic", "request_id": "req-invoke_sta"}
    assert c.served_for("stageB-v10:u1") == {"id": None, "request_id": "req-invoke_sta"}  # absent in the body: never the alias-table id
    assert c.served_for("stageA-v3:u2") is None


def test_unverified_text_carries_the_request_id():
    c = client(["invoke_stage_b_no_model.json"])
    c.chat("sonnet", "b", "s", tag="stageB-v10:u1")
    assert c.served_label("stageB-v10:u1") == "unverified:req-invoke_sta"
    assert c.served_label("stageA-v3:none") == "unverified"


def test_phi_guard_still_refuses_other_routes():
    assert assert_phi_safe("global.anthropic.claude-sonnet-4-6", "invoke_model")
    with pytest.raises(PhiGuardError):
        assert_phi_safe("global.anthropic.claude-sonnet-4-6", "gateway")
    with pytest.raises(PhiGuardError):
        assert_phi_safe("gpt-4", "invoke_model")


def test_pipeline_artifact_keeps_stage_a_and_stage_b_ids_apart(tmp_path):
    from conftest import CONSULTS, stage_a
    from tools.eta2freescript.ingest import load_consult
    from tools.eta2freescript.pipeline import run_consult
    uid = "synth-fever-dose"
    stage_b = (Path(__file__).resolve().parent / "fixtures" / "model" / uid / "stageB.txt").read_text()
    a_body = {"model": "served-a", "content": [{"type": "text", "text": json.dumps(stage_a(uid))}], "stop_reason": "end_turn", "usage": {"input_tokens": 1, "output_tokens": 1}}
    b_body = {"content": [{"type": "text", "text": stage_b}], "stop_reason": "end_turn", "usage": {"input_tokens": 1, "output_tokens": 1}}

    class RT:
        def __init__(self):
            self.n = 0

        def invoke_model(self, **kw):
            self.n += 1
            body = a_body if self.n == 1 else b_body
            return {"body": io.BytesIO(json.dumps(body).encode()), "ResponseMetadata": {"RequestId": f"rid{self.n}", "HTTPHeaders": {}}}

    c = BedrockClient()
    c._rt = RT()
    lg = run_consult(load_consult(CONSULTS, uid), c, tmp_path)
    g = lg["artifact"]["generator"]
    assert g["served_model_ids"] == {"stage_a": "served-a", "stage_b": "unverified:rid2"}
    assert g["served_model_id"] == "served-a" and g["model_id_source"] == "request_alias_unverified"  # Fix2 nit: provider_response only when every stage named its model
