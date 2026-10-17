# llm-pool

Budget-capped OpenAI-compatible gateway on t4 so OpenCode agents anywhere on the tailnet can use
Claude via Bedrock (and Gemini via Vertex) with a hard USD 500 per caller per IST day AWS spend cap.

**Why a small FastAPI shim and not LiteLLM:** LiteLLM is not installed on t4 and the lane rules allow
network only for `pip install numpy/pytest/scipy`, so it could not be installed. The gateway instead
reuses the probe's exact auth chain (SA -> impersonated ID token -> `AssumeRoleWithWebIdentity` ->
`bedrock-runtime.Converse` in ap-south-1) and owns the cap/ledger logic directly.

## Endpoints

- `POST /v1/chat/completions` — OpenAI chat completions, streaming (`stream: true`) and tool calls.
- `GET /v1/models` — aliases and known model ids.
- `GET /spend` — today's (IST) totals per model, plus per-caller spend, in-flight reservations and remaining cap; numbers only.
- `GET /health` — liveness, unauthenticated.

Auth: `Authorization: Bearer <token>` where the token is `~/.config/llm-pool/client.token` (0600,
generated on first start) = caller `main`. Per-caller keys: `./add-caller.py <name>` appends the caller to the
config (0600; the file must stay 0600 once `callers` is set) and prints only the path of the 0600 token file it
wrote (`~/.config/llm-pool/callers/<name>.token`). Restart the gateway to load it. `main` is a reserved name.
The authenticated token decides the cap bucket; `X-LLM-Pool-Caller: <label>` is only a ledger sub-label.

Model aliases: `opus` -> `global.anthropic.claude-opus-5-5`, `sonnet` -> `global.anthropic.claude-sonnet-5-5`,
`haiku` -> `global.anthropic.claude-haiku-5-5`, `gemini` -> Vertex `gemini-2.5-pro` (asia-northeast1).
Full Bedrock profile ids (`^[a-z]{2,6}\.anthropic\.claude-...`) also resolve. Gemini ids must be listed in config
`models` (strict `^gemini-[0-9a-z.\-]+$`, each with a price family); anything else is refused with 404.

## Spend control

- SQLite ledger `~/.config/llm-pool/spend.sqlite3`, append-only (UPDATE/DELETE are blocked by triggers),
  one row per call: ts, ist_day, caller (label), principal (cap bucket), model, model_id, provider, in/out/cache tokens,
  est_usd, request_id, basis.
- Prices come from the config file (seed values, UNVERIFIED — see table below), cache reads at 10% of the
  input price. Bedrock `inputTokens` is treated as including `cacheReadInputTokens`.
- Cap (V, 18 Oct): USD `aws_daily_cap_usd_per_caller` (500) of Bedrock spend per authenticated caller per IST day
  (the cap prevents wasted compute, not cost). Optional `aws_daily_total_cap_usd` (default null = off) caps all
  callers together. Over cap -> HTTP 429 `aws_daily_cap_exceeded` whose body names the caller, its spend and the cap.
  Warning line at 80% per caller. The legacy `aws_daily_cap_usd` key is read as the per-caller cap.
- Atomic: before each Bedrock call the worst case (request bytes as input tokens + `max_tokens` x output price) is
  reserved under a lock, counting other in-flight reservations; afterwards it is settled to the real usage.
  A call Bedrock accepted is never written as 0: a stream whose client went away is still drained to Bedrock's
  final metadata event, and if usage never arrives the reservation is billed (ledger `basis` = `reserved`;
  `actual` = provider-reported, `none` = provider refused the call). Vertex is not AWS spend and is not capped.
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
written to disk, argv, or logs. The bind address must resolve to a tailnet IP in 100.64.0.0/10 (anything unspecified, such as `0`, `::0` or
`0x0`, or outside that range, exits); `--allow-loopback` is for tests only.

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
