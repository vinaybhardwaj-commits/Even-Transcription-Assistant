"""Add a per-caller token: appends to config "callers" and writes the token file. Never prints the token."""
from __future__ import annotations

import json
import os
import secrets
import stat
from pathlib import Path

from .config import CALLER_NAME_RE, DEFAULT_CONFIG_PATH, MAIN_CALLER

DEFAULT_TOKEN_DIR = "~/.config/llm-pool/callers"


class CallerError(ValueError):
    pass


def _write_private(path: Path, text: str, *, exclusive: bool) -> None:
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(text)
    path.chmod(0o600)


def add_caller(name: str, config_path: str | os.PathLike | None = None,
               token_dir: str | os.PathLike | None = None) -> Path:
    """Append caller `name` with a fresh random token. Returns the token file path (the token itself is
    only ever written to that 0600 file and to the 0600 config)."""
    if not isinstance(name, str) or not CALLER_NAME_RE.match(name):
        raise CallerError("caller name must match [A-Za-z0-9._-]{1,64}")
    if name == MAIN_CALLER:
        raise CallerError('caller name "main" is reserved for the main token')
    config_file = Path(config_path or os.environ.get("LLM_POOL_CONFIG", DEFAULT_CONFIG_PATH)).expanduser()
    tokens = Path(token_dir or DEFAULT_TOKEN_DIR).expanduser()
    raw: dict = {}
    if config_file.exists():
        try:
            raw = json.loads(config_file.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise CallerError(f"config file {config_file.name} is not readable JSON: {type(exc).__name__}") from None
        if not isinstance(raw, dict):
            raise CallerError(f"config file {config_file.name} must hold a JSON object")
    callers = raw.get("callers")
    if callers is None:
        callers = {}
    if not isinstance(callers, dict):
        raise CallerError("config callers must be an object")
    if name in callers:
        raise CallerError(f"caller {name} already exists")
    token_file = tokens / f"{name}.token"
    if token_file.exists():
        raise CallerError(f"token file for {name} already exists")
    tokens.mkdir(parents=True, exist_ok=True)
    try:
        tokens.chmod(0o700)
    except OSError:
        pass
    config_file.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    _write_private(token_file, token + "\n", exclusive=True)
    try:
        callers[name] = token
        raw["callers"] = callers
        tmp = config_file.with_name(config_file.name + ".tmp")
        _write_private(tmp, json.dumps(raw, indent=2) + "\n", exclusive=False)
        os.replace(tmp, config_file)
        config_file.chmod(0o600)
    except Exception:
        try:
            token_file.unlink()
        except OSError:
            pass
        raise
    assert stat.S_IMODE(config_file.stat().st_mode) == 0o600
    return token_file
