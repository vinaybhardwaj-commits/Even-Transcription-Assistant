"""Bedrock credentials with no static AWS key.

GCP service account key -> IAM Credentials ID token (impersonated, include_email) -> STS AssumeRoleWithWebIdentity
-> temporary credentials. Cached in memory, refreshed 5 minutes before expiry.
Env (names only): BEDROCK_SA_KEY_FILE, BEDROCK_AUDIENCE, BEDROCK_ROLE_ARN, AWS_REGION.
"""
from __future__ import annotations
import os
import time
from datetime import datetime, timezone

REFRESH_MARGIN_S = 300
SCOPE = ["https://www.googleapis.com/auth/cloud-platform"]


def configured() -> bool:
    return all(os.environ.get(k) for k in ("BEDROCK_SA_KEY_FILE", "BEDROCK_AUDIENCE", "BEDROCK_ROLE_ARN"))


def _fetch(env=os.environ) -> dict:
    """Returns {access_key, secret_key, token, expires_at (epoch)}."""
    from google.oauth2 import service_account
    from google.auth import impersonated_credentials
    from google.auth.transport.requests import Request
    import boto3
    key = os.path.expanduser(env["BEDROCK_SA_KEY_FILE"])
    src = service_account.Credentials.from_service_account_file(key, scopes=SCOPE)
    t = impersonated_credentials.IDTokenCredentials(
        impersonated_credentials.Credentials(source_credentials=src, target_principal=src.service_account_email,
                                             target_scopes=SCOPE),
        target_audience=env["BEDROCK_AUDIENCE"], include_email=True)
    t.refresh(Request())
    region = env.get("AWS_REGION") or "ap-south-1"
    a = boto3.client("sts", region_name=region).assume_role_with_web_identity(
        RoleArn=env["BEDROCK_ROLE_ARN"], RoleSessionName="enc-steward", WebIdentityToken=t.token)["Credentials"]
    exp = a["Expiration"]
    exp = exp.timestamp() if isinstance(exp, datetime) else float(exp)
    return {"access_key": a["AccessKeyId"], "secret_key": a["SecretAccessKey"], "token": a["SessionToken"], "expires_at": exp}


class CredentialCache:
    def __init__(self, fetch=_fetch, now=time.time):
        self._fetch, self._now, self._c = fetch, now, None
        self.fetches = 0

    def get(self) -> dict:
        if self._c is None or self._now() >= self._c["expires_at"] - REFRESH_MARGIN_S:
            self._c = self._fetch()
            self.fetches += 1
        return self._c
