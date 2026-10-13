"""alert_router.py -- durable room-alert router (FR-1 C4, A6 design). Pure logic; the clock, store and bus are injected.

A CASE is one open alert for (room, kind). Opened by the first outbox row, paged at once, re-paged every REPAGE_CLINIC_S in clinic
hours / REPAGE_OFF_S outside, until a person acks ("ACK room-alert-<first_id>" on the bus, sent by gating-lead or fleet). Ack stops
re-pages; the case stays open until recovery closes it. A duplicate row while open bumps suppressed_count; a late duplicate after
close opens a new case.

Crash rule: a page carries the marker "[page N]" in its subject and is posted on thread room-alert-<first_id>. Before posting page N
the router asks the bus whether that marker exists; if so it only writes the state. So a crash between post and state write gives
neither a duplicate page nor a lost alert.

Store interface (see MemoryStore in the tests / SqliteStore): get_open(room, kind) -> case|None, list_open(), insert(case), update(first_id, **f).
Bus interface: post(subject, body, priority, thread_id), thread_messages(thread_id) -> [{"from","subject","body"}].
"""
import re
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
ACKERS = {"gating-lead", "fleet"}
REPAGE_CLINIC_S, REPAGE_OFF_S = 600, 1800
V_KINDS = {"recorder_off", "fleet_outage", "no_machine", "install_retired"}   # patient-impacting (A6 finding 7)
V_FIRST_S, V_REMINDER_S = 1800, 3600
CLINIC_START_MIN, CLINIC_END_MIN, CLINIC_DAYS = 7 * 60 + 30, 21 * 60 + 30, (1, 2, 3, 4, 5, 6)   # mirrors lib/alerts/clinic-hours.ts
DIGEST_HOUR_IST = 21
URGENT = {"offline", "degraded", "fleet_outage", "install_retired", "recorder_off", "mic_denied", "no_machine", "room_disabled",
          "needs_enrol", "capture_stalled", "guardian_quiet", "heal_escalated"}
OPEN_KINDS = URGENT          # kinds that open a case; 'recovered' and 'session_reaped' never do
RECOVERY_KIND = "recovered"
_ACK_RE = re.compile(r"^ACK\s+room-alert-(\d+)\b", re.I)


def is_clinic(now):
    ist = datetime.fromtimestamp(now, IST)
    if (ist.isoweekday() % 7) not in CLINIC_DAYS:     # isoweekday Sun=7 -> 0
        return False
    m = ist.hour * 60 + ist.minute
    return CLINIC_START_MIN <= m < CLINIC_END_MIN


