# App Build A Phase 0 - Home Office Mini runbook - 25 August 2026

This runbook stages and operates one fixed `tapewriter` candidate on the Home Office Mini. It
does not authorize App Build B and never uses the Mini's existing EvenScribe checkout as a test
workspace.

## 1. Verified transport

- SSH alias: `mini`
- Remote account: `vinaybhardwaj`
- Verified host: `Vinays-Mac-mini.local`, Apple silicon
- Cloudflare Access host: `ssh.llmvinayminihome.uk`
- Mini ED25519 host-key fingerprint: `SHA256:GlguKjyKTxK4F86HIrE+G8o3IL31WjmY1T+r1eEEs4U`
- Client public-key fingerprint: `SHA256:hoeujMjYSUDyhugEzWHqesZkKcd0EjULv4XDWkGCLJE`

The private key stays on the development Mac. Never disable host-key checking. A noninteractive
identity check is:

```sh
ssh -o BatchMode=yes mini 'hostname; whoami; sw_vers -productVersion; uname -m'
```

## 2. Safety gate

Before staging, building, recording, unplugging a microphone or pulling power:

1. Read Home Office with `scribe_diff_room`.
2. Require `recording:false` and `recording_session_id:null`.
3. Wait for any just-ended upload disagreement to settle and record the result in `notes.txt`.
4. Tell the room operator the kiosk will be unavailable during the physical protocol.
5. Close the kiosk page before native microphone tests so it is not a competing CoreAudio client.
6. In System Settings > Accessibility > Voice Control, require Voice Control to be off. Do not
   let the recorder change this setting. Record the read-only preflight below in `environment.txt`.
7. Reopen the kiosk page and confirm `listener_state:listening` after the protocol.

Never stop a production recording to make room for a test.

## 3. Isolated layout

Use only this private test root:

```text
~/EvenScribeBench/
  candidates/<full-candidate-sha>/
  runs/<full-candidate-sha>/<protocol>/
```

Create it with mode 700. Do not stage into `~/Documents/EvenScribe`; that checkout may be active
or backed by a file provider.

## 4. Stage the exact commit

From the development Mac, after the candidate commit exists:

```sh
SHA=$(git rev-parse HEAD)
ARCHIVE="${TMPDIR%/}/tapewriter-$SHA.tar"
ARCHIVE_NAME=$(basename "$ARCHIVE")
git archive --format=tar --output="$ARCHIVE" "$SHA" apps/room-recorder docs/handoff
(cd "$(dirname "$ARCHIVE")" && shasum -a 256 "$ARCHIVE_NAME" >"$ARCHIVE_NAME.sha256")
ssh mini "umask 077; mkdir -p ~/EvenScribeBench/candidates/$SHA ~/EvenScribeBench/runs/$SHA"
scp "$ARCHIVE" "$ARCHIVE.sha256" "mini:EvenScribeBench/candidates/$SHA/"
ssh mini "cd ~/EvenScribeBench/candidates/$SHA && shasum -a 256 -c tapewriter-$SHA.tar.sha256 && tar -xf tapewriter-$SHA.tar"
printf '%s\n' "$SHA" \
  | ssh mini "cat > ~/EvenScribeBench/candidates/$SHA/CANDIDATE_SHA"
printf '%s\n' "$SHA" | ssh mini 'cat > ~/EvenScribeBench/ACTIVE_CANDIDATE_SHA'
```

The candidate directory is immutable after verification. A source change requires a new commit
and a new directory.

## 5. Build and permission preflight

Build from a logged-in Terminal on the Mini so microphone permission is attributable and visible:

