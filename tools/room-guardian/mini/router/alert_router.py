"""alert_router.py -- durable room-alert router (FR-1 C4, A6 design). Pure logic; the clock, store and bus are injected.

A CASE is one open alert for (room, kind). Opened by the first outbox row, paged at once, re-paged every REPAGE_CLINIC_S in clinic
hours / REPAGE_OFF_S outside, until a person acks ("ACK room-alert-<first_id>" on the bus, sent by gating-lead or fleet). Ack stops
re-pages; the case stays open until recovery closes it. A duplicate row while open bumps suppressed_count; a late duplicate after
close opens a new case.

R2 (Phase 0 fix round): opening and closing a case NEVER touches the bus. on_row only writes the store; close_room writes the store and queues a
note (store.add_note). All sending happens in tick(): ONE ubus send per tick carries every due page, V notice and queued note, on the day
thread room-alert-batch-<YYYY-MM-DD> (IST). ubus caps sends per machine, so one send per tick is the budget. A failed send leaves every
case state untouched, so the pages are simply due again on the next tick, and it never blocks the digest, the routed-id prune or the ack read.

Crash rule: each page line carries "room-alert-<id> ... [page N]". Before posting, the router reads the day thread; a page whose marker is
already there is only written to the store. So a crash between post and state write gives neither a duplicate page nor a lost alert.
The marker read covers today's AND yesterday's day thread, so a page posted just before IST midnight is not paged again just after it.
ACKs are read from the day threads (today and yesterday) and from each case's own thread room-alert-<first_id>.

The 21:00 list ("digest") rides in the same batch send, as one block: header line, one line per unacked case (capped), and once per calendar month
a size line for backup/_to_delete. The block is atomic: if it does not fit the body cap, or the send fails, it stays due for the next tick.

Store interface (see SqliteStore): get_open(room, kind) -> case|None, list_open(), insert(case), update(first_id, **f), add_note(text, now),
list_notes(), drop_notes(ids).
Bus interface: post(subject, body, priority, thread_id), thread_messages(thread_id) -> [{"from","subject","body"}].
"""
import re
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
ACKERS = {"gating-lead", "fleet"}
REPAGE_CLINIC_S, REPAGE_OFF_S = 600, 1800
CA_KINDS = {"capture_dead", "capture_muted", "coreaudio_heal_failed", "recorder_disturbed"}     # coreaudio heal rule alerts (kiosk kiosk/<room>/heal lines)
CA_WINDOW_MIN = (7 * 60, 21 * 60 + 35)      # gate CA-C3: V flag for the coreaudio kinds inside 07:00-21:35 IST, every day of the week
INBOX_DEADLINE_S = 300                       # a queued HEAL action line not appended to INBOX-FROM-GATING.md within 5 min raises heal_inbox_stuck
V_KINDS = {"recorder_off", "fleet_outage", "no_machine", "install_retired"} | CA_KINDS            # patient-impacting (A6 finding 7)
V_FIRST_S, V_REMINDER_S = 1800, 3600
CLINIC_START_MIN, CLINIC_END_MIN, CLINIC_DAYS = 7 * 60 + 30, 21 * 60 + 30, (1, 2, 3, 4, 5, 6)   # mirrors lib/alerts/clinic-hours.ts
DIGEST_HOUR_IST = 21
ROUTED_KEEP_S = 7 * 86400
URGENT = {"offline", "degraded", "fleet_outage", "install_retired", "recorder_off", "mic_denied", "no_machine", "room_disabled",
          "needs_enrol", "capture_stalled", "guardian_quiet", "heal_escalated", "backup_failed", "heal_inbox_stuck"} | CA_KINDS
