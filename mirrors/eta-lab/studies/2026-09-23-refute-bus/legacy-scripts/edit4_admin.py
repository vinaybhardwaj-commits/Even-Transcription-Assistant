WT = "/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt"
path = WT + "/lib/room-day/admin.ts"
with open(path, "r") as f:
    src = f.read()

old1 = '''          engines: "skipped" | "ran" | "unknown";
          /** The router's own words for it (`silent_skipped`, `no_engine`), when it said any. */
          engines_detail: string | null;
        } | null;'''
assert src.count(old1) == 1, f"old1 count={src.count(old1)}"
new1 = '''          engines: "skipped" | "ran" | "unknown";
          /** The router's own words for it (`silent_skipped`, `no_engine`), when it said any. */
          engines_detail: string | null;
          /**
           * Sub-window granularity (router_server.py job_verdict): how many router sub-windows this
           * job window had, and how many of them no engine ever ran on. Surfacing partial starvation
           * is the point of this slice — a job can be honestly "ran" overall while most of its
           * sub-windows were never heard, and these two numbers are the only place that survives.
           * null whenever `engines` is "unknown", and null on the synchronous path, which has no
           * sub-windows to count (see RouteOutcomeRecord in lib/stt/route-run.ts) — never coerced
           * to 0, which would read as "none skipped" rather than "not applicable".
           */
          windows_total: number | null;
          windows_skipped: number | null;
        } | null;'''
src = src.replace(old1, new1, 1)

old2 = '''              engines: engineReading.known ? (engineReading.skipped ? "skipped" : "ran") : "unknown",
              engines_detail: engineReading.known
                ? (engineReading.outcome ?? engineReading.status ?? null)
                : null,'''
assert src.count(old2) == 1, f"old2 count={src.count(old2)}"
new2 = '''              engines: engineReading.known ? (engineReading.skipped ? "skipped" : "ran") : "unknown",
              engines_detail: engineReading.known
                ? (engineReading.outcome ?? engineReading.status ?? null)
                : null,
              windows_total: engineReading.known ? engineReading.windows_total : null,
              windows_skipped: engineReading.known ? engineReading.windows_skipped : null,'''
src = src.replace(old2, new2, 1)

with open(path, "w") as f:
    f.write(src)
print("admin.ts OK")
