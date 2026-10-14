# TUNNEL-HARDENING: Cloudflare tunnels + Access (Fable, 24 Sep 14:20 IST)

V widened the Cloudflare token (box `~/.claude/secrets/cloudflare_api_token`; never print it, never put it on argv).

Verified by Fable at 14:15:
- Tunnel:Edit works.
- Access apps/policies + service tokens work.
- Zone DNS: NOT yet granted (read → auth error 10000); V is adding it.

Account id: c7f665855e6e4d22090000b0397c4d0d.

Tunnels today: eta-box, eta-c3, eta-gcpl4, llm-tunnel (Mini PRODUCTION), yoga-node. All are healthy, all run on **local config files**, and there are 2 existing Access apps.

## Why
1. Local config files caused wrong-machine routing twice today (a cloned tunnel's credentials; `route dns` using the wrong tunnel).
2. 5 of 7 service hostnames are public and unauthenticated (whisper/diarize/embed on production + twins).
3. Ad-hoc `ssh -L` tunnels between machines are fragile and nobody owns them.

## Owner: new session `tunnel-ops · Cloudflare tunnels + Access · box` (Sonnet). Refuter: eta-refuter-2.

**P0 inventory (read-only, now):**
- Per tunnel: ingress rules (from each host's config.yml), DNS names, which app env var or lab script calls each hostname, and the 2 existing Access apps.
- Output: `studies/2026-09-24-tunnels/INVENTORY.md`. No hostnames with secrets; the account id is OK here but NOT in the public ETA repo.

**P1 twins → remotely managed (daytime OK; production untouched):**
- eta-box, eta-c3, eta-gcpl4: push the SAME ingress via the API tunnel configuration. Switch each connector to token mode (service reinstall on that host). Verify every hostname returns the same status before and after.
- One tunnel at a time; roll back to the local config on any mismatch.
- The hist-gpu nodes get their own remotely managed tunnels only if they need inbound hostnames (default: they don't).

**P2 Access in front of every service hostname: app code FIRST, enforcement LAST.**
- (a) Create one Access app per service hostname group, with a service-token policy (Service Auth) plus V's email as an admin bypass. Tokens are stored 0600 in secrets and never printed.
- (b) scribe adds `CF-Access-Client-Id/Secret` header support to every server-side caller of those hostnames: whisper, diarize, embed, emotion, indic, route and all `*_BULK_URLS` pools. Env-driven, sent only when set.
  - Refuter PASS → next train.
  - Lab harnesses and scripts add the headers too.
- (c) Enforce twins first (after their callers send headers). Then production llm-tunnel hostnames after 20:30 on a later night: set the Vercel env first, deploy, verify 200 with headers and 403 without, keep a one-command rollback (policy → bypass).
- NEVER enforce on a hostname whose callers don't send headers yet.

**P3 replace `ssh -L` tunnels:** lab-mover's 18001 (c3 diarize) and 18086 (c3 emotion) move to Access-protected hostnames on eta-c3 once P2(c) covers them.

**P4 production llm-tunnel → remotely managed:** after 20:30 only, on Fable's go, with the Mini's local config kept for instant rollback. Not tonight.

## Do not
- Touch llm-tunnel or production DNS in clinic hours.
- Print tokens.
- Put the account id or V's email in the public ETA repo.
- Delete any tunnel.
