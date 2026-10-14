# ETA model-to-job map (harness + model per job) — v1, 25 Sep 2026

Owner: Fable. The orchestrator uses this map every time it gives an agent a job. It answers two questions: **which harness** (Claude Code / Cowork, or OpenCode) and **which model in that harness**. Aims: lowest cost that still does the job well; cross-family checking; no patient data to a model whose terms don't allow it.
Source of truth for prices/availability: live probe of OpenCode Zen from the E2E box, 25 Sep 2026 ~15:30 IST (75 models; re-run `~/zen-probe2.sh` on the box). Benchmarks: vendor-reported unless marked; treat them as hints, our calibration tasks decide.

## 1. Five rules the orchestrator applies before picking a model

1. **Harness follows the model family.** Claude models run ONLY in Claude Code / Cowork, on V's flat Claude Max 20 subscription (Anthropic does not allow Max credentials in OpenCode). Claude models on Zen cost $1–50 per M tokens and are used only if Max limits are exhausted. Every non-Claude model runs in **OpenCode** (Zen first; Hugging Face Inference Providers second).
2. **Cheapest capable first, escalate on evidence.** Start at the lowest tier listed for the job. Escalate one tier after 2 failed refuter checks on the same item, or when the agent loops / breaks tool calls. Never start a job on a Tier 3+ open model or an Opus-class model without a stated reason.
3. **Cross-family checking.** Builders run on non-Claude models; checkers (Refuter, Debugger) run on Claude (Opus) in Claude Code. A job is never checked by the same model family that built it.
4. **Patient data (PHI) rule.** PHI may go ONLY to (a) Claude via Claude Code/Cowork, or (b) PAID Zen models covered by Zen's zero-retention terms (V's ZDR agreement with Zen, 25 Sep). NOT to: any FREE model (they may train on prompts; muse-spark-contributor-free explicitly grants Meta training rights); OpenAI models on Zen (gpt-*: Zen docs say OpenAI keeps requests 30 days — UNVERIFIED whether V's ZDR agreement covers them; until confirmed, no PHI); Hugging Face Inference Providers (HF keeps no data, but each backend provider has its own policy; no ZDR switch).
5. **Secrets rule.** No agent in any harness gets read access to ~/.claude/secrets, ~/.ssh or .env; keys load via config without the model seeing them.

## 2. Tiers (OpenCode, Zen prices per million tokens in/out, "works" = answered on our account 25 Sep)

| Tier | Model (Zen id) | $ in / out | Context | Works? | Evidence and notes |
|---|---|---|---|---|---|
| T0 free | space-bunny-free | 0 / 0 | 1M | yes | Undisclosed vendor, new (~23 Sep). Zen states ZDR. Still: NON-PHI only (alpha, terms may change). |
| T0 free | big-pickle | 0 / 0 | 200K | yes | Undisclosed ("stealth"). Data may be used to improve the model. Non-sensitive only. |
| T0 free | nemotron-3.5-lightning-free | 0 / 0 | 262K | yes | NVIDIA 30B/3B-active; SWE-bench Verified 51.6. NVIDIA logs data; "trial use only". Non-sensitive only. |
| T0 free | mimo-v2.6-flash-free | 0 / 0 | 200K | yes | Xiaomi; no coding numbers. Non-sensitive only. |
| AVOID | muse-spark-1.3-contributor-free | 0 / 0 | 1M | yes | Strong numbers but using it grants Meta rights to train on our prompts. Never for our code or data. |
| AVOID | nemotron-3-ultra-free | 0 / 0 | 1M | yes | Independent eval: severe looping (36.5 retries/run). |
| AVOID | ling-3.0-flash-fin-free | 0 / 0 | 262K | yes | Finance-specialised, weak at agent work. |
| **T1 flash** | **qwen3.8-flash** | 0.15 / 0.47 | 1M | yes | Alibaba, Aug 2026. SWE-bench Pro 62.5, LiveCodeBench 91.9 — best value on paper. |
| **T1 flash** | **glm-5.3-flash** | 0.15 / 0.50 | 1M | yes | Z.ai, Aug 2026. Terminal-Bench 84.3 (strong at shell/ops work); AA index 57 (independent). Weakness: accuracy falls on very long documents (96→52 on long extraction). V's preference; linker-oc runs it. |
| T1 flash | deepseek-v4-flash | 0.14 / 0.28 | 1M | **NO — "access disabled" on our account** | Cheapest; SWE-bench Pro ~52.6. Reachable only via HF Inference Providers (no PHI) unless Zen enables it. |
| T1 flash | gpt-6-luna | 0.10 / 0.50 | 1M | yes | OpenAI; no public benchmarks found. OpenAI 30-day retention → non-PHI only. Candidate for scouts. |
| T1 flash | gpt-5.4-nano | 0.20 / 1.25 | 400K | yes | SWE-bench Verified 69.8, Terminal-Bench 60.7. OpenAI retention → non-PHI. |
| **T2 mid** | **minimax-m3** | 0.30 / 1.20 | 512K | yes | MiniMax, Jun 2026. SWE-bench Verified 80.5, Pro 59.0. Caveat: multi-turn tool calls break if the harness strips its <think> text — verify in OpenCode before relying on it. |
| T2 mid | deepseek-v4.1-flash | 0.30 / 1.20 | 1M | yes | DeepSeek Sep 2026; DeepSWE 74.2; very verbose (~79% more tokens). fleet-watch uses it. |
| T2 mid | gemini-3.5-flash-lite | 0.30 / 2.50 | 1M | yes | No coding numbers published; fine for simple loops (fleet-watch uses it). |
| T3 strong | kimi-k2.7-code | 0.95 / 4.00 | 262K | yes (was flaky earlier) | SWE-bench Verified 80.2, Pro 58.6. Coding specialist; vendor admits weaker English tool-routing than Opus. |
| T3 strong | glm-5.3 | 1.40 / 4.40 | 1M | yes | Full GLM; no published SWE numbers; use when glm-5.3-flash fails on long rules. |
| T3 strong | deepseek-v4-pro | 1.74 / 3.84 | 1M | yes | SWE-bench Verified 80.6, Pro 55.4, LiveCodeBench 93.5 (vendor). |
| T3 strong | gemini-3.8-flash | 1.50 / 7.50 | 1M | yes | Good at reading/long context; Terminal-Bench 2.1 89.4 but only 19.1 on the harder v4.0. Already our translation model (via OpenRouter). |
| T4 premium | gpt-5.3-codex / gpt-6-sol / kimi-k3 / claude-* on Zen | 1.75–10 / 10–50 | — | yes | Only with a written reason. Claude models belong in Claude Code (Max), not here. |
| Not usable today | deepseek-v4-flash, qwen3.5-plus, gemini-3-flash, gemini-3.5/3.6/3.7-flash, older Claude on Zen | — | — | "Model access is disabled" | Enable in the Zen console if wanted. Several GPT-5.x/GLM-5.x/MiniMax-2.x/grok ids timed out in the parallel probe (inconclusive, re-test before use). |

## 3. Claude side (Claude Code / Cowork on Max 20 — flat cost, shared limits)

Max 20 has a 5-hour allowance and a weekly cap shared by ALL Claude Code panes plus claude.ai plus Cowork (no published numbers). Opus burns it fastest. So: few Claude panes, each doing work only Claude should do.

| Model (Claude Code id) | Use for | Not for |
|---|---|---|
| **Opus 5.5** (`claude-opus-5-5`, alias `opus`) | Refuters/checkers (eta-refuter, eta-refuter-2, vj-refuter); Debugger (root cause); design/architecture calls; anything whose error reaches patients, production data or a study verdict; Fable itself (Cowork) | Routine building, bookkeeping, scouting |
| **Fable 5.1** (`claude-fable-5-1`) | Only on an explicit Fable decision for the hardest long-horizon problem | Default use — heaviest on limits |
| **Sonnet 5** (`claude-sonnet-5`, alias `sonnet`) | Browser driving (Claude in Chrome / Cowork browser — Claude-only); Fable's research subagents; light checks (docs-only or config diffs); `opusplan` execution half | Final verdicts on production/PHI code |
| **Haiku 4.5** (`claude-haiku-4-5`, alias `haiku`) | Scouts inside Claude sessions (find files, symbols, states); quick look-ups for a refuter | Any judgement or code change |

Pin per pane: `claude --model opus|sonnet|haiku`, or settings.json `"model"`; subagents via frontmatter `model:`. If Max limits run out mid-day: checkers pause non-urgent reviews; urgent ones use usage credits (API rates) — Fable tells V first.

## 4. The map: job → harness → model (start) → escalate to

| Job (our panes) | Harness | Start model | Escalate to | PHI? | Why |
|---|---|---|---|---|---|
| **Orchestrator** (Fable) | Cowork (Claude) | Opus 5.5 | — | yes | Judgement, integration, V-facing |
| **Refuter / checker** (eta-refuter, eta-refuter-2, vj-refuter) | Claude Code | Opus 5.5 | Fable 5.1 (rare) | yes | Cross-family check of non-Claude builders; highest error cost |
| **Debugger** (root cause only) | Claude Code | Opus 5.5 | — | yes | Hard reasoning, short bursts |
| **Builder, settled spec** (lab-viewer, vj-data, vj-arms, join-shard, surg-page, split-speaker) | OpenCode | qwen3.8-flash | minimax-m3 → kimi-k2.7-code → deepseek-v4-pro | yes (paid, non-OpenAI) | Best SWE-bench Pro per $ |
| **Study builder, long protocol** (linker/linker-oc, hist-miner, surg-deid) | OpenCode | glm-5.3-flash | glm-5.3 → minimax-m3 → deepseek-v4-pro | yes | Must follow long pre-registrations exactly; glm flash is weak on very long docs, so escalate early if it misreads |
| **Production deploy train** (scribe) | OpenCode | minimax-m3 | kimi-k2.7-code → deepseek-v4-pro | yes | Errors reach production; start one tier up; Opus refuter on every push |
| **Mover / ops / infra** (lab-mover, tunnel-ops, herdr-kit, radar-kit) | OpenCode | glm-5.3-flash | minimax-m3 → glm-5.3 | yes | Shell-heavy; GLM flash leads Terminal-Bench |
| **Live lab runner** (hist-bulk, diar-lab, indic-mt, yoga-drain) | OpenCode | glm-5.3-flash | minimax-m3 | yes | Runs scripts, watches jobs, small fixes |
| **Conductor** (bookkeeping, board, digests) | OpenCode | qwen3.8-flash | deepseek-v4.1-flash | counts only | Long bus reading, summarising; no verdicts |
| **Monitor loop** (fleet-watch, minibot heartbeat) | OpenCode `run` | gemini-3.5-flash-lite / deepseek-v4.1-flash (current calibration) | qwen3.8-flash | room state only | Per-cycle cost; deterministic wrapper decides |
| **Researcher** (web facts) | Claude subagent (Sonnet 5) when launched by Fable/refuter; OpenCode qwen3.8-flash when standalone | — | gemini-3.8-flash | no | Sonnet on Max costs nothing extra |
| **Scout** (locations only) | Claude subagent (Haiku 4.5) inside Claude sessions; OpenCode standalone | Haiku 4.5 / space-bunny-free (non-PHI code) or qwen3.8-flash (PHI repos) | gpt-6-luna (non-PHI) | depends | Cheapest; no judgement |
| **Metabase data scouts** (mb-rx, mb-ot, mb-ipd) | OpenCode | qwen3.8-flash | minimax-m3 | yes | Reads patient tables → paid ZDR model only |
| **Browser driver** | Claude Code / Cowork | Sonnet 5 | Opus 5.5 | as needed | Claude-in-Chrome works only with Claude |
| **Docs / reports for V** | Cowork | Opus 5.5 (Fable) | — | yes | V-facing quality |
| **Trivial throwaway** (format a file, rename, boilerplate, public docs) | OpenCode | space-bunny-free / big-pickle | qwen3.8-flash | NO | Free; never PHI |

## 5. Hugging Face as a second route

- OpenCode supports Hugging Face natively (`opencode auth login` → Hugging Face; OpenAI-compatible router `https://router.huggingface.co/v1`; models as `org/model:provider`). Our HF Pro includes $2/month of inference credit; beyond that HF passes provider prices through without markup.
- Use HF when a model is disabled or missing on Zen (e.g. DeepSeek V4 Flash) or clearly cheaper there — for NON-PHI work only (backend providers have their own retention terms; no ZDR switch).
- Self-hosting a coding model on our HF GPUs is not worth it: an A10G fits only ~30B coder models; frontier agent models don't fit on one GPU; per-token pricing is cheaper for our bursty use. Our HF GPUs stay for the STT stack.

## 6. How to change this map
Calibration first (eta-refuter-2's builder task + scout question set), then the cheapest model that passes becomes the start model for that job. Update this file and the project copy together; note the date and the evidence. Re-probe Zen monthly or when a model errors.

Sources: opencode.ai/docs/zen; opencode.ai/docs/providers; huggingface.co/docs/inference-providers (integrations/opencode, pricing, security); code.claude.com/docs/en/model-config; support.claude.com (Max plan, Claude Code with Pro/Max, usage credits); vendor model cards (Z.ai GLM-5.x, Alibaba Qwen3.8, MiniMax M3, Moonshot Kimi K2.7, DeepSeek V4, OpenAI GPT-5.4 mini/nano); morphllm.com/swe-bench-pro. Full research notes: Fable scratch files research-open-models.md, research-hf-opencode.md, research-claude-max.md (25 Sep).

## GO route (Fable 438, 26 Sep)

V: use up the OpenCode Go subscription first; Zen credit only after (console balance was $236.92 at ~12:50 IST, 26 Sep). Go models are addressed `opencode-go/<id>` and use the SAME key file as Zen.

Mapping (same model, Go route): opencode/X -> opencode-go/X for X in {glm-5.3, glm-5.3-flash, qwen3.8-flash, deepseek-v4-pro, deepseek-v4.1-flash, minimax-m3, kimi-k3, kimi-k2.7-code}. NOT in Go: gemini-* (panes on gemini stay on Zen).

Limits: 5-hour window (20% of monthly), weekly (50%), monthly. V has Extra Usage ON (continues on paid balance) — nobody touches that toggle (OFF would fall back to FREE models = PHI risk).

NEVER for PHI on Go: grok-*, gpt-* (30-day retention), muse-spark-* (trains on prompts), space-bunny-free, omen-alpha, hy*/longcat/mimo* (not reviewed). DeepSeek ZDR on Go valid only THROUGH 30 SEP 2026; checkers fallback after: kimi-k3.

Switcher: kit/go-switch.sh (idle-gated per-pane relaunch, same session id; run only after eta-refuter PASS).
