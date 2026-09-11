# 0.1.8 — console runbook (V's hand)

Every command below runs in **Terminal.app inside a Screen Sharing session on the Mini**, never in the `ssh mini` tab.
Screen Sharing is a console login; SSH is not, and codesign fails over SSH with `errSecInternalComponent`.

## 0. Get a console session from the Air
Finder → Go → Connect to Server (⌘K) → `vnc://192.168.1.18` → Connect → log in as yourself. In the Mini's screen, open
Terminal.app. Do everything below in that window. Never run `security unlock-keychain`; the console login unlocks it.

## 1. Confirm the tree
```bash
cd ~/dev/Even-Transcription-Assistant
git rev-parse --short HEAD          # 7d21f5e
git status --porcelain              # only ?? docs/handoff/... lines, nothing else
```

## 2. swift test at the console
```bash
cd ~/dev/Even-Transcription-Assistant/apps/room-recorder && swift test \
  -Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing \
  -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/usr/lib 2>&1 | tail -5
```
Expect `510 tests … passed`, 0 issues. Any `needsEnrolment` here is a real failure: STOP, paste me the tail.

## 3. Build and sign the bundle
```bash
cd ~/dev/Even-Transcription-Assistant/apps/room-recorder
Packaging/build-bundle.sh
cat .build/release-bundle/release.json
```
Expect `"version": "0.1.8"`, a `build_sha` of `7d21f5e`, a `sha256`, a `size_bytes`. Paste me `release.json`.

## 4. Publish to channel `test` (Home Office only)
```bash
cd ~/dev/Even-Transcription-Assistant
npx vercel env pull .env.local --environment=production --yes    # brings BLOB_READ_WRITE_TOKEN into the file
set -a; source .env.local; set +a                                 # loads them into this shell; never echo them
export BASE="https://www.evenscribe.app"
export AUTH="Authorization: Bearer $MIGRATION_SECRET"
ZIP=apps/room-recorder/.build/release-bundle/EvenScribe-Room-Recorder-0.1.8.zip
BLOB_URL=$(node -e '
  const {put}=require("@vercel/blob");const fs=require("fs");
  put("room-recorder/EvenScribe-Room-Recorder-0.1.8.zip", fs.readFileSync(process.argv[1]),
      {access:"public", token:process.env.BLOB_READ_WRITE_TOKEN, allowOverwrite:true})
    .then(r=>console.log(r.url));' "$ZIP")
echo "$BLOB_URL"
jq -n --arg u "$BLOB_URL" --slurpfile m apps/room-recorder/.build/release-bundle/release.json \
   '{blob_url:$u, channel:"test", manifest:$m[0]}' \
 | curl -sS -X POST "$BASE/api/admin/releases" -H "$AUTH" -H 'content-type: application/json' -d @- | jq
```
Expect 201 and a release row whose `sha256` equals `release.json`'s. Note the `rel_…` id — withdraw needs it.
The manifest is `release.json` verbatim; nothing is typed by hand, so `version` cannot be mistyped.

## 5. Migration 0078 (before any 0.1.8 poll lands)
```bash
curl -sS -X POST "$BASE/api/run-migrations" -H "$AUTH" | jq
curl -sS "$BASE/api/run-migrations" | jq '.applied[-4:]'        # expect …0075, 0076, 0077, 0078
```
Paste me both outputs. This also settles whether 0075–0077 were ever applied.

## 6. Put Home Office on `test` (on the Home Office Mac, its own Terminal)
```bash
launchctl bootout gui/$(id -u)/com.evenscribe.room-recorder
nano ~/Library/Application\ Support/EvenScribe/RoomRecorder/config.json   # add:  "update_channel": "test",
chmod 600 ~/Library/Application\ Support/EvenScribe/RoomRecorder/config.json
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.evenscribe.room-recorder.plist
```
A typo leaves it on `stable`; the fleet card's Room cell shows the channel tag once 0.1.8 reports it.

## 7. Acceptance §13.5 on Home Office — tell me before each item, I verify on production after each
1. Normal update: 0.1.7 checks at the end of its next successful poll, downloads, swaps. Card shows 0.1.8.
2. Withdraw: `curl -sS -X POST "$BASE/api/admin/releases/<rel_id>/withdraw" -H "$AUTH" | jq` → Home Office returns to 0.1.7.
   Then republish 0.1.8 to `test` (step 4 again, same zip).
3. No new microphone prompt across either swap.
4. Start a recording, wait for a check: the log shows the deferral, nothing swaps until the session ends.
5. Corrupted zip: publish a deliberately damaged copy to `test`; app stops, resident unchanged, card names the reason. Withdraw it.
6. Kill between the moves: `kill <script pid>` (never `kill -9`) — resident holds a working bundle, room polls again. Repeat item 1.
7. Publish to `test` reaches Home Office and no clinic room.
Only after item 7: publish the same `release.json` to `stable`.
