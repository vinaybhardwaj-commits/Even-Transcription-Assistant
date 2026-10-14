#!/usr/bin/env python3
"""Create (or converge) a Cloudflare Access app that allows ONLY the listed emails (ruling 184, lab-viewer).

  kit/access_app.py --hostname H --name NAME (--email E ... | --copy-emails-from HOST) [--expect-count N --apply]
      dry run by default (reads only); --apply creates / converges. Adding a person later = re-run with the full list.

Policy created: ONE policy, decision=allow, include = exactly the given emails. No bypass, no service-auth, no
"everyone", no IP rules. Login is the account's built-in one-time PIN to the email (works on a phone).
Idempotent: an app already on <hostname> is updated in place; its policy is replaced only if it differs.
Output includes the app's AUD tag (needed by the Worker to verify Cf-Access-Jwt-Assertion). The AUD is not a secret.

The Cloudflare token is read from ~/.claude/secrets/cloudflare_api_token (never argv, never printed). Emails are printed
masked (a***@even.in) so they do not land in logs. Reuses kit/tunnel_cf.py for the API plumbing.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tunnel_cf as cf

TEAM = "https://gentle-union-75e6.cloudflareaccess.com"   # public: it is in every Access login redirect


def mask(e):
    u, _, d = e.partition("@")
    return (u[:1] + "***@" + d) if d else "***"


def covering_apps(apps, host):
    """Apps that cover `host` via domain, self_hosted_domains OR destinations (refuter F3)."""
    out = []
    for x in apps:
        hosts = {(x.get("domain") or "").lower()} | {d.lower() for d in (x.get("self_hosted_domains") or [])}
        for d in x.get("destinations") or []:
            hosts.add((d.get("uri") or d.get("hostname") or "").lower().split("/")[0])
        if host in hosts:
            out.append(x)
    return out


def policy_state_ok(policies, emails):
    """True only for exactly ONE policy: allow, include = exactly `emails` (email rules only), no exclude, no require."""
    if len(policies) != 1:
        return False
    p = policies[0]
    inc = p.get("include") or []
    return bool(p.get("decision") == "allow" and not p.get("exclude") and not p.get("require")
                and all(len(i) == 1 and "email" in i for i in inc)
                and sorted(i["email"]["email"].lower() for i in inc) == sorted(emails))


def fail(msg):
    print("FAIL:", msg)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hostname", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--email", action="append", default=[])
    ap.add_argument("--copy-emails-from", metavar="HOSTNAME",
                    help="also allow the emails in the allow policy of the existing app on HOSTNAME (avoids typing an address)")
    ap.add_argument("--expect-count", type=int,
                    help="the exact number of allowed emails you intend; REQUIRED with --apply (guards a silently widened list)")
    ap.add_argument("--session", default="24h")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    acct = cf.account()
    base = f"/accounts/{acct}/access/apps"
    apps = cf.call("GET", base + "?per_page=100").get("result") or []
    src = []
    if a.copy_emails_from:
        srcapp = next((x for x in apps if x.get("domain") == a.copy_emails_from.lower()), None)
        if not srcapp:
            sys.exit("no existing app on %s to copy emails from" % a.copy_emails_from)
        for q in cf.call("GET", f"{base}/{srcapp['id']}/policies").get("result") or []:
            if q.get("decision") == "allow":
                src += [i["email"]["email"] for i in q.get("include", []) if "email" in i]
    emails = sorted({e.strip().lower() for e in a.email + src})
    if a.copy_emails_from:
        print("copied %d allowed email(s) from %s (+ %d from --email)" % (len(src), a.copy_emails_from, len(a.email)))
    if not emails:
        sys.exit("no emails given (--email and/or --copy-emails-from)")
    if a.apply and a.expect_count is None:
        sys.exit("refusing: --apply requires --expect-count N (the exact number of emails you intend, now %d)" % len(emails))
    if a.expect_count is not None and a.expect_count != len(emails):
        sys.exit("refusing: %d email(s) resolved but --expect-count says %d" % (len(emails), a.expect_count))
    bad = [e for e in emails if not e.endswith("@even.in")]
    if bad:
        sys.exit("refusing: every email must be an @even.in address (ruling 184); offending: %s" % [mask(e) for e in bad])
    host = a.hostname.strip().lower()
    cover = covering_apps(apps, host)
    existing = next((x for x in cover if (x.get("domain") or "").lower() == host), None)
    others = [x.get("name") for x in cover if x is not existing]
    if others:
        sys.exit("refusing: hostname is already covered by app(s) %s (domain, secondary domain or destination)" % others)
    if existing and existing.get("name") != a.name:   # F2: the PUT rewrites the app's settings
        sys.exit("refusing: the app on %s is named %r, not %r; a PUT would overwrite settings someone else set. Pass its exact --name." % (host, existing.get("name"), a.name))

    want_policy = {"name": "Allow lab team", "decision": "allow", "precedence": 1,
                   "include": [{"email": {"email": e}} for e in emails]}
    print("MODE:", "APPLY" if a.apply else "DRY RUN (nothing is changed)")
    print("app name       :", a.name)
    print("hostname       :", host, "| existing app on it:", existing["id"] if existing else "none")
    print("allowed emails :", [mask(e) for e in emails], "(%d)" % len(emails))
    print("policy         : allow, include emails only; no bypass / service-auth / everyone / IP")
    print("session        :", a.session)
    print("login          : one-time PIN to the email (account has no other identity provider)")
    if not a.apply:
        print("\nDRY RUN OK. Re-run with --apply to create/converge.")
        return

    body = {"name": a.name, "domain": host, "type": "self_hosted", "session_duration": a.session,
            "app_launcher_visible": False}
    if existing:
        r = cf.call("PUT", f"{base}/{existing['id']}", body)
    else:
        r = cf.call("POST", base, body)
    if not r.get("success"):
        fail("app create/update failed: %s" % r.get("errors"))
    app = r.get("result") or {}
    app_id = app["id"]

    cur = cf.call("GET", f"{base}/{app_id}/policies").get("result") or []
    if policy_state_ok(cur, emails):
        print("policy already correct")
    else:
        if len(cur) == 1:   # edit in place: no moment without a policy, same policy id
            pr = cf.call("PUT", f"{base}/{app_id}/policies/{cur[0]['id']}", want_policy)
            if not pr.get("success"):
                fail("policy update failed: %s" % pr.get("errors"))
        else:               # 0 policies (new app) or several (unexpected): end with exactly ONE
            for p in cur:
                dr = cf.call("DELETE", f"{base}/{app_id}/policies/{p['id']}")
                if not dr.get("success"):
                    fail("could not delete policy %s: %s (the app may have several policies)" % (p.get("id"), dr.get("errors")))
            pr = cf.call("POST", f"{base}/{app_id}/policies", want_policy)
            if not pr.get("success"):
                fail("policy create failed (an app with no policy denies everyone, which is fail-closed): %s" % pr.get("errors"))

    # F1: never report success without reading the state back and asserting it
    final = cf.call("GET", f"{base}/{app_id}/policies").get("result") or []
    app_now = cf.call("GET", f"{base}/{app_id}").get("result") or {}
    if not policy_state_ok(final, emails):
        fail("final read-back is not exactly one allow policy with exactly the intended emails (%d polic%s)" % (len(final), "y" if len(final) == 1 else "ies"))
    if (app_now.get("domain") or "").lower() != host or app_now.get("type") != "self_hosted":
        fail("final read-back: the app is not a self_hosted app on %s" % host)
    print("FINAL STATE ASSERTED: 1 app on %s, exactly 1 allow policy, %d intended email(s), no exclude/require" % (host, len(emails)))
    print("\nRESULT")
    print("app id  :", app_id)
    print("AUD tag :", app_now.get("aud") or app.get("aud"))
    print("issuer  :", TEAM)
    print("JWKS    :", TEAM + "/cdn-cgi/access/certs")
    print("policies:", [(q["name"], q["decision"], len(q.get("include", []))) for q in final])


if __name__ == "__main__":
    main()
