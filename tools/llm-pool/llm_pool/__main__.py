"""Entry point: `python -m llm_pool` starts the gateway on the tailnet bind address only."""
from __future__ import annotations

import argparse
import ipaddress
import logging
import os
import secrets
import socket
import stat
import sys
from pathlib import Path

from .auth import BedrockAuth, Refresher, VertexAuth
from .cap import CapGuard
from .config import ConfigError, load_config
from .ledger import Ledger
from .server import create_app
from .upstream import BedrockUpstream, VertexUpstream

log = logging.getLogger("llm_pool")

TAILNET_NET = ipaddress.ip_network("100.64.0.0/10")  # Tailscale CGNAT range
LOOPBACK_NETS = (ipaddress.ip_network("127.0.0.0/8"), ipaddress.ip_network("::1/128"))


def validate_bind_host(host: str, *, allow_loopback: bool = False) -> str:
    """Resolve the bind host and return the concrete, checked IP the server must bind.

    Refuses anything that is unspecified (0.0.0.0, ::, "0", "0x0", "0:0:0:0:0:0:0:0", ...) and anything outside
    the tailnet range 100.64.0.0/10. Loopback is allowed only with allow_loopback (tests, local smoke).
    Parsing goes through getaddrinfo + ipaddress, never string comparison, so alternative spellings of the
    wildcard cannot slip through."""
    text = (host or "").strip()
    if not text or text == "*":
        raise SystemExit("refusing to bind a wildcard address; pass a concrete tailnet IP (e.g. 100.86.4.104)")
    try:
        infos = socket.getaddrinfo(text, None, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError, ValueError):
        raise SystemExit("bind host does not resolve to an address; pass a concrete tailnet IP") from None
    addresses = []
    for info in infos:
        raw = str(info[4][0]).split("%", 1)[0]
        try:
            addr = ipaddress.ip_address(raw)
        except ValueError:
            raise SystemExit("bind host did not resolve to an IP address") from None
        if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
            addr = addr.ipv4_mapped
        addresses.append(addr)
    if not addresses:
        raise SystemExit("bind host did not resolve to an address")
    for addr in addresses:
        if addr.is_unspecified:
            raise SystemExit("refusing to bind a wildcard address; pass a concrete tailnet IP (e.g. 100.86.4.104)")
        if addr in TAILNET_NET:
            continue
        if allow_loopback and any(addr in net for net in LOOPBACK_NETS):
            continue
        raise SystemExit("refusing to bind outside the tailnet range 100.64.0.0/10; pass a tailnet IP")
    return str(addresses[0])


def ensure_token_file(path) -> str:
    file = Path(path).expanduser()
    file.parent.mkdir(parents=True, exist_ok=True)
    try:
        file.parent.chmod(0o700)
    except OSError:
        pass
    if file.exists():
        token = file.read_text().strip()
        mode = stat.S_IMODE(file.stat().st_mode)
        if mode & 0o077:
            file.chmod(0o600)
            log.warning("llm-pool: client token file %s was group/world readable; tightened to 0600", file.name)
        if not token:
            raise SystemExit(f"client token file {file} is empty")
        return token
    token = secrets.token_urlsafe(32)
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(token + "\n")
    log.info("llm-pool: generated a new client token at %s", file)
    return token


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="llm-pool", description="Budget-capped OpenAI-compatible gateway")
    parser.add_argument("--host", default="100.86.4.104", help="bind address (concrete IP only, not 0.0.0.0)")
    parser.add_argument("--allow-loopback", action="store_true",
                        help="permit a 127.0.0.0/8 bind (tests and local smoke only)")
    parser.add_argument("--port", type=int, default=4100)
    parser.add_argument("--config", default=None, help="JSON config path (default ~/.config/llm-pool/config.json)")
    parser.add_argument("--ledger", default=None, help="spend sqlite path (default from config)")
    parser.add_argument("--bedrock-env", default="~/.config/newcat/probe.env")
    parser.add_argument("--vertex-env", default="~/.config/newcat/vertex.env")
    parser.add_argument("--client-token-file", default=None, help="overrides config client_token_file")
    parser.add_argument("--refresher-interval", type=float, default=300.0)
    parser.add_argument("--no-refresher", action="store_true")
    parser.add_argument("--log-level", default="info")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    host = validate_bind_host(args.host, allow_loopback=args.allow_loopback)
    try:
        config = load_config(args.config)
    except ConfigError as exc:
        log.error("llm-pool: %s", exc)
        return 78
    token_file = args.client_token_file or config["client_token_file"]
    client_token = ensure_token_file(token_file)
    ledger_path = args.ledger or config["ledger_file"]
    ledger = Ledger(ledger_path)
    bedrock_auth = BedrockAuth(args.bedrock_env)
    vertex_auth = VertexAuth(args.vertex_env)
    bedrock = BedrockUpstream(bedrock_auth, default_max_tokens=config["default_max_tokens"])
    vertex = VertexUpstream(vertex_auth, default_max_tokens=config["default_max_tokens"])
    cap_guard = CapGuard(
        ledger,
        config["aws_daily_cap_usd_per_caller"],
        config.get("aws_daily_cap_warn_fraction", 0.8),
        total_cap_usd=config.get("aws_daily_total_cap_usd"),
    )
    app = create_app(
        config,
        ledger=ledger,
        bedrock=bedrock,
        vertex=vertex,
        client_token=client_token,
        cap_guard=cap_guard,
    )
    refresher = None
    if not args.no_refresher:
        refresher = Refresher(
            [lambda: bedrock_auth.session(), lambda: vertex_auth.token()],
            interval_s=args.refresher_interval,
        )
        refresher.start()
    import uvicorn

    log.info("llm-pool: listening on %s:%d (aws cap USD %.2f per caller per day since 00:00 IST)", host, args.port,
             float(config["aws_daily_cap_usd_per_caller"]))
    try:
        uvicorn.run(app, host=host, port=args.port, log_level=args.log_level)
    finally:
        if refresher is not None:
            refresher.stop()
        ledger.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
