#!/usr/bin/env bash
# Vivic online API release pipeline, v2.
#
#   deploy-v2.sh <40-hex-git-sha> [--dry-run] [--skip-nginx-verify] [--keep-staging-data]
#
# Design goals, in priority order:
#   1. Never make production worse than the previous release (fail closed,
#      stage first, automatic rollback).
#   2. Make the stop->start window as short as physically possible on a single
#      data directory with a single upstream port, and MEASURE it every release
#      instead of guessing.
#   3. Record enough evidence per release (JSON report) that the next
#      investigation does not have to guess.
#
# What changed from deploy.sh and why (see docs/decisions/2026-11-04-release-pipeline.md):
#   - Precompiled runtime: the image now carries src/online/index.js (built by
#     precompile.mjs during docker build). Production starts with plain `node`,
#     not `node --import tsx`, which removes the runtime TS transform from the
#     critical section. Falls back to tsx automatically if the artifact is
#     missing, so a build regression degrades instead of breaking the release.
#   - The staging container is now a real gate, not a formality: it must boot
#     inside BOOT_BUDGET_MS and answer warmup traffic, otherwise the deploy
#     aborts before production is touched.
#   - Health polling every HEALTH_POLL_INTERVAL_MS (100ms) instead of sleeping a
#     full second per attempt: the old loop alone could add up to ~1s of outage
#     after the new process was already serving.
#   - space.lock is handled explicitly. The app records the *container* PID
#     (pid 1 when launched by docker), so a SIGKILLed container leaves a lock
#     whose owner "looks alive" forever inside the next container. Left alone,
#     that turns one hard kill into a release that can never start.
#   - Every phase is timed and written to release-v2-reports/<ts>-<sha>.json.
set -Eeuo pipefail
umask 077

# --- configuration -----------------------------------------------------------
# Paths are overridable only for the offline dry-run harness; on the server the
# override switch is never set, so a stray environment cannot redirect a root
# deploy script at the wrong directory.
if [[ ${VIVIC_DEPLOY_ALLOW_OVERRIDE:-0} == 1 ]]; then
  DIR=${VIVIC_DEPLOY_DIR:-/opt/vivic-preview-20261025/backend}
  DATA=${VIVIC_DEPLOY_DATA:-/var/lib/vivic-preview-20261025}
  STAGING=${VIVIC_DEPLOY_STAGING:-/var/lib/vivic-staging}
  LOCKLIB=${VIVIC_DEPLOY_LOCKLIB:-/opt/vivic-preview-20261025/deploy-lock.sh}
else
  DIR=/opt/vivic-preview-20261025/backend
  DATA=/var/lib/vivic-preview-20261025
  STAGING=/var/lib/vivic-staging
  LOCKLIB=/opt/vivic-preview-20261025/deploy-lock.sh
fi
CURRENT=vivic-preview-20261027
PREVIOUS=vivic-api-prev
STAGE=vivic-api-staging
REPORTS=$DIR/release-v2-reports
DOCKERFILE=$DIR/Dockerfile.v2
PRECOMPILE=$DIR/precompile.mjs
PUBLIC_ORIGIN=vivic.edsionc.top

# Tunables (milliseconds unless noted).
BOOT_BUDGET_MS=${VIVIC_BOOT_BUDGET_MS:-6000}      # staging gate: abort above this
PROD_BOOT_TIMEOUT_MS=${VIVIC_PROD_BOOT_TIMEOUT_MS:-30000}
ROLLBACK_HEALTH_TIMEOUT_MS=${VIVIC_ROLLBACK_HEALTH_TIMEOUT_MS:-30000}
HEALTH_POLL_INTERVAL_MS=${VIVIC_HEALTH_POLL_MS:-100}
# docker stop only returns after the container exited, and the app unlinks
# space.lock inside its signal handler before exiting, so anything still present
# here is definitively stale. The wait is only filesystem-timing tolerance: a
# generous wait would add its full duration to the outage in the exact case
# (hard kill) where it is needed.
LOCK_RELEASE_TIMEOUT_MS=${VIVIC_LOCK_RELEASE_TIMEOUT_MS:-300}
STOP_GRACE=${VIVIC_STOP_GRACE:-10}
MIN_FREE_BYTES=${VIVIC_MIN_FREE_BYTES:-3221225472} # 3 GiB
WARMUP_INTENTS=${VIVIC_WARMUP_INTENTS:-4}
WARMUP_TIMEOUT_S=${VIVIC_WARMUP_TIMEOUT_S:-8}
KEEP_IMAGES=${VIVIC_KEEP_IMAGES:-3}

