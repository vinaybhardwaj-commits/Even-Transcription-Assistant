# LOCAL MODELS (Fable ORDER 453.C) — plan and evidence

Owner: herdr-kit. Status: PLAN + measured feasibility, benchmark pending. No pane moves until eta-refuter PASS.

## Purpose
Give cheap-repeat work (loops, pollers, formatting) a local route so it stops burning paid Go tokens. NOT for reasoning-heavy builds.

## 1. Serve box: the Mini
Evidence verified live 26 Sep:
- `ollama 0.18.2` installed (homebrew) and ALREADY RUNNING as a service:
  `curl 127.0.0.1:11434/api/version` OK, server + runner processes alive. This is the
  same service scribe_health already reports for the Mini.
- Models present: `llama3.1:8b` (4.9 GB, capabilities `completion + tools`, tool
  template present) and `nomic-embed-text` (embeddings only). Disk 92 GB free.
- Hardware: Apple M4 Pro, 24 GB unified RAM — measured ~45 tok/s, ~5.7 s cold, ~0.3 s
  warm round-trip on short prompts.
- Box T4 (e2e-lab-ts): NO ollama installed (`curl :11434` refused), GPU 15 GB with
  4.4 GB already used, disk 75% full. Installing there = new service + likely gotcha
  on a production-adjacent box. NOT needed to start; Mini suffices.

## 2. Model and provider block
- Model: `llama3.1:8b`. Already downloaded, no pull, tool-capable per /api/show.
- OpenCode side: opencode 1.18.32 has NO built-in local ollama provider (binary ships
  only `ollama-cloud` = ollama.com with OLLAMA_API_KEY). Verified mechanism: a custom
  provider block with `npm: "@ai-sdk/openai-compatible"` (the universal adapter in the
  binary) + `"options": {"baseURL": "http://127.0.0.1:11434/v1"}`.
  VERIFIED end-to-end live: `opencode run -m ollama/llama3.1:8b` completes through the
  local server, plain + `--format json` both. `step_finish.cost = 0` — free by
  construction, invisible to the Zen meter (no Go burn).
- `kit/local-models/opencode.jsonc.template` is the pane-side block (loopback, no
  secrets, no {file:} reference needed).

## 3. Benchmark (5 REAL loop tasks = the actual prompts these lanes run)
Tasks (synthetic, nophi, in `bench.py`): (t1) fleet-watch room-check strict-JSON
gather, (t2) conductor digest one-line render, (t3) roadmap rev line render,
(t4) bus subject tagging one-word, (t5) sha-format check.
Runner: `bench.py`. For each task and each arm:
- arm L-raw: raw ollama `/api/chat`, `format: "json"`, `temperature 0` (direct API —
  what a poller loop would actually call);
- arm L-oc: `opencode run --agent <lane-agent> -m ollama/llama3.1:8b --format json`
  with the 453.C provider block (what an OpenCode pane would call);
- arm P-oc (baseline): `opencode run -m opencode/qwen3.8-flash`, same config dir.
3 runs per cell, ollama warmed first. Agreement scored per lane (strict JSON compare
on t1 membership+flags, line compare on t2/t3, enum match on t4, invalid-sha list on
t5). Latency from wall + reply-body tokens; cost from step_finish (paid side) and 0
(local side). Raw results to an untracked scratch json; only the summary table goes
on the bus.

## 4. Cap discipline
Paid baseline runs happen OUTSIDE the PARITY-389 GO window (21:15–21:30 Fable) and
before the 20:30 report closes. Five flash calls ≈ $0.005 total worst case. Local
side is $0 always and never touches the meter.

## 5. Candidate models (pre-registered)
1. `llama3.1:8b` — testable today, zero network pulls.
2. If it fails tool/JSON discipline where a lane needs it: qwen3-class fallback needs
   a ~20 GB q4 MoE — that goes to the box T4 (separate V-run install, out of 453.C
   scope) NOT the Mini (would crowd the clinic-hour disk/RAM envelope). Mini stays
   ≤8B-class.
Ollama Cloud (ollama.com) noted as a third route but it is PAID and needs OLLAMA_API_KEY — V-only credential; excluded from this order unless Fable extends scope.

## 6. Risks found in feasibility probes (flagged, not solved here)
- Token metering on the local arm is nonsense (OC reports 16384 input tokens on a
  10-token prompt = context window, not usage; cost is 0 anyway). Loop code must
  treat llama as "free + unmetered" and never derive cost from its token counts.
- `opencode local-serve validate` cannot void the models.claimed check without
  models.dev reachable — the pane-side config uses the normal provider block, so this
  only matters if someone tries local-serve; do not.
- llama3.1:8b hallucinated room rows in one access mode of the feasibility probe
  (invented OPD 1/2/3/6 rows under opencode run) while being byte-strict via the raw
  API with format:json (3/3 exact). That instability IS the kind of thing the
  benchmark exists to measure per-arm; lane adoption can be per-arm (raw API for
  pollers, OC block for pane flows), not one-size.
- ~10 s fixed overhead per `opencode run` invocation (startup/teardown observed under
  today's pane load; bare ollama round-trip is 0.3 s). For 5-min loops the overhead
  is affordable; for tight pollers prefer the raw-API arm.

## 7. What eta-refuter checks
- Runner bench.py: does it measure what the plan says (warm-up, 3 runs, both arms,
  temperature 0, strict judges) — PASS/FAIL by sha.
- The 5 tasks are nophi and synthetic: no session text, no member identifiers, no
  room ids beyond the public room names already on the bus.
- The provider-block template: no secrets, loopback only.
- Then, with PASS: which lanes (fleet t1, conductor digest page, roadmap rev line, a
  bus tagging, a sha check) move to a LOCAL route, one pane at a time, GATE = Fable.
