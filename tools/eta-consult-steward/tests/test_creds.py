from steward import creds, llm


def mk(exp):
    n = {"i": 0}
    def f():
        n["i"] += 1
        return {"access_key": "a", "secret_key": "b", "token": "c", "expires_at": exp + n["i"]}
    return f, n


def test_cache_and_refresh_margin():
    t = {"now": 1000.0}
    f, n = mk(5000.0)
    c = creds.CredentialCache(fetch=f, now=lambda: t["now"])
    c.get(); c.get()
    assert c.fetches == 1
    t["now"] = 5001 - 301   # just outside the 5 min margin
    c.get()
    assert c.fetches == 1
    t["now"] = 5001 - 299   # inside margin -> refresh
    c.get()
    assert c.fetches == 2


def test_configured(monkeypatch):
    for k in ("BEDROCK_SA_KEY_FILE", "BEDROCK_AUDIENCE", "BEDROCK_ROLE_ARN"):
        monkeypatch.delenv(k, raising=False)
    assert not creds.configured()
    for k in ("BEDROCK_SA_KEY_FILE", "BEDROCK_AUDIENCE", "BEDROCK_ROLE_ARN"):
        monkeypatch.setenv(k, "x")
    assert creds.configured()


def test_llm_rebuilds_client_on_new_creds(monkeypatch):
    import boto3
    made = []
    class RT:
        def converse(self, **k): return {"ok": 1}
    monkeypatch.setattr(boto3, "client", lambda *a, **k: (made.append(k), RT())[1])
    t = {"now": 0.0}
    f, n = mk(1000.0)
    cache = creds.CredentialCache(fetch=f, now=lambda: t["now"])
    m = llm.BedrockConverse("global.anthropic.claude-sonnet-4-6", region="ap-south-1", cache=cache)
    m.converse("s", [], {}); m.converse("s", [], {})
    assert len(made) == 1 and made[0]["aws_session_token"] == "c"
    t["now"] = 900.0
    m.converse("s", [], {})
    assert len(made) == 2


def test_fetch_flow_mocked(monkeypatch, tmp_path):
    import sys, types
    from datetime import datetime, timezone
    calls = []
    g = types.ModuleType("google"); go = types.ModuleType("google.oauth2"); sa = types.ModuleType("google.oauth2.service_account")
    class SC:
        service_account_email = "sa@x"
        @staticmethod
        def from_service_account_file(p, scopes): calls.append("sa"); return SC()
    sa.Credentials = SC
    ga = types.ModuleType("google.auth"); imp = types.ModuleType("google.auth.impersonated_credentials")
    class IC:
        def __init__(self, **k): pass
    class IT:
        token = "idtok"
        def __init__(self, base, target_audience, include_email): calls.append(("aud", target_audience, include_email))
        def refresh(self, r): calls.append("refresh")
    imp.Credentials, imp.IDTokenCredentials = IC, IT
    tr = types.ModuleType("google.auth.transport"); trr = types.ModuleType("google.auth.transport.requests"); trr.Request = object
    for name, mod in {"google": g, "google.oauth2": go, "google.oauth2.service_account": sa, "google.auth": ga,
                      "google.auth.impersonated_credentials": imp, "google.auth.transport": tr,
                      "google.auth.transport.requests": trr}.items():
        monkeypatch.setitem(sys.modules, name, mod)
    import boto3
    class STS:
        def assume_role_with_web_identity(self, **k):
            calls.append(("sts", k["RoleArn"], k["WebIdentityToken"]))
            return {"Credentials": {"AccessKeyId": "A", "SecretAccessKey": "S", "SessionToken": "T",
                                    "Expiration": datetime(2030, 1, 1, tzinfo=timezone.utc)}}
    monkeypatch.setattr(boto3, "client", lambda *a, **k: STS())
    out = creds._fetch({"BEDROCK_SA_KEY_FILE": "k.json", "BEDROCK_AUDIENCE": "123", "BEDROCK_ROLE_ARN": "arn:r", "AWS_REGION": "ap-south-1"})
    assert out["token"] == "T" and out["expires_at"] > 1e9
    assert ("aud", "123", True) in calls and ("sts", "arn:r", "idtok") in calls