usage() {
  cat <<'EOF'
Usage: deploy-v2.sh <40-hex-git-sha> [options]

Options:
  --dry-run              Run every read-only preflight check, print the mutating
                         plan, and exit without building or starting anything.
  --skip-nginx-verify    Do not curl the public origin through nginx after the
                         switch (only for rehearsals; production runs keep it).
  --keep-staging-data    Keep /var/lib/vivic-staging for post-mortem inspection.
  --allow-stale-lock     (default) Move an orphaned space.lock aside instead of
                         refusing to start. Kept as an explicit flag for audit.
EOF
}

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
now_ms() { date +%s%3N; }

# --- arguments ---------------------------------------------------------------
DRY_RUN=0
NGINX_VERIFY=1
KEEP_STAGING_DATA=0
ALLOW_STALE_LOCK=1   # see the space.lock note in the header; disabling it makes a hard-killed container unrecoverable by automation.
sha=''
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=1 ;;
    --skip-nginx-verify) NGINX_VERIFY=0 ;;
    --keep-staging-data) KEEP_STAGING_DATA=1 ;;
    --allow-stale-lock) ALLOW_STALE_LOCK=1 ;;
    --help|-h) usage; exit 0 ;;
    -*) usage >&2; die "unknown option: $arg" ;;
    *) [[ -z $sha ]] || { usage >&2; die 'only one SHA argument is accepted'; }; sha=$arg ;;
  esac
done
[[ $sha =~ ^[a-f0-9]{40}$ ]] || { usage >&2; die 'expected a full 40-character lowercase Git SHA'; }

