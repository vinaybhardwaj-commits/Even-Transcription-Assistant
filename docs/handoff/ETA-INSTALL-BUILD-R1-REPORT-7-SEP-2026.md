# ETA Install Build R1 — build report and acceptance runbook

**7 September 2026 · Claude Code · for V**

| | |
|---|---|
| Branch | `feat/room-recorder` |
| Docs commit | `2c217f2` — the five 7 September documents, unchanged |
| Build commit | `86c7c11` — Build R1 |
| Fix commit | `35aed03` — dropped an unratified `?channel=` I had added (see §5.1) |
| Preview deployment | `dpl_FkCFr2ptNb7ME6rvBXxHGPyLtvFF` · `even-transcription-assistant-fnpzac1mp.vercel.app` |
| Earlier preview (86c7c11) | `dpl_7qZsqHfHZ31uKDJdRmytBbg2PtUR` · `even-transcription-assistant-rcklt336u.vercel.app` |
| Migration | `0075_room_install` — **written, NOT run.** Yours. |
| Gate | 1504 unit tests green (was 1443) · typecheck clean · production build green |

Production is still `d7df4b1`. Vercel's production branch is `main`, so the push built a preview
and promotion is yours.

---

## 1. What shipped

Five items, all of §2 of the kickoff.

| # | Item | Where |
|---|---|---|
| 2.1 | Migration `0075_room_install` — three tables, the partial unique index | `db/migrations/0075_room_install.sql` |
| 2.2 | The eight Build R1 routes | `app/api/admin/releases/**`, `app/api/admin/rooms/[roomId]/bootstrap-token`, `app/api/room-recorder/**`, `app/api/admin/bench/fleet`, `app/api/admin/installs/[installId]/retire` |
| 2.3 | Seven optional poll fields + `409 RETIRED` | `app/api/bench/commands/route.ts`, `lib/bench-commands.ts` |
| 2.4 | Nightly cleanup, on the existing nightly job | `app/api/admin/measure-windows/route.ts` |
| 2.5 | The Install and fleet card | `components/admin/BenchInstallFleet.tsx`, `lib/room-install-view.ts` |

Server logic is in `lib/room-install.ts`; every decision the card makes is in the import-free
`lib/room-install-view.ts`, so the card and the tests read the same rules.

**Nightly cleanup — which job.** `/api/admin/measure-windows` (`30 20 * * *`) is the only
genuinely nightly entry in `vercel.json`; `reap-stuck` is hourly, `resume-processing` every three
minutes, `diarize-windows` every five. It hosts the cleanup. **No cron entry was added.** The
cleanup runs after the measurement, deletes at most 500 rows per pass, and reports itself in
`install_cleanup` on the response — its failure is caught and named, never thrown, so a fleet
bookkeeping fault cannot look like a measurement fault.

---

## 2. Acceptance — what is proven, and what waits on you

The kickoff asks for items 1 to 7; PRD §8 lists 9. Both numberings are given. **Items 1 and 3 to
8 cannot be demonstrated by me: every one of them needs migration 0075 applied, and the kickoff
tells me not to run it.** §3 below is the runbook that closes them in about five minutes once you
have.

| PRD §8 | Kickoff | Status |
|---|---|---|
| 1 · three tables + partial unique index, read from production | 1 | **Waits on the migration.** The file is asserted off disk by `tests/unit/room-install.test.ts` — the exact index predicate, three `CREATE TABLE IF NOT EXISTS`, and no `ALTER`/`DROP`/`TRUNCATE` anywhere. |
| 2 · card with four rooms and "No release published yet" | 2 | **Renders now, and cleanly after the migration.** Before it, the card shows the rooms and a `Partial read: installs_unavailable:STORE_UNAVAILABLE` line — `readFleet` guards each read separately, so an operator always gets a screen. |
| 3 · release registered from a real Blob upload, server sha256 matching the local file | — | **Waits.** Runbook §3.3. The mechanism is proven in tests: a manifest whose size or sha256 disagrees with the bytes is `SHA_MISMATCH` **and no row is written**, because the bytes are hashed before the INSERT. |
| 4 · minted token, its row, and the `command` matching §4.2 exactly | — | **Waits.** The string itself is pinned byte-for-byte by a test. |
| 5 · bootstrap returns `text/x-shellscript` with the real Blob URL, sha256 and room name | — | **Waits.** Script body pinned line-by-line by test, including the `bootout` line. |
| 6 · the same token posted twice, second is `TOKEN_INVALID` | — | **Waits.** Enforced in the statement, not by a check that could race — see §4.2. |
| 7 · an expired token on both routes returns `TOKEN_INVALID` | — | **Waits.** Both predicates carry `expires_at > now()`. |
| 8 · a hand-posted poll turns step 2 done with the hostname; `launched_by=user` turns it blocked | 3 | **Waits.** Both branches are pinned by test; the runbook posts the real poll. |
| 9 · the browser kiosk still polls and records unchanged | 7 | **Proven structurally, not on a live room** — see §2.1. |

