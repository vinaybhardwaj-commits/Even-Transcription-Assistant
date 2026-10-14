WT = "/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt"
path = WT + "/lib/stt/adapters/route.ts"
with open(path, "r") as f:
    src = f.read()

old1 = 'import type { SttAdapter, SttTranscribeResult } from "../types";'
assert src.count(old1) == 1, f"old1 count={src.count(old1)}"
new1 = ('import type { SttAdapter, SttTranscribeResult, RouterSegmentation } from "../types";\n'
        'import { isRouterSegmentation } from "../types";')
src = src.replace(old1, new1, 1)

old2 = '''  const native = typeof r.transcript_native === "string" ? r.transcript_native : null;
  const english = typeof r.transcript_english === "string" ? r.transcript_english : null;
  return {
    original: native,
    english,
    language: r.dominant_language ?? null,
    latencyMs,
    // Local hardware on the Mini. Zero, not null: null means "unknown", and this one is known.
    costUsd: 0,
    engineVersion: null,
    languageTimeline: Array.isArray(r.language_timeline) ? r.language_timeline : null,
    // Carried VERBATIM and no further. This adapter does not decide what an outcome MEANS; it only
    // stops throwing away the sentence in which the router said it, which is what left the corpus
    // unable to tell "never heard" from "heard nothing".
    routerOutcome: {
      status: (r as Record<string, unknown>).status,
      segmentation: (r as Record<string, unknown>).segmentation,
      outcome: (r as Record<string, unknown>).outcome,
    },
    error: null,
  };
}'''
assert src.count(old2) == 1, f"old2 count={src.count(old2)}"
new2 = '''  const native = typeof r.transcript_native === "string" ? r.transcript_native : null;
  const english = typeof r.transcript_english === "string" ? r.transcript_english : null;
  // The router puts `outcome` INSIDE `segmentation`, never beside it (router_server.py's
  // window_outcome()/job_verdict()). `r.segmentation` is typed `unknown` on RouterResult, so it is
  // narrowed with a real type guard here — never cast past into a top-level key the reply never
  // carries, which is the bug that left every stored route_outcome's `outcome` null.
  const segmentation: RouterSegmentation | undefined = isRouterSegmentation(r.segmentation) ? r.segmentation : undefined;
  return {
    original: native,
    english,
    language: r.dominant_language ?? null,
    latencyMs,
    // Local hardware on the Mini. Zero, not null: null means "unknown", and this one is known.
    costUsd: 0,
    engineVersion: null,
    languageTimeline: Array.isArray(r.language_timeline) ? r.language_timeline : null,
    // Carried VERBATIM and no further. This adapter does not decide what an outcome MEANS; it only
    // stops throwing away the sentence in which the router said it, which is what left the corpus
    // unable to tell "never heard" from "heard nothing".
    routerOutcome: {
      status: (r as Record<string, unknown>).status,
      segmentation,
      outcome: segmentation?.outcome,
    },
    error: null,
  };
}'''
src = src.replace(old2, new2, 1)

with open(path, "w") as f:
    f.write(src)
print("route.ts OK")
