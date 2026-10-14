WT = "/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt"
path = WT + "/tests/unit/vad-starvation-job-path.test.ts"
with open(path, "r") as f:
    src = f.read()

old = '''  it("a still-running job is not mistaken for a verdict", async () => {
    stubJobFetch(jobReply({ state: "running", progress: { done: 2, total: 5 } }));
    const out = await routeAdapter.poll!("j1");
    expect(out.ok && out.state).toBe("running");
    expect(() => doneResult(out)).toThrow(/not done/);
  });
});'''
assert src.count(old) == 1, f"old count={src.count(old)}"
new = '''  it("a still-running job is not mistaken for a verdict", async () => {
    stubJobFetch(jobReply({ state: "running", progress: { done: 2, total: 5 } }));
    const out = await routeAdapter.poll!("j1");
    expect(out.ok && out.state).toBe("running");
    expect(() => doneResult(out)).toThrow(/not done/);
  });

  it("F1 regression: outcome is read from segmentation, never from a key beside it", async () => {
    // The real router NEVER sends a top-level `outcome` -- this one contradicts segmentation on
    // purpose so a reversion to reading the top level fails this assertion instead of silently
    // passing again.
    stubJobFetch(jobReply({
      status: "ok",
      outcome: "no_engine",
      segmentation: { method: "mixed", windows_total: 5, windows_skipped: 0, n_engine_segments: 5, outcome: "engine_text" },
    }));
    const result = doneResult(await routeAdapter.poll!("j1"));
    expect(result.routerOutcome?.outcome).toBe("engine_text");
    expect(result.routerOutcome?.outcome).not.toBe("no_engine");
  });

  it("F2 regression: a known status with no known outcome falls back to chars === 0, never to not-silent", async () => {
    // `segmentation` carries a real `n_engine_segments` (so `engines_skipped` is knowable from
    // `status` alone) but NO `outcome` key at all -- the shape an older or partial reply has. The
    // transcript is empty, so the pre-merge rule (`chars === 0`) says this window WAS silent.
    // Collapsing "outcome unknown" into "not silent" (the F2 bug) would report `false` here.
    stubJobFetch(jobReply({
      status: "ok",
      segmentation: { method: "silero-vad", n_engine_segments: 3, n_segments: 0 },
    }));
    const out = await routeTranscribeKind.run({ job: {} as never, step: "poll", args: {}, progress: { router_job_id: "j1", audio_seconds: 30 }, runner: "r1" });
    expect(out.kind).toBe("done");
    expect((out as { result: Record<string, unknown> }).result.silent_window).toBe(true);
  });
});'''
src = src.replace(old, new, 1)

with open(path, "w") as f:
    f.write(src)
print("step B OK")