### 2.1 Item 9, stated precisely

Three pieces of evidence, and one gap I am naming rather than papering over.

1. **A poll without `install_id` issues no `room_install` SQL at all.** Not a harmless query — 
   nothing. A test asserts exactly that (`tests/unit/bench-commands.test.ts`), so it is a property
   of the code's shape rather than a hope about it.
2. **All seventeen pre-existing `bench-commands` tests pass unchanged.** I did not edit one.
3. **On the preview, the poll behaves identically with and without the new fields:**

```
GET /api/bench/commands?tab_id=probe
  -> 401 {"error":{"code":"AUTH_REQUIRED","message":"Room sign-in required"}}
GET /api/bench/commands?tab_id=probe&install_id=install_x&launched_by=launchd&tape_advancing=true
  -> 401 {"error":{"code":"AUTH_REQUIRED","message":"Room sign-in required"}}
```

**The gap:** I have no room PIN, so I could not sign in as Home Office and watch a real tape
advance across the deploy. That last step is yours, and it is one page load — open
`/room/home-office…` on the Mini after promotion and confirm the monitor still shows it listening
and recording. Nothing in this build should change it, and I would rather say so than claim a
run I did not make.

### 2.2 What I did verify live, on the preview

All eight routes are present in the build output and answer correctly:

```
GET  /api/admin/releases                        -> 401 AUTH_REQUIRED
POST /api/admin/releases                        -> 401 AUTH_REQUIRED
POST /api/admin/releases/rel_x/withdraw         -> 401 AUTH_REQUIRED
POST /api/admin/rooms/room_x/bootstrap-token    -> 401 AUTH_REQUIRED
GET  /api/admin/bench/fleet                     -> 401 AUTH_REQUIRED
POST /api/admin/installs/install_x/retire       -> 401 AUTH_REQUIRED

GET  /api/room-recorder/bootstrap/not-a-token   -> 404 TOKEN_INVALID      (shape refused, no query)
GET  /api/room-recorder/bootstrap/deadbeef…     -> 503 STORE_UNAVAILABLE  "migration 0075 has not been applied"
POST /api/room-recorder/enrol {"token":"nope"}  -> 400 TOKEN_INVALID
POST /api/room-recorder/enrol {"token":"dead…"} -> 503 STORE_UNAVAILABLE  "migration 0075 has not been applied"
```

The pre-migration state is **named out loud**, not a 500 and not a silent empty answer. Note the
two statuses for `TOKEN_INVALID`: 404 on the bootstrap fetch, 400 on the enrol exchange, exactly
as the §4.2 table gives them.

---

## 3. The runbook — closing items 1 and 3 to 8

Every admin route accepts `Bearer MIGRATION_SECRET` as well as the admin cookie, so the whole
sequence runs from a terminal. Set these first:

```bash
export BASE="https://www.evenscribe.app"          # or the preview host, for a dry run first
export SECRET="<MIGRATION_SECRET>"
export AUTH="Authorization: Bearer $SECRET"
```

### 3.1 Run the migration

```bash
curl -sS -X POST "$BASE/api/run-migrations" -H "$AUTH" | jq
curl -sS "$BASE/api/run-migrations" | jq '.applied[-3:]'      # expect 0075_room_install
```

### 3.2 Item 1 — the tables and the index, read from the database

```sql
SELECT table_name FROM information_schema.tables
 WHERE table_name IN ('app_release','room_bootstrap_token','room_install');

SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_room_install_active_room';
-- expect: ... ON public.room_install USING btree (room_id)
--         WHERE ((retired_at IS NULL) AND (enrolled_at IS NOT NULL))
```

### 3.3 Item 3 — publish a release

Build R2 has not produced a bundle yet, so use **any zip** to prove the path end to end; the
server does not care what is inside it, only that the bytes match the manifest. Upload it to
Blob, then register it.

