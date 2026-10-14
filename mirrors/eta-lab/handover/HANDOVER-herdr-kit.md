# HANDOVER herdr-kit (Claude Code -> OpenCode, FABLE 432) — 26 Sep ~11:20 box clock

## Role
Builder on the Mini: kit/ apply scripts (V-run installers), eta-bus-mcp identity, worker onboarding.

## Open items (bus ids — read these threads for detail)
1. Three apply scripts PASSed, waiting on V (--dry-run then --apply, hash pinned):
   eta-ci-c3-apply.sh 81207f53... (#3496), taghf-apply.sh eec46921... (#3490),
   hf2-gateway-apply.sh f51e9f30... (#3490). Root cause fixed in all three: `herdr --machine <name>`
   doesn't resolve eta-ci-c3/hf-1/hf-2 (labeled, not named) — each now uses the herdr machine ID.
2. After V's eta-ci-c3-apply.sh run: verify cap's bus identity, post `READY eta-ci-c3 w1:p1` (#3496,
   #3475). eta-refuter owes the per-pane + mount checks.
3. ~/.ssh/worker-keys/worker_bus_eta-ci-c3.pub and eta_ci_c3_sftp.pub are temporarily restored on the
   Mini (public keys only) — delete (named) once the above INSTALL-OK is reconfirmed.
4. hsend.sh fix: branch herdr-kit/hsend-machine-ids @ 5c59eef, PASSed (#3518). Merge to main is Fable's.
   Box's own herdr has no saved machines — `herdr machine add` there is separate, unstarted.
5. hf-2 gateway secret (#3416/#3429): once V applies hf2-gateway-apply.sh, read hf2_gateway_key.pub's
   fingerprint, patch start.sh on both Space repos to key the expected fp by ${SPACE_ID##*/} (fails
   closed on unknown SPACE_ID). Not started — no key exists yet.
6. Arm-4 gcloud shim PASSed at be2b6682... (box path ~/bin/gcloud, python3). Deploy is V's (3 commands
   already given — writing it myself was blocked by the permission classifier). Review copy at
   box:~/.gcloud-shim-DRAFT-for-review.py, delete after real deploy. Still blocked on Fable/V placing
   the real credential at box:~/.claude/secrets/vertex-arm4.json, and a live Vertex query for the pinned
   model id (no gcloud access anywhere reachable).
7. Non-blocking, queued, not applied: `|| fail` on eta-ci-c3-apply.sh's stanza-removal line; sudo grep
   for step_box_sftp_authkeys; mount smoke-check can't detect a failed/stale mount (#3496). hsend.sh
   duplicate-name refusal tried + reverted (hung a real call querying slow machines) — needs a cheaper
   design.
8. item 110 fork (#3475): box eta-data/cap/ is 700, blocks jail traversal even once mounted.
   eta-refuter suggests 0710. Fable's ruling, not mine.
9. Room->hostname mapping (#3489): no record for 9 of 11 rooms; only ORB3->orbox3 confirmed. Could not
   run the Home Office audio check — don't know its host.

## Never break
Never install/edit SSH trust myself (authorized_keys/sshd/known_hosts/cron/secrets) — V-run script only.
Never spawn/restart/tag a herdr agent — post the command, Fable runs it. Never chmod a VJ data path.
Never print a key/token. bash 3.2 on the Mini: heredocs must be function+redirect, never `x=$(cat<<EOF)`.

## Tools
mcp__eta-bus; herdr CLI read-only (machine names with "." in the label need the ID); `zsh kit/hsend.sh`
(must be zsh, not bash); ssh e2e-lab-ts (box) / e2e-ci (eta-ci-c3), read-only unless V-run.

## Wake-up checklist
1. bus_inbox. 2. Has V run the 3 apply scripts? If eta-ci-c3, verify cap + post READY. 3. Can the 2
.pub files be deleted yet? 4. Did Fable merge hsend / add box machines? 5. Has the arm-4 credential
landed? 6. Don't re-open item 110 or the room mapping — both wait on someone else.
