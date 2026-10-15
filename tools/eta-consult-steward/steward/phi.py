"""Output guard. No digit runs >= 6, no emails, no phone-like strings. Used on everything the steward writes."""
from __future__ import annotations
import re

DIGIT_RUN = re.compile(r"\d{6,}")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# +91 98765 43210, 98765-43210, (080) 1234 5678, 10+ digits with separators
PHONE = re.compile(r"(?<!\w)\+?\d[\d\s().-]{8,}\d(?!\w)")
TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?|\d{2}:\d{2}(:\d{2})?")
PHONE_DIGITS = re.compile(r"\d")
BLOCKED_MODEL_SUBSTR = ("deepseek", "qwen", "kimi", "moonshot", "grok", "xai", "glm", "zai", "mistral", "gpt",
                        "openai", "nemotron", "nvidia", "minimax", "gemma", "google", "gemini", "llama", "meta.")


class PhiGuardError(RuntimeError):
    pass


def violations(text: str) -> list[str]:
    out = []
    if not isinstance(text, str):
        return out
    if DIGIT_RUN.search(text):
        out.append("digit_run")
    if EMAIL.search(text):
        out.append("email")
    scrub = TIMESTAMP.sub(" ", text)
    for m in PHONE.finditer(scrub):
        if len(PHONE_DIGITS.findall(m.group(0))) >= 9:
            out.append("phone")
            break
    return out


def check(text: str) -> str:
    v = violations(text)
    if v:
        raise PhiGuardError("phi_guard: " + ",".join(v))
    return text


def check_deep(obj):
    """Check every string in a JSON-like object (keys excluded)."""
    if isinstance(obj, str):
        check(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            check_deep(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            check_deep(v)
    return obj


def assert_model_ok(model_id: str) -> str:
    low = (model_id or "").lower()
    if any(b in low for b in BLOCKED_MODEL_SUBSTR) or "anthropic.claude" not in low:
        raise PhiGuardError(f"model {model_id!r} is not Bedrock Anthropic Claude")
    return model_id