class Router:
    def __init__(self, store, bus_factory, clock, state_path=None):
        self.store, self.bus_factory, self.clock = store, bus_factory, clock
        self.state_path = state_path
        self.local = {"v_sent": {}, "digest_day": ""}
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
        for room in rooms:
            if kind == RECOVERY_KIND:
                self.close_room(bus, room, "recovery")
            elif kind in OPEN_KINDS:
                self._open_or_bump(bus, room, kind, rid, row)

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
        self._page(bus, self.store.get_open(room, kind), row.get("room_name") or room)

    def _insert_case(self, rid, room, kind, now):
        self.store.insert({"first_id": rid, "room_id": room, "kind": kind, "opened_at": now, "last_paged_at": None, "page_count": 0,
                           "suppressed_count": 0, "acked_by": None, "acked_at": None, "closed_at": None, "close_reason": None})

    def close_room(self, bus, room, reason, kind=None):
        for c in self.store.list_open():
            if c["room_id"] == room and (kind is None or c["kind"] == kind):
                self.store.update(c["first_id"], closed_at=self.clock(), close_reason=reason)
                self.local["v_sent"].pop(str(c["first_id"]), None)
                self._say(bus, c, f"ROOM ALERT {c['kind']} CLOSED ({reason}) after {self._age_min(c)} min", "normal",
                          f"Case room-alert-{c['first_id']} closed: {reason}. Pages sent {c['page_count']}, duplicates folded {c['suppressed_count']}.")
        self._save()

    # ---- paging
    def _age_min(self, c):
        return int((self.clock() - c["opened_at"]) // 60)

    def _say(self, bus, c, subject, priority, body, marker=""):
        bus.post(f"{subject}{marker}"[:120], body[:4000], priority, f"room-alert-{c['first_id']}")

    def _page(self, bus, c, label, v=False):
        n = c["page_count"] + 1
        marker = f" [page {n}]"
        tid = f"room-alert-{c['first_id']}"
        already = any(marker in str(m.get("subject", "")) for m in bus.thread_messages(tid))
        if not already:
            vtag = " V" if v else ""
            src = " source=mini." if c["first_id"] >= LOCAL_ID_BASE else ""
            body = (f"{c['kind']} in {label}.{src} Case room-alert-{c['first_id']}, open {self._age_min(c)} min, page {n}, duplicates folded "
                    f"{c['suppressed_count']}. Reply 'ACK room-alert-{c['first_id']}' to stop re-pages.")
            if v:
                body = "V: patient-impacting and open past the V threshold. gating-lead tells V. " + body
            pri = "urgent" if c["kind"] in URGENT else "normal"
            bus.post(f"ROOM ALERT{vtag} {c['kind']}: {label}{marker}"[:120], body, pri, tid)
        self.store.update(c["first_id"], last_paged_at=self.clock(), page_count=n)

    def tick(self, bus=None):
        """One cycle: read acks, re-page, V notices, the 21:00 list. Returns a count dict (for logs and tests)."""
        own = bus is None
        bus = bus or self.bus_factory()
        out = {"acked": 0, "paged": 0, "v": 0, "digest": 0}
        try:
            now = self.clock()
            for c in self.store.list_open():
                if not c["acked_at"] and self._read_ack(bus, c):
                    out["acked"] += 1
            for c in self.store.list_open():
                age = now - c["opened_at"]
                if not c["acked_at"]:
                    gap = REPAGE_CLINIC_S if is_clinic(now) else REPAGE_OFF_S
                    if c["last_paged_at"] is None or now - c["last_paged_at"] >= gap:
                        v = self._v_due(c, age, now, mark=True)
                        self._page(bus, c, c["room_id"], v=v)
                        out["paged"] += 1
                        out["v"] += 1 if v else 0
                        continue
                if self._v_due(c, age, now, mark=True):
                    self._say(bus, c, f"ROOM ALERT V {c['kind']}: {c['room_id']} open {int(age // 60)} min", "urgent",
                              f"V: patient-impacting, {'acked but' if c['acked_at'] else 'unacked,'} not recovered. gating-lead tells V. Case room-alert-{c['first_id']}.")
                    out["v"] += 1
            out["digest"] = self._digest(bus, now)
            self._save()
        finally:
            if own and hasattr(bus, "close"):
                bus.close()
        return out

    def _v_due(self, c, age, now, mark):
        if c["kind"] not in V_KINDS or not is_clinic(now) or age < V_FIRST_S:
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

    def _read_ack(self, bus, c):
        for m in bus.thread_messages(f"room-alert-{c['first_id']}"):
            sender = str(m.get("from", ""))
            text = f"{m.get('subject', '')} {m.get('body', '')}".strip()
            mt = _ACK_RE.match(text)
            if sender in ACKERS and mt and int(mt.group(1)) == c["first_id"]:
                self.store.update(c["first_id"], acked_by=sender, acked_at=self.clock())
                return True
        return False

    # ---- end-of-day list
    def unacked_list(self):
        return [f"room-alert-{c['first_id']} {c['kind']} {c['room_id']} open {self._age_min(c)} min, pages {c['page_count']}"
                for c in self.store.list_open() if not c["acked_at"]]

    def _digest(self, bus, now):
        ist = datetime.fromtimestamp(now, IST)
        day = ist.strftime("%Y-%m-%d")
        if ist.hour < DIGEST_HOUR_IST or self.local["digest_day"] == day:
            return 0
        lines = self.unacked_list()
        self.local["digest_day"] = day
        if lines:
            bus.post(f"ROOM ALERTS unacked at 21:00: {len(lines)}", "\n".join(lines)[:4000], "normal", f"room-alert-digest-{day}")
        return 1 if lines else 0


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

    def next_local_id(self):
        """An id for a Mini-detected case: above every id seen, never below LOCAL_ID_BASE."""
        r = self.db.execute("SELECT MAX(first_id) FROM room_alert_case").fetchone()[0]
        return max(r or 0, LOCAL_ID_BASE) + 1

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
