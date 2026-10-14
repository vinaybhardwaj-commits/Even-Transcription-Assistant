#!/usr/bin/python3
"""alert-relay: forward ALERT lines from the consult alert spool to the ETA bus, once each, durably.

The cutter and the vp-auto daily job append one line per alert to the spool (~/eta-data/consult/ALERTS.jsonl, mode 0600;
a JSON object {"at", "source", "alert"}, but any complete line is forwarded, malformed ones raw). This daemon keeps a persistent
read offset, so a restart neither loses nor repeats a line, survives rotation / truncation, and retries a down bus with
backoff without moving the offset. Each line is one bus message: subject "ALERT consult: <first 60 chars>", body = the line,
to the configured recipients (consult-lead, fable). v2: the sender identity is NOT sent by the relay; it is fixed on the Mini by a
dedicated ssh Host alias (its own key with a forced ETA_BUS_AS=consult-alerts), named in config "ssh_command".

    relay.py --config PATH [--live] [--once]
Default is DRY-RUN: it logs "WOULD POST ..." and never opens a connection; its offset lives in a separate state file so going
live later starts from the live state, not from where the dry run got to. --live is required to post.
Stdlib only (/usr/bin/python3). Alert text is operational; it must not contain patient text (the bus rule), and is not inspected.
"""
import argparse, hashlib, json, os, signal, subprocess, sys, time

DEFAULTS = {
    "spool": "~/eta-data/consult/ALERTS.jsonl",
    "state": "~/.local/state/consult-alert-relay/state.json",
    "identity": "consult-alerts",             # only for logs and the dry run: the real identity is set by the Mini for the ssh key behind ssh_command
    "recipients": ["consult-lead", "fable"],
    "ssh_command": ["ssh", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=10",
                    "-o", "BatchMode=yes", "consult-alerts-bus"],     # Host alias in ~/.ssh/config: dedicated key, forced ETA_BUS_AS=consult-alerts on the Mini
    "dead_letter": "~/.local/state/consult-alert-relay/dead-letter.jsonl",
    "start": "beginning",                      # no state yet: "beginning" of the spool, or "end" (only new alerts)
    "poll_s": 5.0,
    "call_timeout_s": 90.0,
    "backoff_start_s": 2.0,
    "backoff_max_s": 300.0,
    "subject_chars": 60,
    "subject_max_utf16": 100,                  # the bus caps subjects at 120 UTF-16 code units; stay well under
    "max_body": 15000,
}
MCP_VERSION = "2024-11-05"
EX_CONFIG = 78                      # sysexits EX_CONFIG; the unit has RestartPreventExitStatus=78


class BusError(Exception):
    """A transport-level failure: the post may or may not have been committed. Retried with backoff."""


class PermanentBusError(BusError):
    """The bus answered and refused this message (bad subject / body / identity / recipient). Retrying cannot help: dead-letter it."""


# The bus turns EVERY server-side exception into an isError reply (herdr agent list timeout, "database is locked", an unresolved
# identity ...), so those must retry. Only the bus's own validation texts mean "this message can never be accepted".
PERMANENT_TEXTS = ("subject exceeds", "control characters", "body exceeds", "looks like it contains a secret",
                   '"to" must be', "no recipients resolved")


def expand(p):
    return os.path.expanduser(p)


def load_config(path=None):
    cfg = dict(DEFAULTS)
    if path:
        with open(expand(path)) as f:
            user = json.load(f)
        if not isinstance(user, dict):
            raise ValueError("config is not a JSON object")
        cfg.update(user)
    return cfg


def validate_config(cfg):
    """-> [problem strings]. Every DEFAULTS key must have the type (and a sane range) of its default; a wrong value must stop the relay
    at start (exit 78), never later inside a poll where it would stick silently."""
    bad = []
    num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
    for k in ("spool", "state", "dead_letter", "identity"):
        if not (isinstance(cfg.get(k), str) and cfg[k].strip()):
            bad.append(f"{k} must be a non-empty string")
    for k in ("recipients", "ssh_command"):
        v = cfg.get(k)
        if not (isinstance(v, list) and v and all(isinstance(x, str) and x for x in v)):
            bad.append(f"{k} must be a non-empty list of non-empty strings")
    if cfg.get("start") not in ("beginning", "end"):
        bad.append('start must be "beginning" or "end"')
    for k in ("poll_s", "call_timeout_s", "backoff_start_s", "backoff_max_s"):
        if not (num(cfg.get(k)) and cfg[k] > 0):
            bad.append(f"{k} must be a number > 0")
    if num(cfg.get("backoff_start_s")) and num(cfg.get("backoff_max_s")) and cfg["backoff_max_s"] < cfg["backoff_start_s"]:
        bad.append("backoff_max_s must be >= backoff_start_s")
    for k, lo, hi in (("subject_chars", 1, 100), ("subject_max_utf16", 30, 120), ("max_body", 200, 16000)):
        v = cfg.get(k)
        if not (isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi):
            bad.append(f"{k} must be an integer from {lo} to {hi}")
    return bad


