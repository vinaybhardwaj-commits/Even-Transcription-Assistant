# llm-pool

Budget-capped OpenAI-compatible gateway on t4 so OpenCode agents anywhere on the tailnet can use
Claude via Bedrock (and Gemini via Vertex) with a hard USD 500/day AWS spend cap.

**Why a small FastAPI shim and not LiteLLM:** LiteLLM is not installed on t4 and the lane rules allow
network only for `pip install numpy/pytest/scipy`, so it could not be installed. The gateway instead
reuses the probe's exact auth chain (SA -> impersonated ID token -> `AssumeRoleWithWebIdentity` ->
`bedrock-runtime.Converse` in ap-south-1) and owns the cap/ledger logic directly.

## Endpoints

- `POST /v1/chat/completions` — OpenAI chat completions, streaming (`stream: true`) and tool calls.
- `GET /v1/models` — aliases and known model ids.
- `GET /spend` — today's (IST) totals per model plus remaining AWS cap; numbers only.
- `GET /health` — liveness, unauthenticated.

Auth: `Authorization: Bearer <token>` where the token is `~/.config/llm-pool/client.token` (0600,
generated on first start). Optional per-caller keys: config `"callers": {"name": "token"}`; with the
main token, callers may set `X-LLM-Pool-Caller: <name>` for ledger attribution.

Model aliases: `opus` -> `global.anthropic.claude-opus-5-5`, `sonnet` -> `global.anthropic.claude-sonnet-5-5`,
`haiku` -> `global.anthropic.claude-haiku-5-5`, `gemini` -> Vertex `gemini-2.5-pro` (asia-northeast1).
Full Bedrock profile ids and any `gemini*` id also resolve; unknown ids are refused with 404.

## Spend control

- SQLite ledger `~/.config/llm-pool/spend.sqlite3`, append-only (UPDATE/DELETE are blocked by triggers),
  one row per call: ts, ist_day, caller, model, model_id, provider, in/out/cache tokens, est_usd, request_id.
- Prices come from the config file (seed values, UNVERIFIED — see table below), cache reads at 10% of the
  input price. Bedrock `inputTokens` is treated as including `cacheReadInputTokens`.
- Hard cap: bedrock spend since 00:00 IST >= `aws_daily_cap_usd` (500) -> HTTP 429 `aws_daily_cap_exceeded`.
  A warning line is logged at 80%. The cap is checked before each call (a concurrent burst can pass the
  check slightly). Vertex calls are not AWS spend and are not capped.

| family | in USD/1M | out USD/1M |
|---|---|---|
| opus | 15 | 75 |
| sonnet | 3 | 15 |
| haiku | 1 | 5 |
| gemini | 1.25 | 10 |

## Credentials

Read from `~/.config/newcat/probe.env` (Bedrock) and `~/.config/newcat/vertex.env` (Vertex) — the same
files the 17 Oct probe used. STS creds use `DurationSeconds=900` and are refreshed in memory at <300 s
remaining (plus a 5-minute background refresher); Vertex SA tokens refresh at <300 s. Secrets are never
written to disk, argv, or logs. The bind address must be a concrete IP (the server exits on 0.0.0.0).

## Run

```
tools/llm-pool/.venv/bin/python -m llm_pool --host 100.86.4.104 --port 4100
```

The venv is `--system-site-packages` plus boto3/botocore/google-auth copied offline from
`~/oc/llm-pool/.venv` (no network install). systemd user unit: `units/llm-pool.service`
(`cp` to `~/.config/systemd/user/`, `systemctl --user daemon-reload && enable --now llm-pool`).

OpenCode provider snippet: `opencode-provider.example.json` (merge into `opencode.json`; the
`{file:...}` read of `client.token` is opencode's file interpolation).

## Tests

```
python3 -m pytest tools/llm-pool/tests -q          # unit tests, no network
LLM_POOL_LIVE=1 python3 -m pytest tools/llm-pool/tests/test_live_smoke.py -q -s   # live, <= USD 2
```

Unit tests cover price math, the append-only ledger, IST day rollover, cap refusal at the exact
boundary (mocked upstream), OpenAI<->Bedrock/Vertex conversion (messages, tool calls, stream chunks)
and the HTTP surface (auth, aliases, 429, /spend). The live smoke runs haiku non-stream, haiku
stream and a tool-call round trip through a real gateway instance.
