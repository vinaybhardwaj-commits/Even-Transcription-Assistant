# night-feeder token (Fable ruling 17, 24 Sep 2026)

The token is on the box at `~/.claude/secrets/night_feeder_token` (mode 0600, 64 hex chars, generated on the box, never printed, never committed). It is NOT in this repo. Fallback if it is not added by 18:00: run the feeder under `operator-v1`.

## What Fable adds to `SCRIBE_MCP_TOKENS` (Vercel production env)
The variable is a JSON object keyed by the SHA-256 hex of the token (`lib/mcp/auth.ts`). Add ONE key, keep every existing key:

```json
"6f659b0d0a7ef0a40241b0cf1229b166763c106073ad5749827791e13c792399": { "actor": "night-feeder", "scopes": ["read", "invoke"] }
```

- The key is the SHA-256 of the token file's exact bytes (no trailing newline), so it cannot be turned back into the token. Anyone holding only this file cannot authenticate.
- Scopes are `read` and `invoke` only. NO `write`: the holder cannot cancel jobs, set `switch_override`, or post room commands.
- Malformed JSON silently disables every keyed token (`parseTokenMap` falls back to the single token). Count entries before and after; a key that is not 64 hex characters is skipped as a typo.
- Env is baked at build time: redeploy the same sha after the edit (`vercel promote` from the `-ow` worktree, per CLAUDE.md), before 18:00.

## Verify (no job is queued by this)
With the box's token, a `scribe_job_list` call (`kind: room_window`, `limit: 1`) must answer 200. A 401 means the entry or the deploy is not live yet. The feeder's `--go` mode exits 2 on a refused token, before it submits anything.