OPEN_KINDS = URGENT | {"heal_message_invalid"}          # kinds that open a case; 'recovered' and 'session_reaped' never do
# An ACK also CLOSES these (order: "closes on recovery or ACK"). recorder_changed and heal_message_invalid have no recovery signal, so ACK is their only close.
ACK_CLOSE_KINDS = CA_KINDS | {"heal_message_invalid"}
RECOVERY_KIND = "recovered"
_ACK_RE = re.compile(r"^ACK\s+room-alert-(\d+)\b", re.I)
_ID_RE = re.compile(r"room-alert-(\d+)\b", re.I)
_MARK_RE = re.compile(r"room-alert-(\d+) .*\[page (\d+)\]")
BATCH_PREFIX = "room-alert-batch-"
BODY_CAP = 3800


def batch_tid(now):
    return BATCH_PREFIX + datetime.fromtimestamp(now, IST).strftime("%Y-%m-%d")


def is_v_window(kind, now):
    """The window in which a V-kind may raise a V notice: the coreaudio kinds use CA-C3's 07:00-21:35 IST; every other kind the general clinic hours."""
    if kind in CA_KINDS:
        ist = datetime.fromtimestamp(now, IST)
        return CA_WINDOW_MIN[0] <= ist.hour * 60 + ist.minute < CA_WINDOW_MIN[1]
    return is_clinic(now)


def append_inbox_line(path, text):
    """One O_APPEND write of '- <text>\n' (a leading newline if the file does not end with one). Raises OSError if the file cannot be written."""
    import os
    path = os.path.expanduser(path)
    lead = ""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            if f.tell() > 0:
                f.seek(-1, 2)
                lead = "" if f.read(1) == b"\n" else "\n"
    except FileNotFoundError:
        pass
    with open(path, "a") as f:
        f.write(lead + text.rstrip("\n") + "\n")


def is_clinic(now):
    ist = datetime.fromtimestamp(now, IST)
    if (ist.isoweekday() % 7) not in CLINIC_DAYS:     # isoweekday Sun=7 -> 0
        return False
    m = ist.hour * 60 + ist.minute
    return CLINIC_START_MIN <= m < CLINIC_END_MIN


