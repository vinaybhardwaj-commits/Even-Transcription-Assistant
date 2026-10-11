"""The CI workflow runs the fast suite only, and only when tools/timbre changes."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def test_workflow_is_fast_and_path_filtered():
    text = (ROOT / ".github" / "workflows" / "timbre-tests.yml").read_text(encoding="utf-8")
    assert "tools/timbre/**" in text
    assert "not slow" in text
    assert "pytest" in text
    assert "requirements-fast.txt" in text
    assert "test-all" not in text