# --- report ------------------------------------------------------------------
report_fields=()
report() { report_fields+=("$(printf '"%s": %s' "$1" "$2")"); }
report_str() { report_fields+=("$(printf '"%s": %s' "$1" "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$2")")"); }
write_report() {
  local file=$REPORTS/$(date +%Y%m%dT%H%M%S)-${sha:0:12}.json
  # A report is evidence, not a deployment step: never let it turn a successful
  # release into a failed one (or a failed rollback into a stuck one).
  {
    mkdir -p "$REPORTS"
    {
      printf '{\n  '
      local IFS=$',\n  '
      printf '%s' "${report_fields[*]}"
      printf '\n}\n'
    } >"$file"
    chmod 600 "$file"
  } 2>/dev/null || { log "WARN could not write report $file"; return 0; }
  log "report: $file"
}

# --- lock library -------------------------------------------------------------
[[ -r $LOCKLIB ]] || die "Missing lock library: $LOCKLIB"
# shellcheck source=/dev/null
. "$LOCKLIB"
trap 'vc_lock_release' EXIT
if ! vc_lock_acquire "$VC_LOCK_BACKEND" "backend deploy v2 sha=$sha"; then
  vc_lock_refuse "$VC_LOCK_BACKEND" 'another deployment holds the global deploy lock'
  exit 1
fi

# --- docker helpers -----------------------------------------------------------
container_exists() { docker inspect "$1" >/dev/null 2>&1; }
image_has_precompiled_entry() {
  docker run --rm --entrypoint /bin/sh "$1" -c 'test -f /app/apps/local-api/src/online/index.js' >/dev/null 2>&1
}
# The start command must be identical on staging and production so the boot-time
# measured on 18891 predicts the outage on 18890.
start_cmd_for() {
  if [[ ${VIVIC_RUNTIME:-auto} == tsx ]]; then printf '%s' 'node --import tsx src/online/index.ts'; return; fi
  if [[ ${VIVIC_RUNTIME:-auto} == js ]]; then printf '%s' 'node src/online/index.js'; return; fi
  if image_has_precompiled_entry "$1"; then printf '%s' 'node src/online/index.js'
  else printf '%s' 'node --import tsx src/online/index.ts'; fi
}

# Poll /healthz until it returns {"ok":true}; sets HEALTH_MS to elapsed ms.
HEALTH_MS=0
health_wait() { # port timeout_ms
  local port=$1 timeout=$2 start status deadline
  start=$(now_ms); deadline=$((start + timeout))
  while (( $(now_ms) < deadline )); do
    if curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:$port/healthz" -o "$DIR/healthz.json" >/dev/null 2>&1; then
      if python3 -c 'import json,sys; assert json.load(open(sys.argv[1])).get("ok") is True' "$DIR/healthz.json" 2>/dev/null; then
        HEALTH_MS=$(( $(now_ms) - start )); return 0
      fi
    fi
    sleep "$(awk -v ms="$HEALTH_POLL_INTERVAL_MS" 'BEGIN{printf "%.3f", ms/1000}')"
  done
  HEALTH_MS=$(( $(now_ms) - start )); return 1
}

# Warmup: exercise the routes the SPA hits at boot, so its first real request
# does not pay for route/handler/sqlite warmup. Rule: transport error or 5xx is
# a failure; any 4xx counts as "route reached" (the staging copy has no session
# cookie, so 401/403 is expected and still proves the request path works).
WARMUP_FAILURES=0
WARMUP_MS=0
warmup() { # port label
  local port=$1 label=$2 start status path body
  WARMUP_FAILURES=0
  start=$(now_ms)
  for path in /healthz /api/space/session /api/providers/status /api/decision/status; do
    status=$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time "$WARMUP_TIMEOUT_S" \
      "http://127.0.0.1:$port$path" 2>/dev/null) || status=000
    log "  warmup[$label] GET $path -> $status"
    if [[ $status == 000 || $status == 5* ]]; then WARMUP_FAILURES=$((WARMUP_FAILURES + 1)); fi
  done
  body='{"message":"warmup ping"}'
  for ((i = 0; i < WARMUP_INTENTS; i++)); do
    status=$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time "$WARMUP_TIMEOUT_S" \
      -X POST -H 'content-type: application/json' --data "$body" \
      "http://127.0.0.1:$port/api/intent" 2>/dev/null) || status=000
    log "  warmup[$label] POST /api/intent #$((i + 1)) -> $status"
    if [[ $status == 000 || $status == 5* ]]; then WARMUP_FAILURES=$((WARMUP_FAILURES + 1)); fi
  done
  WARMUP_MS=$(( $(now_ms) - start ))
}

sqlite_check() { # container label
  docker exec "$1" node --no-warnings --input-type=module -e \
    "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync('/data/vivic/space.sqlite',{readOnly:true}); if(db.prepare('PRAGMA quick_check').all().some(x=>Object.values(x)[0]!=='ok')) throw Error('SQLite integrity check failed'); db.close();" \
    >/dev/null
  log "$2 sqlite quick_check ok"
}

# space.lock belongs to whichever container is running. docker stop/rollback
# guarantees the owner is gone, so a file still present here is an orphan from a
# hard kill (pid 1 inside the old namespace). It is preserved, never deleted.
clear_stale_lock() { # context
  [[ -e $DATA/space.lock ]] || return 0
  local kept=$DATA/space.lock.stale-$(date +%Y%m%dT%H%M%S)
  if [[ $ALLOW_STALE_LOCK == 1 ]]; then
    mv -- "$DATA/space.lock" "$kept"
    log "WARN orphaned space.lock moved aside to $kept ($1)"
  else
    die "orphaned space.lock present ($1); inspect $DATA before retrying"
  fi
}

