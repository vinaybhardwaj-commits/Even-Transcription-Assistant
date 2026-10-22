"""alert_router.py -- durable room-alert router (FR-1 C4, A6 design). Pure logic; the clock, store and bus are injected.

A CASE is one open alert for (room, kind). Opened by the first outbox row, paged at once, reminded at most once per REMIND_S (clinic hours
and outside alike, FR1 D7), until a person acks ("ACK room-alert-<first_id>" on the bus, sent by gating-lead or fleet). Ack stops
reminders; the case stays open until recovery closes it. The first ack or close of a paged case sends ONE "cleared" line. A duplicate row while open bumps suppressed_count; a late duplicate after
close opens a new case.

R2 (Phase 0 fix round): opening and closing a case NEVER touches the bus. on_row only writes the store; close_room writes the store and queues a
note (store.add_note). All sending happens in tick(): ONE ubus send per tick carries every due page, reminder, cleared line and V notice, on the day
thread room-alert-batch-<YYYY-MM-DD> (IST). ubus caps sends per machine, so one send per tick is the budget. A failed send leaves every
case state untouched, so the pages are simply due again on the next tick, and it never blocks the digest, the routed-id prune or the ack read.

Crash rule: each page line carries "room-alert-<id> ... [page N]". Before posting, the router reads the day thread; a page whose marker is
already there is only written to the store. So a crash between post and state write gives neither a duplicate page nor a lost alert.
The marker read covers today's AND yesterday's day thread, so a page posted just before IST midnight is not paged again just after it.
ACKs are read from the day threads (today and yesterday) and from each case's own thread room-alert-<first_id>. FR1 D7: only for a case this
router has paged, at most once per ACK_READ_S per case; a forbidden / not_registered answer is "no ack yet" and backs the case off to
ACK_DENIED_S. The next-read times are kept IN MEMORY (a restart reads each paged case once more at most).

The 21:00 list ("digest") rides in the same batch send, as one block: header line, one line per unacked case (capped), and once per calendar month
a size line for backup/_to_delete. The block is atomic: if it does not fit the body cap, or the send fails, it stays due for the next tick.
FR1 D7: queued notes are sent ONLY with the digest (after the block, as many as fit); a note is dropped once a sent digest carried it. Notes that
did not fit go out on the next ticks of the same evening ("ROOM DIGEST <date> (cont.)"); notes queued after the digest wait for the next one.

Store interface (see SqliteStore): get_open(room, kind) -> case|None, list_open(), insert(case), update(first_id, **f), add_note(text, now),
list_notes(), drop_notes(ids).
Bus interface: post(subject, body, priority, thread_id), thread_messages(thread_id) -> [{"from","subject","body"}].
"""
import re
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
ACKERS = {"gating-lead", "fleet"}
REMIND_S = 7200                  # FR1 D7: one reminder per 2 h while a case stays open and unacked, in clinic hours and outside
ACK_READ_S, ACK_DENIED_S = 120, 600     # FR1 D7: ack reads per paged case; a forbidden / not_registered answer backs that case off
CA_KINDS = {"capture_dead", "capture_muted", "coreaudio_heal_failed", "recorder_disturbed"}     # coreaudio heal rule alerts (kiosk kiosk/<room>/heal lines)
USB_KINDS = {"usb_reboot_failed", "usb_power_off_recurring"}        # FR1 2.4 d': URGENT V kinds, the V window of the coreaudio kinds, ACK closes; usb_device_missing is URGENT only
START_DAY_KINDS = {"start_day_failed"}      # FR1 2.4 d': URGENT, V kind, same V window as the coreaudio kinds
CANARY_V_KINDS = {"canary_failed"}           # FR1-C5 canary (no_local_rise): URGENT, V kind, the coreaudio window, the same targets as capture_dead
CANARY_KINDS = CANARY_V_KINDS | {"canary_inconclusive", "canary_output_absent"}    # inconclusive: NORMAL tier; output_absent on 2 nights in a row: URGENT, not V
CA_WINDOW_MIN = (7 * 60, 21 * 60 + 35)      # gate CA-C3: V flag for the coreaudio kinds inside 07:00-21:35 IST, every day of the week
INBOX_DEADLINE_S = 300                       # a queued HEAL action line not appended to INBOX-FROM-GATING.md within 5 min raises heal_inbox_stuck
V_KINDS = {"recorder_off", "fleet_outage", "no_machine", "install_retired"} | CA_KINDS | START_DAY_KINDS | USB_KINDS | CANARY_V_KINDS            # patient-impacting (A6 finding 7)
V_FIRST_S, V_REMINDER_S = 1800, 3600
CLINIC_START_MIN, CLINIC_END_MIN, CLINIC_DAYS = 7 * 60 + 30, 21 * 60 + 30, (1, 2, 3, 4, 5, 6)   # mirrors lib/alerts/clinic-hours.ts
DIGEST_HOUR_IST = 21
ROUTED_KEEP_S = 7 * 86400
URGENT = {"offline", "degraded", "fleet_outage", "install_retired", "recorder_off", "mic_denied", "no_machine", "room_disabled",
          "needs_enrol", "capture_stalled", "guardian_quiet", "heal_escalated", "backup_failed", "heal_inbox_stuck", "usb_device_missing", "canary_output_absent"} | CA_KINDS | START_DAY_KINDS | USB_KINDS | CANARY_V_KINDS
