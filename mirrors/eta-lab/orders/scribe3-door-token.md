# ORDER — scribe3 — issue the night-drain token. V has authorised it.

V's words: *"you have access to vercel through your browser. you can put any token you like."*
That is explicit authorisation to mint and install the credential. Do it. The drain has been dead
all day on a 401 and this is the only thing standing between us and 2,451 windows.

## Use the CLI, not the browser
`npx -y vercel ... --scope vinaybhardwaj-commits-projects` works from the Mini and is faster and
less error-prone than driving a browser. Only fall back to the browser if the CLI refuses, and say
so if you do.

## What you established earlier, and should re-verify before changing anything
- The door checks `lib/mcp/auth.ts:26` then `:79` — `SCRIBE_MCP_TOKENS` first, a hash-keyed map of
  actor to scopes, falling back to `SCRIBE_MCP_TOKEN`.
- On the Mini: `SCRIBE_MCP_TOKEN` is present and not placeholder-shaped; `SCRIBE_MCP_TOKENS` is
  absent, and so is `~/.claude/secrets/scribe_mcp_token`.
- The night-drain reads it from `.env.local`. The door answers 401 on three tries.
- Production's own auto-drain works, so a valid token exists there — the Mini's copy is stale,
  most likely rotated. **Re-confirm the hash scheme from the source before you compute anything.**

## Steps
1. Read `lib/mcp/auth.ts` and establish exactly how `SCRIBE_MCP_TOKENS` is keyed and hashed, and
   what a scope entry looks like. Do not guess the format.
2. Generate a fresh high-entropy token. **Never print it. Never put it on a command line** — `ps`
   exposes that. Generate it into a variable or a 0600 file and pipe it where it needs to go.
3. Add an entry for actor **`night-drain`** with **read scope only** to `SCRIBE_MCP_TOKENS` in the
   **production** environment, preserving every existing entry. `vercel env add` reads from stdin.
   If the variable already exists you will need to pull, extend and re-add — **do not clobber other
   actors**; count entries before and after and report both numbers.
4. Install the matching token on the Mini where the night-drain actually reads it, at mode 0600.
5. **Production env bakes at build time here**, so promote a new production deployment after the
   env change, or the door will keep rejecting. Current production is `45eedda`.
6. **Verify**: call the door and show me the status code changes from 401 to 200. If it still
   401s, stop and report — do not start issuing more tokens.
7. Once the door answers 200, **start the night-drain**. Watchdog governs: stop on any STOP verdict
   or disk under 40 GB. `ETA_MAX_INFLIGHT` stays 3. Report the first real per-window breakdown of
   fetch, diarize, transcribe and write — measured, not constructed.

## Hard constraints
- Never print, echo, log or commit the token, any existing token, or any other credential value.
- Never pass a secret as a command-line argument. Environment or stdin only.
- Read scope only. Do not grant write scope to the night-drain.
- Do not modify, rotate or remove any existing actor's entry.
- Do not disable or weaken the door's auth check to make this work.

## Output
Entry count before and after, the actor name and scope, where the Mini-side token now lives,
the deployment id, the door's status code before and after, and the drain's first rate.
**No secret values.** CAP 200 words.
