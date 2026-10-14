#!/usr/bin/env python3
"""Offline tests for kit/access_app.py against a fake Cloudflare Access API. No network, no token, nothing live.

    python3 -m unittest kit/test_access_app.py        (from the repo root)
"""
import contextlib, io, os, sys, unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import access_app as aa

HOST = "lab.example-test.invalid"
V, S = "staff-redacted@even.in", "staff-redacted@even.in"


class FakeAPI:
    """Just enough of /accounts/X/access/apps and its policies. `fail` = set of (METHOD, path-suffix-kind) to fail."""
    def __init__(self, apps=None, policies=None, fail=()):
        self.apps = {a["id"]: dict(a) for a in (apps or [])}
        self.pol = {k: [dict(p) for p in v] for k, v in (policies or {}).items()}
        self.fail = set(fail)
        self.calls = []
        self.n = 0

    def account(self):
        return "acct"

    def _ok(self, result=None):
        return {"success": True, "result": result, "errors": []}

    def _bad(self):
        return {"success": False, "result": None, "errors": [{"message": "forced failure"}]}

    def call(self, method, path, body=None):
        self.calls.append((method, path))
        parts = path.split("?")[0].strip("/").split("/")        # accounts acct access apps [id [policies [pid]]]
        rest = parts[4:]
        kind = "app" if len(rest) <= 1 else "policy"
        if (method, kind) in self.fail:
            return self._bad()
        if method == "GET" and not rest:
            return self._ok(list(self.apps.values()))
        if method == "GET" and len(rest) == 1:
            return self._ok(self.apps[rest[0]])
        if method == "GET" and rest[1:] == ["policies"]:
            return self._ok([dict(p) for p in self.pol.get(rest[0], [])])
        if method == "POST" and not rest:
            self.n += 1
            app = {**body, "id": "app%d" % self.n, "aud": "aud%d" % self.n}
            self.apps[app["id"]] = app
            return self._ok(app)
        if method == "PUT" and len(rest) == 1:
            self.apps[rest[0]].update(body)
            return self._ok(self.apps[rest[0]])
        if method == "POST" and rest[1:] == ["policies"]:
            self.n += 1
            self.pol.setdefault(rest[0], []).append({**body, "id": "pol%d" % self.n})
            return self._ok()
        if method == "PUT" and len(rest) == 3:
            self.pol[rest[0]] = [{**body, "id": rest[2]} if p["id"] == rest[2] else p for p in self.pol[rest[0]]]
            return self._ok()
        if method == "DELETE" and len(rest) == 3:
            self.pol[rest[0]] = [p for p in self.pol[rest[0]] if p["id"] != rest[2]]
            return self._ok()
        raise AssertionError("unexpected call %s %s" % (method, path))

    def mutations(self):
        return [c for c in self.calls if c[0] != "GET"]


def policy(pid, emails, decision="allow", **extra):
    return {"id": pid, "name": "p", "decision": decision, "include": [{"email": {"email": e}} for e in emails], **extra}


def run(api, *argv):
    """Run aa.main() with argv against `api`; returns (exit_code, stdout)."""
    out = io.StringIO()
    with mock.patch.object(aa.cf, "call", api.call), mock.patch.object(aa.cf, "account", api.account), \
            mock.patch.object(sys, "argv", ["access_app.py", *argv]), contextlib.redirect_stdout(out):
        try:
            aa.main()
            code = 0
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else 2
            if isinstance(e.code, str):
                out.write(e.code)
    return code, out.getvalue()


NAME = "Lab App"
BASE = ["--hostname", HOST, "--name", NAME, "--email", V, "--email", S]


class PureFunctions(unittest.TestCase):
    def test_policy_state_ok(self):
        ok = [policy("1", [V, S])]
        self.assertTrue(aa.policy_state_ok(ok, sorted([V, S])))
        self.assertFalse(aa.policy_state_ok([], [V]))
        self.assertFalse(aa.policy_state_ok(ok + [policy("2", [V])], sorted([V, S])), "two policies")
        self.assertFalse(aa.policy_state_ok([policy("1", [V, S], decision="bypass")], sorted([V, S])))
        self.assertFalse(aa.policy_state_ok([policy("1", [V, S], exclude=[{"email": {"email": V}}])], sorted([V, S])))
        self.assertFalse(aa.policy_state_ok([policy("1", [V, S], require=[{"everyone": {}}])], sorted([V, S])))
        self.assertFalse(aa.policy_state_ok([policy("1", [V])], sorted([V, S])), "missing an email")
        p = policy("1", [V, S]); p["include"].append({"everyone": {}})
        self.assertFalse(aa.policy_state_ok([p], sorted([V, S])), "non-email include")
        self.assertTrue(aa.policy_state_ok([policy("1", [V.upper(), S])], sorted([V, S])), "case-insensitive")

    def test_covering_apps_sees_destinations(self):
        apps = [{"id": "a", "name": "A", "domain": "x.example.invalid"},
                {"id": "b", "name": "B", "domain": "y.example.invalid", "self_hosted_domains": [HOST]},
                {"id": "c", "name": "C", "domain": "z.example.invalid", "destinations": [{"type": "public", "uri": HOST + "/api"}]}]
        self.assertEqual([x["id"] for x in aa.covering_apps(apps, HOST)], ["b", "c"])


