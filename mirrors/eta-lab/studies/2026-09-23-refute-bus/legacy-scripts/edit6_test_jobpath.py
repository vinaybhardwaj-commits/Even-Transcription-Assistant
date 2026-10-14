WT = "/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt"
path = WT + "/tests/unit/vad-starvation-job-path.test.ts"
with open(path, "r") as f:
    src = f.read()

# --- 1. imports: add routeTranscribeKind ---
old = 'import { routeAdapter } from "@/lib/stt/adapters/route";'
assert src.count(old) == 1
new = ('import { routeAdapter } from "@/lib/stt/adapters/route";\n'
       'import { routeTranscribeKind } from "@/lib/jobs/kinds/route-transcribe";')
src = src.replace(old, new, 1)

# --- 2. jobReply(): move outcome inside segmentation, keep status top-level ---
old = '''const jobReply = (over: Record<string, unknown> = {}) => ({
  ok: true,
  job_id: "j1",
  state: "done",
  progress: { done: 5, total: 5 },
  dominant_language: null,
  language_timeline: [],
  transcript_native: "",
  transcript_english: null,
  segments: [],
  sec: 61.2,
  error: null,
  status: "silent_skipped",
  outcome: "no_engine",
  segmentation: {
    method: "fixed-window-vad-empty",
    methods: { "fixed-window-vad-empty": 5 },
    windows_total: 5,
    windows_skipped: 5,
    n_engine_segments: 0,
    n_segments: 0,
    n_skipped_silent: 30,
  },
  ...over,
});'''
assert src.count(old) == 1, "jobReply block not found"
new = '''const jobReply = (over: Record<string, unknown> = {}) => ({
  ok: true,
  job_id: "j1",
  state: "done",
  progress: { done: 5, total: 5 },
  dominant_language: null,
  language_timeline: [],
  transcript_native: "",
  transcript_english: null,
  segments: [],
  sec: 61.2,
  error: null,
  // `status` sits at the TOP LEVEL of the reply (job_verdict()'s returned tuple, router_server.py
  // 765-781, written to job["status"]). `outcome` is NEVER a sibling of `segmentation` — it lives
  // INSIDE it (job_verdict()'s returned dict). A fixture that puts `outcome` beside `segmentation`
  // instead of in it tests the reply's mirror image, not the reply router_server.py actually sends.
  status: "silent_skipped",
  segmentation: {
    method: "fixed-window-vad-empty",
    methods: { "fixed-window-vad-empty": 5 },
    windows_total: 5,
    windows_skipped: 5,
    n_engine_segments: 0,
    n_segments: 0,
    n_skipped_silent: 30,
    outcome: "no_engine",
  },
  ...over,
});'''
src = src.replace(old, new, 1)

# --- 3. partial-starvation override: outcome moves inside its segmentation override ---
old = '''    stubJobFetch(jobReply({
      status: "ok",
      outcome: "engine_text",
      transcript_native: "some real speech",
      segments: [{ text: "some real speech" }],
      segmentation: { method: "mixed", windows_total: 5, windows_skipped: 4, n_engine_segments: 1 },
    }));'''
assert src.count(old) == 1
new = '''    stubJobFetch(jobReply({
      status: "ok",
      transcript_native: "some real speech",
      segments: [{ text: "some real speech" }],
      segmentation: { method: "mixed", windows_total: 5, windows_skipped: 4, n_engine_segments: 1, outcome: "engine_text" },
    }));'''
src = src.replace(old, new, 1)

# --- 4. PRE-FIX test: outcome no longer exists at the top level, so it cannot be destructured there ---
old = '''    const { status, segmentation, outcome, ...preFix } = jobReply();
    void status; void segmentation; void outcome;'''
assert src.count(old) == 1
new = '''    const { status, segmentation, ...preFix } = jobReply();
    void status; void segmentation;'''
src = src.replace(old, new, 1)

with open(path, "w") as f:
    f.write(src)
print("step A OK")
