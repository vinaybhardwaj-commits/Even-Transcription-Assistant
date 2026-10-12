"""PHI routing guard: consult transcripts may only go to Bedrock Anthropic Claude on the converse route.

Every client resolves a model alias to (model_id, route) and the pipeline calls assert_phi_safe on that pair before any
transcript leaves the process, whatever the client is (Bedrock, the box gateway, or a test double).
"""
from __future__ import annotations

BLOCKED_SUBSTR = ("deepseek", "qwen", "kimi", "moonshot", "grok", "xai", "glm", "zai", "mistral",
                  "gpt", "openai", "nemotron", "nvidia", "minimax", "gemma", "google", "gemini", "llama", "meta.")


class PhiGuardError(RuntimeError):
    pass


def assert_phi_safe(model_id: str, route: str) -> str:
    low = (model_id or "").lower()
    if any(b in low for b in BLOCKED_SUBSTR) or "anthropic.claude" not in low:
        raise PhiGuardError(f"PHI guard: model {model_id!r} is not Bedrock Anthropic Claude; refusing to send a transcript")
    if route != "converse":
        raise PhiGuardError(f"PHI guard: model {model_id!r} routes to {route!r}, expected Bedrock converse")
    return model_id
