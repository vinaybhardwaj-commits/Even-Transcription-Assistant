import base64
import json
import logging
import time

import pytest

from llm_pool.auth import AuthError, BedrockAuth, Refresher, VertexAuth, load_env_file, service_account_info

ENV_KEYS = {
    "GCP_SA_KEY_JSON": "e30=",
    "GCP_AUDIENCE": "https://example.invalid/audience",
    "AWS_ROLE_ARN": "arn:aws:iam::123456789012:role/demo",
    "AWS_STS_REGION": "ap-south-1",
    "BEDROCK_REGION": "ap-south-1",
}


def write_env(tmp_path, name="probe.env", **overrides):
    values = dict(ENV_KEYS)
    values.update(overrides)
    path = tmp_path / name
    path.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
    path.chmod(0o600)
    return path


class Clock:
    def __init__(self, now=1_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


class ScriptedBedrockAuth(BedrockAuth):
    def __init__(self, env_path, clock):
        super().__init__(env_path, clock=clock)
        self.id_calls = 0
        self.sts_calls = 0
        self.durations = []
        self.invalidate_calls = 0

    def _mint_id_token(self):
        self.id_calls += 1
        return f"id-token-{self.id_calls}", self._clock() + 3600

    def _assume_role(self, web_identity_token):
        self.sts_calls += 1
        self.durations.append(self.duration_seconds)
        creds = {
            "AccessKeyId": f"AKIAFAKE{self.sts_calls}",
            "SecretAccessKey": f"secret-{self.sts_calls}",
            "SessionToken": f"session-{self.sts_calls}",
        }
        return creds, self._clock() + 900

    def invalidate(self):
        self.invalidate_calls += 1
        super().invalidate()


class ScriptedVertexAuth(VertexAuth):
    def __init__(self, env_path, clock):
        super().__init__(env_path, clock=clock)
        self.mint_calls = 0

    def _mint_token(self):
        self.mint_calls += 1
        return f"vertex-token-{self.mint_calls}", self._clock() + 3600


def test_env_file_parser(tmp_path):
    path = write_env(tmp_path, EXTRA_KEY="x")
    env = load_env_file(path)
    assert env["AWS_STS_REGION"] == "ap-south-1"
    assert env["EXTRA_KEY"] == "x"


def test_missing_bedrock_key_names_only(tmp_path):
    path = write_env(tmp_path)
    text = path.read_text().replace("AWS_ROLE_ARN", "AWS_ROLE_ARN_DISABLED")
    path.write_text(text)
    with pytest.raises(AuthError) as excinfo:
        BedrockAuth(path)
    message = str(excinfo.value)
    assert "AWS_ROLE_ARN" in message
    assert "arn:aws:iam" not in message


def test_session_refresh_lifecycle(tmp_path):
    clock = Clock()
    auth = ScriptedBedrockAuth(write_env(tmp_path), clock)
    session = auth.session()
    assert auth.id_calls == 1 and auth.sts_calls == 1
    assert auth.durations == [900]
    assert session.access_key_id == "AKIAFAKE1"
    assert session.expires_at == pytest.approx(clock.now + 900)
    assert auth.session() is session
    assert auth.sts_calls == 1
    clock.now += 601
    session2 = auth.session()
    assert auth.sts_calls == 2
    assert session2.access_key_id == "AKIAFAKE2"
    auth.invalidate()
    assert auth.invalidate_calls == 1
    auth.session(force=True)
    assert auth.sts_calls == 3


def test_session_reuses_within_margin(tmp_path):
    clock = Clock()
    auth = ScriptedBedrockAuth(write_env(tmp_path), clock)
    auth.session()
    clock.now += 599
    auth.session()
    assert auth.sts_calls == 1
    clock.now += 3
    auth.session()
    assert auth.sts_calls == 2


def test_id_token_cached_across_sts_refreshes(tmp_path):
    clock = Clock()
    auth = ScriptedBedrockAuth(write_env(tmp_path), clock)
    auth.session()
    clock.now += 601
    auth.session()
    assert auth.id_calls == 1
    assert auth.sts_calls == 2
    clock.now += 3001
    auth.session()
    assert auth.id_calls == 2
    assert auth.sts_calls == 3


def test_credentials_never_logged(tmp_path, caplog):
    caplog.set_level(logging.INFO, logger="llm_pool")
    clock = Clock()
    auth = ScriptedBedrockAuth(write_env(tmp_path), clock)
    auth.session()
    text = caplog.text
    assert "AKIAFAKE1" not in text
    assert "secret-1" not in text
    assert "session-1" not in text
    assert "id-token-1" not in text
    assert "bedrock sts session refreshed" in text


def test_vertex_token_lifecycle(tmp_path):
    clock = Clock()
    auth = ScriptedVertexAuth(write_env(tmp_path, name="vertex.env", VERTEX_SA_KEY_FILE="/tmp/fake.json",
                                        VERTEX_PROJECT="demo", VERTEX_LOCATION="asia-northeast1",
                                        GEMINI_MODEL="gemini-2.5-pro"), clock)
    assert auth.project == "demo"
    assert auth.location == "asia-northeast1"
    assert auth.default_model == "gemini-2.5-pro"
    assert auth.token() == "vertex-token-1"
    clock.now += 3299
    assert auth.token() == "vertex-token-1"
    clock.now += 3
    assert auth.token() == "vertex-token-2"
    auth.invalidate()
    assert auth.token() == "vertex-token-3"


def test_vertex_missing_key_names_only(tmp_path):
    path = write_env(tmp_path, name="vertex.env", VERTEX_SA_KEY_FILE="/tmp/fake.json", VERTEX_PROJECT="demo")
    path.write_text("\n".join(line for line in path.read_text().splitlines()
                              if not line.startswith("VERTEX_PROJECT")) + "\n")
    with pytest.raises(AuthError) as excinfo:
        VertexAuth(path)
    assert "VERTEX_PROJECT" in str(excinfo.value)


def test_service_account_info_forms(tmp_path):
    info = {"type": "service_account", "client_email": "sa@demo.iam.gserviceaccount.com"}
    assert service_account_info(json.dumps(info))["type"] == "service_account"
    key_file = tmp_path / "sa.json"
    key_file.write_text(json.dumps(info))
    assert service_account_info(str(key_file))["client_email"] == info["client_email"]
    encoded = base64.b64encode(json.dumps(info).encode()).decode().rstrip("=")
    assert service_account_info(encoded)["type"] == "service_account"


def test_service_account_info_long_blob_is_not_treated_as_path():
    short_blob = base64.b64encode(json.dumps({"type": "service_account", "project_id": "demo",
                                              "private_key": "x" * 2200}).encode()).decode().rstrip("=")
    assert len(short_blob) < 4096
    assert service_account_info(short_blob)["project_id"] == "demo"
    long_blob = base64.b64encode(json.dumps({"type": "service_account", "project_id": "demo",
                                             "private_key": "y" * 5000}).encode()).decode().rstrip("=")
    assert len(long_blob) > 4096
    assert service_account_info(long_blob)["project_id"] == "demo"


def test_service_account_info_errors_do_not_echo_input():
    with pytest.raises(AuthError) as excinfo:
        service_account_info("not-json-not-file-" + "z" * 500)
    assert "not-json-not-file" not in str(excinfo.value)
    with pytest.raises(AuthError):
        service_account_info("{not valid json")
    assert service_account_info.__name__ == "service_account_info"


def test_safe_cause_never_includes_path_payload():
    from llm_pool.auth import safe_cause

    error = OSError(36, "File name too long", "some-secret-blob")
    cause = safe_cause(error)
    assert "some-secret-blob" not in cause
    assert "File name too long" in cause
    assert safe_cause(ValueError("boom")) == "ValueError"


def test_refresher_survives_failures(caplog):
    caplog.set_level(logging.WARNING, logger="llm_pool")
    calls = []

    def flaky():
        calls.append(1)
        raise RuntimeError("boom")

    refresher = Refresher([flaky], interval_s=0.05)
    refresher.start()
    time.sleep(0.35)
    refresher.stop()
    refresher.join(timeout=2)
    assert len(calls) >= 2
    assert "RuntimeError" in caplog.text
    assert "boom" not in caplog.text