wait_lock_release() {
  local deadline=$(( $(now_ms) + LOCK_RELEASE_TIMEOUT_MS ))
  while [[ -e $DATA/space.lock ]] && (( $(now_ms) < deadline )); do sleep 0.1; done
  [[ -e $DATA/space.lock ]] || return 0
  clear_stale_lock 'after stop'
}

nginx_verify() {
  local base=https://$PUBLIC_ORIGIN
  curl --noproxy '*' -k -fsS --max-time 10 --resolve "$PUBLIC_ORIGIN:443:127.0.0.1" "$base/healthz" -o "$DIR/healthz-public.json" \
    || die 'public /healthz through nginx failed'
  python3 -c 'import json,sys; assert json.load(open(sys.argv[1])).get("ok") is True' "$DIR/healthz-public.json" \
    || die 'public /healthz payload is not ok'
  curl --noproxy '*' -k -fsS --max-time 10 --resolve "$PUBLIC_ORIGIN:443:127.0.0.1" "$base/" -o /dev/null \
    || die 'public / through nginx failed'
  log 'nginx path verified (/healthz + /)'
}

# --- lifecycle ----------------------------------------------------------------
stage_created=0
prod_touched=0
success=0

rollback() {
  local reason=$1 failed=''
  log "ROLLBACK: $reason"
  if container_exists "$PREVIOUS"; then
    # Normal path: the new container already took over $CURRENT; park it and
    # bring the previous release back.
    if container_exists "$CURRENT"; then
      docker stop --time "$STOP_GRACE" "$CURRENT" >/dev/null 2>&1 || true
      failed="vivic-api-failed-$(date +%Y%m%dT%H%M%S)"
      docker rename "$CURRENT" "$failed" >/dev/null 2>&1 || true
      log "failed container preserved as $failed"
      report_str rollback_failed_container "$failed"
    fi
    wait_lock_release
    docker rename "$PREVIOUS" "$CURRENT" >/dev/null
    docker start "$CURRENT" >/dev/null
  else
    # Failed between `docker stop` and `docker rename`: $CURRENT is still the
    # last-good release, only stopped. Starting it is the whole rollback.
    log 'rollback: no previous container yet; restarting the stopped current release'
    wait_lock_release
    container_exists "$CURRENT" || die 'rollback impossible: neither current nor previous container exists'
    docker start "$CURRENT" >/dev/null
  fi
  local start; start=$(now_ms)
  if health_wait 18890 "$ROLLBACK_HEALTH_TIMEOUT_MS"; then
    report rollback_health_ms "$HEALTH_MS"
    report rollback_total_ms "$(( $(now_ms) - start ))"
    sqlite_check "$CURRENT" 'rollback'
    local image sha_prev
    image=$(docker inspect --format '{{.Config.Image}}' "$CURRENT")
    sha_prev=$(docker inspect --format '{{index .Config.Labels "vivic.git.sha"}}' "$CURRENT")
    [[ -n $sha_prev && $sha_prev != '<no value>' ]] || sha_prev=unversioned-original-baseline
    printf 'sha=%s\nimage=%s\ntime=%s\naction=rollback\nfailed=%s\n' \
      "$sha_prev" "$image" "$(date -Is)" "$failed" >"$DIR/DEPLOYED.tmp"
    mv "$DIR/DEPLOYED.tmp" "$DIR/DEPLOYED"
    report_str action rollback
    write_report
    printf 'ROLLBACK_OK image=%s sha=%s\n' "$image" "$sha_prev"
  else
    report_str action rollback-failed
    write_report
    die "rollback health check failed after ${HEALTH_MS}ms - manual intervention required (previous container renamed, image $image)"
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  if (( status != 0 && prod_touched == 1 && success == 0 )); then
    rollback "deploy failed (exit $status)" || status=1
  fi
  if (( stage_created == 1 )); then
    if (( status != 0 )); then
      local logfile=$DIR/staging-failure-$(date +%Y%m%dT%H%M%S).log
      docker logs "$STAGE" >"$logfile" 2>&1 || true
      chmod 600 "$logfile" 2>/dev/null || true
      printf 'STAGING_FAILURE_LOG=%s\n' "$logfile" >&2
    fi
    docker rm -f "$STAGE" >/dev/null 2>&1 || true
    if [[ $KEEP_STAGING_DATA == 0 && "$STAGING" == /var/lib/vivic-staging && ! -L $STAGING ]]; then
      rm -rf -- "$STAGING"
    fi
  fi
  vc_lock_release
  exit "$status"
}

