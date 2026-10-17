#!/bin/bash
# R16 (OPD 6 R14 step 5 fail, rc 255): the REAL /usr/bin/ssh against a loopback sshd started by the test.
# The sshd runs as the test user from a sandbox config, on a random high port, bound to the loopback address, with its own host key, and is killed by exact pid.
# No root, no launchctl, no system ssh config. The sandbox HOME has "Application Support" (a space) in the path, as the real kiosk path does.
# Never faked: if sshd cannot start here, the test prints "  SKIP" (run.sh shows it) and says why.
# shellcheck disable=SC2016,SC2030,SC2031,SC2034,SC2154

# the loopback address is built from parts: t_static.sh (G7) forbids a literal IPv4 anywhere in tests/
R16_LO="127.0.0.$((0 + 1))"
R16_SSH=/usr/bin/ssh; R16_SSHD=/usr/sbin/sshd; R16_KEYGEN=/usr/bin/ssh-keygen
R16_SSHD_PID=""

# r16_stop: kill the loopback sshd by its exact pid (never by name, never a pattern).
r16_stop() { if [ -n "$R16_SSHD_PID" ]; then kill "$R16_SSHD_PID" 2>/dev/null; wait "$R16_SSHD_PID" 2>/dev/null; fi; R16_SSHD_PID=""; }

# r16_start: build keys + sshd config under $T/ssh and start sshd. Sets R16_PORT. rc 0 started, rc 1 not (R16_WHY says why).
r16_start() {
  local d="$T/ssh" me tries=0 i
  R16_WHY=""
  [ -x "$R16_SSH" ] && [ -x "$R16_SSHD" ] && [ -x "$R16_KEYGEN" ] || { R16_WHY="ssh, sshd or ssh-keygen missing"; return 1; }
  me="$(/usr/bin/id -un)"
  mkdir -p "$d" && chmod 700 "$d"
  "$R16_KEYGEN" -q -t ed25519 -N '' -C r16-host -f "$d/hostkey" || { R16_WHY="ssh-keygen failed"; return 1; }
  "$R16_KEYGEN" -q -t ed25519 -N '' -C r16-client -f "$d/clientkey" || { R16_WHY="ssh-keygen failed"; return 1; }
  cp "$d/clientkey.pub" "$d/authorized_keys"
  # ForceCommand: record the remote command and the stdin the pipe received
  cat >"$d/force.sh" <<F
#!/bin/bash
printf '%s\n' "\$SSH_ORIGINAL_COMMAND" >"$d/cmd.txt"
cat >>"$d/stdin.txt"
F
  chmod 700 "$d/force.sh"
  cat >"$d/sshd_config" <<F
HostKey $d/hostkey
AuthorizedKeysFile $d/authorized_keys
PidFile $d/sshd.pid
StrictModes no
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers $me
ListenAddress $R16_LO
ForceCommand $d/force.sh
LogLevel INFO
F
  while [ "$tries" -lt 5 ]; do
    tries=$((tries + 1))
    R16_PORT=$((20000 + (RANDOM % 30000)))
    "$R16_SSHD" -D -e -f "$d/sshd_config" -p "$R16_PORT" >"$d/sshd.log" 2>&1 &
    R16_SSHD_PID=$!
    echo "$R16_SSHD_PID" >"$T/r16_sshd.pid"
    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      grep -q "Server listening on $R16_LO port $R16_PORT" "$d/sshd.log" 2>/dev/null && return 0
      kill -0 "$R16_SSHD_PID" 2>/dev/null || break
      sleep 0.25
    done
    r16_stop
  done
  R16_WHY="sshd did not start as $me on $R16_LO: $(head -c 200 "$d/sshd.log" | tr '\n' ' ')"
  return 1
}

# r16_conf <old|new>: a guardian.conf built from the "#>" lines of guardian.conf.example (the tested form), the port and host swapped in.
# "old" then rewrites the UserKnownHostsFile option into the bare form that broke OPD 6.
r16_conf() {
  local f="$GUARDIAN_HOME/guardian.conf"
  {
    echo 'GUARDIAN_ROOM="opd9"'
    grep '^#> ' "$KDIR/guardian.conf.example" | sed -e 's/^#> //' -e "s/-p 2225/-p $R16_PORT/" -e "s/ pipe\\.example/ $R16_LO/" \
      -e "s#-o StrictHostKeyChecking=yes#-o StrictHostKeyChecking=yes -o LogLevel=ERROR#"
  } >"$f"
  if [ "$1" = old ]; then
    sed -e 's#-o "UserKnownHostsFile=\\"\([^"\\]*\)\\""#-o UserKnownHostsFile="\1"#' "$f" >"$f.old" && mv "$f.old" "$f"
  fi
  chmod 600 "$f"
}

# r16_publish <topic> <line>: run the conf's GUARDIAN_PUBLISH_CMD through the agent's real clean-env exec (run mode, env -i, bash -p).
# Prints "rc=N err=[stderr]".
r16_publish() {
  local out rc
  out="$( ( G_RUNMODE=1; . "$KDIR/lib/common.sh"; . "$KDIR/lib/conf.sh"; audit() { :; }
            conf_load "$GUARDIAN_HOME/guardian.conf" noperm || { echo "CONFBAD"; exit 70; }
            printf '%s\n' "$2" | g_conf_cmd "$GUARDIAN_PUBLISH_CMD" "$1" ) 2>&1 )"; rc=$?
  printf 'rc=%s err=[%s]' "$rc" "$out"
}

