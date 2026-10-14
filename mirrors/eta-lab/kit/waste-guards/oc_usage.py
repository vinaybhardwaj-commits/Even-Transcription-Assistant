#!/usr/bin/env python3
"""oc_usage.py -- read-only opencode.db snapshot helper for the 455 waste guards.

Works on a local db path OR over ssh on a remote machine (box eta-lab-t4 via the
e2e-lab-ts ssh alias). Read-only sqlite URI everywhere: it never locks or writes
the running server's database.

Tokens rule (verified 26 Sep): the LAST assistant message's tokens.total per live
session is the current session context size (cumulative input+cache+output of the
conversation window as OpenCode reported it to the meter). Format variants explain
small deltas; big numbers track real context.

Subcommands (each prints ONE json line, or a table with --table):
  snapshot [machine]     live sessions: dir, session, title(40c), last_total,
                         time_updated (ms epoch)
  usage --day YYYY-MM-DD day table for one machine (session.rollup columns)
  alert --limit 150000   per-session rows breaching the context limit ( watchdog core )

No PHI: prints directories, session ids and titles only -- never message text.
"""
import argparse, json, os, subprocess, sys, time

BOX_SSH = "e2e-lab-ts"          # eta-lab-t4 machine (Fable r333; same box)
C3_SSH = "e2e-ci"
MACHINES = {"mini": None, "box": BOX_SSH, "c3": C3_SSH}
DB_REL = ".local/share/opencode/opencode.db"

def db_path(machine):
    if machine == "mini":
        return os.path.expanduser("~/" + DB_REL)
    return None  # remote

def connect(machine):
    path = db_path(machine)
    if path:
        import sqlite3
        return sqlite3.connect("file:%s?mode=ro" % path, uri=True, timeout=30), None
    ssh = MACHINES[machine]
    if not ssh:
        return None, None
    # remote read-only query runner: one python3 -c process per call (cheap enough
    # at watchdog cadence; never opens a write handle remotely)

    class Remote:
        def execute(self, q, args=()):
            """Remote read-only query. ssh joins remote command args with spaces
            (quoting hell), and one stdin serves ONE consumer: so the script (with
            the query embedded as a python string literal, args pre-rendered by
            repr for tuples of constants we build ourselves) goes on ssh stdin to
            `python3 -`. Queries here are module constants, never user input."""
            assert isinstance(q, str)
            script = (
                "import sqlite3,json\n"
                "db=sqlite3.connect('file:/home/eta/%s?mode=ro',uri=True,timeout=30)\n"
                "print(json.dumps([list(map(str,r)) for r in db.execute(%r, %r)]))\n"
            ) % (DB_REL, q, tuple(args))
            p = subprocess.run(
                ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ssh,
                 "python3", "-"],
                input=script, capture_output=True, text=True, timeout=60)
            if p.returncode != 0:
                raise RuntimeError("remote %s failed: %s" % (ssh, p.stderr[:200]))
            return [tuple(r) for r in json.loads(p.stdout.strip() or "[]")]
    return Remote(), None

def latest_assistant_tokens(conn, limit=None):
    """{session_id: {dir, title, tokens_total, time_updated_ms}} for unarchived sessions.
    Metric = the LAST assistant message that HAS a tokens rollup (c3 shows a trailing
    None rollup on a partial step; the last non-null one is the live context size)."""
    q = ("SELECT s.id, s.directory, substr(COALESCE(s.title,''),1,40),"
         " json_extract(m.data,'$.tokens.total'), s.time_updated"
         " FROM session s JOIN message m ON m.session_id=s.id"
         " WHERE json_extract(m.data,'$.role')='assistant'"
         " AND json_extract(m.data,'$.tokens.total') IS NOT NULL"
         " AND s.time_archived IS NULL"
         " AND m.rowid=(SELECT max(rowid) FROM message WHERE session_id=s.id"
         "              AND json_extract(data,'$.role')='assistant'"
         "              AND json_extract(data,'$.tokens.total') IS NOT NULL)")
    out = {}
    for sid, d, t, tot, tu in conn.execute(q):
        if tot in (None, "", "None"):
            continue  # sessions with no assistant token rollup yet
        out[sid] = {"dir": d, "title": t or "", "tokens_total": int(tot),
                    "time_updated": int(tu or 0)}
    return out

def machine_labels():
    return ["mini", "box", "c3"]

def snapshot(machine):
    conn, _ = connect(machine)
    rows = latest_assistant_tokens(conn)
    for sid, r in sorted(rows.items(), key=lambda x: -x[1]["tokens_total"]):
        print(json.dumps({"machine": machine, "session": sid, **r}))

def alert(limit):
    breaches = []
    for m in machine_labels():
        try:
            conn, _ = connect(m)
        except Exception:
            continue
        for sid, r in latest_assistant_tokens(conn).items():
            if r["tokens_total"] >= limit:
                breaches.append({"machine": m, "session": sid,
                                 "tokens_total": r["tokens_total"], **r})
    return breaches

def cli():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["snapshot", "alert"])
    ap.add_argument("machine", nargs="?", default=None)
    ap.add_argument("--limit", type=int, default=150000)
    ap.add_argument("--table", action="store_true")
    a = ap.parse_args()
    if a.cmd == "alert":
        print(json.dumps(alert(a.limit)))
    elif a.machine:
        snapshot(a.machine)
    else:
        for m in machine_labels():
            try:
                snapshot(m)
            except Exception as ex:
                print(json.dumps({"machine": m, "error": str(ex)[:120]}))

if __name__ == "__main__":
    cli()
