#!/usr/bin/env python3
"""add-caller.py <name>: add a per-caller token to the llm-pool config (0600) and print only the path of
the 0600 token file written (~/.config/llm-pool/callers/<name>.token). The token is never printed.
Restart the gateway to load the new caller."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from llm_pool.callers import CallerError, add_caller  # noqa: E402


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="add-caller.py", description=__doc__.split("\n")[0])
    parser.add_argument("name")
    parser.add_argument("--config", default=None, help="config path (default $LLM_POOL_CONFIG or ~/.config/llm-pool/config.json)")
    parser.add_argument("--token-dir", default=None, help="token directory (default ~/.config/llm-pool/callers)")
    args = parser.parse_args(argv)
    try:
        path = add_caller(args.name, args.config, args.token_dir)
    except CallerError as exc:
        print(f"add-caller: {exc}", file=sys.stderr)
        return 2
    print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