class Router:
    inbox_path = None        # set by run_router.py: the router job appends queued HEAL action lines there. None (subscriber's router, tests): the queue is only written.
    def __init__(self, store, bus_factory, clock, state_path=None, size_line_fn=None):
        self.store, self.bus_factory, self.clock = store, bus_factory, clock
        self.state_path = state_path
        self.size_line_fn = size_line_fn          # () -> str | None: the monthly _to_delete size line; None or an error means no line
        self.local = {"v_sent": {}, "digest_day": "", "size_month": ""}
        self._load()

    # ---- local state: V notices and the digest day. Losing it repeats a V notice at worst.
    def _load(self):
        import json, os
        if self.state_path and os.path.exists(self.state_path):
            try:
                with open(self.state_path) as f:
                    d = json.load(f)
                if isinstance(d, dict):
                    self.local["v_sent"] = {str(k): list(v) for k, v in d.get("v_sent", {}).items()}
                    self.local["digest_day"] = str(d.get("digest_day", ""))
                    self.local["size_month"] = str(d.get("size_month", ""))
            except (OSError, ValueError):
                pass

    def _save(self):
        import json, os
        if not self.state_path:
            return
        tmp = f"{self.state_path}.tmp{os.getpid()}"
        with open(tmp, "w") as f:
            json.dump(self.local, f)
        os.replace(tmp, self.state_path)

    # ---- rows from the outbox
    def on_row(self, bus, row):
        """Called by the relay AFTER the plain post succeeded. Safe to call twice for the same row (a replay after a crash)."""
        rid, kind, rooms = row.get("id"), row.get("kind"), row.get("room_ids") or ([row["room_id"]] if row.get("room_id") else [])
        if not isinstance(rid, int) or isinstance(rid, bool) or not rooms:
            return
        if self.store.is_routed(rid):               # the kit relay re-delivers recent rows (its `late` set): each row id is routed ONCE (R3)
            return
        for room in rooms:
            if kind == RECOVERY_KIND:
                self.close_room(bus, room, "recovery")
            elif kind in OPEN_KINDS:
                self._open_or_bump(bus, room, kind, rid, row)
        self.store.mark_routed(rid, self.clock())    # AFTER the work: a crash before this replays the row (a late duplicate), never loses it

    def _open_or_bump(self, bus, room, kind, rid, row):
        case = self.store.get_open(room, kind)
        if case:
            if rid != case["first_id"]:
                self.store.update(case["first_id"], suppressed_count=case["suppressed_count"] + 1)
            return
        now = self.clock()
        try:
            self._insert_case(rid, room, kind, now)
        except Exception:                      # a concurrent opener (relay vs subscriber) won the unique index: fold in as a duplicate
            case = self.store.get_open(room, kind)
            if not case:
                raise
            self.store.update(case["first_id"], suppressed_count=case["suppressed_count"] + 1)
            return
        # R2: no page here. tick() pages any case with last_paged_at None within one tick.

    def _insert_case(self, rid, room, kind, now):
        self.store.insert({"first_id": rid, "room_id": room, "kind": kind, "opened_at": now, "last_paged_at": None, "page_count": 0,
                           "suppressed_count": 0, "acked_by": None, "acked_at": None, "closed_at": None, "close_reason": None})

    def close_room(self, bus, room, reason, kind=None):
        for c in self.store.list_open():
            if c["room_id"] == room and (kind is None or c["kind"] == kind):
                self.store.update(c["first_id"], closed_at=self.clock(), close_reason=reason)
                self.local["v_sent"].pop(str(c["first_id"]), None)
                self.store.add_note(f"room-alert-{c['first_id']} {c['kind']} in {room} CLOSED ({reason}) after {self._age_min(c)} min. "
                                    f"Pages sent {c['page_count']}, duplicates folded {c['suppressed_count']}.", self.clock())
        self._save()

    # ---- paging
    def _age_min(self, c):
        return int((self.clock() - c["opened_at"]) // 60)

    def _flush(self, bus, now, pages, vcases, notes, msgs, out, digest=None):
        """One send for everything due. State is written only after the send succeeded. `digest` is (lines, day, month|None) or None."""
        tid = batch_tid(now)
        done = set()
        for mt_tid in (tid, batch_tid(now - 86400)):          # yesterday's thread too: a page posted before IST midnight is not repeated after it
            for m in msgs(mt_tid):
                for line in f"{m.get('subject', '')}\n{m.get('body', '')}".splitlines():
                    mt = _MARK_RE.search(line)
                    if mt:
                        done.add((int(mt.group(1)), int(mt.group(2))))
        lines, send, already = [], [], []
        for c, v in pages:
            n = c["page_count"] + 1
            if (c["first_id"], n) in done:
                already.append((c, n)); continue
            src = " source=mini." if c["first_id"] >= LOCAL_ID_BASE else ""
            line = (f"room-alert-{c['first_id']} {c['kind']} in {c['room_id']}.{src} open {self._age_min(c)} min, duplicates folded "
                    f"{c['suppressed_count']}. [page {n}]" + (" V: patient-impacting, past the V threshold. gating-lead tells V." if v else ""))
            lines.append(line); send.append((c, n, v))
        vlines = [(c, f"V room-alert-{c['first_id']} {c['kind']} in {c['room_id']} open {self._age_min(c)} min, "
                      f"{'acked but' if c['acked_at'] else 'unacked,'} not recovered. gating-lead tells V.") for c in vcases]
        # trim to the body cap: what does not fit stays due for the next tick
        head = "Reply 'ACK room-alert-<id>' (one line per case) in this thread to stop re-pages.\n"
        budget = BODY_CAP - len(head)
        keep_pages, keep_v, keep_notes, used = [], [], [], 0
        for (c, n, v), line in zip(send, lines):
            if used + len(line) + 1 <= budget: keep_pages.append((c, n, v, line)); used += len(line) + 1
        for c, line in vlines:
            if used + len(line) + 1 <= budget: keep_v.append((c, line)); used += len(line) + 1
        for nid, text in notes:
            if used + len(text) + 1 <= budget: keep_notes.append((nid, text)); used += len(text) + 1
        keep_digest = None
        if digest:                                            # last in line: pages, V notices and notes come first; the digest is atomic
            dtext = "\n".join(digest[0])
            if used + len(dtext) + 1 <= budget:
                keep_digest = digest; used += len(dtext) + 1
        if keep_pages or keep_v or keep_notes or keep_digest:
            body = head + "\n".join([l for *_, l in keep_pages] + [l for _, l in keep_v] + [t for _, t in keep_notes]
                                    + (list(keep_digest[0]) if keep_digest else []))
            anyv = any(v for *_, v, _l in keep_pages) or bool(keep_v)
            subject = (f"ROOM ALERT{' V' if anyv else ''}: {len(keep_pages)} page(s), {len(keep_v)} V, {len(keep_notes)} note(s)"
                       + (", 21:00 list" if keep_digest else ""))[:120]
            urgent = any(c["kind"] in URGENT for c, *_ in keep_pages) or bool(keep_v)
            bus.post(subject, body, "urgent" if urgent else "normal", tid)
        t = self.clock()
        for c, n, v, _l in keep_pages:
            self.store.update(c["first_id"], last_paged_at=t, page_count=n)
            if v:
                self._v_due(c, now - c["opened_at"], now, mark=True)
        for c, n in already:
            self.store.update(c["first_id"], last_paged_at=t, page_count=n)
        for c, _l in keep_v:
            self._v_due(c, now - c["opened_at"], now, mark=True)
        if keep_notes:
            self.store.drop_notes([nid for nid, _ in keep_notes])
        if keep_digest:
            self.local["digest_day"] = keep_digest[1]
            if keep_digest[2]:
                self.local["size_month"] = keep_digest[2]
            out["digest"] += 1
        out["paged"] += len(keep_pages) + len(already); out["v"] += len(keep_v) + sum(1 for *_, v, _l in keep_pages if v)
        out["notes"] += len(keep_notes)

    def tick(self, bus=None):
        """One cycle: read acks, then ONE send for every due page / V notice / queued note, then the 21:00 list. Each stage is isolated:
        a bus failure in one never stops the others. Returns a count dict (for logs and tests); out["errors"] counts failed stages."""
        own = bus is None
        bus = bus or self.bus_factory()
        out = {"acked": 0, "paged": 0, "v": 0, "digest": 0, "notes": 0, "errors": 0}
        cache = {}

        def msgs(tid):
            if tid not in cache:
                cache[tid] = list(bus.thread_messages(tid))
            return cache[tid]
        try:
            now = self.clock()
            opens = self.store.list_open()
            try:
                for c in opens:
                    if not c["acked_at"] and self._read_ack(c, now, msgs):
                        out["acked"] += 1
            except Exception as e:
                out["errors"] += 1; out["error"] = f"ack read: {e.__class__.__name__}"
            pages, vcases = [], []
            for c in self.store.list_open():
                age = now - c["opened_at"]
                if not c["acked_at"]:
                    gap = REPAGE_CLINIC_S if is_clinic(now) else REPAGE_OFF_S
                    if c["last_paged_at"] is None or now - c["last_paged_at"] >= gap:
                        pages.append((c, self._v_due(c, age, now, mark=False)))
                        continue
                if self._v_due(c, age, now, mark=False):
                    vcases.append(c)
            notes = self.store.list_notes()
            digest = None
            try:
                digest = self._digest_block(now)
            except Exception as e:
                out["errors"] += 1; out["error"] = f"digest: {e.__class__.__name__}"
            if pages or vcases or notes or digest:
                try:
                    self._flush(bus, now, pages, vcases, notes, msgs, out, digest)
                except Exception as e:
                    out["errors"] += 1; out["error"] = f"send: {e.__class__.__name__}: {str(e)[:80]}"
            try:
                self.store.prune_routed(now - ROUTED_KEEP_S)
            except Exception as e:
                out["errors"] += 1; out["error"] = f"prune: {e.__class__.__name__}"
            self._save()
            self._inbox_stage(now, out)
        finally:
            if own and hasattr(bus, "close"):
                bus.close()
        return out

    def _inbox_stage(self, now, out):
        """CA-C6: append every queued HEAL action line to the gating INBOX file; alarm (heal_inbox_stuck) if one waits more than INBOX_DEADLINE_S.
        At-least-once: a crash between the append and the mark repeats the line. Isolated: a fault here never stops the other stages."""
        if not self.inbox_path:
            return
        try:
            for iid, text, _created in self.store.list_inbox_pending():
                try:
                    append_inbox_line(self.inbox_path, text)
                except OSError:
                    break                                       # try again next tick; the deadline below raises the alarm
                self.store.mark_inbox_written(iid, self.clock())
                out["inbox"] = out.get("inbox", 0) + 1
            left = self.store.list_inbox_pending()
            stuck = [p for p in left if now - p[2] > INBOX_DEADLINE_S]
            if stuck and not self.store.get_open("mini", "heal_inbox_stuck"):
                self.on_row(None, {"id": self.store.alloc_local_id(), "kind": "heal_inbox_stuck", "room_ids": ["mini"], "room_name": "mini (heal inbox append)"})
            elif not left and self.store.get_open("mini", "heal_inbox_stuck"):
                self.close_room(None, "mini", "inbox drained", kind="heal_inbox_stuck")
            self.store.prune_inbox(now - ROUTED_KEEP_S)
        except Exception as e:
            out["errors"] += 1; out["error"] = f"inbox: {e.__class__.__name__}"

    def _v_due(self, c, age, now, mark):
        if c["kind"] not in V_KINDS or not is_v_window(c["kind"], now) or age < V_FIRST_S:
            return False
        sent = self.local["v_sent"].setdefault(str(c["first_id"]), [])
        step = 60 if age >= V_REMINDER_S else 30
        if step in sent:
            return False
        if step == 60 and 30 not in sent:
            sent.append(30)            # crossed both thresholds while nobody looked: one notice covers both
        if mark:
            sent.append(step)
        return True

    @staticmethod
    def ack_ids(m):
        """Every case id acked by one message. Accepts: a single 'ACK room-alert-<id>' subject; several ACK lines in the body (the batch reply the
        page asks for); a list on one ACK line; a ubus_reply, whose subject is 'Re: <batch subject>' and whose body holds the ACK lines. Lines are matched one by one."""
        subj = re.sub(r"^\s*(re:\s*)+", "", str(m.get("subject", "")), flags=re.I)
        ids = set()
        for line in [subj] + str(m.get("body", "")).splitlines():
            line = line.strip()
            if _ACK_RE.match(line):                       # a line that starts with ACK acks EVERY room-alert-<id> on it (gate C1): "ACK room-alert-1, room-alert-2"
                ids.update(int(x) for x in _ID_RE.findall(line))
        return ids

    def _read_ack(self, c, now, msgs):
        tids = [f"room-alert-{c['first_id']}", batch_tid(now), batch_tid(now - 86400)]
        for tid in tids:
            for m in msgs(tid):
                sender = str(m.get("from", ""))
                if sender in ACKERS and c["first_id"] in self.ack_ids(m):
                    t = self.clock()
                    self.store.update(c["first_id"], acked_by=sender, acked_at=t)
                    if c["kind"] in ACK_CLOSE_KINDS:
                        self.store.update(c["first_id"], closed_at=t, close_reason="acked")
                        self.local["v_sent"].pop(str(c["first_id"]), None)
                        self.store.add_note(f"room-alert-{c['first_id']} {c['kind']} in {c['room_id']} CLOSED (acked by {sender}) after {self._age_min(c)} min. "
                                            f"Pages sent {c['page_count']}, duplicates folded {c['suppressed_count']}.", t)
                    return True
        return False

    # ---- end-of-day list
    def unacked_list(self):
        return [f"room-alert-{c['first_id']} {c['kind']} {c['room_id']} open {self._age_min(c)} min, pages {c['page_count']}"
                for c in self.store.list_open() if not c["acked_at"]]

    DIGEST_LINES_CAP = 30

    def _digest_block(self, now):
        """The 21:00 block for this day, or None (not yet 21:00, already sent today, or nothing to say). Returns (lines, day, month|None); the day and
        month are recorded only after the batch send succeeded (see _flush). The size line goes out with the first digest run of each calendar month."""
        ist = datetime.fromtimestamp(now, IST)
        day, month = ist.strftime("%Y-%m-%d"), ist.strftime("%Y-%m")
        if ist.hour < DIGEST_HOUR_IST or self.local["digest_day"] == day:
            return None
        lines = self.unacked_list()
        block = []
        if lines:
            block.append(f"ROOM ALERTS unacked at 21:00: {len(lines)}")
            block.extend(lines[:self.DIGEST_LINES_CAP])
            if len(lines) > self.DIGEST_LINES_CAP:
                block.append(f"... and {len(lines) - self.DIGEST_LINES_CAP} more")
        size_month = None
        if self.size_line_fn and self.local["size_month"] != month:
            try:
                sl = self.size_line_fn()
            except Exception:
                sl = None
            if sl:
                block.append(sl); size_month = month
        if not block:
            self.local["digest_day"] = day          # nothing to say today: do not look again until tomorrow
            return None
        return block, day, size_month


def folder_size_line(path, label="backup/_to_delete"):
    """The monthly size line for a folder nothing empties. None when the folder is absent. Only counts regular files, top level and below."""
    import os
    if not os.path.isdir(path):
        return None
    n = size = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                size += os.path.getsize(os.path.join(root, f)); n += 1
            except OSError:
                pass
    return f"{label}: {n} file(s), {size / 1048576:.1f} MB. Reviewer: fleet / herdr-lead. Nothing empties it; move out or remove by hand."


LOCAL_ID_BASE = 10 ** 12      # cases opened on the Mini (source=mini) use ids from here; server outbox ids stay far below


class SqliteStore:
    """Production case store (C4 R2 ruling 1): Mini-local SQLite, WAL. The router and the relay are its only users and both run on the Mini."""
    COLS = ("first_id", "room_id", "kind", "opened_at", "last_paged_at", "page_count", "suppressed_count", "acked_by", "acked_at", "closed_at", "close_reason")

    def __init__(self, path=":memory:"):
        import os, sqlite3
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.path = path
        self.db = sqlite3.connect(path, timeout=10, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA busy_timeout=10000")
        if path != ":memory:":
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS room_alert_case (first_id INTEGER PRIMARY KEY, room_id TEXT NOT NULL, kind TEXT NOT NULL, opened_at REAL NOT NULL, "
                        "last_paged_at REAL, page_count INTEGER NOT NULL DEFAULT 0, suppressed_count INTEGER NOT NULL DEFAULT 0, acked_by TEXT, acked_at REAL, closed_at REAL, close_reason TEXT)")
        self.db.execute("CREATE TABLE IF NOT EXISTS routed_ids (row_id INTEGER PRIMARY KEY, routed_at REAL NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS outbox_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at REAL NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS heal_inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at REAL NOT NULL, written_at REAL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS local_seq (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL)")
        self.db.execute("INSERT OR IGNORE INTO local_seq (id, seq) VALUES (1, 0)")
        self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS open_uq ON room_alert_case (room_id, kind) WHERE closed_at IS NULL")

    def get_open(self, room, kind):
        r = self.db.execute("SELECT * FROM room_alert_case WHERE room_id=? AND kind=? AND closed_at IS NULL", (room, kind)).fetchone()
        return dict(r) if r else None

    def list_open(self):
        return [dict(r) for r in self.db.execute("SELECT * FROM room_alert_case WHERE closed_at IS NULL ORDER BY first_id")]

    def insert(self, case):
        self.db.execute(f"INSERT INTO room_alert_case ({','.join(self.COLS)}) VALUES ({','.join('?' * len(self.COLS))})", [case[c] for c in self.COLS])

    def update(self, first_id, **f):
        bad = set(f) - set(self.COLS)
        if bad:
            raise ValueError(f"unknown columns {bad}")
        sets = ",".join(f"{k}=?" for k in f)
        self.db.execute(f"UPDATE room_alert_case SET {sets} WHERE first_id=?", [*f.values(), first_id])

    def add_note(self, text, now):
        self.db.execute("INSERT INTO outbox_notes (text, created_at) VALUES (?, ?)", (text, now))

    def list_notes(self):
        return [(r[0], r[1]) for r in self.db.execute("SELECT id, text FROM outbox_notes ORDER BY id")]

    def drop_notes(self, ids):
        for i in ids:
            self.db.execute("DELETE FROM outbox_notes WHERE id=?", (i,))

    def add_inbox(self, text, now):
        self.db.execute("INSERT INTO heal_inbox (text, created_at) VALUES (?, ?)", (text, now))

    def list_inbox_pending(self):
        return [(r[0], r[1], r[2]) for r in self.db.execute("SELECT id, text, created_at FROM heal_inbox WHERE written_at IS NULL ORDER BY id")]

    def mark_inbox_written(self, iid, now):
        self.db.execute("UPDATE heal_inbox SET written_at=? WHERE id=?", (now, iid))

    def prune_inbox(self, before):
        self.db.execute("DELETE FROM heal_inbox WHERE written_at IS NOT NULL AND written_at < ?", (before,))

    def is_routed(self, row_id):
        return self.db.execute("SELECT 1 FROM routed_ids WHERE row_id=?", (row_id,)).fetchone() is not None

    def mark_routed(self, row_id, now):
        self.db.execute("INSERT OR IGNORE INTO routed_ids (row_id, routed_at) VALUES (?, ?)", (row_id, now))

    def prune_routed(self, before):
        self.db.execute("DELETE FROM routed_ids WHERE routed_at < ?", (before,))

    def alloc_local_id(self):
        """A Mini-local case id: LOCAL_ID_BASE + a monotonic counter in local_seq. Never derived from existing cases or routed ids, so a duplicate
        (which makes a routed id but no case) cannot cause a reuse. The increment commits on its own before the id is used; a burnt id is harmless."""
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self.db.execute("UPDATE local_seq SET seq = seq + 1 WHERE id = 1")
            seq = self.db.execute("SELECT seq FROM local_seq WHERE id = 1").fetchone()[0]
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        return LOCAL_ID_BASE + seq

    def backup_to(self, dest_dir, keep=14, stamp=None):
        """Online copy via the sqlite backup API (safe with WAL). Keeps the newest `keep` files named cases-YYYYMMDD-HHMMSS.sqlite."""
        import os, sqlite3
        os.makedirs(dest_dir, exist_ok=True)
        stamp = stamp or datetime.now(IST).strftime("%Y%m%d-%H%M%S")
        dest = os.path.join(dest_dir, f"cases-{stamp}.sqlite")
        out = sqlite3.connect(dest)
        try:
            self.db.backup(out)
        finally:
            out.close()
        files = sorted(f for f in os.listdir(dest_dir) if f.startswith("cases-") and f.endswith(".sqlite"))
        for f in files[:-keep]:
            os.remove(os.path.join(dest_dir, f))
        return dest


def default_store(home):
    import os
    return SqliteStore(os.path.join(home, "data", "cases.sqlite"))
