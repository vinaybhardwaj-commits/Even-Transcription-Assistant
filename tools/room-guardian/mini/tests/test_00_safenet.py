"""FR1 D7-4 MUST-1: the safety net is in force for the whole run (this file sorts first, so discover imports it before any router test)."""
import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import safenet
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "router"))
import ubus_bus


class SafeNetTests(unittest.TestCase):
    def test_the_env_names_scratch_places_only(self):
        for k in ("GUARDIAN_HOME", "GUARDIAN_GATING_INBOX", "UBUS_MCP"):
            self.assertTrue(os.environ.get(k), k)
            self.assertFalse(safenet.is_live(os.environ[k]), k)
            self.assertFalse(safenet.under(os.environ[k], os.path.expanduser("~/.local/ubus-mcp")), k)

    def test_the_router_modules_were_imported_with_the_scratch_home(self):
        self.assertFalse(safenet.is_live(ubus_bus.HOME)); self.assertFalse(safenet.is_live(ubus_bus.SHIM))
        self.assertEqual(safenet.real(ubus_bus.HOME), safenet.real(os.environ["GUARDIAN_HOME"]))

    def test_the_live_values_are_detected_and_replaced(self):
        from unittest import mock
        live = {"GUARDIAN_HOME": os.path.expanduser("~/oc/fleet-access/guardian"), "GUARDIAN_GATING_INBOX": "~/oc/fable/INBOX-FROM-GATING.md",
                "UBUS_MCP": os.path.expanduser("~/.local/ubus-mcp/bin/ubus-mcp")}
        with mock.patch.dict(os.environ, live):
            self.assertTrue(all(safenet.is_live(live[k]) for k in ("GUARDIAN_HOME", "GUARDIAN_GATING_INBOX")))
            safenet.install()
            for k in ("GUARDIAN_HOME", "GUARDIAN_GATING_INBOX", "UBUS_MCP"):
                self.assertNotEqual(os.environ[k], live[k]); self.assertFalse(safenet.is_live(os.environ[k]))
        # mock.patch.dict restored the env; the tempdir install() made is removed at exit


if __name__ == "__main__":
    unittest.main()
