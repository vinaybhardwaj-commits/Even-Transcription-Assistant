"""Read-only fetch of consult audio from the ``eta-audio`` R2 bucket.

The client is allowed to call ``GetObject`` and nothing else. Keys must sit under
an allowed prefix and end in ``.wav`` or ``.flac``. Credentials are read from
the environment when no client is injected. They are never logged.
"""

from __future__ import annotations

import os

BUCKET = "eta-audio"
DEFAULT_PREFIXES = ("consult-clips/", "clips/")
AUDIO_SUFFIXES = (".wav", ".flac")
ENV_KEYS = ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")


class R2AudioError(ValueError):
    pass


def resolve_prefixes(explicit: str | tuple[str, ...] | None = None) -> tuple[str, ...]:
    """CLI value, else ``TIMBRE_AUDIO_PREFIXES``, else the consult prefixes."""
    raw = explicit
    if raw is None:
        raw = os.environ.get("TIMBRE_AUDIO_PREFIXES")
    if raw is None or raw == "":
        return DEFAULT_PREFIXES
    if isinstance(raw, str):
        parts = tuple(p.strip() for p in raw.split(",") if p.strip())
    else:
        parts = tuple(p.strip() for p in raw if str(p).strip())
    if not parts:
        raise R2AudioError("audio prefixes are empty")
    out = []
    for part in parts:
        if "/" in part.strip("/") or part.startswith("/") or ".." in part:
            raise R2AudioError("audio prefix is not a single relative prefix")
        out.append(part if part.endswith("/") else part + "/")
    return tuple(out)


def allowed_audio_key(key: str, prefixes: tuple[str, ...] | None = None) -> None:
    """Refuse anything that is not a wav/flac object under an allowed prefix."""
    if not isinstance(key, str) or not key or key.startswith("/") or "\\" in key or "\x00" in key:
        raise R2AudioError("refusing audio key: suffix or prefix is not allowed")
    parts = key.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise R2AudioError("refusing audio key: suffix or prefix is not allowed")
    if not key.endswith(AUDIO_SUFFIXES):
        raise R2AudioError("refusing audio key: suffix or prefix is not allowed")
    allowed = prefixes if prefixes is not None else DEFAULT_PREFIXES
    if not any(key.startswith(prefix) for prefix in allowed):
        raise R2AudioError("refusing audio key: suffix or prefix is not allowed")


def bucket_name() -> str:
    name = os.environ.get("R2_BUCKET") or BUCKET
    if not name or "/" in name or " " in name:
        raise R2AudioError("R2_BUCKET is not a bucket name")
    return name


def fetch_audio(
    key: str,
    *,
    client=None,
    bucket: str | None = None,
    prefixes: tuple[str, ...] | None = None,
) -> bytes:
    """``GetObject`` only. ``client`` is injectable so tests never touch the network."""
    allowed_audio_key(key, prefixes)
    if client is None:
        client = r2_client_from_env()
    chosen = bucket or bucket_name()
    obj = client.get_object(Bucket=chosen, Key=key)
    body = obj["Body"].read()
    if not isinstance(body, (bytes, bytearray)):
        raise R2AudioError("R2 object body was not bytes")
    if not body:
        raise R2AudioError("R2 object body was empty")
    return bytes(body)


def r2_client_from_env():
    missing = [name for name in ENV_KEYS if not os.environ.get(name)]
    if missing:
        raise R2AudioError("missing env: " + ", ".join(missing))
    try:
        import boto3
        from botocore.config import Config
    except ImportError as e:
        raise R2AudioError("boto3 is not installed") from e
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
        region_name="auto",
    )
