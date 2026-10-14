#!/usr/bin/env python3
"""CLI for kit/clip_fetch_core.py -- see that module for how this works.

Usage: clip-fetch.py <window_id> <out_path>
Exit 0 = fetched. Exit 1 = Scribe MCP refusal or no chunk covers the window. Exit 2 = usage/
lookup error.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from clip_fetch_core import fetch_window_clip, ClipFetchError  # noqa: E402


def main():
    if len(sys.argv) != 3:
        print("usage: clip-fetch.py <window_id> <out_path>", file=sys.stderr)
        sys.exit(2)
    window_id, out_path = sys.argv[1], sys.argv[2]
    try:
        n, session_id = fetch_window_clip(window_id, out_path)
    except ClipFetchError as e:
        print(f"{window_id}: {e}", file=sys.stderr)
        sys.exit(2 if str(e).startswith("LOOKUP") else 1)
    print(f"{window_id}: fetched via {n} chunk(s) ({session_id})", file=sys.stderr)


if __name__ == "__main__":
    main()
