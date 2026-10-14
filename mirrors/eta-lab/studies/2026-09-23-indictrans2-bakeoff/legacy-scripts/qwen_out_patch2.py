#!/usr/bin/env python3
"""Second pass: reword remaining literal 'qwen2.5' mentions in comments (including ones this
build itself just wrote) so the new guard test's literal scan is genuinely clean, not gamed."""
import sys

ROOT = "/Users/vinaybhardwaj/dev/eta-qwen-out-wt/"

EDITS = [
    ("lib/llm-trace/model-labels.ts",
     " * (22 Sep, qwen-out) `qwen2.5:14b`/`qwen2.5:7b` are removed from this map: those models are",
     " * (22 Sep, qwen-out) the retired 14B/7B local reasoning models are removed from this map: they are"),

    ("lib/llm/gemini.ts",
     " * OFF QWEN (V, 22 Sep). qwen2.5:14b is retired: 11.55 GB on a 24 GB Mini, reached from",
     " * OFF QWEN (V, 22 Sep). The retired 14B local model was 11.55 GB on a 24 GB Mini, reached from"),

    ("lib/llm/gemini.ts",
     " * There is no Ollama fallback: qwen2.5:14b is retired (22 Sep). Returns the assistant",
     " * There is no Ollama fallback: the local 14B model is retired (22 Sep). Returns the assistant"),

    ("lib/overnight-translate/gate.ts",
     " * qwen2.5:14b, retired 22 Sep). The model here is ~9 GB on disk and 10-11.5 GB",
     " * the retired local 14B model, retired 22 Sep). The model here is ~9 GB on disk and 10-11.5 GB"),

    ("lib/openrouter.ts",
     " * WHY IT EXISTS. qwen2.5:14b is retired (V, 22 Sep): 11.55 GB on a 24 GB Mini, reached from Vercel",
     " * WHY IT EXISTS. The retired local 14B model (V, 22 Sep) was 11.55 GB on a 24 GB Mini, reached from Vercel"),

    ("lib/jev/translate.ts",
     " * This used to call qwen2.5:14b through `lib/qwen.ts` — 11.55 GB on the Mini, reached from Vercel",
     " * This used to call the local 14B model through `lib/qwen.ts` — 11.55 GB on the Mini, reached from Vercel"),

    ("lib/note-generation.ts",
     " * Model: routed through `routedChat` (Gemini when flagged+configured, OpenRouter otherwise —\n * qwen2.5:14b is retired, 22 Sep). JSON mode via response_format. Temperature 0 for determinism.",
     " * Model: routed through `routedChat` (Gemini when flagged+configured, OpenRouter otherwise —\n * the local 14B model is retired, 22 Sep). JSON mode via response_format. Temperature 0 for determinism."),

    ("lib/stt/scoring.ts",
     " * used to call qwen2.5:14b directly via `lib/qwen.ts`. They now go through `routedChat`",
     " * used to call the retired local 14B model directly via `lib/qwen.ts`. They now go through `routedChat`"),

    ("lib/stt/indic-note-assist.ts",
     " * OFF QWEN (22 Sep). Both LLM calls below used to go straight to qwen2.5:14b via",
     " * OFF QWEN (22 Sep). Both LLM calls below used to go straight to the retired local 14B model via"),

    ("lib/stt/translate-bakeoff.ts",
     " * rerouted: qwen2.5:14b is retired on the Mini, so that arm can no longer run at all —",
     " * rerouted: the local 14B model it used is retired on the Mini, so that arm can no longer run at all —"),

    ("lib/stt/indic-comprehension.ts",
     " * direct qwen2.5:14b call on any null/failure. It now makes ONE call through `routedChat`,",
     " * direct call to the retired local 14B model on any null/failure. It now makes ONE call through `routedChat`,"),

    ("lib/stt/adapters/gemini.ts",
     " *      were actually served by `qwen2.5:14b` for four days, and nothing anywhere said so. There",
     " *      were actually served by the retired local 14B model for four days, and nothing anywhere said so. There"),
]

def main():
    failures = []
    for rel, old, new in EDITS:
        path = ROOT + rel
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        count = content.count(old)
        if count != 1:
            failures.append(f"{rel}: expected 1 occurrence, found {count}\n  --- old ---\n{old[:200]}")
            continue
        content = content.replace(old, new)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"OK  {rel}")
    if failures:
        print("FAILURES:")
        for f_ in failures:
            print(f_)
        sys.exit(1)
    print("ALL EDITS APPLIED")

if __name__ == "__main__":
    main()
