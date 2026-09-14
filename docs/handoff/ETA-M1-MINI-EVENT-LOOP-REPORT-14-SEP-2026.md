# ETA — M1: FREE THE MINI'S EVENT LOOP — REPORT
**14 September 2026 · Builder · Mini services only · no git, no commit**

## Backups, labels
- Diarize: `~/eta-diarize/server.py.bak-20260914084949` · label `uk.llmvinayminihome.eta-diarize` (port 8001)
- Router: `~/eta-router/router_server.py.bak-20260914085234` · label `com.vinaybhardwaj.eta-router` (port 8083)

## Diff (full: `diff -u <bak> <file>`)
Diarize. Handler bodies moved unchanged into module-level functions. Only these lines are new:
```
+import asyncio
+_HEAVY_SEM = asyncio.Semaphore(1)
+def _diarize_blocking(audio_bytes, clinician_centroids, manual_relabels, batch_threshold):
+    return speakers, transcript_segments_raw, overlap_windows, aggregates
+    async with _HEAVY_SEM:
+        speakers, transcript_segments_raw, overlap_windows, aggregates = await asyncio.to_thread(
+            _diarize_blocking, audio_bytes, clinician_centroids, manual_relabels, batch_threshold)
+def _enroll_blocking(raw):
+    return emb
+    async with _HEAVY_SEM:
+        emb = await asyncio.to_thread(_enroll_blocking, raw)
+    if isinstance(emb, dict):
+        return emb
```
Router. `_ENGINE_SEM` is unchanged.
```
+import asyncio
+_ROUTE_SEM = asyncio.Semaphore(1)
+def _route_blocking(raw_bytes: bytes, cand_list: list[str], translate: bool, t0: float):
-            fh.write(await file.read())
+            fh.write(raw_bytes)
+    raw_bytes = await file.read()
+    async with _ROUTE_SEM:
+        return await asyncio.to_thread(_route_blocking, raw_bytes, cand_list, translate, t0)
```
Both files pass `py_compile` with the venv Python and with system `python3`.

## §4 numbers (clip made with `say`, 63 s, no patient audio)
| | idle health | health during request | request |
|---|---|---|---|
| Diarize before | ≤13 ms | **3067 ms** | 200, 4084 ms |
| Diarize after | ≤4 ms | **≤1.4 ms** (5 polls) | 200, 3558 ms |
| Router before | ≤2 ms | **3 × timeout at 15 s**, then 3135 ms | 200, 50.8 s |
| Router after | ≤1.5 ms | **≤4.9 ms** (66 polls) | 200, 35.0 s |

After the edit the response shape is identical for both services, compared key by key. Diarize gives the same speaker types and seconds. The router gives the same `language_timeline`.
Extra checks: `/enroll` returned 200 with `ok:true, dim:192`. Two concurrent `/diarize` calls ran one after the other (they ended at 2.55 s and 5.05 s).

## Rollback
```
cp ~/eta-diarize/server.py.bak-20260914084949 ~/eta-diarize/server.py && launchctl kickstart -k "gui/$(id -u)/uk.llmvinayminihome.eta-diarize"
cp ~/eta-router/router_server.py.bak-20260914085234 ~/eta-router/router_server.py && launchctl kickstart -k "gui/$(id -u)/com.vinaybhardwaj.eta-router"
```

## Not verified / flags
- I did not test whether two concurrent `/route` calls run one at a time.
- `/route/job` and `/route/job/{id}` were not exercised and not changed. No job file had changed in the hour before the restart.
- Error paths were not exercised: the router's ffmpeg 400 and diarize's 415.
- Under concurrent load, `latency_ms` (diarize) and `sec` (router) now include time spent waiting on the semaphore. Before the edit they did not include queue time.
- Cancellation, reasoned only: if a handler were cancelled mid-job, the semaphore would be released while the thread keeps running. Starlette 0.38.6 and uvicorn 0.30.6 do not cancel a handler when the client disconnects, so this happens only at shutdown.
- I did not watch the production probes from Vercel.
- Other services were not touched.
