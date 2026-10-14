import sys

WT = "/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt"
path = WT + "/lib/stt/types.ts"
with open(path, "r") as f:
    src = f.read()

old1 = 'export interface SttTranscribeResult {'
assert src.count(old1) == 1, f"old1 count={src.count(old1)}"
new1 = '''/**
 * The router's `segmentation` block, as router_server.py's `window_outcome()` / `job_verdict()`
 * build it (router_server.py:557-596, 765-781). `outcome` lives HERE, and only here — the reply's
 * top level carries `status`, never `outcome`. A reader that goes looking for `outcome` beside
 * `segmentation` instead of inside it is reading a key the router never sends.
 */
export type RouterOutcomeValue = "no_engine" | "engine_no_text" | "engine_text";

export type RouterSegmentation = {
  outcome?: RouterOutcomeValue | string | null;
  windows_total?: number | null;
  windows_skipped?: number | null;
  n_segments?: number | null;
  n_engine_segments?: number | null;
  method?: string | null;
  methods?: unknown;
};

/** Runtime narrowing for a value the router client typed `unknown` — never an `as` past the shape. */
export function isRouterSegmentation(v: unknown): v is RouterSegmentation {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export interface SttTranscribeResult {'''
src = src.replace(old1, new1, 1)

old2 = '  routerOutcome?: { status?: unknown; segmentation?: unknown; outcome?: unknown } | null;'
assert src.count(old2) == 1, f"old2 count={src.count(old2)}"
new2 = '  routerOutcome?: { status?: unknown; segmentation?: RouterSegmentation | null; outcome?: RouterOutcomeValue | string | null } | null;'
src = src.replace(old2, new2, 1)

with open(path, "w") as f:
    f.write(src)
print("types.ts OK")