def log(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}", flush=True)


def alert_text(line):
    """The human text of a spool line: the "alert" field of a JSON object, else the raw line."""
    try:
        r = json.loads(line)
        if isinstance(r, dict) and r.get("alert") is not None:
            return str(r["alert"])
    except ValueError:
        pass
    return line


def utf16_len(s):
    return len(s.encode("utf-16-le")) // 2


def idempotency_key(spool, offset, line):
    """sha256 of spool path + the line's start offset + the line: stable across retries and restarts, unique per spool line."""
    return hashlib.sha256(f"{spool}\0{offset}\0{line}".encode("utf-8", "replace")).hexdigest()


def make_message(line, cfg, key, retry=0):
    """-> (subject, body). Subject: one line, no control characters, first subject_chars (code points) of the alert text, cut
    further so that subject + retry mark is at most subject_max_utf16 UTF-16 units. Body = the line, then the idempotency key on
    its own last line (the line is truncated, never the key)."""
    text = "".join(ch if ch.isprintable() else " " for ch in alert_text(line)).strip()[:cfg["subject_chars"]]
    mark = f" [retry {retry}]" if retry else ""
    head = "ALERT consult: "
    while text and utf16_len(head + text + mark) > cfg["subject_max_utf16"]:
        text = text[:-1]
    tail = f"\nrelay-key: {key}"
    body = line
    if len(body.encode("utf-8", "replace")) > cfg["max_body"]:
        body = body.encode("utf-8", "replace")[:cfg["max_body"]].decode("utf-8", "ignore") + " ...[truncated by relay]"
    return head + text + mark, body + tail


# ---- senders -------------------------------------------------------------------------------------------------------

class DryRunSender:
    def __init__(self, cfg):
        self.cfg = cfg
        self.sent = []

    def post(self, subject, body):
        self.sent.append((subject, body))
        log(f"DRY-RUN WOULD POST to={','.join(self.cfg['recipients'])} as={self.cfg['identity']} subject={subject!r} body={body!r}")


class McpSshSender:
    """Posts through the eta-bus MCP server over ssh: one short-lived connection per message: initialize, initialized, tools/call
    bus_post. The command is config (an ssh Host alias whose key the Mini maps to the sender identity). Errors:
      transport (ssh down / timeout / no or unparsable reply)  -> BusError            (retried)
      the bus answered with its own validation error (PERMANENT_TEXTS) -> PermanentBusError (dead-lettered)
      any other JSON-RPC error / isError (herdr timeout, database locked, identity unresolved, unknown text) -> BusError (retried)"""

    def __init__(self, cfg):
        self.cfg = cfg

    def command(self):
        return list(self.cfg["ssh_command"])

    def post(self, subject, body):
        args = {"to": list(self.cfg["recipients"]), "subject": subject, "body": body}
        msgs = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": MCP_VERSION, "capabilities": {}, "clientInfo": {"name": "consult-alert-relay", "version": "2"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "bus_post", "arguments": args}},
        ]
        data = "".join(json.dumps(m) + "\n" for m in msgs)
        try:
            p = subprocess.run(self.command(), input=data, capture_output=True, text=True, timeout=self.cfg["call_timeout_s"])
        except (OSError, subprocess.SubprocessError) as e:
            raise BusError(f"transport: {type(e).__name__}: {str(e)[:120]}")
        reply = None
        for l in p.stdout.splitlines():
            try:
                m = json.loads(l)
            except ValueError:
                continue
            if isinstance(m, dict) and m.get("id") == 2:
                reply = m
        if reply is None:
            raise BusError(f"no reply to bus_post (ssh rc={p.returncode}): {p.stderr.strip()[:120]}")
        if "error" in reply:
            self._refuse(f"bus_post error: {str(reply['error'])[:200]}")
        res = reply.get("result") or {}
        if res.get("isError"):
            self._refuse(f"bus_post isError: {str(res.get('content'))[:200]}")

    @staticmethod
    def _refuse(text):
        if any(w in text.lower() for w in PERMANENT_TEXTS):
            raise PermanentBusError(text)
        raise BusError(text)


