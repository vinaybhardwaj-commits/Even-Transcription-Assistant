import os
import stat

import pytest

from llm_pool.__main__ import build_parser, ensure_token_file, validate_bind_host


def test_wildcard_bind_refused():
    for host in ("0.0.0.0", "::", "", " ", "0", "::0", "0:0:0:0:0:0:0:0", "0x0", "00", "*", "0.0.0.0/0"):
        with pytest.raises(SystemExit):
            validate_bind_host(host)
        with pytest.raises(SystemExit):
            validate_bind_host(host, allow_loopback=True)


def test_bind_must_be_tailnet():
    assert validate_bind_host("100.86.4.104") == "100.86.4.104"
    assert validate_bind_host("100.64.0.1") == "100.64.0.1"
    assert validate_bind_host("100.127.255.255") == "100.127.255.255"
    for host in ("100.128.0.1", "100.63.255.255", "10.0.0.1", "192.168.1.5", "8.8.8.8", "127.0.0.1", "::1",
                 "localhost", "172.16.0.1"):
        with pytest.raises(SystemExit):
            validate_bind_host(host)


def test_loopback_only_with_flag():
    assert validate_bind_host("127.0.0.1", allow_loopback=True) == "127.0.0.1"
    with pytest.raises(SystemExit):
        validate_bind_host("10.0.0.1", allow_loopback=True)


def test_token_file_created_0600(tmp_path):
    path = tmp_path / "nested" / "client.token"
    token = ensure_token_file(path)
    assert len(token) >= 32
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert ensure_token_file(path) == token
    assert path.parent.stat().st_mode & 0o077 == 0


def test_token_file_tightened_if_world_readable(tmp_path):
    path = tmp_path / "client.token"
    path.write_text("existing-token\n")
    path.chmod(0o644)
    assert ensure_token_file(path) == "existing-token"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_empty_token_file_is_fatal(tmp_path):
    path = tmp_path / "client.token"
    path.write_text("\n")
    path.chmod(0o600)
    with pytest.raises(SystemExit):
        ensure_token_file(path)


def test_parser_defaults():
    args = build_parser().parse_args([])
    assert args.host == "100.86.4.104"
    assert args.port == 4100