OPEN_KINDS = URGENT | {"heal_message_invalid", "consult_hold_source_down", "canary_inconclusive"}          # kinds that open a case; 'recovered' and 'session_reaped' never do
# An ACK also CLOSES these (order: "closes on recovery or ACK"). recorder_changed and heal_message_invalid have no recovery signal, so ACK is their only close.
ACK_CLOSE_KINDS = CA_KINDS | START_DAY_KINDS | USB_KINDS | {"usb_device_missing"} | {"heal_message_invalid", "consult_hold_source_down"} | CANARY_KINDS
RECOVERY_KIND = "recovered"
ACK_ONLY_KINDS = {"recorder_disturbed", "heal_message_invalid", "start_day_failed"} | USB_KINDS     # a server `recovered` row never closes these: only an ACK does
RECOVERY_KEEP_KINDS = ACK_ONLY_KINDS | {"usb_device_missing"} | CANARY_KINDS        # nor this one: it closes only on a health line with usb_mic_present true (or an ACK does not close it either)
_ACK_RE = re.compile(r"^ACK\s+room-alert-(\d+)\b", re.I)
_ID_RE = re.compile(r"room-alert-(\d+)\b", re.I)
_MARK_RE = re.compile(r"room-alert-(\d+) .*\[page (\d+)\]")
_CLEAR_RE = re.compile(r"room-alert-(\d+) .*\[cleared\]")
NOTE_CAP = 500


def _denied(e):
    """forbidden / not_registered from a thread read (ubus_bus.UbusDenied, or the bare error text from another bus)."""
    t = str(e)
    if getattr(e, "denied", False) or "forbidden" in t or "not_registered" in t:
        return "not_registered" if "not_registered" in t else "forbidden"
    return None
BATCH_PREFIX = "room-alert-batch-"
BODY_CAP = 3800


def batch_tid(now):
    return BATCH_PREFIX + datetime.fromtimestamp(now, IST).strftime("%Y-%m-%d")


