"""REB collector (PALIMPSEST step 4a): box index files -> R2 -> Neon index. A track is "in the palimpsest" only when the live file
is verified, the object is in R2 and the row is in the index (REB-SPEC v2.3 principle 8, sections 2 and 4).

Source of truth: ~/eta-data/reb/<date>/index.jsonl (every writer appends there). For each complete line:
  resolve the track file; missing file or sha256 != line  -> `stale`, skipped;
  heldout guard (heldout.py f672c1ef) on the path date and the window's t0/t1 -> `blind`, skipped, nothing of the window leaves the box;
  r2_key = reb/<path>; HEAD; absent -> PUT with the sha256 in object metadata; present, same sha -> skip;
  present with a different (or no) sha256 -> `r2_conflict`, alarm line, NEVER overwritten, and its row is NOT indexed.
  manifest.json is pushed too (overwrite allowed, it is append-only on the box).
Index rows (<= 500 per POST) are posted only AFTER the objects of those rows are confirmed in R2. A 409 conflict is counted and alarmed,
never retried. State: <root>/_collector/state.json holds, per date file, the byte offset fully processed; it advances only past lines
whose R2 objects AND index rows are all done (or resolved: stale/blind/conflict). Re-runs are idempotent (HEAD + ON CONFLICT DO NOTHING).

Credentials are read from files inside this process only (env REB_R2_WRITE_KEY_FILE: 3 lines id/secret/endpoint, the r2_lab_results_read
shape; REB_INDEX_TOKEN_FILE: the bearer token) and never appear in argv, logs or exception text. If a needed file is absent the run is a
dry run regardless and says so. A dry run makes NO network call and writes no state: would_put counts every live object (it does not HEAD).
Index base URL: env REB_INDEX_BASE_URL (the ETA web origin; the path /api/reb/index is appended).

CLI: --date D | --since D | --all ; --dry-run (default) | --write ; --limit N (lines examined) ; --workers N (R2 threads, 1..16, default 8) ; --no-index (R2 only, state not advanced) ;
--no-r2 (index only; forbidden unless --no-index, i.e. only useful for nothing: the index must never point at a missing object).
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

REB_ROOT = os.path.expanduser("~/eta-data/reb")
OUT_DIR = "/home/eta/oc/palimpsest/out"
BUCKET = os.environ.get("REB_R2_BUCKET", "eta-lab-results")
BATCH = 500
DEFAULT_WORKERS = 8
MAX_WORKERS = 16
DEFAULT_MACHINE = "eta-lab-t4"
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
COUNTERS = ("lines", "bad_lines", "live", "stale_missing", "stale_sha", "no_manifest", "blind", "r2_present", "r2_conflict",
            "would_put", "put", "manifest_put", "would_index", "indexed", "index_existing", "index_conflicts", "errors")


class CollectorError(RuntimeError):
    """A failure with a message that is safe to print (never carries credential material)."""


# ---------------------------------------------------------------- real clients (credentials read from files, in-process only)
class Boto3R2:
    def __init__(self, key_file, bucket=BUCKET):
        import boto3
        with open(key_file) as f:
            ident, secret, endpoint = [l.strip() for l in f.read().splitlines()[:3]]
        self.bucket = bucket
        from botocore.config import Config
        # ONE client for the whole process (boto3 clients are thread-safe), with a connection pool wide enough for MAX_WORKERS and
        # keep-alive, so every HEAD/PUT reuses a warm TLS connection instead of opening its own.
        cfg = Config(max_pool_connections=max(16, 2 * MAX_WORKERS), connect_timeout=10, read_timeout=60,
                     retries={"max_attempts": 3, "mode": "standard"}, tcp_keepalive=True)
        self.c = boto3.client("s3", endpoint_url=endpoint, aws_access_key_id=ident, aws_secret_access_key=secret, region_name="auto", config=cfg)

    def head(self, key):
        try:
            r = self.c.head_object(Bucket=self.bucket, Key=key)
        except Exception as e:  # noqa: BLE001
            code = getattr(e, "response", {}).get("Error", {}).get("Code", "")
            if code in ("404", "NoSuchKey", "NotFound"):
                return None
            raise CollectorError(f"R2 HEAD failed ({type(e).__name__} {code})")
        return {"sha256": (r.get("Metadata") or {}).get("sha256"), "size": r.get("ContentLength")}

    def put(self, key, path, sha256):
        try:
            with open(path, "rb") as f:
                self.c.put_object(Bucket=self.bucket, Key=key, Body=f, Metadata={"sha256": sha256}, ContentType="application/json")
        except Exception as e:  # noqa: BLE001
            raise CollectorError(f"R2 PUT failed ({type(e).__name__})")


class HttpIndex:
    def __init__(self, base_url, token_file):
        with open(token_file) as f:
            self._token = f.read().strip()
        self.url = base_url.rstrip("/") + "/api/reb/index"

    def post(self, rows):
        """-> (status, body dict). 200 and 409 are answers; anything else raises CollectorError."""
        req = urllib.request.Request(self.url, data=json.dumps(rows).encode(), method="POST",
                                     headers={"authorization": f"Bearer {self._token}", "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            if e.code == 409:
                return 409, json.loads(e.read() or b"{}")
            raise CollectorError(f"index POST failed (HTTP {e.code})")
        except Exception as e:  # noqa: BLE001
            raise CollectorError(f"index POST failed ({type(e).__name__})")


# ---------------------------------------------------------------- helpers
def sha256_file(path):
    with open(path, "rb") as f:
        body = f.read()
    return hashlib.sha256(body).hexdigest(), len(body)


def list_dates(root, date=None, since=None):
    out = []
    for d in sorted(os.listdir(root)):
        if DATE_RE.match(d) and os.path.isfile(os.path.join(root, d, "index.jsonl")):
            if (date and d != date) or (since and d < since):
                continue
            out.append(d)
    return out


def read_complete_lines(path, offset):
    """[(line_bytes, end_offset)] for complete lines after `offset` (anything after the last newline is a line still being written)."""
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    out, pos = [], 0
    while True:
        nl = data.find(b"\n", pos)
        if nl < 0:
            break
        out.append((data[pos:nl], offset + nl + 1))
        pos = nl + 1
    return out


class State:
    def __init__(self, path, write):
        self.path, self.write = path, write
        try:
            with open(path) as f:
                self.d = json.load(f)
        except (OSError, ValueError):
            self.d = {"version": 1, "dates": {}}

    def offset(self, date):
        return int(self.d["dates"].get(date, {}).get("offset", 0))

    def set(self, date, offset):
        if not self.write:
            return
        self.d["dates"][date] = {"offset": offset, "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.d, f, indent=1, sort_keys=True)
        os.replace(tmp, self.path)


# ---------------------------------------------------------------- the collector
class Collector:
    def __init__(self, root, is_held, r2=None, index=None, write=False, use_r2=True, use_index=True, alarms_path=None, limit=None, batch=BATCH, workers=1):
        if use_index and not use_r2:
            raise CollectorError("--no-r2 with index writes is refused: the index must never point at a missing object")
        self.root, self.is_held, self.r2, self.index = root, is_held, r2, index
        self.write, self.use_r2, self.use_index = write, use_r2, use_index
        self.alarms_path, self.limit, self.batch = alarms_path, limit, batch
        if not 1 <= int(workers) <= MAX_WORKERS:
            raise CollectorError(f"--workers must be 1..{MAX_WORKERS}")
        self.workers = int(workers)
        self._lock = threading.Lock()      # guards counters, the alarms file and _manifest_done across worker threads
        self.state = State(os.path.join(root, "_collector", "state.json"), write and use_index)
        self.cnt = {}
        self.examined = 0
        self._manifests = {}
        self._manifest_done = set()
        if write and ((use_r2 and r2 is None) or (use_index and index is None)):
            raise CollectorError("write mode needs the R2 and index clients")

    def c(self, date):
        return self.cnt.setdefault(date, dict.fromkeys(COUNTERS, 0))

    def _manifest(self, rel_dir):
        if rel_dir not in self._manifests:
            p = os.path.join(self.root, rel_dir, "manifest.json")
            try:
                with open(p) as f:
                    self._manifests[rel_dir] = json.load(f)
            except (OSError, ValueError):
                self._manifests[rel_dir] = None
        return self._manifests[rel_dir]

    def _blind(self, date, room, m):
        try:
            if self.is_held(date, room):
                return True
            from .from_hist import window_held
            return window_held(self.is_held, room, int(m["t0_ms"]), int(m["t1_ms"]))
        except Exception:  # noqa: BLE001 - any doubt is blind
            return True

    def _row(self, date, line, m, path, sha, nbytes):
        # A path can have several manifest entries (a rewrite or repair appends one; the older is stale). Only the entry whose sha256 is
        # the live file's sha256 describes this row; if none does, take model/reason/machine from the track body and leave times null.
        match = [t for t in m.get("tracks", []) if t.get("path") == line["path"] and t.get("sha256") == sha]
        e = match[-1] if match else None
        if e is None:
            try:
                with open(path) as f:
                    t = json.load(f)
            except (OSError, ValueError):
                t = {}
            e = {k: t.get(k) for k in ("model", "reason", "machine")}
        return {
            "window_id": line["window_id"], "ist_date": date, "room_id": line["room_id"], "t0_ms": m.get("t0_ms"), "t1_ms": m.get("t1_ms"),
            "layer": line["layer"], "engine": line["engine"], "model": e.get("model"), "version": line["version"],
            "config_hash": line["config_hash"], "shadow": False, "status": line["status"], "reason": e.get("reason"),
            "machine": e.get("machine") or DEFAULT_MACHINE, "r2_key": "reb/" + line["path"], "sha256": sha, "bytes": nbytes,
            "started_at": e.get("started_at"), "finished_at": e.get("finished_at"),
        }

    def _inc(self, date, key, n=1):
        with self._lock:
            self.c(date)[key] += n

    def alarm(self, date, **kw):
        if not self.alarms_path:
            return
        with self._lock:
            os.makedirs(os.path.dirname(self.alarms_path), exist_ok=True)
            with open(self.alarms_path, "a") as f:
                f.write(json.dumps(dict(kw, date=date, ts=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())), sort_keys=True) + "\n")

    def _put_object(self, date, key, path, sha, kind, overwrite=False):
        """True: the object at `key` holds `sha` (already, or after our PUT). False: conflict (alarmed, not overwritten).
        Raises CollectorError if R2 did not confirm. Safe to call from several threads (different keys)."""
        have = self.r2.head(key)
        if have is not None and have.get("sha256") == sha:
            self._inc(date, "r2_present")
            return True
        if have is not None and not overwrite:
            self._inc(date, "r2_conflict")
            self.alarm(date, kind="r2_conflict", key=key, stored_sha=have.get("sha256"), local_sha=sha,
                       reason="no_sha_metadata" if not have.get("sha256") else "sha_differs")
            return False
        self.r2.put(key, path, sha)
        self._inc(date, "manifest_put" if kind == "manifest" else "put")
        return True

    def _flush(self, date, pending):
        """POST pending rows (their objects are confirmed). Raises CollectorError if the index did not answer."""
        if not pending:
            return
        status, body = self.index.post(pending)
        if status not in (200, 409):
            raise CollectorError(f"unexpected index status {status}")
        self._inc(date, "indexed", int(body.get("inserted", 0)))
        self._inc(date, "index_existing", int(body.get("existing", 0)))
        for conf in body.get("conflicts", []) or []:
            self._inc(date, "index_conflicts")
            self.alarm(date, kind="index_conflict", key=conf.get("key"), stored_sha=conf.get("stored_sha"), sent_sha=conf.get("sent_sha"))

    # ------------------------------------------------------------ one date
    def run_date(self, date):
        """Process the date's new index lines in chunks of `batch` lines.
        Per chunk: (1) classify every line in file order on this thread (parse, hash, manifest, blind -> resolved/skipped or live);
        (2) R2 work for the live lines, one pool task per WINDOW (its tracks, then its manifest), up to `workers` windows at once;
        (3) barrier; walk the chunk in file order and take the CONTIGUOUS PREFIX of lines that are resolved (skipped, r2_conflict, or
        object confirmed); (4) POST the rows of that prefix (<= batch rows, only for objects confirmed in this run); (5) the state
        offset moves to the end of the prefix only if the POST was accepted. The first unresolved line ends the date's pass.
        Objects confirmed after that line are harmless (HEAD + ON CONFLICT make a redo free) but are never indexed in this pass."""
        c = self.c(date)
        path = os.path.join(self.root, date, "index.jsonl")
        start = self.state.offset(date)
        if os.path.getsize(path) < start:
            start = 0   # the file shrank (rewritten): start over; HEAD + ON CONFLICT make it harmless
        done = start
        error = None
        lines = read_complete_lines(path, start)
        pos = 0
        pool = ThreadPoolExecutor(max_workers=self.workers) if self.write and self.use_r2 and self.workers > 1 else None
        try:
            while pos < len(lines) and error is None:
                room = self.batch if self.limit is None else min(self.batch, self.limit - self.examined)
                if room <= 0:
                    break
                chunk = lines[pos:pos + room]
                pos += len(chunk)
                self.examined += len(chunk)
                c["lines"] += len(chunk)
                items = [self._classify(date, raw, end, c) for raw, end in chunk]    # [(kind, end, payload)]
                if self.write:
                    error = self._r2_chunk(date, items, pool)
                prefix_end, before_rows_end, rows, error = self._resolve_prefix(items, error=error)
                if rows:
                    try:
                        self._flush(date, rows)
                    except CollectorError as e:
                        error = error or e
                        prefix_end = before_rows_end      # not accepted: the offset covers only the resolved lines before the first row
                if prefix_end is not None:
                    done = max(done, prefix_end)
        finally:
            if pool is not None:
                pool.shutdown(wait=True)
        if error is not None:
            c["errors"] += 1
            self.alarm(date, kind="error", message=str(error))
        if self.use_index and self.write:
            self.state.set(date, done)
        return c

    def _classify(self, date, raw, end, c):
        """One index line -> (kind, end_offset, payload). kind: skip | live."""
        try:
            line = json.loads(raw)
            rel = line["path"]
            for k in ("window_id", "room_id", "layer", "engine", "version", "config_hash", "status", "sha256"):
                if not isinstance(line.get(k), str):
                    raise ValueError(k)
            if not isinstance(rel, str) or rel.split("/")[0] != date or ".." in rel.split("/"):
                raise ValueError("path")
        except (ValueError, KeyError, TypeError, AttributeError):
            c["bad_lines"] += 1
            return ("skip", end, None)
        tpath = os.path.join(self.root, rel)
        try:
            sha, nbytes = sha256_file(tpath)
        except OSError:
            c["stale_missing"] += 1
            return ("skip", end, None)
        if sha != line["sha256"]:
            c["stale_sha"] += 1
            return ("skip", end, None)
        rel_dir = os.path.dirname(os.path.dirname(rel))   # <date>/<room>/<window>
        m = self._manifest(rel_dir)
        if m is None:
            c["no_manifest"] += 1
            return ("skip", end, None)
        if self._blind(date, line["room_id"], m):
            c["blind"] += 1
            return ("skip", end, None)
        c["live"] += 1
        if not self.write:
            c["would_put"] += 1
            c["would_index"] += 1
            return ("skip", end, None)
        return ("live", end, {"line": line, "rel": rel, "rel_dir": rel_dir, "tpath": tpath, "sha": sha, "nbytes": nbytes, "m": m,
                              "result": None, "error": None})

    def _r2_window(self, date, rel_dir, group):
        """Pool task: confirm one window's track objects, then push its manifest (once per window per run). Sets item['result'] to
        'ok' | 'conflict' | 'fail' on each item; never raises."""
        any_ok = False
        for it in group:
            try:
                ok = self._put_object(date, "reb/" + it["rel"], it["tpath"], it["sha"], "track")
                it["result"] = "ok" if ok else "conflict"
                any_ok = any_ok or ok
            except CollectorError as e:
                it["result"], it["error"] = "fail", e
        if any_ok:
            with self._lock:
                need = rel_dir not in self._manifest_done
                if need:
                    self._manifest_done.add(rel_dir)
            if need:
                try:
                    mp = os.path.join(self.root, rel_dir, "manifest.json")
                    msha, _ = sha256_file(mp)
                    self._put_object(date, "reb/" + rel_dir + "/manifest.json", mp, msha, "manifest", overwrite=True)
                except (CollectorError, OSError) as e:
                    with self._lock:
                        self._manifest_done.discard(rel_dir)
                    for it in group:      # a window is not "in the palimpsest" without its manifest: none of its rows may go out
                        if it["result"] == "ok":
                            it["result"], it["error"] = "fail", e if isinstance(e, CollectorError) else CollectorError("manifest read failed")

    def _r2_chunk(self, date, items, pool):
        groups = {}
        for kind, _end, p in items:
            if kind == "live":
                groups.setdefault(p["rel_dir"], []).append(p)
        if not self.use_r2:
            for g in groups.values():
                for it in g:
                    it["result"] = "ok"
            return None
        if pool is None:
            for rel_dir, g in groups.items():
                self._r2_window(date, rel_dir, g)
        else:
            futs = [pool.submit(self._r2_window, date, rel_dir, g) for rel_dir, g in groups.items()]
            for f in futs:
                f.result()
        return None

    def _resolve_prefix(self, items, error):
        """Walk the chunk in file order. -> (end of the contiguous resolved prefix, end of the part of it before the first row,
        rows to post, error). A failed or unresolved line ends the prefix."""
        rows, prefix_end, before_rows_end = [], None, None
        for kind, end, p in items:
            if kind == "live":
                if p["result"] == "fail":
                    return prefix_end, before_rows_end if rows else prefix_end, rows, error or p["error"]
                if p["result"] is None:
                    return prefix_end, before_rows_end if rows else prefix_end, rows, error or CollectorError("unresolved line")
                if p["result"] == "ok" and self.use_index:
                    if not rows:
                        before_rows_end = prefix_end
                    rows.append(self._row_for(p))
            prefix_end = end
        return prefix_end, before_rows_end if rows else prefix_end, rows, error

    def _row_for(self, p):
        row = self._row(p["line"]["path"].split("/")[0], p["line"], p["m"], p["tpath"], p["sha"], p["nbytes"])
        self._inc(row["ist_date"], "would_index")
        return row


def credentials_present(use_r2, use_index, env=os.environ):
    miss = []
    if use_r2 and not (env.get("REB_R2_WRITE_KEY_FILE") and os.path.isfile(env["REB_R2_WRITE_KEY_FILE"])):
        miss.append("REB_R2_WRITE_KEY_FILE")
    if use_index and not (env.get("REB_INDEX_TOKEN_FILE") and os.path.isfile(env["REB_INDEX_TOKEN_FILE"])):
        miss.append("REB_INDEX_TOKEN_FILE")
    if use_index and not env.get("REB_INDEX_BASE_URL"):
        miss.append("REB_INDEX_BASE_URL")
    return miss


def main(argv=None, root=REB_ROOT, out_dir=OUT_DIR, is_held=None, r2=None, index=None, env=None):
    env = os.environ if env is None else env
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--date")
    g.add_argument("--since")
    g.add_argument("--all", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help=f"R2 worker threads per date, 1..{MAX_WORKERS} (default {DEFAULT_WORKERS})")
    ap.add_argument("--no-index", action="store_true")
    ap.add_argument("--no-r2", action="store_true")
    a = ap.parse_args(argv)
    if a.write and a.dry_run:
        print("collector: --write and --dry-run are exclusive", file=sys.stderr)
        return 2
    if not 1 <= a.workers <= MAX_WORKERS:
        print(f"collector: --workers must be 1..{MAX_WORKERS}", file=sys.stderr)
        return 2
    use_r2, use_index = not a.no_r2, not a.no_index
    if use_index and not use_r2:
        print("collector: --no-r2 is refused unless --no-index too: the index must never point at a missing object", file=sys.stderr)
        return 2
    if not use_r2 and not use_index:
        print("collector: nothing to do (--no-r2 and --no-index)", file=sys.stderr)
        return 2
    write = a.write
    if write:
        miss = credentials_present(use_r2, use_index, env)
        if miss:
            print(f"collector: DRY RUN regardless: not configured: {', '.join(miss)}", file=sys.stderr)
            write = False
    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    alarms = os.path.join(out_dir, f"collector-alarms-{datetime.date.today().isoformat()}.jsonl")
    if is_held is None:
        from .from_hist import load_heldout
        is_held = load_heldout()    # fail-closed: GuardUnavailable (SystemExit) if heldout.py is not the expected one
    lock_fd = None
    try:
        if write:
            os.makedirs(os.path.join(root, "_collector"), exist_ok=True)
            lock_fd = os.open(os.path.join(root, "_collector", "collector.lock"), os.O_CREAT | os.O_RDWR, 0o640)
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                print("collector: another collector holds the lock", file=sys.stderr)
                return 3
            r2 = r2 or (Boto3R2(env["REB_R2_WRITE_KEY_FILE"]) if use_r2 else None)
            index = index or (HttpIndex(env["REB_INDEX_BASE_URL"], env["REB_INDEX_TOKEN_FILE"]) if use_index else None)
        col = Collector(root, is_held, r2=r2, index=index, write=write, use_r2=use_r2, use_index=use_index, alarms_path=alarms, limit=a.limit, workers=a.workers)
        dates = list_dates(root, date=a.date, since=a.since)
        for d in dates:
            col.run_date(d)
            if col.cnt[d]["errors"]:
                break    # a failed date is not skipped past: the next run resumes at its offset
    except CollectorError as e:
        print(f"collector: {e}", file=sys.stderr)
        return 2
    finally:
        if lock_fd is not None:
            os.close(lock_fd)    # releases the flock
    total = dict.fromkeys(COUNTERS, 0)
    for d in col.cnt.values():
        for k, v in d.items():
            total[k] += v
    mode = "WRITE" if write else "DRY-RUN"
    lines = [f"{mode} {ts} dates={len(col.cnt)} r2={'on' if use_r2 else 'off'} index={'on' if use_index else 'off'}"]
    for d, cn in sorted(col.cnt.items()):
        lines.append(f"{d} " + " ".join(f"{k}={v}" for k, v in cn.items() if v))
    lines.append("TOTAL " + " ".join(f"{k}={v}" for k, v in total.items()))
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, f"collector-{ts}.log"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines[:1] + lines[-1:]))
    return 1 if total["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
