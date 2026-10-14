WT = "/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt"
path = WT + "/lib/jobs/kinds/route-transcribe.ts"
with open(path, "r") as f:
    src = f.read()

old = '''        silent_window: outcome.known ? outcome.outcome === "engine_no_text" : chars === 0,
        engines_skipped: outcome.known ? outcome.skipped : null,'''
assert src.count(old) == 1, f"old count={src.count(old)}"
new = '''        // `outcome.known` alone settles the BINARY skip/no-skip question — `status` does that on
        // its own. `silent_window` is the THREE-way read (no_engine / engine_no_text / engine_text)
        // and status alone cannot answer it: only a genuine `outcome` value can. A row with a known
        // status but no known outcome (an older router, a partial reply) falls back to the pre-merge
        // rule, `chars === 0`, and must never default to "not silent" — an unknown outcome must
        // never collapse into "ran", exactly as it must never collapse into "skipped".
        silent_window: (outcome.known && outcome.outcome !== null) ? outcome.outcome === "engine_no_text" : chars === 0,
        engines_skipped: outcome.known ? outcome.skipped : null,'''
src = src.replace(old, new, 1)

with open(path, "w") as f:
    f.write(src)
print("route-transcribe.ts OK")
