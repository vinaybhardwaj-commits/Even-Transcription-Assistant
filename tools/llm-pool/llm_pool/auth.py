"""Credential refresher: SA -> impersonated ID token -> STS AssumeRoleWithWebIdentity (Bedrock),
and a Vertex service-account bearer token. Secrets stay in process memory and are never logged."""
from __future__ import annotations

import base64
import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("llm_pool.auth")

BEDROCK_REQUIRED_KEYS = ("GCP_SA_KEY_JSON", "AWS_ROLE_ARN", "AWS_STS_REGION", "BEDROCK_REGION")
VERTEX_REQUIRED_KEYS = ("VERTEX_SA_KEY_FILE", "VERTEX_PROJECT")
CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform"


class AuthError(RuntimeError):
    pass


def load_env_file(path) -> dict:
    file = Path(path).expanduser()
    if not file.exists():
        raise AuthError(f"env file {file} does not exist")
    out: dict[str, str] = {}
    for line in file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip().strip('"').strip("'")
    return out


def safe_cause(exc: Exception) -> str:
    detail = exc.strerror if isinstance(exc, OSError) and exc.strerror else ""
    return f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__


def service_account_info(raw: str) -> dict:
    raw = raw.strip()
    if raw.startswith("{"):
        try:
            info = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise AuthError(f"inline GCP_SA_KEY_JSON is not valid JSON ({exc.msg})") from None
        if not isinstance(info, dict):
            raise AuthError("inline GCP_SA_KEY_JSON must be a JSON object")
        return info
    candidate = os.path.expanduser(raw) if raw.startswith("~") else raw
    if len(raw) < 4096 and os.path.isfile(candidate):
        try:
            info = json.loads(Path(candidate).read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise AuthError(f"service account key file unreadable ({safe_cause(exc)})") from None
        if not isinstance(info, dict):
            raise AuthError("service account key file must hold a JSON object")
        return info
    try:
        info = json.loads(base64.b64decode(raw + "=" * (-len(raw) % 4)))
    except Exception:
        raise AuthError("GCP_SA_KEY_JSON is neither inline JSON, an existing file path, nor base64 JSON") from None
    if not isinstance(info, dict):
        raise AuthError("base64 GCP_SA_KEY_JSON did not decode to a JSON object")
    return info


def _expiry_to_float(value) -> float:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.timestamp()
    return float(value)


@dataclass(frozen=True)
class BedrockSession:
    region: str
    access_key_id: str = field(repr=False)
    secret_access_key: str = field(repr=False)
    session_token: str = field(repr=False)
    expires_at: float

    def boto_kwargs(self) -> dict:
        return {
            "region_name": self.region,
            "aws_access_key_id": self.access_key_id,
            "aws_secret_access_key": self.secret_access_key,
            "aws_session_token": self.session_token,
        }


class BedrockAuth:
    def __init__(self, env_path, *, duration_seconds=900, refresh_margin_s=300, id_token_margin_s=120,
                 clock=time.time, session_name="llm-pool"):
        self.env = load_env_file(env_path)
        missing = [key for key in BEDROCK_REQUIRED_KEYS if not self.env.get(key)]
        if missing:
            raise AuthError("bedrock env file is missing keys: " + ", ".join(sorted(missing)))
        self.duration_seconds = int(duration_seconds)
        self.refresh_margin_s = float(refresh_margin_s)
        self.id_token_margin_s = float(id_token_margin_s)
        self._clock = clock
        self.session_name = session_name
        self._lock = threading.RLock()
        self._session: BedrockSession | None = None
        self._id_token: str | None = None
        self._id_token_expires_at = 0.0

    @property
    def region(self) -> str:
        return self.env["BEDROCK_REGION"]

    def session(self, force: bool = False) -> BedrockSession:
        with self._lock:
            now = self._clock()
            if not force and self._session and self._session.expires_at - now > self.refresh_margin_s:
                return self._session
            self._refresh_locked(now)
            assert self._session is not None
            return self._session

    def invalidate(self) -> None:
        with self._lock:
            self._session = None

    def _refresh_locked(self, now: float) -> None:
        try:
            token = self._id_token_locked(now)
            creds, expires_at = self._assume_role(token)
            session = BedrockSession(
                region=self.region,
                access_key_id=creds["AccessKeyId"],
                secret_access_key=creds["SecretAccessKey"],
                session_token=creds["SessionToken"],
                expires_at=_expiry_to_float(expires_at),
            )
        except AuthError:
            raise
        except Exception as exc:
            raise AuthError(f"bedrock credential refresh failed ({safe_cause(exc)})") from None
        self._session = session
        log.info("llm-pool: bedrock sts session refreshed (expires in %ds)", int(session.expires_at - now))

    def _id_token_locked(self, now: float) -> str:
        if self._id_token and self._id_token_expires_at - now > self.id_token_margin_s:
            return self._id_token
        token, expires_at = self._mint_id_token()
        self._id_token = token
        self._id_token_expires_at = _expiry_to_float(expires_at)
        return token

    def _mint_id_token(self) -> tuple[str, float]:
        from google.auth import impersonated_credentials
        import google.auth.transport.requests as google_requests
        from google.oauth2 import service_account

        info = service_account_info(self.env["GCP_SA_KEY_JSON"])
        scopes = [CLOUD_SCOPE]
        source = service_account.Credentials.from_service_account_info(info, scopes=scopes)
        audience = self.env.get("GCP_AUDIENCE") or info.get("client_email")
        impersonated = impersonated_credentials.Credentials(
            source_credentials=source,
            target_principal=info["client_email"],
            target_scopes=scopes,
            lifetime=3600,
        )
        id_token = impersonated_credentials.IDTokenCredentials(
            impersonated, target_audience=audience, include_email=True
        )
        id_token.refresh(google_requests.Request())
        expires_at = _expiry_to_float(id_token.expiry) if id_token.expiry else self._clock() + 3500
        return id_token.token, expires_at

    def _assume_role(self, web_identity_token: str) -> tuple[dict, float]:
        import boto3

        sts = boto3.client("sts", region_name=self.env["AWS_STS_REGION"])
        response = sts.assume_role_with_web_identity(
            RoleArn=self.env["AWS_ROLE_ARN"],
            RoleSessionName=self.session_name,
            WebIdentityToken=web_identity_token,
            DurationSeconds=self.duration_seconds,
        )
        creds = response["Credentials"]
        return creds, _expiry_to_float(creds["Expiration"])


class VertexAuth:
    def __init__(self, env_path, *, refresh_margin_s=300, clock=time.time):
        self.env = load_env_file(env_path)
        missing = [key for key in VERTEX_REQUIRED_KEYS if not self.env.get(key)]
        if missing:
            raise AuthError("vertex env file is missing keys: " + ", ".join(sorted(missing)))
        self.refresh_margin_s = float(refresh_margin_s)
        self._clock = clock
        self._lock = threading.RLock()
        self._token: str | None = None
        self._expires_at = 0.0

    @property
    def project(self) -> str:
        return self.env["VERTEX_PROJECT"]

    @property
    def location(self) -> str:
        return self.env.get("VERTEX_LOCATION") or "global"

    @property
    def default_model(self) -> str:
        return self.env.get("GEMINI_MODEL") or "gemini-2.5-pro"

    def token(self, force: bool = False) -> str:
        with self._lock:
            now = self._clock()
            if not force and self._token and self._expires_at - now > self.refresh_margin_s:
                return self._token
            try:
                token, expires_at = self._mint_token()
            except AuthError:
                raise
            except Exception as exc:
                raise AuthError(f"vertex credential refresh failed ({safe_cause(exc)})") from None
            self._token = token
            self._expires_at = _expiry_to_float(expires_at)
            log.info("llm-pool: vertex sa token refreshed (expires in %ds)", int(self._expires_at - now))
            return self._token

    def invalidate(self) -> None:
        with self._lock:
            self._token = None
            self._expires_at = 0.0

    def _mint_token(self) -> tuple[str, float]:
        import google.auth.transport.requests as google_requests
        from google.oauth2 import service_account

        key_file = Path(self.env["VERTEX_SA_KEY_FILE"]).expanduser()
        creds = service_account.Credentials.from_service_account_file(str(key_file), scopes=[CLOUD_SCOPE])
        creds.refresh(google_requests.Request())
        expires_at = _expiry_to_float(creds.expiry) if creds.expiry else self._clock() + 3500
        return creds.token, expires_at


class Refresher(threading.Thread):
    def __init__(self, targets, interval_s=300.0, *, logger=log):
        super().__init__(name="llm-pool-refresher", daemon=True)
        self._targets = list(targets)
        self._interval_s = float(interval_s)
        self._stop_event = threading.Event()
        self.log = logger

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        while not self._stop_event.wait(self._interval_s):
            for target in self._targets:
                try:
                    target()
                except Exception as exc:
                    self.log.warning(
                        "llm-pool: credential refresh failed (%s); will retry", type(exc).__name__
                    )
