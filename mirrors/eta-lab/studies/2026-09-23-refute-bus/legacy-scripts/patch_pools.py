#!/usr/bin/env python3
"""Apply the translate-pools patch to router_server.py in place, via exact string replacement.
Refuses (exit 1) if either anchor isn't found, or is found more than once, so this can never
silently do nothing or double-patch."""
import sys

PATH = "/Users/vinaybhardwaj/eta-router-pools/router_server.py"

OLD1 = '''# THE SHARED GUARD (D1, D2): every backend call goes through `_call_backend`, so no backend can raise
# out of translate() and none can outlive its deadline.
#
# One pool, sized well above the most translate() calls that can be in flight (pool.map at
# MAX_INFLIGHT inside the single _WINDOW_SEM slot), so an honest call never queues behind a slow
# one. A call that overruns its deadline keeps its worker until its socket gives up; the headroom
# absorbs that, and when it cannot, a queued call's own deadline still expires on time. A slow
# backend makes translation FAIL on schedule; it can no longer hang a job.
_BACKEND_POOL = ThreadPoolExecutor(max_workers=max(8, 4 * MAX_INFLIGHT * MAX_WINDOWS_INFLIGHT),
                                   thread_name_prefix="translate-backend")'''

NEW1 = '''# THE SHARED GUARD (D1, D2, D2-pools): every backend call goes through `_call_backend`, so no
# backend can raise out of translate() and none can outlive its deadline.
#
# ONE POOL PER ENGINE (ETA-Refuter, round 4, 22 Sep). A single shared pool meant a primary engine
# that only DRIPS bytes (a server sending them slowly enough that `requests`' own per-read timeout
# never fires) never freed its worker — `requests` calls cannot be cancelled from outside. Every
# retry against that sick engine piled another abandoned worker into the SAME pool; once the pool
# was exhausted, the HEALTHY fallback engine's call queued behind them and was itself cancelled at
# ITS OWN deadline before a worker ever picked it up. From round 4, every window's English was null.
# Each engine now gets its OWN bounded pool, created lazily and cached for the process's life: a
# sick engine can only exhaust ITS OWN workers, never another engine's.
_BACKEND_POOL_WORKERS = int(os.environ.get("ETA_BACKEND_POOL_WORKERS", "4"))
_BACKEND_POOLS: dict[str, ThreadPoolExecutor] = {}
_BACKEND_POOLS_LOCK = threading.Lock()


def _pool_for(engine: str) -> ThreadPoolExecutor:
    """The engine string IS the pool key — e.g. `openrouter:google/gemini-2.5-flash-lite` and
    `openrouter:openai/gpt-5-nano` are DIFFERENT keys even though both are `openrouter:`-typed,
    which is exactly the point: a stuck primary must never be able to starve its own fallback.
    Checked unlocked first (the common case: the pool already exists), locked only to create one."""
    pool = _BACKEND_POOLS.get(engine)
    if pool is not None:
        return pool
    with _BACKEND_POOLS_LOCK:
        pool = _BACKEND_POOLS.get(engine)
        if pool is None:
            safe = re.sub(r"[^A-Za-z0-9_.-]", "-", engine)[:32]
            pool = ThreadPoolExecutor(max_workers=_BACKEND_POOL_WORKERS,
                                       thread_name_prefix=f"translate-{safe}")
            _BACKEND_POOLS[engine] = pool
        return pool'''

OLD2 = '''    fut = _BACKEND_POOL.submit(_dispatch, engine, text, lang_code)
    try:
        return fut.result(timeout=_deadline_for(engine))
    except FuturesTimeout:
        fut.cancel()  # a call still queued at its deadline never starts'''

NEW2 = '''    fut = _pool_for(engine).submit(_dispatch, engine, text, lang_code)
    try:
        return fut.result(timeout=_deadline_for(engine))
    except FuturesTimeout:
        fut.cancel()  # a call still queued at its deadline never starts (ETA-Refuter H9)'''


def apply_one(src: str, old: str, new: str, label: str) -> str:
    n = src.count(old)
    if n != 1:
        print(f"REFUSED: anchor {label} found {n} times (expected 1)", file=sys.stderr)
        sys.exit(1)
    return src.replace(old, new)


with open(PATH, "r", encoding="utf-8") as fh:
    src = fh.read()

src = apply_one(src, OLD1, NEW1, "OLD1 (_BACKEND_POOL definition)")
src = apply_one(src, OLD2, NEW2, "OLD2 (_call_backend submit)")

with open(PATH, "w", encoding="utf-8") as fh:
    fh.write(src)

print("OK: patched", PATH)
