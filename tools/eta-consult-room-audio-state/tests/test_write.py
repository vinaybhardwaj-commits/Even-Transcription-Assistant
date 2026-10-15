"""Writer tests use a mocked connection/cursor. Nothing here touches the live tables or reads the credential."""
import contextlib
import ras_write as w
from ras.classify import IST
from datetime import datetime


class Cur:
    def __init__(self, conn):
        self.c = conn

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.c.log.append(("exec", sql.split()[0].upper(), params))
        self.last = sql

    def executemany(self, sql, rows):
        self.c.log.append(("many", sql.split()[0].upper(), list(rows)))

    def fetchone(self):
        return self.c.check_result


class Conn:
    def __init__(self, check_result=(True, 2)):
        self.log, self.check_result, self.committed, self.rolled_back = [], check_result, 0, 0

    def cursor(self):
        return Cur(self)

    @contextlib.contextmanager
    def transaction(self):
        try:
            yield
            self.committed += 1
        except Exception:
            self.rolled_back += 1
            raise


def iv(state, a, b, day="2026-10-03"):
    t = lambda x: datetime.fromtimestamp(x, IST).isoformat(timespec="milliseconds")
    return {"ist_day": day, "state": state, "ts_start": t(a), "ts_end": t(b), "_a": a, "_b": b, "evidence": {"x": 1}}


D0 = datetime(2026, 10, 3, tzinfo=IST).timestamp()


def room_day(n=2):
    return {"room_id": "room_a", "ist_day": "2026-10-03",
            "rows": [("room_a", None, "kiosk", "2026-10-03", "recorder_off", "s", "e", "{}", "v")] * n,
            "day": {"room_id": "room_a", "ist_day": "2026-10-03", "classifier_version": "v", **{c: 0 for c in w.DAY_COLS},
                    "consult_min_usable": 0, "consult_min_uncertain": 0, "consult_min_lost": 0, "n_consults": 0}}


def test_transaction_order_and_commit():
    c = Conn()
    assert w.write_room_day(c, room_day()) is True
    kinds = [(k, s) for k, s, _ in c.log]
    assert kinds == [("exec", "DELETE"), ("many", "INSERT"), ("exec", "WITH"), ("exec", "INSERT")]
    assert c.committed == 1 and c.rolled_back == 0
    assert c.log[0][2] == ("room_a", "2026-10-03")


def test_guard_failure_rolls_back_and_skips_upsert():
    c = Conn(check_result=(False, 2))
    assert w.write_room_day(c, room_day()) is False
    assert c.rolled_back == 1 and c.committed == 0
    assert all(not (k == "exec" and s == "INSERT") for k, s, _ in c.log)       # no UPSERT after a failed guard


def test_row_count_mismatch_rolls_back():
    c = Conn(check_result=(True, 5))
    assert w.write_room_day(c, room_day(2)) is False and c.rolled_back == 1


def test_db_error_rolls_back_and_log_has_no_credential(caplog):
    c = Conn()
    c.cursor = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
    with caplog.at_level("ERROR"):
        assert w.write_room_day(c, room_day()) is False
    assert "ROLLBACK room_a 2026-10-03" in caplog.text and "postgres" not in caplog.text


def test_check_sql_asserts_contiguity_total_and_span():
    s = w.CHECK_SQL
    assert "= 86400" in s and "prev_end = ts_start" in s and "Asia/Kolkata" in s and "min(ts_start)" in s and "max(ts_end)" in s


def test_split_minutes_sums_to_1440():
    m = w.split_minutes({"min_off": 600.4 * 60, "min_present": 839.6 * 60})
    assert sum(m.values()) == 1440 and set(m) == set(w.DAY_COLS)
    m = w.split_minutes({"min_off": 86400.0})
    assert m["min_off"] == 1440
    m = w.split_minutes({"min_off": 1440 * 60 / 3, "min_muted": 1440 * 60 / 3, "min_present": 1440 * 60 / 3})
    assert sum(m.values()) == 1440


def test_consult_minutes_usable_uncertain_lost_and_withheld_excluded():
    ivs = [iv("audio_present", D0, D0 + 3600), iv("audio_gated", D0 + 3600, D0 + 7200),
           iv("muted", D0 + 7200, D0 + 9000), iv("recorder_off", D0 + 9000, D0 + 10800),
           iv("withheld", D0 + 10800, D0 + 14400)]
    wins = [(D0 + 3000, D0 + 4200), (D0 + 8400, D0 + 9600), (D0 + 11000, D0 + 12000)]
    u, g, l = w.consult_minutes(ivs, wins)
    assert (u, g, l) == (10, 10, 20)       # 10 on present, 10 on gated, 10 muted + 10 off = 20 lost; withheld excluded


def test_source_rule():
    assert w.source_for("ot-3-x79h") == "ot" and w.source_for("orb3-29ac") == "ot"
    assert w.source_for("opd-1-xqj7") == "kiosk" and w.source_for("home-office-w8fb") == "kiosk"


