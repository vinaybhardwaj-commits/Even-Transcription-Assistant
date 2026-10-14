def flag($k):
  ( .[$k] // false ) as $v
  | if ($v|type) == "string"
    then ( ($v | ascii_downcase) as $s
           | ($s != "" and ($s | test("^(false|0|no|none|null|off)$") | not)) )
    else ( $v != false and $v != null and $v != 0 and $v != "" )
    end;

def protected:
  . as $a
  | [ "protected","pinned","pin","hold","hold_reason","holdReason","keepalive",
      "do_not_reap","doNotReap","no_reap","frozen" ]
  | map(. as $k | $a | flag($k))
  | any;

def inflight:
  . as $a
  | [ "inflight_task","inflightTask","current_task","currentTask","running_task",
      "runningTask","active_task","activeTask","in_flight" ]
  | map($a[.]? // null)
  | map(select(. != null and . != "" and . != [] and . != {}))
  | (length > 0);

def qlen:
  ( [ (.queue?, .queued?, .tasks?, .pending?, .pending_tasks?, .pendingTasks? )
      | select(. != null)
      | if type == "array" then length
        elif type == "object" then (if length == 0 then 0 else 1 end)
        else 1 end ] | (max // 0) ) as $q
  | ( [ (.queue_depth?, .queueDepth?, .queued_count?, .queuedCount?, .pending_count?)
      | select(type == "number" or (type == "string" and test("^[0-9]+$")))
      | tonumber | floor ] | (max // 0) ) as $d
  | ([$q, $d] | max);

def busy:
  ( [ .state?, .status?, .phase? ]
    | map(select(type == "string")) | (.[0] // null)
    | (if . == null then null else (ascii_downcase | gsub(" +"; "_")) end) ) as $s
  | ( $s != null
      and ( ["busy","running","working","active","in_progress","inprogress","in-flight",
              "inflight","streaming","thinking","blocked","waiting_for_input"]
            | index($s) ) != null );

def epoch:
  if type == "number" then (if . > 1e11 then ./1000 else . end)
  elif type == "string" then
    ( if test("^[0-9]+(\\.[0-9]+)?$")
      then (tonumber | if . > 1e11 then ./1000 else . end)
      else
        ( capture("^(?<b>[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2})(\\.[0-9]+)?(Z|(?<s>[+-])(?<h>[0-9]{2}):?(?<m>[0-9]{2}))$")
          // null ) as $c
        | if $c == null then null
          else ( (try (($c.b + "Z") | fromdateiso8601) catch null) as $base
                 | if $base == null then null
                   else ( $base
                          - (if $c.s == "+" then 1 else -1 end)
                            * ( (($c.h // "0") | tonumber) * 3600
                              + (($c.m // "0") | tonumber) * 60 ) )
                   end )
          end
      end )
  else null end;

def agents:
  if type == "array" then map(select(type == "object"))
  elif (.agents? | type) == "array" then .agents | map(select(type == "object"))
  elif (.panes?  | type) == "array" then .panes  | map(select(type == "object"))
  else [] end;

def norm:
  . as $a
  | ( [ "last_activity","lastActivity","last_event","lastEvent","updated_at",
        "updatedAt","last_used","lastUsed","last_seen","lastSeen" ]
      | map($a[.]? // null) | map(select(. != null and . != "")) | (.[0] // null) ) as $last
  | { agent:  ($a.agent // $a.name // $a.id // "?"),
      pane:   ($a.pane // $a.pane_id // $a.target // "?"),
      raw:    $last,
      t:      ($last | epoch),
      a:      $a };

def fixed1:
  ((. * 10) | round) as $d
  | (($d / 10 | floor) | tostring) + "." + (($d % 10) | tostring);

# $NOW / $MIN come from --argjson (or are defaulted), so this file also runs as a
# bare `jq -r -f idle_reaper.jq agents.json` with no arguments at all.
($ARGS.named.NOW // now) as $now
| (($ARGS.named.MIN // 60) | tonumber) as $min
| agents
| map(norm)
| map(select(.t != null))
| map(select(($now - .t) / 60 > $min))
| map(select((.a | busy) | not))
| map(select((.a | protected) | not))
| map(select((.a | inflight) | not))
| map(select((.a | qlen) == 0))
| map({ agent, pane,
        idle_minutes: (($now - .t) / 60),
        last_activity: (.raw | tostring) })
| sort_by([ -(.idle_minutes), .agent, .pane ])
| .[]
| [ .agent, .pane, (.idle_minutes | fixed1), .last_activity ]
| @tsv
