WT = "/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt"
path = WT + "/lib/stt/room-drain.ts"
with open(path, "r") as f:
    src = f.read()

old = '''           ...(asr.languageTimeline || asr.routerOutcome
             ? buildRouteMetrics(asr.languageTimeline ?? [], {}, asr.routerOutcome ?? undefined)
             : {}),'''
assert src.count(old) == 1, f"old count={src.count(old)}"
new = '''           // Gated on an ACTUAL timeline, never on `routerOutcome` alone: that carrier is an object
           // whenever the router answered at all (F1), so `|| asr.routerOutcome` was writing an
           // EMPTY `language_timeline` block on every route run that had none written before this
           // feature existed.
           ...(asr.languageTimeline
             ? buildRouteMetrics(asr.languageTimeline, {}, asr.routerOutcome ?? undefined)
             : {}),'''
src = src.replace(old, new, 1)

with open(path, "w") as f:
    f.write(src)
print("room-drain.ts OK")
