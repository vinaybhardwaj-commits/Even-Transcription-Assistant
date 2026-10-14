"""Mirror finished REB files to the lab R2 bucket (Fable, 27 Sep 13:22: "mirror each finished window
to the lab R2 bucket reb/ so lab-viewer can read it"; 13:55: token-only, no account id needed —
wrangler resolves the account from the token). Off by default (REB_R2_MIRROR unset); the step-3/4
runner turns it on for the real backfill, so the offline test suite never touches the network.

Uses `wrangler r2 object put` (the tool lab-viewer's own HANDOVER says it uses for R2 reads), not
boto3/S3 API, since the lab bucket is fronted by wrangler/the Cloudflare API, not raw R2 keys.
The token is read from its 0600 secrets file into THIS PROCESS's env only for the duration of the
wrangler subprocess call — never argv, never logged, never left in the parent's own environ.
"""
import os
import subprocess

DEFAULT_BUCKET = os.environ.get("REB_R2_BUCKET", "eta-lab-results")
TOKEN_FILE = os.environ.get("CLOUDFLARE_API_TOKEN_FILE", os.path.expanduser("~/.claude/secrets/cloudflare_api_token"))


class R2MirrorNotConfigured(RuntimeError):
    pass


def enabled():
    return os.environ.get("REB_R2_MIRROR", "").strip().lower() in ("1", "true", "yes")


def _read_token():
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except OSError as e:
        raise R2MirrorNotConfigured(
            f"REB_R2_MIRROR is on but {TOKEN_FILE} could not be read ({e}); set CLOUDFLARE_API_TOKEN_FILE "
            "or unset REB_R2_MIRROR."
        )


def put(local_path, r2_key, bucket=None):
    """Upload one file to <bucket>/<r2_key> via `wrangler r2 object put --remote`. Raises
    subprocess.CalledProcessError on failure (never swallowed — a silent mirror gap is worse than a
    loud one, since lab-viewer trusts R2 to have what the box has)."""
    bucket = bucket or DEFAULT_BUCKET
    token = _read_token()
    env = dict(os.environ, CLOUDFLARE_API_TOKEN=token)
    try:
        subprocess.run(
            ["npx", "wrangler", "r2", "object", "put", f"{bucket}/{r2_key}",
             "--file", local_path, "--remote"],
            check=True, capture_output=True, text=True, env=env,
        )
    finally:
        del env  # drop our only reference to the token-bearing dict promptly


def mirror_window_files(root, ist_date, room_id, window_id, paths, bucket=None):
    """paths: absolute local paths (manifest.json + whichever track files changed) already known to
    the caller (the writer knows exactly what it just wrote — this module never scans for work).
    r2_key mirrors the local layout under reb/: reb/<ist_date>/<room_id>/<window_id>/...
    """
    if not enabled():
        return []
    pushed = []
    for p in paths:
        rel = os.path.relpath(p, root)
        r2_key = f"reb/{rel}"
        put(p, r2_key, bucket=bucket)
        pushed.append(r2_key)
    return pushed


def mirror_index(root, ist_date, bucket=None):
    """The day's index.jsonl is rewritten (grown) on every track write; re-push the whole (small)
    file rather than trying to append remotely."""
    if not enabled():
        return None
    index_path = os.path.join(root, ist_date, "index.jsonl")
    if not os.path.exists(index_path):
        return None
    r2_key = f"reb/{ist_date}/index.jsonl"
    put(index_path, r2_key, bucket=bucket)
    return r2_key
