#!/usr/bin/env python3
"""
Parity for the exported lexicon: eta_number_words.py must equal the router's own NUMBER_WORDS, and the
generator must be the only way it is written.

RUN:  ETA_JOBS_DIR=$(mktemp -d) ./.venv/bin/python -m unittest test_lexicon_export -v

The shim is MiniBot's file and is never edited here. Its list is REPORTED, not asserted: a test that
failed because another owner's file is behind would be a red suite nobody here can fix, and the number
that matters to them (which words they are missing) is printed instead.
"""
import importlib.util
import os
import re
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("ETA_JOBS_DIR", tempfile.mkdtemp())
import router_server as rs  # noqa: E402
import eta_number_words as export  # noqa: E402
from tools_export_lexicon import lexicon_sha  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SHIM = os.path.expanduser("~/.local/bin/whisper-shim.py")


class Parity(unittest.TestCase):
    def test_export_equals_the_router(self):
        self.assertEqual(export.NUMBER_WORDS, rs.NUMBER_WORDS)

    def test_the_header_hash_is_recomputable_from_the_file_itself(self):
        """The provenance line names the WORDS, so a reader can verify it without the repo — and the
        byte comparison below survives being committed, which a HEAD sha never could."""
        with open(os.path.join(HERE, "eta_number_words.py"), encoding="utf-8") as fh:
            header = fh.read().split("NUMBER_WORDS = frozenset({")[0]
        recorded = re.search(r"lexicon sha256 ([0-9a-f]{16})", header)
        self.assertIsNotNone(recorded, "the header does not record a lexicon hash")
        self.assertEqual(recorded.group(1), lexicon_sha(export.NUMBER_WORDS))
        self.assertNotRegex(header, r"at commit [0-9a-f]{7}", "the header must not name a checkout")

    def test_export_is_what_the_generator_writes(self):
        """Generate into a SCRATCH file and compare with the committed one. The committed file is only
        ever read here: a check that regenerated over it caught a hand-edit once and then erased it,
        so the next run was green and the evidence was gone (ETA-Refuter on ffbe1c7, 23 Sep)."""
        committed_path = os.path.join(HERE, "eta_number_words.py")
        with open(committed_path, "rb") as fh:
            committed = fh.read()
        before = os.stat(committed_path).st_mtime_ns
        with tempfile.TemporaryDirectory() as td:
            scratch = os.path.join(td, "eta_number_words.py")
            subprocess.run([sys.executable, os.path.join(HERE, "tools_export_lexicon.py"), scratch],
                           cwd=HERE, check=True, capture_output=True,
                           env={**os.environ, "ETA_JOBS_DIR": td})
            with open(scratch, "rb") as fh:
                regenerated = fh.read()
        # The committed file was not touched, byte for byte or by timestamp.
        with open(committed_path, "rb") as fh:
            self.assertEqual(fh.read(), committed, "the check modified the committed export")
        self.assertEqual(os.stat(committed_path).st_mtime_ns, before, "the check rewrote the committed export")
        self.assertEqual(committed, regenerated, "eta_number_words.py is not what the generator writes")

    def test_every_exported_word_is_a_number_to_the_router(self):
        for w in export.NUMBER_WORDS:
            self.assertTrue(rs.is_number_token(w), w)

    def test_the_export_covers_0_to_100_in_both_scripts(self):
        for lang, table in rs.number_lexicon().items():
            for n, (rom, nat) in table.items():
                for w in rom | nat:
                    self.assertIn(w.lower(), export.NUMBER_WORDS, f"{lang} {n} {w}")


class ShimReport(unittest.TestCase):
    """Reports the live shim's coverage against the export. Never edits or asserts on MiniBot's file."""

    def test_report_shim_coverage(self):
        if not os.path.exists(SHIM):
            self.skipTest("whisper-shim not on this machine")
        spec = importlib.util.spec_from_file_location("whisper_shim_readonly", SHIM)
        shim = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(spec and shim)  # module level only defines; the server needs __main__
        shim_words = None
        for name in ("NUMBER_WORDS", "_NUMBER_WORDS", "NUMBERS"):
            if isinstance(getattr(shim, name, None), (set, frozenset)):
                shim_words = {str(w).lower() for w in getattr(shim, name)}
                break
        if shim_words is None:
            print("\n[shim] exposes no number-word set at module level — parity cannot be read from here")
            self.skipTest("shim exposes no number-word set")
        missing = set(export.NUMBER_WORDS) - shim_words
        extra = shim_words - set(export.NUMBER_WORDS)
        print(f"\n[shim] words: {len(shim_words)} | export: {len(export.NUMBER_WORDS)} | "
              f"missing from shim: {len(missing)} | in shim only: {len(extra)}")
        if missing:
            print(f"[shim] examples missing (romanised): {sorted(w for w in missing if w.isascii())[:8]}")
        if extra:
            print(f"[shim] in shim only: {sorted(extra)[:8]}")
        # Deliberately no assertion on another owner's file: the numbers above are the handoff, and a
        # red suite here could only be fixed by MiniBot, not by anyone reading this one.


if __name__ == "__main__":
    unittest.main()
