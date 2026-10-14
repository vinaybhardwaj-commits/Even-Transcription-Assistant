WT = "/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt"
path = WT + "/tests/unit/route-metrics-truth.test.ts"
with open(path, "r") as f:
    src = f.read()

replacements = [
    (
        'const m = buildRouteMetrics([], {}, {\n      status: ROUTE_STATUS_SKIPPED,\n      outcome: "no_engine",\n      segmentation: { method: "silero-vad-no-speech", n_engine_segments: 0 },\n    });',
        'const m = buildRouteMetrics([], {}, {\n      status: ROUTE_STATUS_SKIPPED,\n      outcome: "no_engine",\n      // `outcome` also lives INSIDE `segmentation`, exactly where the real router body carries it\n      // (router_server.py window_outcome()/job_verdict()) -- carried here alongside the top-level\n      // convenience copy this function\'s own contract (RouterOutcomeInput) reads.\n      segmentation: { method: "silero-vad-no-speech", n_engine_segments: 0, outcome: "no_engine" },\n    });',
    ),
    (
        'const m = buildRouteMetrics([], {}, {\n      status: "ok",\n      outcome: "engine_no_text",\n      segmentation: { method: "silero-vad", n_engine_segments: 12 },\n    });',
        'const m = buildRouteMetrics([], {}, {\n      status: "ok",\n      outcome: "engine_no_text",\n      segmentation: { method: "silero-vad", n_engine_segments: 12, outcome: "engine_no_text" },\n    });',
    ),
    (
        'const m = buildRouteMetrics([SPAN], {}, {\n      status: "ok",\n      outcome: "engine_text",\n      segmentation: { n_engine_segments: 3 },\n    });\n    expect(recordOf(m).engines_skipped).toBe(false);\n    expect(recordOf(m).outcome).toBe("engine_text");\n    expect((m.language_timeline as { chars: number }).chars).toBe(42);',
        'const m = buildRouteMetrics([SPAN], {}, {\n      status: "ok",\n      outcome: "engine_text",\n      segmentation: { n_engine_segments: 3, outcome: "engine_text" },\n    });\n    expect(recordOf(m).engines_skipped).toBe(false);\n    expect(recordOf(m).outcome).toBe("engine_text");\n    expect((m.language_timeline as { chars: number }).chars).toBe(42);',
    ),
    (
        'const m = buildRouteMetrics([SPAN], stale, { status: "ok", outcome: "engine_text", segmentation: { n_engine_segments: 3 } });',
        'const m = buildRouteMetrics([SPAN], stale, { status: "ok", outcome: "engine_text", segmentation: { n_engine_segments: 3, outcome: "engine_text" } });',
    ),
    (
        'const m = buildRouteMetrics([SPAN], {}, {\n      status: "ok",\n      outcome: "engine_text",\n      segmentation: { method: "mixed", n_engine_segments: 1, windows_total: 5, windows_skipped: 4 },\n    });',
        'const m = buildRouteMetrics([SPAN], {}, {\n      status: "ok",\n      outcome: "engine_text",\n      segmentation: { method: "mixed", n_engine_segments: 1, windows_total: 5, windows_skipped: 4, outcome: "engine_text" },\n    });',
    ),
    (
        'const r = readEngineOutcome(buildRouteMetrics([], {}, {\n      status: ROUTE_STATUS_SKIPPED, outcome: "no_engine",\n      segmentation: { windows_total: 5, windows_skipped: 5 },\n    }));',
        'const r = readEngineOutcome(buildRouteMetrics([], {}, {\n      status: ROUTE_STATUS_SKIPPED, outcome: "no_engine",\n      segmentation: { windows_total: 5, windows_skipped: 5, outcome: "no_engine" },\n    }));',
    ),
]

for old, new in replacements:
    cnt = src.count(old)
    assert cnt == 1, f"count={cnt} for block starting: {old[:60]!r}"
    src = src.replace(old, new, 1)

with open(path, "w") as f:
    f.write(src)
print("route-metrics-truth.test.ts OK")