def test_build_room_days_rows_and_day_row():
    ivs = [iv("audio_present", D0, D0 + 43200), iv("recorder_off", D0 + 43200, D0 + 86400)]
    rds = w.build_room_days({"room_a": ivs}, {"room_a": [(D0 + 600, D0 + 1200)]}, {"room_a": "M"}, {"room_a": "opd-1"})
    assert len(rds) == 1
    rd = rds[0]
    assert rd["day"]["min_present"] == 720 and rd["day"]["min_off"] == 720 and rd["day"]["n_consults"] == 1
    assert rd["day"]["consult_min_usable"] == 10
    assert rd["rows"][0][:5] == ("room_a", "M", "kiosk", "2026-10-03", "audio_present")
    assert sum(rd["day"][c] for c in w.DAY_COLS) == 1440


def test_window_belongs_to_the_day_it_opens_and_filters_days():
    ivs = [iv("audio_present", D0, D0 + 86400), iv("audio_present", D0 + 86400, D0 + 2 * 86400, day="2026-10-04")]
    wins = [(D0 + 86400 - 600, D0 + 86400 + 600)]          # opens 23:50 on the 3rd, closes 00:10 on the 4th
    rds = w.build_room_days({"r": ivs}, {"r": wins}, {}, {"r": "s"}, days={"2026-10-03"})
    assert [r["ist_day"] for r in rds] == ["2026-10-03"] and rds[0]["day"]["n_consults"] == 1
    assert rds[0]["day"]["consult_min_usable"] == 20       # whole window is counted on the day it opened


def test_no_live_credential_use_in_tests():
    assert w.CRED.endswith("db.url")


class TxnConn(Conn):
    """Models psycopg's default (non-autocommit) behaviour: an implicit transaction opens on the first statement,
    and conn.transaction() inside it is only a savepoint. Room-days are durable only on a real commit."""

    def __init__(self, kill_on_room=None):
        super().__init__()
        self.autocommit, self.implicit, self.pending, self.durable = False, False, [], []
        self.kill_on_room, self.current = kill_on_room, None

    def commit(self):
        if self.implicit:
            self.durable += self.pending
            self.pending = []
        self.implicit = False

    def cursor(self):
        cur = Cur(self)
        orig = cur.execute

        def execute(sql, params=None):
            if not self.autocommit and not self.in_txn:
                self.implicit = True
            if sql.split()[0].upper() == "DELETE":
                self.current = params[0] + params[1]
                if self.kill_on_room and self.current == self.kill_on_room:
                    raise KeyboardInterrupt           # the run is killed in the middle of this room-day
            orig(sql, params)
        cur.execute = execute
        return cur

    in_txn = False

    @contextlib.contextmanager
    def transaction(self):
        top = self.autocommit and not self.implicit
        self.in_txn = True
        try:
            yield
        except Exception:
            self.in_txn = False
            raise
        self.in_txn = False
        (self.durable if top else self.pending).append(self.current)


def rds_n(n):
    out = []
    for i in range(n):
        rd = room_day()
        rd["room_id"], rd["ist_day"] = f"room_{i}", "2026-10-03"
        out.append(rd)
    return out


def test_killed_run_keeps_the_finished_room_days():
    import pytest
    c = TxnConn(kill_on_room="room_32026-10-03")           # killed during room-day 3 (index 3 of 0..4 -> after 3 done)
    c.cursor().execute("SELECT 1 FROM eta_encounter_windows")   # the windows read opens an implicit transaction
    w.begin_writes(c)
    with pytest.raises(KeyboardInterrupt):
        w.write_all(c, rds_n(5))
    assert c.durable == ["room_02026-10-03", "room_12026-10-03", "room_22026-10-03"]


def test_killed_after_room_day_2_leaves_1_and_2_committed():
    import pytest
    c = TxnConn(kill_on_room="room_22026-10-03")
    c.cursor().execute("SELECT 1 FROM eta_encounter_windows")
    w.begin_writes(c)
    with pytest.raises(KeyboardInterrupt):
        w.write_all(c, rds_n(5))
    assert c.durable == ["room_02026-10-03", "room_12026-10-03"]       # room-days 1 and 2 survive the kill


def test_control_without_begin_writes_a_killed_run_loses_everything():
    import pytest
    c = TxnConn(kill_on_room="room_22026-10-03")
    c.cursor().execute("SELECT 1 FROM eta_encounter_windows")           # implicit transaction left open (the old bug)
    with pytest.raises(KeyboardInterrupt):
        w.write_all(c, rds_n(5))
    assert c.durable == []


def test_begin_writes_commits_and_sets_autocommit():
    c = TxnConn()
    c.cursor().execute("SELECT 1")
    w.begin_writes(c)
    assert c.autocommit is True and c.implicit is False


def test_write_all_counts_commits_and_rollbacks():
    c = Conn()
    c.autocommit = True
    good, bad = w.write_all(c, rds_n(3))
    assert (good, bad) == (3, 0) and c.committed == 3
    c2 = Conn(check_result=(False, 2))
    assert w.write_all(c2, rds_n(2)) == (0, 2)
