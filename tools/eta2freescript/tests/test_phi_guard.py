"""PHI guard: only Bedrock Anthropic Claude on converse may receive a transcript."""
import sys

import pytest
from conftest import CONSULTS

from tools.eta2freescript.ingest import load_consult
from tools.eta2freescript.models import BedrockClient, FakeClient, ReplayClient
from tools.eta2freescript.phi_guard import PhiGuardError, assert_phi_safe
from tools.eta2freescript.pipeline import run_consult


@pytest.mark.parametrize("mid", ["global.anthropic.claude-sonnet-4-6", "anthropic.claude-opus-4-6-v1", "replay.anthropic.claude-sonnet"])
def test_claude_on_converse_is_allowed(mid):
    assert assert_phi_safe(mid, "converse") == mid


@pytest.mark.parametrize("mid", ["openai.gpt-5", "deepseek.r1", "qwen.qwen3", "google.gemini-2", "meta.llama4", "mistral.large",
                                 "anthropic.claude-on-gemini", "amazon.nova-pro", "", None])
def test_other_models_are_refused(mid):
    with pytest.raises(PhiGuardError):
        assert_phi_safe(mid, "converse")


def test_claude_on_another_route_is_refused():
    with pytest.raises(PhiGuardError, match="routes to"):
        assert_phi_safe("anthropic.claude-sonnet", "openrouter")


def test_pipeline_refuses_before_any_call(tmp_path):
    fake = FakeClient({"stageA": "{}"}, model_id="openai.gpt-5")
    with pytest.raises(PhiGuardError):
        run_consult(load_consult(CONSULTS, "synth-fever-dose"), fake, tmp_path)
    assert fake.calls == []
    assert not (tmp_path / "synth-fever-dose" / "artifact.json").exists()


def test_bedrock_ids_are_claude_and_overridable(monkeypatch):
    c = BedrockClient()
    for alias in ("sonnet", "opus", "haiku"):
        mid, route = c.resolve(alias)
        assert_phi_safe(mid, route)
    monkeypatch.setenv("ETA2FS_BEDROCK_SONNET", "openai.gpt-oss")
    with pytest.raises(PhiGuardError):
        c.chat("sonnet", "x", "y")


def test_replay_and_resolve_never_import_boto3():
    BedrockClient().resolve("sonnet")
    ReplayClient(CONSULTS).resolve("sonnet")
    assert "boto3" not in sys.modules