# Install the lifecycle trap only now that rollback/cleanup are defined.
trap cleanup EXIT

# --- preflight (read-only) ----------------------------------------------------
log "release-v2 preflight sha=$sha dry_run=$DRY_RUN"
available=$(df -B1 --output=avail / | tail -n1 | tr -d ' ')
(( available >= MIN_FREE_BYTES )) || die "less than $MIN_FREE_BYTES bytes free on / ($available)"
[[ $(realpath "$DATA") == "$DATA" ]] || die "data dir is not canonical: $DATA"
[[ -f $DATA/space.sqlite ]] || die "missing $DATA/space.sqlite"
[[ -f $DIR/env.list ]] || die "missing $DIR/env.list (mode 600, private env)"
chmod 600 "$DIR/env.list"
[[ -f $DIR/uploads/$sha.tar ]] || die "missing upload $DIR/uploads/$sha.tar"
container_exists "$CURRENT" || die "current container $CURRENT is missing"
[[ ! -L $STAGING ]] || die 'unexpected staging symlink'
[[ ! -e $STAGING ]] || die 'inspect existing staging data first'
report_str sha "$sha"
report roll_free_bytes "$available"

base=$(docker inspect --format '{{.Config.Image}}' "$CURRENT")
[[ $(docker image inspect --format '{{.Id}}' "$base") == $(docker inspect --format '{{.Image}}' "$CURRENT") ]] \
  || die "current container does not run its own image ($base)"
image="vivic-api:$sha"
# Detection starts the image once in a throwaway container, so a dry run must not
# do it: the real start command is only known after the build anyway.
if [[ $DRY_RUN == 1 ]]; then
  start_cmd='(detected from the new image after build)'
else
  start_cmd=$(start_cmd_for "$base")
fi
log "base=$base image=$image start_cmd=[$start_cmd]"
report_str base_image "$base"
report_str start_cmd "$start_cmd"
log 'note: the start command is re-detected from the NEW image after the build'

if [[ $DRY_RUN == 1 ]]; then
  cat <<EOF
[dry-run] plan (nothing was changed):
  1. extract $DIR/uploads/$sha.tar -> $DIR/bundles/$sha
  2. apply required overlays
  3. docker build -f $DOCKERFILE --build-arg BASE=$base --build-arg REVISION=$sha -t $image
  4. copy $DATA -> $STAGING (consistent sqlite backup), drop space.lock from the copy
  5. docker run -d --name $STAGE -p 127.0.0.1:18891:8790 -v $STAGING:/data/vivic $image $start_cmd
  6. gate: boot<=${BOOT_BUDGET_MS}ms, warmup (healthz+session+providers+decision+${WARMUP_INTENTS}x intent), imports, sqlite
  7. docker stop --time $STOP_GRACE $CURRENT; wait space.lock release <=${LOCK_RELEASE_TIMEOUT_MS}ms
  8. docker rename $CURRENT $PREVIOUS; docker run -d --name $CURRENT -p 127.0.0.1:18890:8790 -v $DATA:/data/vivic $image $start_cmd
  9. health poll every ${HEALTH_POLL_INTERVAL_MS}ms (max ${PROD_BOOT_TIMEOUT_MS}ms), nginx verify, sqlite, DEPLOYED, report
 10. on any failure after step 7: automatic rollback to $PREVIOUS
