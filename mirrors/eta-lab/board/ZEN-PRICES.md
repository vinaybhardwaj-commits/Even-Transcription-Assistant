# Zen prices (USD per 1M tokens)

Generated 2026-09-25 14:24 IST by `studies/2026-09-25-zen-meter/zen_prices.py` from OpenCode's model catalogue (provider `opencode`, 110 models). Cross-checked against https://opencode.ai/docs/zen/ on 25 Sep 2026: the docs' sample rows (GPT 6 Astra, Claude Opus 5.5, Claude Sonnet 5, Gemini 3.8 Flash, DeepSeek V4 Flash) match the catalogue exactly; the docs list only a sample, so the rest is the catalogue's word.

**Cost = tokens x price.** Zen replies carry token counts only (no cost field, no balance header), so every dollar figure in the spend meter is COMPUTED; the Zen console balance is the only ground truth. Top-up fee per the docs: 4.4% + $0.30 per transaction, passed on at cost (record the credit actually added). The docs also say auto-reload recharges $20 when the balance falls below $5, which V can customise or disable (r407: no auto-recharge).

Free models (`*free`, big-pickle): non-patient work only (ZDR may not cover them; r407a).

## Access on V's account (measured)

| model | status | detail | via |
|---|---|---|---|
| deepseek-v4-flash | **DISABLED** | 403 'Upstream request failed: Model access is disabled' | chat |
| kimi-k2.6 | **DISABLED** | 403 'Upstream request failed: Model access is disabled' | chat |
| glm-5.3-flash | **ok** | HTTP 200 | chat |
| deepseek-v4.1-flash | **ok** | HTTP 200; also used by fleet-watch as fallback | chat |
| deepseek-v4-pro | **ok** | HTTP 200 | chat |
| gemini-3.5-flash-lite | **ok** | answers via opencode; fleet-watch primary; spends many reasoning tokens unless variant=low | opencode |
| gpt-5.4-nano | **ok** | answers via opencode; called tools although told not to | opencode |
| qwen3.8-flash | **ok** | answers via opencode | opencode |
| gpt-5.3-codex | **ok** | in use by linker-oc | opencode |

Measured on V's Zen account with one trivial non-patient prompt per model, 25 Sep 2026 ~14:10-14:25 IST. 'chat' = POST /zen/v1/chat/completions; 'opencode' = opencode run. Re-run and edit when V changes the console's model toggles.

## All models, free first then by output price

