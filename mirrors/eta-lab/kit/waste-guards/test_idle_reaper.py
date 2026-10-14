#!/usr/bin/env python3
"""Tests for the idle-reaper filters and the spec that quotes them.

The jq filter and the python filter are two implementations of one rule, so the
central test is that they agree byte-for-byte on the shipped fixture, and that
the markdown spec quotes both files exactly as they are on disk.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "idle_agents_fixture.json")
JQ_FILE = os.path.join(HERE, "idle_reaper.jq")
PY_FILE = os.path.join(HERE, "idle_reaper_filter.py")
SPEC = os.path.join(HERE, "idle-reaper-spec.md")
NOW_ISO = "2026-09-26T18:00:00Z"
NOW_EPOCH = 1790445600

_spec = importlib.util.spec_from_file_location("idle_reaper_filter", PY_FILE)
irf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(irf)

EXPECTED = [
    "claude\therdr:2.%0\t180.0\t1790434800",
    "fable\therdr:2.%1\t180.0\t1790434800000",
    "fable\therdr:2.%4\t180.0\t2026-09-26T15:00:00Z",
    "muse\therdr:2.%2\t180.0\t2026-09-26T20:30:00+05:30",
    "fable\therdr:0.%3\t120.0\t2026-09-26T16:00:00Z",
    "muse\therdr:0.%5\t61.0\t2026-09-26T16:59:00Z",
]


def read(path):
    with open(path) as fh:
        return fh.read()


def have_jq():
    return shutil.which("jq") is not None


def run_python(*argv, stdin=None):
    return subprocess.run([sys.executable, PY_FILE] + list(argv),
                          input=stdin, capture_output=True, text=True)


def run_jq(*extra, doc=FIXTURE):
    return subprocess.run(["jq", "-r", "-f", JQ_FILE, "--argjson", "NOW", str(NOW_EPOCH),
                           "--argjson", "MIN", "60"] + list(extra) + [doc],
                          capture_output=True, text=True)


class FiltersAgree(unittest.TestCase):
    def test_jq_matches_expected(self):
        if not have_jq():
            self.skipTest("jq not installed")
        proc = run_jq()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.splitlines(), EXPECTED)

    def test_python_matches_expected(self):
        proc = run_python(FIXTURE, "--now", NOW_ISO)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.splitlines(), EXPECTED)

    def test_jq_and_python_are_byte_identical(self):
        if not have_jq():
            self.skipTest("jq not installed")
        jq_out = run_jq().stdout
        py_out = run_python(FIXTURE, "--now", NOW_ISO).stdout
        self.assertEqual(jq_out, py_out)

    def test_bare_array_top_level_form(self):
        doc = json.loads(read(FIXTURE))
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(doc["agents"], fh)
            path = fh.name
        self.addCleanup(os.unlink, path)
        self.assertEqual(run_python(path, "--now", NOW_ISO).stdout.splitlines(), EXPECTED)
        if have_jq():
            self.assertEqual(run_jq(doc=path).stdout.splitlines(), EXPECTED)

    def test_panets_wrapper_key(self):
        doc = json.loads(read(FIXTURE))
        wrapped = {"panes": doc["agents"]}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(wrapped, fh)
            path = fh.name
        self.addCleanup(os.unlink, path)
        self.assertEqual(run_python(path, "--now", NOW_ISO).stdout.splitlines(), EXPECTED)

    def test_empty_document_yields_nothing(self):
        self.assertEqual(run_python("-", "--now", NOW_ISO, stdin='{"agents": []}').stdout, "")
        self.assertEqual(run_python("-", "--now", NOW_ISO, stdin="[]").stdout, "")

    def test_invalid_json_exits_2(self):
        proc = run_python("-", stdin="{not json")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("not valid JSON", proc.stderr)

    def test_missing_file_exits_2(self):
        self.assertEqual(run_python("/nonexistent/agents.json").returncode, 2)

    def test_jq_with_no_arguments_at_all(self):
        if not have_jq():
            self.skipTest("jq not installed")
        proc = subprocess.run(["jq", "-r", "-f", JQ_FILE, FIXTURE], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        panes = {a["pane"] for a in json.loads(read(FIXTURE))["agents"]}
        for line in proc.stdout.splitlines():
            self.assertIn(line.split("\t")[1], panes)

    def test_min_threshold_override(self):
        self.assertEqual(run_python(FIXTURE, "--now", NOW_ISO, "--minutes", "240").stdout, "")
        # at 30 min the 59-minute pane (a3) joins the six
        panes = [l.split("\t")[1] for l in
                 run_python(FIXTURE, "--now", NOW_ISO, "--minutes", "30").stdout.splitlines()]
        self.assertEqual(len(panes), 7)
        self.assertIn("herdr:0.%7", panes)


class RuleByRule(unittest.TestCase):
    """One test per decision rule, using the fixture row that exercises it."""

    def setUp(self):
        self.doc = json.loads(read(FIXTURE))
        self.by_id = {a["id"]: a for a in self.doc["agents"]}

    def verdict(self, agent_id, minutes=60):
        rows = irf.reapable([self.by_id[agent_id]], NOW_EPOCH, minutes)
        return [r["pane"] for r in rows]

    def test_plain_idle_pane_is_reaped(self):
        self.assertEqual(self.verdict("a1"), ["herdr:0.%3"])

    def test_just_over_threshold(self):
        self.assertEqual(self.verdict("a2"), ["herdr:0.%5"])

    def test_just_under_threshold_is_kept(self):
        self.assertEqual(self.verdict("a3"), [])

    def test_exactly_at_threshold_is_kept(self):
        agent = dict(self.by_id["a1"], last_activity="2026-09-26T17:00:00Z")
        rows = irf.reapable([agent], NOW_EPOCH, 60)
        self.assertEqual(rows, [])  # 60.0 min is not > 60

    def test_queued_work_keeps_the_pane(self):
        self.assertEqual(self.verdict("a4"), [])

    def test_inflight_task_keeps_the_pane(self):
        self.assertEqual(self.verdict("a5"), [])

    def test_protected_keeps_the_pane(self):
        self.assertEqual(self.verdict("a6"), [])

    def test_busy_state_keeps_the_pane(self):
        self.assertEqual(self.verdict("a7"), [])

    def test_missing_timestamp_keeps_the_pane(self):
        self.assertEqual(self.verdict("a8"), [])

    def test_waiting_for_input_keeps_the_pane(self):
        self.assertEqual(self.verdict("a15"), [])

    def test_hold_reason_keeps_the_pane(self):
        self.assertEqual(self.verdict("a16"), [])

    def test_queue_object_counts_as_queued(self):
        self.assertEqual(self.verdict("a12"), [])

    def test_depth_beats_empty_array(self):
        self.assertEqual(self.verdict("a14"), [])

    def test_camel_case_agent_is_reaped(self):
        self.assertEqual(self.verdict("a13"), ["herdr:2.%4"])

    def test_null_queue_is_empty(self):
        self.assertEqual(self.verdict("a11"), ["herdr:2.%2"])

    def test_epoch_and_offset_timestamps(self):
        self.assertEqual(self.verdict("a9"), ["herdr:2.%0"])
        self.assertEqual(self.verdict("a10"), ["herdr:2.%1"])


class UnitRules(unittest.TestCase):
    def test_parse_ts_variants(self):
        base = 1790434800  # 2026-09-26T15:00:00Z
        self.assertEqual(irf.parse_ts("2026-09-26T15:00:00Z"), base)
        self.assertEqual(irf.parse_ts("2026-09-26T15:00:00"), base)
        self.assertEqual(irf.parse_ts("2026-09-26 15:00:00Z"), base)
        self.assertEqual(irf.parse_ts("2026-09-26T15:00:00.123Z"), base)
        self.assertEqual(irf.parse_ts("2026-09-26T20:30:00+05:30"), base)
        self.assertEqual(irf.parse_ts("2026-09-26T10:00:00-0500"), base)
        self.assertEqual(irf.parse_ts(base), float(base))
        self.assertEqual(irf.parse_ts(base * 1000), float(base))
        self.assertEqual(irf.parse_ts(str(base * 1000)), float(base))

    def test_parse_ts_rejects_junk(self):
        for bad in (None, "", "   ", "yesterday", True, False, [], {}, "15/09/2026"):
            self.assertIsNone(irf.parse_ts(bad), bad)

    def test_queue_len(self):
        self.assertEqual(irf._queue_len({}), 0)
        self.assertEqual(irf._queue_len({"queue": None}), 0)
        self.assertEqual(irf._queue_len({"queue": []}), 0)
        self.assertEqual(irf._queue_len({"queue": [1, 2]}), 2)
        self.assertEqual(irf._queue_len({"queue": {}}), 0)
        self.assertEqual(irf._queue_len({"queue": {"t": 1}}), 1)
        self.assertEqual(irf._queue_len({"queue": "TASK 1"}), 1)
        self.assertEqual(irf._queue_len({"queue": [], "queue_depth": 3}), 3)
        self.assertEqual(irf._queue_len({"queue_depth": 0}), 0)
        self.assertEqual(irf._queue_len({"queueDepth": "2"}), 2)
        self.assertEqual(irf._queue_len({"queue": [1], "queue_depth": 0}), 1)

    def test_protected_flag_string_forms(self):
        for v in (True, 1, "yes", "waiting on V", "hold"):
            self.assertTrue(irf._protected({"hold": v}), v)
        for v in (False, 0, None, "", "false", "no", "none", "null", "off"):
            self.assertFalse(irf._protected({"hold": v}), v)
        self.assertFalse(irf._protected({}))

    def test_busy_states(self):
        for v in ("busy", "RUNNING", "in progress", "waiting_for_input", "Streaming"):
            self.assertTrue(irf._busy({"state": v}), v)
        for v in ("idle", "ready", "waiting", ""):
            self.assertFalse(irf._busy({"state": v}), v)
        self.assertFalse(irf._busy({}))

    def test_agents_of_shapes(self):
        self.assertEqual(irf.agents_of({"agents": [{"id": 1}]}), [{"id": 1}])
        self.assertEqual(irf.agents_of([{"id": 1}]), [{"id": 1}])
        self.assertEqual(irf.agents_of({"panes": [{"id": 2}]}), [{"id": 2}])
        self.assertEqual(irf.agents_of({"nope": 1}), [])
        self.assertEqual(irf.agents_of("garbage"), [])

    def test_ordering_is_stable_and_idle_desc(self):
        rows = irf.reapable(json.loads(read(FIXTURE)), NOW_EPOCH, 60)
        minutes = [r["idle_minutes"] for r in rows]
        self.assertEqual(minutes, sorted(minutes, reverse=True))
        self.assertEqual([r["agent"] for r in rows][:2], ["claude", "fable"])


class SpecStaysInSync(unittest.TestCase):
    """The spec quotes both filters verbatim; a stale quote must fail here."""

    def _blocks(self, lang):
        text = read(SPEC)
        return re.findall(r"^```%s\n(.*?)^```$" % lang, text, re.S | re.M)

    def test_spec_embeds_the_jq_filter_verbatim(self):
        blocks = [b for b in self._blocks("jq") if b.lstrip().startswith("def flag(")]
        self.assertEqual(len(blocks), 1, "expected exactly one jq filter block in the spec")
        self.assertEqual(blocks[0].rstrip("\n"), read(JQ_FILE).rstrip("\n"))

    def test_spec_embeds_the_python_filter_verbatim(self):
        blocks = [b for b in self._blocks("python") if b.startswith("#!/usr/bin/env python3")]
        self.assertEqual(len(blocks), 1, "expected exactly one python filter block in the spec")
        self.assertEqual(blocks[0].rstrip("\n"), read(PY_FILE).rstrip("\n"))

    def test_spec_shows_the_verified_output(self):
        text = read(SPEC)
        block = re.search(r"Expected stdout, identical from both filters:\n\n```\n(.*?)\n```", text, re.S)
        self.assertIsNotNone(block, "spec is missing its verified-output block")
        quoted = [l.replace("\\t", "\t") for l in block.group(1).splitlines()]
        self.assertEqual(quoted, EXPECTED)

    def test_spec_documents_the_cron_cadence(self):
        text = read(SPEC)
        self.assertIn("*/15 * * * *", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
