#!/usr/bin/env python3
"""Targeted string replacements for the eta-qwen-out build. Each entry: (path, old, new).
Aborts loudly (prints ERROR and exits 1) if `old` is not found exactly once in the file,
so a mismatch never silently no-ops or double-applies.
"""
import sys

ROOT = "/Users/vinaybhardwaj/dev/eta-qwen-out-wt/"

EDITS = [
    ("lib/stt/translate-bakeoff.ts",
     " * OFF QWEN (22 Sep). `translate_qwen` (qwen2.5:14b text translation) is REMOVED, not",
     " * OFF QWEN (22 Sep). `translate_qwen` (the retired local-model text-translation arm) is REMOVED, not"),

    ("lib/llm.ts",
     "export const TEXT_MODEL = process.env.TEXT_MODEL || 'qwen2.5:14b';",
     "// Unused (22 Sep, qwen-out): nothing in this codebase reads TEXT_MODEL any more.\nexport const TEXT_MODEL = process.env.TEXT_MODEL || '';"),

    ("lib/note-generation.ts",
     " * Model: qwen2.5:14b on the Mac Mini Ollama (already used by CDMSS).\n * JSON mode via response_format. Temperature 0 for determinism.",
     " * Model: routed through `routedChat` (Gemini when flagged+configured, OpenRouter otherwise —\n * qwen2.5:14b is retired, 22 Sep). JSON mode via response_format. Temperature 0 for determinism."),

    ("lib/note-generation.ts",
     'const NOTE_MODEL = process.env.NOTE_MODEL || "qwen2.5:14b";',
     'const NOTE_MODEL = process.env.NOTE_MODEL || "note";'),

    ("lib/note-generation.ts",
     '  const base = process.env.OLLAMA_BASE_URL;\n  // Nothing has run yet, so there is no provider to report. \'unknown\' is the honest answer.\n  if (!base) return { ok: false, error: "OLLAMA_BASE_URL not set", latency_ms: 0, provider: "unknown" };\n  const cleanTranscript = (transcript ?? "").trim();',
     '  const cleanTranscript = (transcript ?? "").trim();'),

    ("lib/note-generation.ts",
     '    // Note generation: Gemini (note surface, flash tier) when GEMINI_ALL/GEMINI_NOTE=1\n    // + Vertex configured; otherwise local qwen. Soft-fails to qwen on any error.\n    const rc = await routedChat({\n      surface: "note", tier: "flash", ollamaModel: NOTE_MODEL,\n      messages: [',
     '    // Note generation: Gemini (note surface, flash tier) when GEMINI_ALL/GEMINI_NOTE=1\n    // + Vertex configured; otherwise OpenRouter. Soft-fails to OpenRouter on any Gemini error.\n    const rc = await routedChat({\n      surface: "note", tier: "flash",\n      messages: ['),

    ("lib/cdmss-pipeline.ts",
     " *   4. Draft pass (qwen2.5:14b, JSON mode): generate CDS suggestions\n *      with [N] citation markers pointing to retrieved excerpt indices\n *   5. Critique pass (llama3.1:8b): audit each claim for citation support\n *   6. Revise pass (qwen2.5:14b, JSON mode): rewrite to fix unsupported\n *      claims (either cite or remove)",
     " *   4. Draft pass (routed via `routedChat`: Gemini or OpenRouter, JSON mode): generate CDS\n *      suggestions with [N] citation markers pointing to retrieved excerpt indices\n *   5. Critique pass (llama3.1:8b): audit each claim for citation support\n *   6. Revise pass (routed via `routedChat`, JSON mode): rewrite to fix unsupported\n *      claims (either cite or remove)"),

    ("lib/cdmss-pipeline.ts",
     'const DRAFT_MODEL = process.env.CDS_DRAFT_MODEL || "qwen2.5:14b";',
     'const DRAFT_MODEL = process.env.CDS_DRAFT_MODEL || "cds-draft";'),

    ("lib/cdmss-pipeline.ts",
     'const REVISE_MODEL = process.env.CDS_REVISE_MODEL || "qwen2.5:14b";',
     'const REVISE_MODEL = process.env.CDS_REVISE_MODEL || "cds-revise";'),

    ("lib/cdmss-pipeline.ts",
     '  // CDS reasoning passes (draft/critique/revise) run on Gemini (cds surface, pro\n  // tier) when GEMINI_ALL/GEMINI_CDS=1 + Vertex configured; otherwise local llama/\n  // qwen. Soft-fails to the local model on any error.\n  const rc = await routedChat({\n    surface: "cds", tier: "pro", ollamaModel: model,\n    messages: [',
     '  // CDS reasoning passes (draft/critique/revise) run on Gemini (cds surface, pro\n  // tier) when GEMINI_ALL/GEMINI_CDS=1 + Vertex configured; otherwise OpenRouter.\n  // Soft-fails to OpenRouter on any Gemini error. `model` now only labels the onEvent\n  // stage-start payload below (routedChat picks the real model itself).\n  const rc = await routedChat({\n    surface: "cds", tier: "pro",\n    messages: ['),

    ("lib/whisper.ts",
     " * Why local: same Mac Mini that hosts qwen2.5:14b, so no extra cloud",
     " * Why local: same Mac Mini that hosts the local note/CDS models, so no extra cloud"),

    ("lib/overnight-translate/gate.ts",
     " * WHY THIS GATE MATTERS MORE HERE THAN IT DID FOR DIARIZE. qwen2.5:14b is ~9 GB on disk and 10-11.5 GB",
     " * WHY THIS GATE MATTERS MORE HERE THAN IT DID FOR DIARIZE (historical: this used to be about\n * qwen2.5:14b, retired 22 Sep). The model here is ~9 GB on disk and 10-11.5 GB"),

    ("lib/llm-trace/stage-explainers.ts",
     " * /api/transcribe-compare — Parallel Deepgram + Whisper + qwen judge.",
     " * /api/transcribe-compare — Parallel Deepgram + Whisper + LLM judge."),

    ("lib/llm-trace/stage-explainers.ts",
     "    body: 'qwen2.5:14b is scoring both transcripts 1–10 on clinical accuracy, picking a winner, and explaining the delta.',",
     "    body: 'The model is scoring both transcripts 1–10 on clinical accuracy, picking a winner, and explaining the delta.',"),
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