```sh
SHA=$(cat ~/EvenScribeBench/ACTIVE_CANDIDATE_SHA)
test "$(cat ~/EvenScribeBench/candidates/$SHA/CANDIDATE_SHA)" = "$SHA"
(cd ~/EvenScribeBench/candidates/$SHA && \
  shasum -a 256 -c "tapewriter-$SHA.tar.sha256")
cd ~/EvenScribeBench/candidates/$SHA/apps/room-recorder
swift package reset
swift build -c release 2>&1 | tee ~/EvenScribeBench/runs/$SHA/build-release.txt
shasum -a 256 .build/release/tapewriter \
  | tee ~/EvenScribeBench/runs/$SHA/binary.sha256

VOICE_CONTROL=$(defaults read com.apple.Accessibility CommandAndControlEnabled 2>/dev/null || \
  printf '0\n')
printf 'voice_control_enabled=%s\n' "$VOICE_CONTROL" \
  | tee -a ~/EvenScribeBench/runs/$SHA/environment.txt
if test "$VOICE_CONTROL" = 1; then
  printf '%s\n' \
    'STOP: turn off System Settings > Accessibility > Voice Control before microphone tests.' >&2
  false
fi
```

Run all 20 tests with the dependency-free CLT scratch recipe in section 4.2 of the test plan and
tee the complete output to `~/EvenScribeBench/runs/$SHA/swift-test.txt`. Do not begin microphone
or physical protocols unless all 20 pass. Because this candidate is a `git archive`, provenance
is the explicit `CANDIDATE_SHA` plus the verified archive hash; it is not a remote Git checkout.

Run a short foreground recording first. Grant microphone permission when macOS asks, confirm the
printed device is `TONOR TM20 Audio Device`, retain its stable UID, stop with Ctrl-C, verify, export
and listen. While it runs, speak with Terminal and a browser text field focused in turn; speech
must not be inserted into either field. A zero-audio run, injected text, any dropped block, any ring
overflow or a checkpoint gap over 2.5 s is a failure.

## 6. Detached recording

Start detached protocols from the Mini's logged-in Terminal after permission succeeds:

```sh
RUN=~/EvenScribeBench/runs/$SHA/one-hour-kill
mkdir -p "$RUN"
nohup .build/release/tapewriter record --out "$RUN/tape" --device "$TONOR_UID" \
  </dev/null >"$RUN/record.log" 2>&1 &
PID=$!
printf '%s\n' "$PID" >"$RUN/recorder.pid"
printf 'started_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$RUN/commands.txt"
```

SSH may monitor the process and issue the planned `kill -9`; it must not start an unpermitted
capture session. Record every PID and UTC action time. The Mini is already configured not to sleep
on AC, but verify `pmset -g custom` in `environment.txt`.

## 7. Evidence retrieval

Keep raw audio outside Git. Pull the immutable evidence directory to the approved protected local
location with:

```sh
rsync -a --protect-args "mini:EvenScribeBench/runs/$SHA/" \
  "/approved/protected/phase-0-evidence/$SHA/"
```

Generate SHA-256 files on the Mini before transfer and verify them after transfer. Commit only the
textual acceptance report and non-sensitive hashes. The authoritative evidence inventory remains
section 7 of the Phase 0 test plan.

## 8. Recovery

- SSH process gone, tape present: run `tapewriter verify` before any restart.
- Mini rebooted: confirm host fingerprint, collect the pre-restart verifier output, then restart in
  the same tape directory so the durable restart record preserves the surviving tail.
- TONOR after a cold-power event: the first 25 August run did not start IO until USB re-enumeration;
  the fixed-candidate H-02 rerun recovered without a post-boot replug. Do not infer readiness from
  enumeration. Let the recorder retry, and require durable sample-index growth. If it still does not
  advance after two five-second retry cycles, V accepted unplugging the TONOR USB cable for at least
  five seconds and reconnecting it as the hardware fallback. Device presence, process liveness and a
  level display are not substitutes for tape growth.
- Kiosk does not return after testing: reopen the Home Office room page on the Mini and confirm the
  Scribe listener is fresh before leaving.
- Any verifier `FAIL`, dropped block, unexpected discontinuity, or missing evidence: stop the
  protocol and preserve the directory unchanged. Do not silently rerun over it.