def is_v_window(kind, now):
    """The window in which a V-kind may raise a V notice: the coreaudio kinds use CA-C3's 07:00-21:35 IST; every other kind the general clinic hours."""
    if kind in CA_KINDS or kind in START_DAY_KINDS or kind in USB_KINDS or kind in CANARY_V_KINDS:
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
    log_fn = None            # set by run_router.py (staticmethod(log)): metadata lines only, never message text
    def __init__(self, store, bus_factory, clock, state_path=None, size_line_fn=None):
        self.store, self.bus_factory, self.clock = store, bus_factory, clock
        self.state_path = state_path
        self.size_line_fn = size_line_fn          # () -> str | None: the monthly _to_delete size line; None or an error means no line
        self.local = {"v_sent": {}, "digest_day": "", "size_month": "", "cleared": {}, "clear_since": None, "digest_note_upto": 0}
        self._ack_next, self._denied_logged = {}, set()     # FR1 D7: in memory only
        self._load()
        if self.local["clear_since"] is None:          # first run of the D7 code: no cleared lines for cases that cleared before it
            self.local["clear_since"] = float(self.clock())

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
                    if isinstance(d.get("cleared"), dict):
                        self.local["cleared"] = {str(k): float(v) for k, v in d["cleared"].items()}
                    if isinstance(d.get("clear_since"), (int, float)):
                        self.local["clear_since"] = float(d["clear_since"])
                    if isinstance(d.get("digest_note_upto"), int):
                        self.local["digest_note_upto"] = d["digest_note_upto"]
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
                self.close_room(bus, room, "recovery", keep=RECOVERY_KEEP_KINDS)
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

    def close_room(self, bus, room, reason, kind=None, keep=()):
        for c in self.store.list_open():
            if c["room_id"] == room and (kind is None or c["kind"] == kind) and c["kind"] not in keep:
                self.store.update(c["first_id"], closed_at=self.clock(), close_reason=reason)
                self.local["v_sent"].pop(str(c["first_id"]), None)
                self.store.add_note(f"room-alert-{c['first_id']} {c['kind']} in {room} CLOSED ({reason}) after {self._age_min(c)} min. "
                                    f"Pages sent {c['page_count']}, duplicates folded {c['suppressed_count']}.", self.clock())
        self._save()

    # ---- paging
    def _age_min(self, c):
        return int((self.clock() - c["opened_at"]) // 60)

    def _flush(self, bus, now, pages, vcases, cleared, msgs, out, digest=None):
        """One send for everything due. State is written only after the send succeeded. `digest` is (unacked cases, size lines, day, month|None,
        notes, continuation) or None."""
        tid = batch_tid(now)
        done, cdone = set(), set()
        if pages or cleared:                                   # the crash markers matter only for page and cleared lines
            for mt_tid in (tid, batch_tid(now - 86400)):      # yesterday's thread too: a page posted before IST midnight is not repeated after it
                for m in msgs(mt_tid):
                    for line in f"{m.get('subject', '')}\n{m.get('body', '')}".splitlines():
                        mt = _MARK_RE.search(line)
                        if mt:
                            done.add((int(mt.group(1)), int(mt.group(2))))
                        mc = _CLEAR_RE.search(line)
                        if mc:
                            cdone.add(int(mc.group(1)))
        lines, send, already = [], [], []
        for c, v in pages:
            n = c["page_count"] + 1
            if (c["first_id"], n) in done:
                already.append((c, n)); continue
            src = " source=mini." if c["first_id"] >= LOCAL_ID_BASE else ""
            line = (f"room-alert-{c['first_id']} {c['kind']} in {c['room_id']}.{src} open {self._age_min(c)} min, duplicates folded "
                    f"{c['suppressed_count']}. [page {n}]" + (" V: patient-impacting, past the V threshold. gating-lead tells V." if v else ""))
            lines.append(line); send.append((c, n, v))
        clines, cleared_already = [], []
        for c in cleared:
            if c["first_id"] in cdone:
                cleared_already.append(c); continue
            ended = c["closed_at"] or c["acked_at"]
            why = (f"CLOSED (acked by {c['acked_by']})" if c["close_reason"] == "acked" and c["acked_by"] else f"CLOSED ({c['close_reason']})") if c["closed_at"] \
                else f"ACKED by {c['acked_by']}"
            clines.append((c, f"room-alert-{c['first_id']} {c['kind']} in {c['room_id']} cleared: {why} after {int((ended - c['opened_at']) // 60)} min. "
                              f"Pages sent {c['page_count']}. [cleared]"))
        vlines = [(c, f"V room-alert-{c['first_id']} {c['kind']} in {c['room_id']} open {self._age_min(c)} min, "
                      f"{'acked but' if c['acked_at'] else 'unacked,'} not recovered. gating-lead tells V.") for c in vcases]
        # trim to the body cap: what does not fit stays due for the next tick
        head = "Reply 'ACK room-alert-<id>' (one line per case) in this thread to stop reminders.\n" if send else ""
        budget = BODY_CAP - len(head)
        keep_pages, keep_clear, keep_v, used = [], [], [], 0
        for (c, n, v), line in zip(send, lines):
            if used + len(line) + 1 <= budget: keep_pages.append((c, n, v, line)); used += len(line) + 1
        for c, line in clines:
            if used + len(line) + 1 <= budget: keep_clear.append((c, line)); used += len(line) + 1
        for c, line in vlines:
            if used + len(line) + 1 <= budget: keep_v.append((c, line)); used += len(line) + 1
        keep_digest, keep_notes = None, []
        if digest:                                            # last in line: pages, cleared lines and V notices come first; the digest block is atomic
            paged_now = {c["first_id"]: n for c, n, _v, _l in keep_pages}
            paged_now.update({c["first_id"]: n for c, n in already})
            dlines = self._render_digest(digest[0], digest[1], paged_now)
            dtext = "\n".join(dlines)
            if used + len(dtext) + 1 <= budget:
                keep_digest = (dlines, digest[2], digest[3]); used += len(dtext) + 1
                hdr = f"Notes since the last digest ({len(digest[4])}):" if not digest[5] else f"Notes, continued ({len(digest[4])}):"
                used += len(hdr) + 1
                for nid, text in digest[4]:                   # the notes ride only with the digest: as many as fit, the rest on the next ticks
                    text = text[:NOTE_CAP]
                    if used + len(text) + 1 <= budget: keep_notes.append((nid, text)); used += len(text) + 1
                if keep_notes:
                    keep_digest = (dlines + [hdr] + [t for _, t in keep_notes], digest[2], digest[3])
                elif not dlines:                              # a continuation with nothing that fits: nothing to send
                    keep_digest = None
        if keep_pages or keep_clear or keep_v or keep_digest:
            body = head + "\n".join([l for *_, l in keep_pages] + [l for _, l in keep_clear] + [l for _, l in keep_v]
                                    + (list(keep_digest[0]) if keep_digest else []))
            nv = len(keep_v) + sum(1 for *_, v, _l in keep_pages if v)
            dname = f"ROOM DIGEST {digest[2]}" + (" (cont.)" if digest[5] else "") if keep_digest else ""
            if keep_pages or keep_clear or keep_v:
                subject = (f"ROOM ALERT: {sum(1 for _c, n, *_ in keep_pages if n == 1)} new, {len(keep_clear)} cleared, "
                           f"{sum(1 for _c, n, *_ in keep_pages if n > 1)} reminder(s)" + (f", {nv} V" if nv else "") + (f"; {dname}" if dname else ""))[:120]
            else:
                subject = dname
            urgent = any(c["kind"] in URGENT for c, *_ in keep_pages) or bool(keep_v)
            bus.post(subject, body, "urgent" if urgent else "normal", tid)
        t = self.clock()
        for c, n, v, _l in keep_pages:
            self.store.update(c["first_id"], last_paged_at=t, page_count=n)
            if v:
                self._v_due(c, now - c["opened_at"], now, mark=True)
        for c, n in already:
            self.store.update(c["first_id"], last_paged_at=t, page_count=n)
        for c in [c for c, _l in keep_clear] + cleared_already:
            self.local["cleared"][str(c["first_id"])] = t
        for c, _l in keep_v:
            self._v_due(c, now - c["opened_at"], now, mark=True)
        if keep_notes:
            self.store.drop_notes([nid for nid, _ in keep_notes])
        if keep_digest:
            if not digest[5]:
                self.local["digest_day"] = keep_digest[1]
                self.local["digest_note_upto"] = max([nid for nid, _ in digest[4]] or [0])
                if keep_digest[2]:
                    self.local["size_month"] = keep_digest[2]
            out["digest"] += 1
        out["paged"] += len(keep_pages) + len(already); out["v"] += len(keep_v) + sum(1 for *_, v, _l in keep_pages if v)
        out["cleared"] += len(keep_clear) + len(cleared_already)
        out["notes"] += len(keep_notes)

    def _log(self, msg):
        if self.log_fn:
            try:
                self.log_fn(msg)
            except Exception:
                pass

    def tick(self, bus=None):
        """One cycle: read acks (paged cases only, throttled), then ONE send for every due page / reminder / cleared line / V notice, and the 21:00
        list with the queued notes. Each stage is isolated: a bus failure in one never stops the others. Returns a count dict (for logs and tests);
        out["errors"] counts failed stages."""
        own = bus is None
        bus = bus or self.bus_factory()
        out = {"acked": 0, "paged": 0, "v": 0, "digest": 0, "notes": 0, "cleared": 0, "errors": 0}
        cache = {}

        def read(tid):
            """(messages, denied reason or None) for one thread, read once per tick."""
            if tid not in cache:
                try:
                    cache[tid] = (list(bus.thread_messages(tid)), None)
                except Exception as e:
                    why = _denied(e)
                    if not why:
                        raise
                    cache[tid] = ([], why)
            return cache[tid]

        def msgs(tid):
            return read(tid)[0]
        try:
            now = self.clock()
            opens = self.store.list_open()
            try:
                for c in opens:
                    fid = c["first_id"]
                    if c["acked_at"] or c["last_paged_at"] is None or now < self._ack_next.get(fid, 0):
                        continue                              # D7: never read a case this router has not paged; at most once per ACK_READ_S
                    self._ack_next[fid] = now + ACK_READ_S
                    acked, why = self._read_ack(c, now, read)
                    if acked:
                        out["acked"] += 1
                    elif why:
                        self._ack_next[fid] = now + ACK_DENIED_S
                        if fid not in self._denied_logged:
                            self._denied_logged.add(fid)
                            self._log(f"ack read {why}: case room-alert-{fid}, next read in {ACK_DENIED_S}s")
            except Exception as e:
                out["errors"] += 1; out["error"] = f"ack read: {e.__class__.__name__}"
            pages, vcases = [], []
            for c in self.store.list_open():
                age = now - c["opened_at"]
                if not c["acked_at"]:
                    if c["last_paged_at"] is None or now - c["last_paged_at"] >= REMIND_S:
                        pages.append((c, self._v_due(c, age, now, mark=False)))
                        continue
                if self._v_due(c, age, now, mark=False):
                    vcases.append(c)
            cleared = []
            try:
                cleared = self._cleared_due(now)
            except Exception as e:
                out["errors"] += 1; out["error"] = f"cleared: {e.__class__.__name__}"
            digest = None
            try:
                digest = self._digest_block(now)
            except Exception as e:
                out["errors"] += 1; out["error"] = f"digest: {e.__class__.__name__}"
            if pages or vcases or cleared or digest:
                try:
                    self._flush(bus, now, pages, vcases, cleared, msgs, out, digest)
                except Exception as e:
                    out["errors"] += 1; out["error"] = f"send: {e.__class__.__name__}: {str(e)[:80]}"
            try:
                self.store.prune_routed(now - ROUTED_KEEP_S)
            except Exception as e:
                out["errors"] += 1; out["error"] = f"prune: {e.__class__.__name__}"
            self._prune_local(now)
            self._save()
            self._inbox_stage(now, out)
        finally:
            if own and hasattr(bus, "close"):
                bus.close()
        return out

    def _cleared_due(self, now):
        """Paged cases whose first ack or close has no cleared line yet. Only events after clear_since (the first D7 run) and inside ROUTED_KEEP_S."""
        since = max(self.local["clear_since"] or 0.0, now - ROUTED_KEEP_S)
        cands = [c for c in self.store.list_open() if c["acked_at"]]
        if hasattr(self.store, "list_closed_since"):
            cands += self.store.list_closed_since(since)
        return [c for c in cands if c["page_count"] > 0 and str(c["first_id"]) not in self.local["cleared"] and (c["closed_at"] or c["acked_at"]) >= since]

    def _prune_local(self, now):
        try:
            open_ids = {str(c["first_id"]) for c in self.store.list_open()}
        except Exception:
            return
        for k in [k for k, t in self.local["cleared"].items() if t < now - ROUTED_KEEP_S and k not in open_ids]:
            del self.local["cleared"][k]
        for fid in [f for f in self._ack_next if str(f) not in open_ids]:
            self._ack_next.pop(fid, None)

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

    def _read_ack(self, c, now, read):
        """(acked, denied reason or None). `read(tid)` -> (messages, denied reason or None)."""
        tids = [f"room-alert-{c['first_id']}", batch_tid(now), batch_tid(now - 86400)]
        why = None
        for tid in tids:
            ms, d = read(tid)
            why = why or d
            for m in ms:
                sender = str(m.get("from", ""))
                if sender in ACKERS and c["first_id"] in self.ack_ids(m):
                    t = self.clock()
                    self.store.update(c["first_id"], acked_by=sender, acked_at=t)
                    if c["kind"] in ACK_CLOSE_KINDS:
                        self.store.update(c["first_id"], closed_at=t, close_reason="acked")
                        self.local["v_sent"].pop(str(c["first_id"]), None)
                        self.store.add_note(f"room-alert-{c['first_id']} {c['kind']} in {c['room_id']} CLOSED (acked by {sender}) after {self._age_min(c)} min. "
                                            f"Pages sent {c['page_count']}, duplicates folded {c['suppressed_count']}.", t)
                    return True, why
        return False, why

    # ---- end-of-day list
    def unacked_cases(self):
        return [c for c in self.store.list_open() if not c["acked_at"]]

    def _unacked_line(self, c, pages=None):
        return f"room-alert-{c['first_id']} {c['kind']} {c['room_id']} open {self._age_min(c)} min, pages {c['page_count'] if pages is None else pages}"

    def unacked_list(self):
        return [self._unacked_line(c) for c in self.unacked_cases()]

    def _render_digest(self, cases, tail, paged_now):
        """The digest lines. `paged_now` = {first_id: page_count after this send}: a case paged in the same batch shows the count that batch makes it (S1: it was one behind)."""
        block = []
        if cases:
            block.append(f"ROOM ALERTS unacked at 21:00: {len(cases)}")
            block.extend(self._unacked_line(c, paged_now.get(c["first_id"])) for c in cases[:self.DIGEST_LINES_CAP])
            if len(cases) > self.DIGEST_LINES_CAP:
                block.append(f"... and {len(cases) - self.DIGEST_LINES_CAP} more")
        return block + list(tail)

    DIGEST_LINES_CAP = 30

    def _digest_block(self, now):
        """The 21:00 block for this day, or None (not yet 21:00, already sent today, or nothing to say). Returns (unacked cases, size lines, day, month|None,
        notes, continuation); _flush renders it (see _render_digest) and records the day and month only after the batch send succeeded. The size lines (backup,
        data and logs _to_delete) go out with the first digest run of each calendar month; size_line_fn may return one string or a list of strings.
        After the day's digest went out, notes it could not carry (ids up to digest_note_upto) come back as a continuation on the same evening."""
        ist = datetime.fromtimestamp(now, IST)
        day, month = ist.strftime("%Y-%m-%d"), ist.strftime("%Y-%m")
        if ist.hour < DIGEST_HOUR_IST:
            return None
        if self.local["digest_day"] == day:
            left = [n for n in self.store.list_notes() if n[0] <= self.local["digest_note_upto"]]
            return ([], [], day, None, left, True) if left else None
        cases, tail = self.unacked_cases(), []
        size_month = None
        if self.size_line_fn and self.local["size_month"] != month:
            try:
                sl = self.size_line_fn()
            except Exception:
                sl = None
            tail = [x for x in ([sl] if isinstance(sl, str) else list(sl or [])) if x]
            if tail:
                size_month = month
        notes = self.store.list_notes()
        if not cases and not tail and not notes:
            self.local["digest_day"] = day          # nothing to say today: do not look again until tomorrow
            self.local["digest_note_upto"] = 0
            return None
        return cases, tail, day, size_month, notes, False


def guardian_size_lines(home):
    """The three _to_delete size lines the monthly digest carries (backup, data, logs); a folder that is not there is left out."""
    import os
    lines = [folder_size_line(os.path.join(home, *sub), f"{'/'.join(sub)}") for sub in (("backup", "_to_delete"), ("data", "_to_delete"), ("logs", "_to_delete"))]
    return [x for x in lines if x]


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

    def list_closed_since(self, since):
        return [dict(r) for r in self.db.execute("SELECT * FROM room_alert_case WHERE closed_at IS NOT NULL AND closed_at >= ? AND page_count > 0 ORDER BY first_id", (since,))]

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
        """Online copy via the sqlite backup API (safe with WAL). Keeps the newest `keep` files named cases-YYYYMMDD-HHMMSS.sqlite; older ones are MOVED to _to_delete/."""
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
        for f in files[:-keep]:                  # no hard deletes: rotation moves the oldest to <dest_dir>/_to_delete/, a name clash gets a numeric suffix
            os.makedirs(os.path.join(dest_dir, "_to_delete"), exist_ok=True)
            target = os.path.join(dest_dir, "_to_delete", f)
            n = 0
            while os.path.exists(target):
                n += 1; target = os.path.join(dest_dir, "_to_delete", f"{f}.{n}")
            os.rename(os.path.join(dest_dir, f), target)
        return dest


def default_store(home):
    import os
    return SqliteStore(os.path.join(home, "data", "cases.sqlite"))
