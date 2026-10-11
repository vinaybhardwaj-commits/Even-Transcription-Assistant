"""The CI workflow runs the unit suite only when tools/eta2freescript changes, and never installs a model SDK."""
from conftest import ROOT

WF = ROOT / ".github" / "workflows" / "eta2freescript-tests.yml"


def test_workflow_is_path_filtered_and_offline():
    text = WF.read_text(encoding="utf-8")
    assert text.count('"tools/eta2freescript/**"') == 2
    assert "pytest -c tools/eta2freescript/pytest.ini tools/eta2freescript/tests" in text
    assert "build_v02 --check" in text
    assert "requirements.txt" in text and "requirements-bedrock" not in text and "boto3" not in text


def test_requirements_have_no_model_sdk():
    req = (ROOT / "tools" / "eta2freescript" / "requirements.txt").read_text(encoding="utf-8")
    assert "boto3" not in req and "anthropic" not in req and "jsonschema" in req