EOF
  exit 0
fi

# --- build --------------------------------------------------------------------
bundle=$DIR/bundles/$sha
mkdir -p "$bundle"
tar -xf "$DIR/uploads/$sha.tar" -C "$bundle" --no-same-owner
python3 "$DIR/required-overlays/connection-qrcode-20261031-1/apply.py" "$bundle"
[[ -f $PRECOMPILE ]] || die "missing $PRECOMPILE"
cp -- "$PRECOMPILE" "$bundle/precompile.mjs"
t0=$(now_ms)
docker build --build-arg "BASE=$base" --build-arg "REVISION=$sha" \
  -f "$DOCKERFILE" -t "$image" "$bundle" >"$DIR/build-$sha.log" 2>&1 \
  || { tail -40 "$DIR/build-$sha.log" >&2; die 'docker build failed'; }
report build_ms "$(( $(now_ms) - t0 ))"
log "built $image in $(( $(now_ms) - t0 ))ms"
# Detect the runtime from the image that will actually run, not from its base.
start_cmd=$(start_cmd_for "$image")
report_str start_cmd_runtime "$start_cmd"
log "runtime for $image: [$start_cmd]"

# --- staging gate --------------------------------------------------------------
if container_exists "$STAGE"; then
  [[ $(docker inspect --format '{{index .Config.Labels "vivic.managed"}}' "$STAGE") == backend ]] \
    || die "container name $STAGE is taken by an unmanaged container"
  docker rm -f "$STAGE" >/dev/null
fi
stage_created=1
t0=$(now_ms)
cp -a "$DATA" "$STAGING"
report copy_ms "$(( $(now_ms) - t0 ))"
# A process lock belongs to the production instance, never to its staged copy.
rm -f "$STAGING/space.lock"
# Use the application runtime for the consistent backup: CentOS SQLite cannot
# read the STRICT tables this schema uses.
docker run --rm --user node -v "$DATA:/data/vivic:ro" -v "$STAGING:/staging" \
  --entrypoint node "$image" --no-warnings --input-type=module -e \
  "import { DatabaseSync, backup } from 'node:sqlite'; const db=new DatabaseSync('/data/vivic/space.sqlite',{readOnly:true}); await backup(db,'/staging/space.consistent.sqlite'); db.close(); console.log('consistent-backup-ok');" >/dev/null
rm -f "$STAGING/space.sqlite" "$STAGING/space.sqlite-wal" "$STAGING/space.sqlite-shm"
mv "$STAGING/space.consistent.sqlite" "$STAGING/space.sqlite"
chown --reference="$DATA/space.sqlite" "$STAGING/space.sqlite"

t0=$(now_ms)
docker run -d --name "$STAGE" --label vivic.managed=backend \
  --label "vivic.git.sha=$sha" --user node --restart no \
  --workdir /app/apps/local-api \
  -p 127.0.0.1:18891:8790 -v "$STAGING:/data/vivic" \
  --env-file "$DIR/env.list" "$image" $start_cmd >/dev/null
health_wait 18891 "$PROD_BOOT_TIMEOUT_MS" || { docker logs --tail 40 "$STAGE" >&2 || true; die 'staging container never became healthy'; }
stage_boot_ms=$(( $(now_ms) - t0 ))
report stage_boot_ms "$stage_boot_ms"
log "staging boot ${stage_boot_ms}ms (budget ${BOOT_BUDGET_MS}ms)"

docker exec "$STAGE" node --import tsx --input-type=module -e \
  "await import('./src/intent/pipeline.ts'); await import('./src/space/executor.ts'); await import('@vivic/contracts'); await import('@vivic/card-runtime');" >/dev/null
