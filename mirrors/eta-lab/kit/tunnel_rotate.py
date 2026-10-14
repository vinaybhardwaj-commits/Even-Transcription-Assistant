#!/usr/bin/env python3
"""Tunnel-secret rotation helpers for kit/tunnel-rotate.sh (ruling 286). Separate from tunnel_cf.py on purpose: that file is hash-pinned for P1.

  rotate <tunnel_id>         PATCH the tunnel with a FRESH random 32-byte secret. Prints only {"success": ...}.
  restore <tunnel_id>        read a connector TOKEN on STDIN and PATCH the tunnel back to the secret that token embeds
                             (rollback after a failed rotation). Refuses a token for a different tunnel or account.

  rotated <tunnel_id>        read the OLD connector token on STDIN, fetch the CURRENT token and exit 0 only if the embedded
                             secret DIFFERS (proof the secret really rotated; the API never returns the secret itself)
  count <tunnel_id>          print {"connectors": N, "origin_ips": [...]} (distinct connectors, from the API)
  connector-id <tunnel_id>   print the id of the tunnel's single connector (exit 1 unless exactly one)

No secret is ever printed, put on argv or written to disk by this file. Measured on a throwaway tunnel (24 Sep):
PATCH works on locally- and remote-managed tunnels; after it a connector with the OLD token cannot register, one with
the NEW token can; an already-connected connector is NOT dropped (it stays up until it reconnects).
"""
import base64, json, secrets, sys
import tunnel_cf as t


def token_parts(tok):
    return json.loads(base64.b64decode(tok.strip() + "=" * (-len(tok.strip()) % 4)))


def main():
    cmd, tid = sys.argv[1], sys.argv[2]
    base = f"/accounts/{t.account()}/cfd_tunnel/{tid}"
    if cmd == "rotate":
        secret = base64.b64encode(secrets.token_bytes(32)).decode()
        r = t.call("PATCH", base, {"tunnel_secret": secret})
    elif cmd == "restore":
        d = token_parts(sys.stdin.read())
        if d.get("t") != tid or d.get("a") != t.account() or not d.get("s"):
            sys.exit("refusing: that token is not for this tunnel/account")
        r = t.call("PATCH", base, {"tunnel_secret": d["s"]})
    elif cmd == "rotated":
        old = token_parts(sys.stdin.read())
        r = t.call("GET", base + "/token")
        if not r.get("success"):
            sys.exit("could not read the current token: %s" % r.get("errors"))
        new = token_parts(r["result"])
        same_tunnel = old.get("t") == new.get("t") == tid and old.get("a") == new.get("a")
        rotated = bool(same_tunnel and new.get("s") and new.get("s") != old.get("s"))
        print(json.dumps({"rotated": rotated, "same_tunnel_and_account": bool(same_tunnel)}))
        sys.exit(0 if rotated else 1)
    elif cmd == "count":
        r = t.call("GET", f"/accounts/{t.account()}/cfd_tunnel/{tid}")
        conns = (r.get("result") or {}).get("connections") or []
        print(json.dumps({"connectors": len({c["client_id"] for c in conns}), "origin_ips": sorted({c["origin_ip"] for c in conns})}))
        sys.exit(0 if r.get("success") else 1)
    elif cmd == "connector-id":
        r = t.call("GET", base + "/connections")
        conns = r.get("result") or []
        if not r.get("success") or len(conns) != 1:
            sys.exit("expected exactly one connector, saw %d" % len(conns))
        print(conns[0]["id"])
        sys.exit(0)
    else:
        sys.exit(__doc__)
    print(json.dumps({"success": r.get("success"), "errors": [e.get("message") for e in (r.get("errors") or [])]}))
    sys.exit(0 if r.get("success") else 1)


if __name__ == "__main__":
    main()
