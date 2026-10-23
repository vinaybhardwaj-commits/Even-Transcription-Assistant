# SPINE-VERTEX-BUILD — OpenRouter -> Vertex (branch spine/vertex-no-openrouter, base origin/main 8b185887)
## Call sites (TS) -> Vertex
| former OpenRouter site | now | model / region |
|---|---|---|
| lib/llm/gemini.ts routedChat fallback (all surfaces: note, cds, hyde, cleanup, scoring, compare, native...) | 2 more Vertex targets, one mint shared | LLM_FALLBACK_MODELS `model[@region]`, default gemini-2.5-flash then gemini-2.5-flash-lite, region GCP_FALLBACK_LOCATION else GCP_LOCATION. Label `gemini:<model>@<region>` (primary stays `gemini:<model>`) |
| lib/jev/translate.ts | `vertexChat` (new, lib/llm/gemini.ts); `deps.chat` seam kept | JEV_TRANSLATE_MODEL / _FALLBACK, default gemini-2.5-flash / gemini-2.5-flash-lite, `model[@region]` |
| lib/rubrics/llm.ts (llm_zdr engine, consult-llm) | `vertexChat`; test hook kept | first target of LLM_FALLBACK_MODELS (model + region) |
| services/eta-router router_server.py translate | new `vertex:<model>` engine, now DEFAULT | see below |
Env names now needed: GCP_PROJECT, GCP_SA_KEY, GCP_LOCATION (existing) + NEW optional GCP_FALLBACK_LOCATION. Old OpenRouter slugs left in LLM_FALLBACK_MODELS / JEV_TRANSLATE_* are handled by parseVertexTargets (R2): `google/<m>` is MAPPED to `<m>`, sent, and logged; any other slug is DROPPED with a counted warning. Unset them anyway.
## Behaviour changes to know
- Surface not flagged but Vertex configured: goes straight to the Vertex fallback chain (was OpenRouter). Vertex not configured: `all_failed: vertex_not_configured`, provider none.
- silent_fallback (scribe_llm_health) and fusion `provider_not_gemini` now treat `gemini:<m>@<region>` (fallback stage) as NOT the primary: meaning unchanged. A fallback equal to the failed primary (model+region) is skipped.
- Deadline math unchanged (FALLBACK_STAGE_CAP_MS, count from the resolved chain); the token is minted once per call and shared. Caller abort reports `aborted` even with Gemini on (was `deadline_exceeded` in the primary stage).
- Retention: Vertex has no per-request zdr flag; the stance is the GCP project's (no per-call equivalent of provider.zdr).
## eta-router (services/eta-router/router_server.py)
`vertex:<model>` engine: generateContent, location ETA_VERTEX_LOCATION (default global), SA JSON read at CALL time from file named by ETA_VERTEX_SA_FILE (project: ETA_VERTEX_PROJECT else project_id in file), ETA_VERTEX_TIMEOUT (60). Token via google-auth (lazy import; token cached per file mtime, never the key). Same TranslateError taxonomy (`vertex_*`), engine string = pool key, deadline wired. Defaults: ETA_TRANSLATE_ENGINE `vertex:gemini-2.5-flash-lite`, FALLBACK `vertex:gemini-2.5-flash,indictrans2`. openrouter: engine code left (reachable only if named). NEW services/eta-router/requirements.txt = `google-auth==2.35.0` only (no requirements file existed in repo; the twin's own file is untouched, add the line there). tools/router-fix/* copies NOT changed.
## Deploy notes for fable (NOT run by me; Mini paths UNVERIFIED)
(a) `cp services/eta-router/router_server.py ~/services/eta-router-twin/ && cat services/eta-router/requirements.txt >> ~/services/eta-router-twin/requirements.txt` (b) `~/services/eta-router-twin/venv/bin/pip install google-auth==2.35.0` (venv path assumed)
(c) in /etc/systemd/system/eta-router-twin.service: Environment=ETA_TRANSLATE_ENGINE=vertex:gemini-2.5-flash-lite  ETA_TRANSLATE_FALLBACK=vertex:gemini-2.5-flash,indictrans2  ETA_VERTEX_SA_FILE=/home/eta/.secrets/gcp-vertex-ai-external.json  ETA_VERTEX_LOCATION=global  (drop ETA_OPENROUTER_KEY_FILE)
(d) `sudo systemctl daemon-reload && sudo systemctl restart eta-router-twin.service`
(e) `curl -s localhost:<port>/healthz`; then POST the router's translate route (as test_translate.py does) with fake text e.g. "mujhe bukhar hai"; expect translate_engine `vertex:gemini-2.5-flash-lite`, translate_error null. Mini eta-router: same env NAMES in its launchd plist, then `launchctl kickstart -k gui/501/com.vinaybhardwaj.eta-router`.
## Remaining OPENROUTER references
Runtime TS (lib/, app/): none (pinned by tests/unit/no-openrouter-runtime.test.ts); lib/openrouter.ts is UNUSED, kept (not deleted). Python, owner Mini/eta-router: services/eta-router/router_server.py (openrouter engine, ETA_OPENROUTER_*; unused by defaults), tools/router-fix/router_server.py + fuserv1/gemini_call.py (OPENROUTER_API_KEY, offline eval tooling, not moved), their tests, tools/eta2freescript test string. Key can be removed from Vercel once env above is set; the Mini router needs ETA_OPENROUTER_KEY_FILE only if someone names an openrouter: engine.
## Tests
Gate (.bc/gate.log): typecheck + typecheck:tests green; vitest `Test Files 522 passed | 1 skipped (524)`, `Tests 10424 passed | 7 skipped (10436)` but gate=1 from 3 "Timeout calling onTaskUpdate" worker-RPC errors in nemo-sweeper-pg (load, Docker); that file rerun alone: `Tests 9 passed (9)`. `npm run build` exit 0. check:silent exit 1 = the 9 accepted pre-existing findings. swift N/A (Linux). pytest services/eta-router: `136 passed, 2 skipped` (new VertexEngine class: SA/network mocked).
Updated, not weakened: routed-chat-fallback/-deadline, jev-translate, jev-english, rubric-llm, s7-rubric-pg, llm-provider-truth, fuse-arms (+1 fallback-stage refusal test). Mutants: none run.
## Assumptions
Fallback default models/regions are my choice (same region as primary unless GCP_FALLBACK_LOCATION; no data-residency change by default). google-auth chosen over hand-minting (cryptography not installed). Migration: none.