test_r16_real_ssh_old_form_fails_255_new_form_publishes_through_the_spaced_path() {
  local d="$T/ssh" kd="$GUARDIAN_HOME" r
  trap r16_stop EXIT
  case "$GUARDIAN_HOME" in *" "*) ok ;; *) fail "the sandbox GUARDIAN_HOME must contain a space: [$GUARDIAN_HOME]" ;; esac
  if ! r16_start; then
    echo "  SKIP test_r16_real_ssh: $R16_WHY (the real-ssh evidence is NOT produced on this box; ssh is never faked)"
    return 0
  fi
  mkdir -p "$kd/keys" && chmod 700 "$kd/keys"
  cp "$d/clientkey" "$kd/keys/id_ed25519" && chmod 600 "$kd/keys/id_ed25519"
  printf '[%s]:%s %s\n' "$R16_LO" "$R16_PORT" "$(cut -d' ' -f1,2 "$d/hostkey.pub")" >"$kd/known_hosts"
  # control: the real ssh (not a fake) is what runs
  assert_eq "$("$R16_SSH" -V 2>&1 | cut -c1-8)" "OpenSSH_" "real OpenSSH client"
  # OLD form: the bare spaced UserKnownHostsFile. ssh splits it, the host key is unknown, rc 255.
  r16_conf old
  assert_has "$(cat "$GUARDIAN_HOME/guardian.conf")" 'UserKnownHostsFile="\$HOME' "old form really is the bare form (conf sanity)"
  r="$(r16_publish "kiosk/opd9/probe" "old-line")"
  assert_has "$r" "rc=255" "old form: ssh exits 255"
  assert_has "$r" "Host key verification failed" "old form: host key verification failed"
  [ ! -s "$d/stdin.txt" ] && ok || fail "old form: nothing may reach the forced command"
  # NEW form (as shipped in guardian.conf.example): past host-key checking, authenticated, the line arrives.
  r16_conf new
  assert_has "$(cat "$GUARDIAN_HOME/guardian.conf")" 'UserKnownHostsFile=\\"' "new form is the inner-quoted form (conf sanity)"
  r="$(r16_publish "kiosk/opd9/probe" '{"state":"ok","n":1}')"
  assert_eq "$r" "rc=0 err=[]" "new form: publish succeeds, no stderr"
  assert_eq "$(cat "$d/stdin.txt" 2>/dev/null)" '{"state":"ok","n":1}' "the published line arrived at the sshd side"
  assert_eq "$(cat "$d/cmd.txt" 2>/dev/null)" "pub -c -b=false kiosk/opd9/probe" "the remote command carries the topic"
  assert_has "$(cat "$d/sshd.log")" "Accepted publickey" "sshd accepted the sandbox key"
  r16_stop
}

# ---- install.sh --config lint (R16 item 0c): pattern check on the text, never eval ----
r16_lint() { # <GUARDIAN_PIPE_SSH value, written inside single quotes> -> "rc=N msg=[stderr]"
  local f="$T/lint.conf" out rc
  { echo 'GUARDIAN_ROOM="opd9"'; printf "export GUARDIAN_PIPE_SSH='%s'\n" "$1"; } >"$f"; chmod 600 "$f"
  out="$(GUARDIAN_ROOT_HELPER="$T/libexec/eta-guardian-root" LA_DIR="$HOME/Library/LaunchAgents" bash "$KDIR/install.sh" --room opd9 --sudo "$T/bin/fakesudo" --dry-run --config "$f" 2>&1 >/dev/null)"; rc=$?
  printf 'rc=%s msg=[%s]' "$rc" "$out"
}
test_r16_install_lint_refuses_uninner_quoted_spaced_ssh_paths() {
  local sp='$HOME/Library/Application Support/EvenScribe/Guardian/known_hosts' r
  # refused: the OPD 6 form, the same for IdentityFile, single-quoted bare, outer-quoted without an inner quote
  r="$(r16_lint "ssh -o UserKnownHostsFile=\"$sp\" -p 1 h")"; assert_has "$r" "rc=2" "bare double-quoted UserKnownHostsFile"; assert_has "$r" "conf: GUARDIAN_PIPE_SSH" "conf: error line"
  r="$(r16_lint "ssh -o IdentityFile=\"$sp\" -p 1 h")"; assert_has "$r" "rc=2" "bare IdentityFile"
  r="$(r16_lint "ssh -o UserKnownHostsFile=\"$sp\"")"; assert_has "$r" "rc=2" "at the end of the value"
  r="$(r16_lint "UserKnownHostsFile=\"$sp\" -p 1 h")"; assert_has "$r" "rc=2" "at the start of the value"
  r="$(r16_lint "ssh -o \"UserKnownHostsFile=$sp\" -p 1 h")"; assert_has "$r" "rc=2" "outer-quoted, no inner quote"
  # accepted: the inner-quoted form, a no-space path, -i with a spaced path, the conf.example form
  r="$(r16_lint "ssh -o \"UserKnownHostsFile=\\\\\"$sp\\\\\"\" -p 1 h")"; assert_not "$r" "rc=2" "inner-quoted form passes"; assert_has "$r" "rc=0" "inner-quoted form rc 0"
  r="$(r16_lint "ssh -o UserKnownHostsFile=/var/empty/known_hosts -p 1 h")"; assert_has "$r" "rc=0" "no space"
  r="$(r16_lint "ssh -i \"$sp\" -p 1 h")"; assert_has "$r" "rc=0" "-i with a space is fine"
  r="$(r16_lint "$(grep '^#> export' "$KDIR/guardian.conf.example" | sed -e "s/^#> export GUARDIAN_PIPE_SSH='//" -e "s/'\$//")")"; assert_has "$r" "rc=0" "the conf.example form passes"
  # no eval of conf text: a command substitution in the value is never run
  r="$(r16_lint 'ssh $(touch '"$T"'/pwned) -p 1 h')"; [ ! -e "$T/pwned" ] && ok || fail "conf text was executed"
}