```bash
ZIP=/tmp/rr-test.zip
# 1. make something to upload
printf 'placeholder bundle' > /tmp/x && zip -j "$ZIP" /tmp/x

# 2. compute LOCALLY what the manifest will claim
SHA=$(shasum -a 256 "$ZIP" | awk '{print $1}')
SIZE=$(wc -c < "$ZIP" | tr -d ' ')
echo "local sha256=$SHA size=$SIZE"

# 3. upload to Vercel Blob (BLOB_READ_WRITE_TOKEN from the project env)
BLOB_URL=$(node -e '
  const {put}=require("@vercel/blob");const fs=require("fs");
  put("room-recorder/rr-test.zip", fs.readFileSync(process.argv[1]),
      {access:"public", token:process.env.BLOB_READ_WRITE_TOKEN, allowOverwrite:true})
    .then(r=>console.log(r.url));' "$ZIP")
echo "$BLOB_URL"

# 4. register it — the server re-streams the object and recomputes both numbers
curl -sS -X POST "$BASE/api/admin/releases" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"blob_url\":\"$BLOB_URL\",\"channel\":\"stable\",
       \"manifest\":{\"version\":\"0.0.1-probe\",\"build_sha\":\"0000000\",
                     \"sha256\":\"$SHA\",\"size_bytes\":$SIZE}}" | jq
```

Expect `201` and a release whose `sha256` equals your local `$SHA` — that is item 3.