# ---- state ---------------------------------------------------------------------------------------------------------

def save_state(path, st):
    path = expand(path)
    d = os.path.dirname(path)
    os.makedirs(d, mode=0o700, exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(st, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    dfd = os.open(d, os.O_RDONLY)                    # make the rename itself durable
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def load_state(path):
    """-> (state | None, problem | None). None + no problem = no state file yet (first start). A file that exists but cannot be
    trusted (unreadable, not JSON, empty, a field missing or of the wrong type) is a problem."""
    p = expand(path)
    if not os.path.exists(p):
        return None, None
    try:
        with open(p) as f:
            st = json.load(f)
    except (OSError, ValueError) as e:
        return None, f"state file unreadable: {type(e).__name__}"
    if not isinstance(st, dict):
        return None, "state file is not an object"
    if not isinstance(st.get("offset"), int) or isinstance(st.get("offset"), bool) or st["offset"] < 0:
        return None, "state file has no valid offset"
    if not isinstance(st.get("inode"), int) or isinstance(st.get("inode"), bool):
        return None, "state file has no valid inode"
    infl = st.get("inflight")
    if infl is not None and not (isinstance(infl, dict) and isinstance(infl.get("tries", 0), int) and not isinstance(infl.get("tries", 0), bool)
                                 and (infl.get("end") is None or isinstance(infl.get("end"), int)) and (infl.get("sha") is None or isinstance(infl.get("sha"), str))):
        return None, "state file has an invalid inflight record"
    nt = st.get("notice")
    if nt is not None and not (isinstance(nt, dict) and isinstance(nt.get("reason"), str) and isinstance(nt.get("at"), str)):
        return None, "state file has an invalid notice record"
    if st.get("head") is not None and not isinstance(st.get("head"), str):
        return None, "state file has an invalid head"
    return st, None


def head_hash(path, offset):
    """Fingerprint of the (up to) 64 bytes of the spool that end at `offset` (the tail of the last line we handled): catches
    a file replaced in place or by one that reuses the inode and is at least as long as our offset."""
    try:
        with open(path, "rb") as f:
            f.seek(max(0, offset - 64))
            return hashlib.sha256(f.read(min(offset, 64))).hexdigest()[:16]
    except OSError:
        return None


def last_newline_end(path):
    """Offset just after the last newline of the file (0 if there is none): where a 'start at the end' must begin, so a line that is
    still being written is later forwarded whole instead of as a fragment."""
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return 0
    i = data.rfind(b"\n")
    return i + 1


def dead_letter(cfg, record):
    p = expand(cfg["dead_letter"])
    os.makedirs(os.path.dirname(p), mode=0o700, exist_ok=True)
    fd = os.open(p, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a") as f:
        f.write(json.dumps(record) + "\n")


# ---- relay ---------------------------------------------------------------------------------------------------------

class Relay:
    def __init__(self, cfg, sender, sleep=time.sleep, stop=lambda: False):
        self.cfg, self.sender, self.sleep, self.stop = cfg, sender, sleep, stop
        self.spool = expand(cfg["spool"])
        self.state_path = cfg["state"]
        self.st, problem = load_state(self.state_path)
        self.notice = None
        if problem:
            # L1: never replay the whole spool on a damaged state: start at the END and say so once
            log(f"STATE RESET: {problem}; starting at the end of the spool")
            try:
                s = os.stat(self.spool)
                off = last_newline_end(self.spool)
                self.st = {"inode": s.st_ino, "offset": off, "inflight": None, "head": head_hash(self.spool, off)}
            except OSError:
                self.st = {"inode": None, "offset": 0, "inflight": None, "head": None}
            self.st["notice"] = {"reason": problem, "at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
            save_state(self.state_path, self.st)

    # -- reading
    def _init_state(self):
        if self.st is not None and self.st.get("inode") is not None:
            return
        try:
            s = os.stat(self.spool)
        except OSError:
            return                                  # no spool yet: nothing to remember; start at 0 when it appears
        if self.st is not None:                     # reset while the spool was absent: the file that appeared is all new
            self.st.update({"inode": s.st_ino, "offset": 0, "head": None})
        else:
            off = last_newline_end(self.spool) if self.cfg["start"] == "end" else 0
            self.st = {"inode": s.st_ino, "offset": off, "inflight": None, "head": head_hash(self.spool, off)}
        save_state(self.state_path, self.st)

    def _complete_lines(self, path, offset):
        """[(line_text, start_offset, end_offset)] of the complete lines at/after offset. An offset that is not at a line start
        (the byte before it is not a newline) skips forward to the next newline: the fragment is never forwarded."""
        out = []
        with open(path, "rb") as f:
            if offset > 0:
                f.seek(offset - 1)
                if f.read(1) != b"\n":
                    f.seek(offset)
                    rest = f.read()
                    nl = rest.find(b"\n")
                    if nl < 0:
                        return []
                    log(f"offset {offset} is mid-line; skipping {nl + 1} bytes to the next line")
                    offset += nl + 1
                    self.st["offset"], self.st["inflight"] = offset, None
                    save_state(self.state_path, self.st)
            f.seek(offset)
            data = f.read()
        pos = 0
        while True:
            nl = data.find(b"\n", pos)
            if nl < 0:
                break
            out.append((data[pos:nl].decode("utf-8", "replace").rstrip("\r"), offset + pos, offset + nl + 1))
            pos = nl + 1
        return out

    def _deliver(self, line_for_log, make, on_dead):
        """Post one message. make(attempt_number) -> (subject, body), attempt 1 is the first try. Transport errors back off and retry
        (the offset does not move); a PermanentBusError calls on_dead(reason) and returns True (move on). False = asked to stop."""
        delay = self.cfg["backoff_start_s"]
        while True:
            infl = self.st.get("inflight")
            n = (infl.get("tries", 0) if infl else 0) + 1
            if infl is not None:
                infl["tries"] = n
                save_state(self.state_path, self.st)              # recorded BEFORE the post: a crash in between is visible on restart
            subject, body = make(n)
            try:
                self.sender.post(subject, body)
                return True
            except PermanentBusError as e:
                log(f"bus REFUSED {line_for_log}: {e}")
                on_dead(str(e), subject)
                return True
            except BusError as e:
                log(f"bus down ({e}); retry in {delay:.0f}s")
            if self.stop():
                return False
            self.sleep(delay)
            if self.stop():
                return False
            delay = min(delay * 2, self.cfg["backoff_max_s"])

    def _send_notice(self):
        n = self.st.get("notice")
        if not n:
            return
        key = hashlib.sha256(f"state-reset\0{self.spool}\0{n['at']}".encode()).hexdigest()
        body = (f"consult-alert-relay lost its state ({n['reason']}) at {n['at']}. It restarted at the END of the spool and did not "
                f"re-send old alerts: alerts written while it was down or not tracked may be missing; check the spool "
                f"{self.spool} and the cutter / vp-auto logs.\nrelay-key: {key}")
        def make(tries):
            return "ALERT consult: relay state reset" + (f" [retry {tries - 1}]" if tries > 1 else ""), body
        infl = self.st.get("inflight")
        if not (infl and infl.get("end") is None and infl.get("sha") is None):
            self.st["inflight"] = {"end": None, "sha": None, "tries": 0}       # a notice already tried before a crash keeps its count
        if self._deliver("state-reset notice", make, lambda reason, subj: dead_letter(self.cfg, {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "kind": "state-reset", "reason": reason, "subject": subj})):
            self.st["inflight"] = None
            self.st.pop("notice", None)
            save_state(self.state_path, self.st)

    def _drain(self, path, inode):
        """Forward every complete line of `path` after the saved offset. Returns the number sent; stops early on stop()."""
        sent = 0
        for line, start, end in self._complete_lines(path, self.st["offset"]):
            if self.stop():
                break
            if line.strip():
                sha = hashlib.sha256(line.encode("utf-8", "replace")).hexdigest()[:16]
                infl = self.st.get("inflight")
                if not (infl and infl.get("end") == end and infl.get("sha") == sha):
                    infl = {"end": end, "sha": sha, "tries": 0}
                self.st["inflight"] = infl
                key = idempotency_key(self.spool, start, line)

                def dead(reason, subject, line=line, start=start, key=key):
                    dead_letter(self.cfg, {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "offset": start, "key": key,
                                           "reason": reason, "subject": subject, "line": line})
                if not self._deliver(f"line@{start}", lambda tries: make_message(line, self.cfg, key, tries - 1), dead):
                    break                                         # stopped: the in-flight record (tries so far) stays, so the next run marks its retry
                sent += 1
            self.st["offset"], self.st["inflight"] = end, None
            self.st["head"] = head_hash(path, end)
            save_state(self.state_path, self.st)
        return sent

    def poll_once(self):
        self._init_state()
        if self.st is not None and self.st.get("notice"):
            self._send_notice()
            if self.st.get("notice"):
                return 0
        try:
            s = os.stat(self.spool)
        except OSError:
            return 0
        if self.st is None:
            self._init_state()
        sent = 0
        same_content = (s.st_ino != self.st["inode"] and self.st["offset"] > 0 and s.st_size >= self.st["offset"]
                        and self.st.get("head") is not None and head_hash(self.spool, self.st["offset"]) == self.st["head"]
                        and not (os.path.exists(self.spool + ".1") and os.stat(self.spool + ".1").st_ino == self.st["inode"]))
        if same_content:
            # editor save / cp + mv: a new inode holding the bytes we already forwarded: keep the offset, nothing is re-sent
            log("spool replaced by a copy of itself (same bytes up to the offset); keeping the offset")
            self.st["inode"] = s.st_ino
            save_state(self.state_path, self.st)
        if s.st_ino != self.st["inode"]:
            # rotation: first finish the old file (now <spool>.1 by convention), then start the new one at 0
            old = self.spool + ".1"
            try:
                if os.stat(old).st_ino == self.st["inode"]:
                    sent += self._drain(old, self.st["inode"])
                    if self.stop():
                        return sent
            except OSError:
                log("spool rotated; the old file is gone, its unread tail (if any) is unrecoverable")
            self.st.update({"inode": s.st_ino, "offset": 0, "inflight": None, "head": None})
            save_state(self.state_path, self.st)
        elif s.st_size < self.st["offset"] or (self.st["offset"] and self.st.get("head") not in (None, head_hash(self.spool, self.st["offset"]))):
            log("spool truncated or replaced in place; restarting at offset 0")
            self.st.update({"offset": 0, "inflight": None, "head": None})
            save_state(self.state_path, self.st)
        return sent + self._drain(self.spool, s.st_ino)

    def run(self):
        while not self.stop():
            try:
                self.poll_once()
            except Exception as e:     # never die on a bad poll; Restart=always is the backstop, not the plan
                log(f"poll error {type(e).__name__}: {str(e)[:160]}")
            if self.stop():
                break
            self.sleep(self.cfg["poll_s"])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config")
    ap.add_argument("--live", action="store_true", help="actually post to the bus (default: dry run)")
    ap.add_argument("--once", action="store_true", help="one poll, then exit")
    a = ap.parse_args(argv)
    try:
        cfg = load_config(a.config)
    except (OSError, ValueError, TypeError) as e:
        log(f"CONFIG ERROR {a.config}: {type(e).__name__}: {str(e)[:160]}; exiting {EX_CONFIG} (systemd will not restart)")
        return EX_CONFIG
    problems = validate_config(cfg)
    if problems:
        log(f"CONFIG ERROR {a.config}: {'; '.join(problems)}; exiting {EX_CONFIG} (systemd will not restart)")
        return EX_CONFIG
    if not a.live:                                      # a dry run never shares the live state
        cfg["state"] = cfg["state"].replace(".json", "") + ".dryrun.json"
    stopping = []
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stopping.append(1))
    sender = McpSshSender(cfg) if a.live else DryRunSender(cfg)
    r = Relay(cfg, sender, stop=lambda: bool(stopping))
    log(f"alert-relay start mode={'LIVE' if a.live else 'DRY-RUN'} spool={r.spool} identity={cfg['identity']} to={cfg['recipients']}")
    if a.once:
        r.poll_once()
    else:
        r.run()
    log("alert-relay stop")
    return 0


if __name__ == "__main__":
    sys.exit(main())