class Flows(unittest.TestCase):
    def test_dry_run_makes_no_mutation(self):
        api = FakeAPI()
        code, out = run(api, *BASE)
        self.assertEqual(code, 0)
        self.assertEqual(api.mutations(), [])
        self.assertIn("DRY RUN OK", out)

    def test_apply_requires_expect_count(self):
        api = FakeAPI()
        code, out = run(api, *BASE, "--apply")
        self.assertNotEqual(code, 0)
        self.assertEqual(api.mutations(), [])
        self.assertIn("--expect-count", out)

    def test_expect_count_mismatch_refuses(self):
        api = FakeAPI()
        code, _ = run(api, *BASE, "--expect-count", "3", "--apply")
        self.assertNotEqual(code, 0)
        self.assertEqual(api.mutations(), [])

    def test_non_even_in_refused(self):
        for bad in ("user@example.com", "staff-redacted@b.even.in", "staff-redacted@even.in.evil.com"):
            api = FakeAPI()
            code, _ = run(api, "--hostname", HOST, "--name", NAME, "--email", bad)
            self.assertNotEqual(code, 0, bad)
            self.assertEqual(api.mutations(), [])

    def test_new_app_happy_path_asserts_final_state(self):
        api = FakeAPI()
        code, out = run(api, *BASE, "--expect-count", "2", "--apply")
        self.assertEqual(code, 0, out)
        self.assertIn("FINAL STATE ASSERTED", out)
        (app,) = api.apps.values()
        self.assertTrue(aa.policy_state_ok(api.pol[app["id"]], sorted([V, S])))

    def test_existing_app_edited_in_place_same_policy_id(self):
        app = {"id": "app1", "name": NAME, "domain": HOST, "type": "self_hosted", "aud": "x"}
        api = FakeAPI([app], {"app1": [policy("pol9", [V])]})
        code, out = run(api, *BASE, "--expect-count", "2", "--apply")
        self.assertEqual(code, 0, out)
        self.assertEqual([p["id"] for p in api.pol["app1"]], ["pol9"], "edited in place, not recreated")
        self.assertNotIn(("DELETE", "/accounts/acct/access/apps/app1/policies/pol9"), api.calls)

    def test_F1_failed_delete_is_a_failure_not_success(self):
        app = {"id": "app1", "name": NAME, "domain": HOST, "type": "self_hosted", "aud": "x"}
        api = FakeAPI([app], {"app1": [policy("p1", [V]), policy("p2", [S])]}, fail={("DELETE", "policy")})
        code, out = run(api, *BASE, "--expect-count", "2", "--apply")
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL", out)
        self.assertNotIn("FINAL STATE ASSERTED", out)
        # pin the DELETE check itself (refuter #958): it must stop AT the failed delete, before any new policy is created,
        # so this test does not pass merely because the final read-back would also catch the leftover state
        self.assertIn("could not delete policy", out)
        self.assertNotIn(("POST", "/accounts/acct/access/apps/app1/policies"), api.calls)

    def test_F1_final_state_wrong_is_a_failure(self):
        """The write 'succeeds' but the read-back shows a different state: must not report success."""
        app = {"id": "app1", "name": NAME, "domain": HOST, "type": "self_hosted", "aud": "x"}
        api = FakeAPI([app], {"app1": [policy("p1", [V])]})
        real = api.call
        def sneaky(method, path, body=None):
            r = real(method, path, body)
            if method == "PUT" and "/policies/" in path:      # claims success but stores the OLD list
                api.pol["app1"] = [policy("p1", [V])]
            return r
        api.call = sneaky
        code, out = run(api, *BASE, "--expect-count", "2", "--apply")
        self.assertEqual(code, 1, out)
        self.assertNotIn("FINAL STATE ASSERTED", out)

    def test_F2_name_mismatch_refused_no_mutation(self):
        app = {"id": "app1", "name": "Someone else's app", "domain": HOST, "type": "self_hosted"}
        api = FakeAPI([app], {"app1": [policy("p1", [V])]})
        code, out = run(api, *BASE, "--expect-count", "2", "--apply")
        self.assertNotEqual(code, 0)
        self.assertEqual(api.mutations(), [])
        self.assertIn("named", out)

    def test_F3_destination_coverage_refused(self):
        other = {"id": "o1", "name": "Other", "domain": "o.example.invalid", "destinations": [{"type": "public", "uri": HOST}]}
        api = FakeAPI([other])
        code, _ = run(api, *BASE, "--expect-count", "2", "--apply")
        self.assertNotEqual(code, 0)
        self.assertEqual(api.mutations(), [])

    def test_F4_copy_flag_prints_count_and_expect_count_guards_widening(self):
        src = {"id": "s1", "name": "Src", "domain": "src.example.invalid", "type": "self_hosted"}
        api = FakeAPI([src], {"s1": [policy("sp", [V, S, "staff-redacted@even.in"])]})     # the source has grown to 3
        code, out = run(api, "--hostname", HOST, "--name", NAME, "--copy-emails-from", "src.example.invalid",
                        "--expect-count", "2", "--apply")
        self.assertNotEqual(code, 0)
        self.assertIn("copied 3 allowed email(s)", out)
        self.assertEqual(api.mutations(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