**Prove the refusal too**, which is the half that matters. Re-run step 4 with one character of
`$SHA` changed, or `size_bytes` off by one:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/admin/releases" -H "$AUTH" \
  -H 'content-type: application/json' \
  -d "{\"blob_url\":\"$BLOB_URL\",\"channel\":\"stable\",
       \"manifest\":{\"version\":\"0.0.2-probe\",\"build_sha\":\"0000000\",
                     \"sha256\":\"$SHA\",\"size_bytes\":$((SIZE+1))}}"
# expect 400, code SHA_MISMATCH, and NO new row in app_release
```

### 3.4 Items 4 and 5 — mint a token, fetch the script

```bash
ROOM=$(curl -sS "$BASE/api/bench/rooms" -H "$AUTH" | jq -r '.rooms[0].id')   # or pick one
MINT=$(curl -sS -X POST "$BASE/api/admin/rooms/$ROOM/bootstrap-token" -H "$AUTH")
echo "$MINT" | jq

TOKEN=$(echo "$MINT" | jq -r .token)
INSTALL=$(echo "$MINT" | jq -r .install_id)

# item 4 — the command string, byte for byte
echo "$MINT" | jq -r .command
# expect exactly:
# curl -fsSL "https://www.evenscribe.app/api/room-recorder/bootstrap/<token>" | bash

# item 5 — the script, with the real blob url, sha and room name
curl -sSD- -o /tmp/boot.sh "$BASE/api/room-recorder/bootstrap/$TOKEN" | grep -i content-type
# expect: content-type: text/x-shellscript; charset=utf-8
grep -E 'BLOB_URL=|EXPECTED_SHA=|bootout|Installed and enrolled as' /tmp/boot.sh
```

The fetch does **not** spend the token — run it twice and it answers twice, by design: the script
needs the same token for its own `enrol` call seconds later.

### 3.5 Item 6 — the same token twice

```bash
curl -sS -X POST "$BASE/api/room-recorder/enrol" -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\"}" | jq      # 200, with a 365-day session

curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/room-recorder/enrol" \
  -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}"
# expect 400, code TOKEN_INVALID
```

Check the session really is 365 days, not 30:

```bash
# paste the session token into this to read its claims
node -e 'const [,,t]=process.argv;const p=JSON.parse(Buffer.from(t.split(".")[1],"base64url"));
         console.log("aud",p.aud,"days",Math.round((p.exp-p.iat)/86400));' "<session.token>"
# expect: aud room days 365
```

### 3.6 Item 7 — an expired token

Mint one and age it by hand, then try both routes:

```sql
UPDATE room_bootstrap_token SET expires_at = now() - interval '1 hour' WHERE token = '<token>';
```

```bash
curl -sS -o /dev/null -w 'bootstrap %{http_code}\n' "$BASE/api/room-recorder/bootstrap/<token>"
curl -sS -o /dev/null -w 'enrol %{http_code}\n' -X POST "$BASE/api/room-recorder/enrol" \
  -H 'content-type: application/json' -d '{"token":"<token>"}'
# expect bootstrap 404 TOKEN_INVALID, enrol 400 TOKEN_INVALID
```

### 3.7 Item 8 — the hand-posted poll, and the checklist turning

This is the one the kickoff calls item 3. It needs the **room session** from §3.5 as a cookie,
because `GET /api/bench/commands` is room-gated and that has not changed.

```bash
SESSION=$(echo "$ENROL" | jq -r .session.token)     # from the successful enrol in §3.5

# open /admin/bench, press Copy install command on that room, and LEAVE THE CHECKLIST OPEN,
# then run this:
curl -sS "$BASE/api/bench/commands?tab_id=app_$INSTALL&install_id=$INSTALL\
&launched_by=launchd&mic_state=authorized&tape_advancing=true\
&app_version=0.0.1-probe&build_sha=0000000&never_sleep=true\
&hostname=OPD-5-MINI&hardware_model=Mac%20mini%20M2&os_version=macOS%2015.6" \
  -H "Cookie: eta_room_session=$SESSION" | jq
```

Within three seconds the open checklist turns **step 2 done, showing `OPD-5-MINI`**, and step 3
done. Post it **twice** and step 4 turns done as well — that is the two-consecutive-polls rule,
and one poll deliberately is not enough.

Then the blocked branch:

```bash
curl -sS "$BASE/api/bench/commands?tab_id=app_$INSTALL&install_id=$INSTALL&launched_by=user" \
  -H "Cookie: eta_room_session=$SESSION" | jq
# step 2 turns BLOCKED: "App opened but not resident. Started by user, not launchd."
```

And the supersession rule:

```bash
curl -sS -X POST "$BASE/api/admin/installs/$INSTALL/retire" -H "$AUTH" | jq
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE/api/bench/commands?tab_id=app_$INSTALL&install_id=$INSTALL" \
  -H "Cookie: eta_room_session=$SESSION"
# expect 409 — the app stops polling (§4.5 rule 3)
```

### 3.8 Clean up the probe release before real use

```bash
REL=$(curl -sS "$BASE/api/admin/releases" -H "$AUTH" | jq -r '.releases[0].id')
curl -sS -X POST "$BASE/api/admin/releases/$REL/withdraw" -H "$AUTH" | jq
```

With every release withdrawn the card returns to "No release published yet" and every install
button goes off — which is also the proof that the empty table really is the gate.

---

## 4. Three things worth knowing about how this is built

### 4.1 The enrol exchange is two ordered statements, not one clever one

The obvious implementation is a single statement chaining data-modifying CTEs. It is wrong here.
Retiring the old install and enrolling the new one both touch `uq_room_install_active_room`, and
**CTE execution order is not defined in Postgres** — if the enrol ran first, the new row would
enter the index while the old row was still in it and the statement would fail on a uniqueness
violation that has nothing to do with what you asked for. A legitimate re-enrol would fail,
intermittently, and only on rooms that already had a Mac.

Neon's HTTP driver gives ordered statements inside one transaction, so the retire lands first, by
construction, every time.

### 4.2 Single use is enforced twice, in the statements

Statement 1 claims the token only while `used_at IS NULL` **and** unexpired, and the retire hangs
off that claim's `RETURNING` — so nothing is retired unless this call won the token. Statement 2
enrols only while `enrolled_at IS NULL`. `TOKEN_INVALID` is read off the emptiness of statement 2,
not from a separate check that two concurrent calls could both pass.

Unknown, expired and used tokens all give the **same** message. An unauthenticated endpoint that
could confirm a token had once existed would be telling a caller something no honest client needs.

### 4.3 The room name is escaped for the quotes §4.4 already uses

§4.4 is reproduced verbatim, which means the substitution points sit inside `"…"`, where bash
still expands `$`, honours `\` and runs a backtick. You can type `OPD "3" $(id)` into the room
name box today. Unescaped, that ends the echo string and runs `id` on a clinic Mac. Four
characters are escaped and control characters are dropped; the script's structure is untouched
and a test pins both the escaping and the line count.

---

## 5. Flags — decisions I made that are not in the document

Per the kickoff, these are raised rather than settled silently.

### 5.1 One thing I got wrong and fixed in-branch

I first added `?channel=` to the mint route so a test build could go to one Mac. It was an
unratified parameter on a settled contract, **and it did not work**: `room_bootstrap_token` has no
channel column, and the bootstrap fetch reads the release again minutes later, so a token minted
against `test` would have been served a stable script. Removed in `35aed03`. The install path is
stable-only. `latestRelease` keeps its channel argument for R3's release route, which reads it per
request — which is where a channel belongs.

### 5.2 Three columns beyond PRD §4.1 — **needs your nod**

`room_install` carries three columns the §4.1 list does not have. Each is documented in the
migration with its reason. None is typed by a person; all three are written only by the poll.

| Column | Why §6 cannot be built without it |
|---|---|
| `tape_poll_streak` | Step 4 turns done on **two consecutive polls**. A single boolean has no memory of the previous poll, so the rule cannot be evaluated from it at all. Reset to 0 by any poll reporting false, so one true surrounded by falses never reaches two. |
| `tape_advancing_since` | Step 4's "audio arriving since 14:41" line. NULLed whenever the streak resets, so it can never show the start of a run that has already broken. |
| `first_seen_at` | Step 2 renders "started by launchd, `<time>`". `last_seen_at` moves on every poll; `enrolled_at` is the token exchange, which happens moments earlier inside the script and would put a time on screen that is not the time the app came up. |

### 5.3 `launch_agent_loaded` is derived, not reported — **needs your nod**

§4.3 fixes the poll's additions at **seven** fields and `launch_agent_loaded` is not among them,
yet §9.2 expects it true once launchd owns the process. Rather than invent an eighth field, the
poll sets it from `launched_by = 'launchd'` — which is what the column means. If you would rather
the app report it separately in R2, that is a one-line change here.

### 5.4 The two rate-limit numbers are chosen, not quoted — **needs your ratification**

The kickoff says "do not add rate limiting beyond the two numbers in §4.2". **§4.2 contains no
numbers** — it names two error codes, `BOOTSTRAP_RATE_LIMITED` and `ENROL_RATE_LIMITED`. The codes
are part of the route contract so the routes must be able to emit them; the numbers are mine:

- bootstrap: 30 requests / minute / IP
- enrol: 10 requests / minute / IP

Both are far above any honest install (one paste makes one fetch and one enrol). It is in-process
and per-instance — no shared store, no new infrastructure, nothing from a security checklist. It
is the cheap thing that makes the two named codes real, and I am not describing it as a defence.

### 5.5 The last-seen alarm window is inherited, not established — **R18 stays open**

§6 marks it UNKNOWN and asks the builder to establish it "against an ordinary day". **An ordinary
day of the native app cannot be observed: the app is Build R2 and does not exist.** Measuring the
browser kiosk instead would establish the cadence of a different program.

So it is set to `LISTENER_OFFLINE_MS` — ten minutes — which `lib/bench-bus-constants.ts` already
uses to answer the identical question for the kiosk ("how long may a listener be gone before *it
might come back* becomes *somebody has to walk there*"). A second, differently-guessed number
would only mean two screens disagreeing about when a room is dark. **R18 carries into R2**, where
a real Mac running a real day can settle it.

### 5.6 The origin does not read `APP_URL`

Acceptance item 4 requires the command to match §4.2 **exactly**, which names
`https://www.evenscribe.app`. This repo already documents that the deployed `APP_URL` holds a
stale `eta.even.in` value overridden in code (`app/api/admin/doctors/route.ts`). Reading it here
would have emitted a command pointing a clinic Mac at a host that does not answer. The default is
the PRD's literal; `ROOM_RECORDER_ORIGIN` (new, documented in `.env.example`) is the deliberate
override for a staging host.

### 5.7 `@vercel/blob` is a dependency but the SDK is not imported

R1 only needs to **read** a public Blob object to recompute its digest, and a plain streamed
`fetch` does that without a token. What the SDK would have added is confirmation that the URL is
an object in *this* store; instead `isBlobUrl` requires https and a `*.blob.vercel-storage.com`
host, which is the check that matters — this URL is handed to `curl` on a clinic Mac. Say the word
and I will add a `head()` call in R2, where the packaging script uses the SDK to upload anyway.

### 5.8 `check:silent` is red, and was already

`npm run check:silent` reports 9 findings in the encounter `/process`, `finalize-*` and
note-composer paths. **All nine are pre-existing** — I verified the identical set at `d7df4b1`
with my work stashed. None is in a file this build touches. Recorded here because
`docs/BUILD-HISTORY.md` used to claim that gate was green, and it is not.

---

## 6. Not built, deliberately

The app side, the packaging script and self-update (Builds R2 and R3). No feature flag — the empty
release table is the gate. The room PIN login and its 30-day TTL for humans are untouched: the one
existing caller of `signRoomJwt` passes no options and still gets 30 days. `GET
/api/room-recorder/release` is R3 and is not here.

Nothing was added from a security checklist beyond what §4 states.
