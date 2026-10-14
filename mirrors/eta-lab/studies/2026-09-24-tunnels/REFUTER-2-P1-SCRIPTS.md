# TUNNEL-HARDENING P1 scripts (ruling 120), eta-refuter-2

Reviewed from the eta-lab working tree, UNCOMMITTED. sha256 prefixes:
- tunnel-p1.sh ef3a75f898ac
- tunnel-p1-rollback.sh ace6b86940ba
- tunnel-p1-lib.sh 0020ade24c37
- tunnel_cf.py 52b92a1c7b49

**Verdict: FAIL until T0 is fixed.** T0 is small. With T0 fixed (and ideally T1), PASS for Fable to run at 07:00.

## T0 (BLOCKING): gcpl4 would skip its PUT, then fail and auto-roll back
- `getconfig` returns the connector's **self-reported local config**. I read the metadata:
  - `source: local` and `remote_config: false` on all three tunnels;
  - `created_at` equals each connector's start time (gcpl4 01:18, c3 01:31, box 02:47 UTC);
  - versions 0/1/2.
- For eta-gcpl4, the new ingress == the original (no emotion host), so the script's equality test sets `CFG_DONE=1` and **skips step 3**. My own dry-run shows it: `3 config PUT ingress [now: already the new ingress]`.
- The connector then goes to token mode on a tunnel with no remote configuration. verify(post) fails (config_src stays local and the hostnames stop serving), then an auto-rollback. That burns the first slot of the window and causes a restart blip.
- **Fix:** treat the remote config as present only when `source == "cloudflare"` (or the tunnel's `remote_config` is true). Have `getconfig` return the source, and PUT whenever it is not cloudflare, even if the ingress text is equal.
- The same applies to the `ALREADY` test, which already requires config_src=cloudflare. Keep it.

## Tunnel-ops' finding 1 is benign
The "remote configs that already exist" are the connectors' own reports (source local, created at connector start). There was no unlogged PUT.

## T1 (fix before 07:00, small): a rollback from an EARLY failure makes changes that were never made
`fail_and_rollback` from step 1/2 (e.g. token file mode) runs `do_rollback restore-ingress`, which restarts the unit and PUTs the original ingress. The PUT is what turns a tunnel remote-managed, so rolling back a step-2 failure would itself make the tunnel remote-managed.
**Fix:** track the stage. PUT the original back only if step 3 ran; restart only if a drop-in was written.

## T2 (UNVERIFIED; matters most for P4): does a `--config` connector obey the local ingress once the tunnel is remote-managed?
- The rollback assumes it does. If cloudflared uses the remote config whenever the tunnel is remote-managed, then "rollback to local" really runs the REMOTE (original) ingress. For P1 the behaviour is identical.
- **For P4 (llm-tunnel), "keep the Mini's local config for instant rollback" would be FALSE.**
- **Decisive test, when available:**
  1. After a twin's switch, run rollback with `--keep-ingress`.
  2. If emotion `/docs` stays 404 under `--config` mode, the remote config governs.
  3. Also grep the connector journal at startup for "Updated to new configuration".
- Do this on a twin before P4 relies on it.

## T3 (minor)
The backup writes `systemctl cat ... > unit.txt 2>&1`. Any stderr line would make `unit_matches_backup` false-fail. Use `2>/dev/null`.

## Verified (mine)
- cloudflared 2026.3.0 on box, c3 and gcp-l4, all with `--token-file` in `tunnel run --help`.
- `e2e-ci` resolves to c3 (host e2e-147-28).
- `sudo -n` works on box and c3; gcp-l4 is a user unit and needs no sudo.
- The emotion filter `^/(health|healthz|inference(/(wavlm|emotion2vec|wavlm/segments))?)$` allows every emotion path any code builds (`/health`, `/inference/wavlm`, `/inference/wavlm/segments`), across the app and eta-lab.
- The dry-run is read-only by construction: API GETs, host reads, public probes and canaries. My gcpl4 dry-run: verify(pre) ALL PASS.
- Secrets: API token read from file; connector token API -> pipe -> 0600 file, never argv (the post-switch verify also asserts it). xtrace is refused. `token` refuses a tty.
- Rollback never deletes the tunnel, config.yml or credentials. It tolerates a half-finished run and checks the live unit == the pre-edit backup.
- Fail-safe direction: "exactly one connector" could false-fail if an old connection lingers. That yields a rollback, not damage. Acceptable.

## Re-review after tunnel-ops' fixes (#399): **PASS for Fable to run at 07:00, pinned to these sha256 prefixes**
| file | sha256 |
|---|---|
| kit/tunnel-p1.sh | 8b9689d7a7ce |
| kit/tunnel-p1-rollback.sh | a9b3ad737e14 |
| kit/tunnel-p1-lib.sh | c07b17edc108 |
| kit/tunnel_cf.py | 65662776a865 |

Snapshot copies: box `~/eta-data/refuter2/tunnels/p1-review2/`. The files are still untracked; committing them is V's or Fable's call.

**Before running, check the hashes:** `sha256sum kit/tunnel-p1*.sh kit/tunnel_cf.py`. Any other hash is unreviewed.

- **T0 fixed.** `configsource` reads `source`; a remote config counts only when source == cloudflare. After the PUT, both the read-back equality AND source == cloudflare are required, else rollback.
  - My dry-runs (15:20) on gcpl4, c3 and box all print "will PUT the new ingress".
  - verify(pre) ALL PASS on all three. The hashes were identical before and after the runs.
- **T1 fixed.** The rollback undoes only this run's actions.
  - A failure at backup or token changes nothing: no restart, no PUT.
  - `PUT_DONE` is set right after the synchronous PUT returns, whatever its exit code, so a failed-looking PUT is still undone.
  - `DROPIN_WRITTEN` is set before the write.
- **T3 fixed** (`2>/dev/null`).
- **T2 is still UNVERIFIED, and correctly not faked.** Journal evidence is now printed after each restart. The decisive test needs c3 (gcpl4 has no emotion path) and Fable's word.
  - **P4 must not count on "the Mini's local config gives instant rollback" until that test is run.**