log 'staging dependency imports ok'
sqlite_check "$STAGE" 'staging'

warmup 18891 staging
report stage_warmup_ms "$WARMUP_MS"
report stage_warmup_failures "$WARMUP_FAILURES"
(( WARMUP_FAILURES == 0 )) || die "staging warmup saw $WARMUP_FAILURES failed request(s); refusing to touch production"

# The gate that makes the optimisation safe: a release whose cold start blows
# the budget is not allowed near production. Production keeps running.
if (( stage_boot_ms > BOOT_BUDGET_MS )); then
  die "staging boot ${stage_boot_ms}ms exceeds budget ${BOOT_BUDGET_MS}ms; production untouched"
fi

# --- the critical section ------------------------------------------------------
# Everything above this line is free. Below it, production has no listener on
# 18890 until the new container answers /healthz, so every millisecond counts.
stop_started=$(now_ms)
prod_touched=1
docker stop --time "$STOP_GRACE" "$CURRENT" >/dev/null
stopped_at=$(now_ms)
report stop_ms "$(( stopped_at - stop_started ))"
wait_lock_release
lock_at=$(now_ms)
report lock_release_ms "$(( lock_at - stopped_at ))"

if container_exists "$PREVIOUS"; then docker rm "$PREVIOUS" >/dev/null; fi
docker rename "$CURRENT" "$PREVIOUS"
docker run -d --name "$CURRENT" --label vivic.managed=backend \
  --label "vivic.git.sha=$sha" --user node --restart unless-stopped \
  --workdir /app/apps/local-api \
  -p 127.0.0.1:18890:8790 -v "$DATA:/data/vivic" \
  --env-file "$DIR/env.list" "$image" $start_cmd >/dev/null
health_wait 18890 "$PROD_BOOT_TIMEOUT_MS" || die 'new production container never became healthy'
up_at=$(now_ms)
prod_boot_ms=$(( up_at - stopped_at ))
gap_ms=$(( up_at - stop_started ))
report prod_boot_ms "$prod_boot_ms"
report gap_ms "$gap_ms"
log "production listening again: boot ${prod_boot_ms}ms, total no-listener window ${gap_ms}ms"

# --- verification (still inside the rollback window) ---------------------------
warmup 18890 production
report prod_warmup_ms "$WARMUP_MS"
report prod_warmup_failures "$WARMUP_FAILURES"
(( WARMUP_FAILURES == 0 )) || die "production warmup saw $WARMUP_FAILURES failed request(s)"
if [[ $NGINX_VERIFY == 1 ]]; then nginx_verify; fi
sqlite_check "$CURRENT" 'production'

backup=$DIR/../backups/db-$(date +%Y%m%dT%H%M%S)
mkdir -p "$backup"
cp -a "$DATA"/space.sqlite* "$backup/"
report_str backup "$backup"

printf 'sha=%s\nimage=%s\ntime=%s\nbackup=%s\naction=deploy\ngap_ms=%s\nstart_cmd=%s\n' \
  "$sha" "$image" "$(date -Is)" "$backup" "$gap_ms" "$start_cmd" >"$DIR/DEPLOYED.tmp"
mv "$DIR/DEPLOYED.tmp" "$DIR/DEPLOYED"
success=1
report_str action deploy
write_report

# --- housekeeping --------------------------------------------------------------
mapfile -t tags < <(docker image ls vivic-api --format '{{.Repository}}:{{.Tag}}')
if (( ${#tags[@]} > KEEP_IMAGES )); then
  for old in "${tags[@]:KEEP_IMAGES}"; do
    docker image rm "$old" >/dev/null 2>&1 || true
  done
fi
printf 'DEPLOY_OK sha=%s image=%s gap_ms=%s start=%s\n' "$sha" "$image" "$gap_ms" "$start_cmd"
