#!/bin/bash
# orbox-job (herdr-kit, r415d; "--" separator fix per eta-refuter-2 #3021): the ONLY way any of our
# processes should start on orbox3. Wraps the command in a transient systemd --user scope with the ruled
# resource caps, so it can never touch more than 6 of the 12 cores or 16 GB, and always runs at nice 15 /
# IO class idle -- keeping the OT recorder (the room-recorder process, its audio device and its upload
# path) safe by construction regardless of what the job itself does. Note: --scope only carries cgroup
# limits (CPUQuota, MemoryMax); Nice and IO class are EXEC-time properties a transient scope cannot set on
# its own (systemd 259 refuses them there), so this wraps the command with `nice` + `ionice` INSIDE the
# scope instead -- tested working (25 Sep).
#
# usage: orbox-job [description] -- <command> [args...]
# To tie a unit to a job card for the audit trail (fleet #2974), bake the id into the description, e.g.
# orbox-job "J-123-hist-mine" -- ...
#
# "--" is REQUIRED and checked (eta-refuter-2 #3021: without this, an omitted "--" let the command's own
# first word silently become the description while the rest ran as a broken command).
set -u
[ $# -ge 1 ] || { echo "orbox-job: missing arguments (usage: orbox-job [description] -- <command> [args...])" >&2; exit 2; }
if [ "$1" = "--" ]; then
  DESC="orbox-job"
  shift
else
  DESC="$1"
  if [ "${2:-}" != "--" ]; then
    echo "orbox-job: missing '--' separator (usage: orbox-job [description] -- <command> [args...])" >&2
    exit 2
  fi
  shift 2
fi
[ $# -ge 1 ] || { echo "orbox-job: no command given after '--'" >&2; exit 2; }

# unit naming (fleet #2961/#2972, alarm-pause needs to find these AND two jobs with the same description
# must never collide): sanitise DESC into a slug, then suffix with $$ (this shell's own PID) so the unit
# name is unique per invocation even for identical descriptions. systemd-run refuses a duplicate unit
# name outright ("Unit ... already exists") -- exec'ing it directly here already fails loudly instead of
# falling back to an unscoped run; there is no fallback path to accidentally take.
SLUG=$(printf '%s' "$DESC" | tr -c 'A-Za-z0-9' '-' | sed 's/-\{2,\}/-/g; s/^-//; s/-$//')
[ -n "$SLUG" ] || SLUG="job"
UNIT="eta-${SLUG}-$$"
exec systemd-run --user --scope --unit="${UNIT}" \
  -p CPUQuota=600% -p MemoryMax=16G \
  --description="$DESC" --collect \
  -- nice -n 15 ionice -c3 "$@"