| model | in | out | cache read | cache write | context | protocol | tier / note |
|---|---|---|---|---|---|---|---|
| big-pickle (free) | 0 | 0 | 0 | 0 | 200K | openai-compatible |  |
| deepseek-v4-flash-free (free) | 0 | 0 | 0 |  | 200K | openai-compatible |  |
| glm-4.7-free (free) | 0 | 0 | 0 |  | 204K | openai-compatible |  |
| glm-5-free (free) | 0 | 0 | 0 |  | 204K | openai-compatible |  |
| grok-code (free) | 0 | 0 | 0 | 0 | 256K | openai-compatible |  |
| hy3-free (free) | 0 | 0 | 0 |  | 190K | openai-compatible |  |
| hy3-preview-free (free) | 0 | 0 | 0 |  | 256K | openai-compatible |  |
| kimi-k2.5-free (free) | 0 | 0 | 0 |  | 262K | openai-compatible |  |
| laguna-s-2.1-free (free) | 0 | 0 | 0 |  | 256K | openai-compatible |  |
| ling-2.6-flash-free (free) | 0 | 0 |  |  | 262K | openai-compatible |  |
| ling-3.0-flash-fin-free (free) | 0 | 0 | 0 |  | 262K | openai-compatible |  |
| ling-3.0-flash-free (free) | 0 | 0 | 0 |  | 262K | openai-compatible |  |
| ling-3.0-tiny-free (free) | 0 | 0 |  |  | 262K | openai-compatible |  |
| longcat-2.0-free (free) | 0 | 0 | 0 |  | 1000K | openai-compatible |  |
| mimo-v2-flash-free (free) | 0 | 0 | 0 |  | 262K | openai-compatible |  |
| mimo-v2-omni-free (free) | 0 | 0 | 0 |  | 262K | openai-compatible |  |
| mimo-v2-pro-free (free) | 0 | 0 | 0 |  | 1048K | openai-compatible |  |
| mimo-v2.5-free (free) | 0 | 0 | 0 |  | 200K | openai-compatible |  |
| mimo-v2.6-flash-free (free) | 0 | 0 | 0 |  | 200K | openai-compatible |  |
| minimax-m2.1-free (free) | 0 | 0 | 0 |  | 204K | anthropic |  |
| minimax-m2.5-free (free) | 0 | 0 | 0 |  | 204K | anthropic |  |
| minimax-m3-free (free) | 0 | 0 | 0 |  | 200K | anthropic |  |
| muse-spark-1.2-contributor-free (free) | 0 | 0 | 0 |  | 1048K | openai |  |
| muse-spark-1.3-contributor-free (free) | 0 | 0 | 0 |  | 1048K | openai |  |
| nemotron-3-super-free (free) | 0 | 0 | 0 |  | 204K | openai-compatible |  |
| nemotron-3-ultra-free (free) | 0 | 0 | 0 |  | 1000K | openai-compatible |  |
| nemotron-3.5-lightning-free (free) | 0 | 0 | 0 |  | 262K | openai-compatible |  |
| north-mini-code-free (free) | 0 | 0 |  |  | 256K | openai-compatible |  |
| qwen3.6-plus-free (free) | 0 | 0 | 0 |  | 262K | anthropic |  |
| ring-2.6-1t-free (free) | 0 | 0 |  |  | 262K | openai-compatible |  |
| space-bunny-free (free) | 0 | 0 | 0 | 0 | 1048K | openai-compatible |  |
| trinity-large-preview-free (free) | 0 | 0 |  |  | 131K | openai-compatible |  |
| x-preview-f-free (free) | 0 | 0 | 0 |  | 1000K | openai-compatible |  |
| deepseek-v4-flash | 0.14 | 0.28 | 0.028 |  | 1000K | openai-compatible |  |
| deepseek-v4-flash-vision-exp | 0.14 | 0.28 | 0.028 |  | 1000K | openai-compatible |  |
| gpt-5-nano | 0.05 | 0.4 | 0.005 |  | 400K | openai |  |
| qwen3.8-flash | 0.15 | 0.47 | 0.016 | 0.2 | 1000K | anthropic |  |
| glm-5.3-flash | 0.15 | 0.5 | 0.03 |  | 1000K | openai-compatible |  |
| gpt-6-luna | 0.1 | 0.5 | 0.01 | 0.125 | 1050K | openai | over 272K ctx: 0.2 in / 0.75 out |
| deepseek-v4.1-flash | 0.3 | 1.2 | 0.006 |  | 1000K | openai-compatible |  |
| gpt-5.6-luna | 0.2 | 1.2 | 0.02 | 0.25 | 1050K | openai | over 272K ctx: 0.4 in / 1.8 out |
| minimax-m2.1 | 0.3 | 1.2 | 0.1 |  | 204K | openai-compatible |  |
| minimax-m2.5 | 0.3 | 1.2 | 0.06 |  | 204K | openai-compatible |  |
| minimax-m2.7 | 0.3 | 1.2 | 0.06 |  | 204K | openai-compatible |  |
| minimax-m3 | 0.3 | 1.2 | 0.06 |  | 512K | openai-compatible |  |
| qwen3.5-plus | 0.2 | 1.2 | 0.02 | 0.25 | 262K | anthropic |  |
| gpt-5.4-nano | 0.2 | 1.25 | 0.02 |  | 400K | openai |  |
| qwen3-coder | 0.45 | 1.8 |  |  | 262K | openai-compatible |  |
| gpt-5.1-codex-mini | 0.25 | 2 | 0.025 |  | 400K | openai |  |
| grok-build-0.1 | 1 | 2 | 0.2 |  | 256K | openai |  |
| glm-4.6 | 0.6 | 2.2 | 0.1 |  | 204K | openai-compatible |  |
| glm-4.7 | 0.6 | 2.2 | 0.1 |  | 204K | openai-compatible |  |
| gemini-3.5-flash-lite | 0.3 | 2.5 | 0.03 |  | 1048K | google |  |
| kimi-k2 | 0.4 | 2.5 | 0.4 |  | 262K | openai-compatible |  |
| kimi-k2-thinking | 0.4 | 2.5 | 0.4 |  | 262K | openai-compatible |  |
| gemini-3-flash | 0.5 | 3 | 0.05 |  | 1048K | google |  |
| kimi-k2.5 | 0.6 | 3 | 0.08 |  | 262K | openai-compatible |  |
| qwen3.6-plus | 0.5 | 3 | 0.05 | 0.625 | 262K | anthropic |  |
| glm-5 | 1 | 3.2 | 0.2 |  | 204K | openai-compatible |  |
| deepseek-v4-pro | 1.74 | 3.84 | 0.145 |  | 1000K | openai-compatible |  |
| claude-3-5-haiku | 0.8 | 4 | 0.08 | 1 | 200K | anthropic |  |
| kimi-k2.6 | 0.95 | 4 | 0.16 |  | 262K | openai-compatible |  |
| kimi-k2.7-code | 0.95 | 4 | 0.19 |  | 262K | openai-compatible |  |
| grok-4.7 | 1.4 | 4.2 | 0.35 |  | 500K | openai | over 200K ctx: 2.8 in / 8.4 out |
| muse-spark-1.2 | 1.25 | 4.25 | 0.15 |  | 1048K | openai |  |
| muse-spark-1.3 | 1.25 | 4.25 | 0.15 |  | 1048K | openai |  |
| glm-5.1 | 1.4 | 4.4 | 0.26 |  | 204K | openai-compatible |  |
| glm-5.2 | 1.4 | 4.4 | 0.26 |  | 1000K | openai-compatible |  |
| glm-5.3 | 1.4 | 4.4 | 0.26 |  | 1000K | openai-compatible |  |
| gpt-5.4-mini | 0.75 | 4.5 | 0.075 |  | 400K | openai |  |
| claude-haiku-4-5 | 1 | 5 | 0.1 | 1.25 | 200K | anthropic |  |
| grok-4.5 | 2 | 6 | 0.3 |  | 500K | openai | over 200K ctx: 4 in / 12 out |
| grok-4.6 | 2 | 6 | 0.5 |  | 500K | openai | over 200K ctx: 4 in / 12 out |
| gemini-3.6-flash | 1.5 | 7.5 | 0.15 |  | 1048K | google |  |
| gemini-3.7-flash | 1.5 | 7.5 | 0.15 |  | 1048K | google |  |
| gemini-3.8-flash | 1.5 | 7.5 | 0.15 |  | 1048K | google |  |
| gpt-5 | 1.07 | 8.5 | 0.107 |  | 400K | openai |  |
| gpt-5-codex | 1.07 | 8.5 | 0.107 |  | 400K | openai |  |
| gpt-5.1 | 1.07 | 8.5 | 0.107 |  | 400K | openai |  |
| gpt-5.1-codex | 1.07 | 8.5 | 0.107 |  | 400K | openai |  |
| gemini-3.5-flash | 1.5 | 9 | 0.15 |  | 1048K | google |  |
| claude-sonnet-5 | 2 | 10 | 0.2 | 2.5 | 1000K | anthropic |  |
| gpt-5.1-codex-max | 1.25 | 10 | 0.125 |  | 400K | openai |  |
| gpt-6-sol | 2 | 10 | 0.2 | 2.5 | 1050K | openai | over 272K ctx: 4 in / 15 out |
| gemini-3-pro | 2 | 12 | 0.2 |  | 1048K | google | over 200K ctx: 4 in / 18 out |
| gemini-3.1-pro | 2 | 12 | 0.2 |  | 1048K | google | over 200K ctx: 4 in / 18 out |
| gpt-5.2 | 1.75 | 14 | 0.175 |  | 400K | openai |  |
| gpt-5.2-codex | 1.75 | 14 | 0.175 |  | 400K | openai |  |
| gpt-5.3-codex | 1.75 | 14 | 0.175 |  | 400K | openai |  |
| gpt-5.3-codex-spark | 1.75 | 14 | 0.175 |  | 128K | openai |  |
| claude-sonnet-4 | 3 | 15 | 0.3 | 3.75 | 1000K | anthropic | over 200K ctx: 6 in / 22.5 out |
| claude-sonnet-4-5 | 3 | 15 | 0.3 | 3.75 | 1000K | anthropic | over 200K ctx: 6 in / 22.5 out |
| claude-sonnet-4-6 | 3 | 15 | 0.3 | 3.75 | 1000K | anthropic |  |
| gpt-5.4 | 2.5 | 15 | 0.25 |  | 1050K | openai | over 272K ctx: 5 in / 22.5 out |
| gpt-5.6-terra | 2.5 | 15 | 0.25 | 3.125 | 1050K | openai | over 272K ctx: 5 in / 22.5 out |
| kimi-k3 | 3 | 15 | 0.3 |  | 1048K | openai-compatible |  |
| claude-opus-5-5 | 4 | 20 | 0.2 | 5 | 1000K | anthropic |  |
| gpt-5.6-sol | 4 | 20 | 0.4 | 5 | 1050K | openai | over 272K ctx: 8 in / 30 out |
| claude-opus-4-5 | 5 | 25 | 0.5 | 6.25 | 200K | anthropic |  |
| claude-opus-4-6 | 5 | 25 | 0.5 | 6.25 | 1000K | anthropic |  |
| claude-opus-4-7 | 5 | 25 | 0.5 | 6.25 | 1000K | anthropic |  |
| claude-opus-4-8 | 5 | 25 | 0.5 | 6.25 | 1000K | anthropic |  |
| claude-opus-5 | 5 | 25 | 0.5 | 6.25 | 1000K | anthropic |  |
| gpt-5.5 | 5 | 30 | 0.5 |  | 1050K | openai | over 272K ctx: 10 in / 45 out |
| claude-fable-5 | 10 | 50 | 1 | 12.5 | 1000K | anthropic |  |
| claude-fable-5-1 | 10 | 50 | 0.25 | 12.5 | 1000K | anthropic |  |
| gpt-6-astra | 10 | 50 | 1 | 12.5 | 1050K | openai | over 272K ctx: 20 in / 75 out |
| claude-opus-4-1 | 15 | 75 | 1.5 | 18.75 | 200K | anthropic |  |
| gpt-5.4-pro | 30 | 180 | 30 |  | 1050K | openai |  |
| gpt-5.5-pro | 30 | 180 | 30 |  | 1050K | openai |  |
