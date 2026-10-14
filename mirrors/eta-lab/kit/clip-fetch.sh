#!/bin/zsh
# kit/clip-fetch.sh <window_id> <out_path> -- see clip-fetch.py for the real logic
# (Scribe MCP scribe_extract_audio, since real R2 credentials exist only in Vercel prod).
exec python3 "$(dirname "$0")/clip-fetch.py" "$@"
