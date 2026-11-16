#!/usr/bin/env bash
# publish-lock.sh — 前端发布锁：任何切 frontend-current 的动作都必须先拿这把锁。
#
# 用法：
#   publish-lock.sh status
#   publish-lock.sh run <tag> -- python3 releases/<版本>/publish.py
#   publish-lock.sh switch /opt/vivic-preview-20261025/releases/<版本>/web [tag]
#   publish-lock.sh release --pid <PID> --confirm
#
# 语义与 backend/deploy.sh 一致：flock 非阻塞，拿不到立即失败（不排队）；
# 进程退出自动释放；锁文件保留作 owner 记录，绝不建议手动删除。
set -Eeuo pipefail
umask 077

BASE=/opt/vivic-preview-20261025
POINTER=$BASE/frontend-current
CONF=/etc/nginx/conf.d/60-vivic-preview-20261025.conf
LOCKLIB=$BASE/deploy-lock.sh
[[ -r $LOCKLIB ]] || { echo "Missing lock library: $LOCKLIB" >&2; exit 1; }
# shellcheck source=/dev/null
. "$LOCKLIB"

die() { printf 'publish-lock: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
publish-lock.sh — frontend-current 发布锁

  status                                   查看两把锁：谁在部署、持有者 pid / 起始时间
  run <tag> -- <命令...>                    拿锁后执行命令（推荐：包住现有 publish.py，不改 release）
  switch <release>/web [tag]               拿锁后原子切换 frontend-current 指向
  release --pid <PID> --confirm             仅 owner：按锁记录里的 pid 终止持有进程并确认锁已释放

退出码：0 成功；1 拿不到锁/失败；被拒时 stderr 会打印持有者信息与文档路径。
文档：/opt/vivic-preview-20261025/DEPLOY_LOCK.md
EOF
}

conf_head_ptr() {
  # 当前 nginx 配置里 include 的 frontend-headers.conf 路径（正常应有 2 处）
  grep -o 'include [^;]*/frontend-headers\.conf;' "$CONF" 2>/dev/null | head -n1 | sed 's/^include //; s/;$//' || true
}

cmd_status() {
  printf 'deploy locks @ %s (%s)\n' "$(date -Is)" "$(hostname -s 2>/dev/null || hostname)"
  vc_lock_report_all
  printf '\nfrontend-current -> %s\n' "$(readlink -f -- "$POINTER" 2>/dev/null || echo '(missing)')"
  printf 'nginx headers    -> %s\n' "$(conf_head_ptr || true)"
}

cmd_run() {
  local tag=${1:-manual}
  shift || true
  [[ ${1:-} == -- ]] && shift
  (( $# )) || die 'run: nothing to execute (expected: run <tag> -- <command...>)'
  vc_lock_acquire "$VC_LOCK_FRONTEND" "frontend publish tag=$tag cmd=$*" \
    || { vc_lock_refuse "$VC_LOCK_FRONTEND" 'another task is publishing the frontend'; exit 1; }
  trap 'vc_lock_release' EXIT
  printf 'publish-lock: acquired %s (tag=%s)\n' "$VC_LOCK_FRONTEND" "$tag" >&2
  local rc=0
  if "$@"; then rc=0; else rc=$?; fi
  printf 'publish-lock: command exit=%s, releasing lock\n' "$rc" >&2
  vc_lock_release
  exit "$rc"
}

cmd_switch() {
  local target=${1:-} tag=${2:-manual} resolved before tmp
  [[ -n $target ]] || die 'switch: missing <release>/web path'
  [[ $target == /* ]] || die "switch: path must be absolute: $target"
  [[ -d $target ]] || die "switch: not a directory: $target"
  [[ -f $target/index.html ]] || die "switch: no index.html in $target"
  resolved=$(readlink -f -- "$target")

  nginx -t -q >/dev/null 2>&1 || die 'switch: nginx -t already fails BEFORE switch; fix nginx first'

  vc_lock_acquire "$VC_LOCK_FRONTEND" "frontend switch tag=$tag -> $resolved" \
    || { vc_lock_refuse "$VC_LOCK_FRONTEND" 'another task is publishing the frontend'; exit 1; }
  trap 'vc_lock_release' EXIT

  before=$(readlink -f -- "$POINTER" 2>/dev/null || true)
  tmp="$BASE/.frontend-current.next.$$"
  rm -f -- "$tmp"
  ln -sfn -- "$resolved" "$tmp"
  # rename(2) over the old symlink：单步原子切换，不存在 "指针短暂消失"
  mv -Tf -- "$tmp" "$POINTER"
  [[ $(readlink -f -- "$POINTER") == "$resolved" ]] || die 'switch: pointer verification failed after rename'

  printf 'SWITCHED %s -> %s (previous: %s)\n' "$POINTER" "$resolved" "${before:-<none>}" >&2

  if ! nginx -t -q >/dev/null 2>&1; then
    [[ -n ${before:-} ]] && { ln -sfn -- "$before" "$tmp"; mv -Tf -- "$tmp" "$POINTER"; }
    die 'switch: nginx -t failed after switch; pointer restored'
  fi

  local head; head=$(conf_head_ptr || true)
  case "$head" in
    "$resolved"/*) ;;
    *) printf 'WARN: nginx 仍 include 旧 headers：%s\n      （仅改指针不会改 nginx；需要 reload 前先更新 include）\n' "${head:-<none>}" >&2 ;;
  esac
  printf 'NEXT: nginx -s reload（仅当你同时改了 nginx 配置）\n' >&2
}

cmd_release() {
  local pid='' confirm=0
  while (( $# )); do
    case "$1" in
      --pid) pid=${2:-}; shift 2 ;;
      --confirm) confirm=1; shift ;;
      *) die "release: unknown argument $1" ;;
    esac
  done
  [[ $pid =~ ^[0-9]+$ ]] || die 'release: --pid <PID> required (见锁文件 pid= 字段)'
  (( confirm == 1 )) || die 'release: 只有确认过锁记录的 owner 才能手动解除，请加 --confirm'
  (( pid != $$ )) || die 'release: refusing to signal myself'
  kill -0 "$pid" 2>/dev/null || die "release: pid $pid is not running (锁应已自动释放；先跑 status)"
  local cmdline
  cmdline=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
  case "$cmdline" in
    *deploy.sh*|*rollback.sh*|*publish-lock.sh*|*publish.py*) ;;
    *) die "release: pid $pid 看起来不是部署进程，拒绝：$cmdline" ;;
  esac
  printf 'release: SIGTERM pid=%s cmd=%s\n' "$pid" "$cmdline" >&2
  kill -TERM "$pid" 2>/dev/null || true
  for ((i = 0; i < 15; i++)); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    die "release: pid $pid still alive after 15s; escalate to the owner, do NOT delete the lock file"
  fi
  if vc_lock_probe "$VC_LOCK_FRONTEND" && vc_lock_probe "$VC_LOCK_BACKEND"; then
    printf 'release: done, both locks are free\n' >&2
    vc_lock_report_all
  else
    die 'release: target exited but a lock is still held by another process'
  fi
}

main() {
  (( $# )) || { usage; exit 2; }
  local cmd=$1; shift
  case "$cmd" in
    status)  cmd_status ;;
    run)     cmd_run "$@" ;;
    switch)  cmd_switch "$@" ;;
    release) cmd_release "$@" ;;
    -h | --help | help) usage ;;
    *) die "unknown command: $cmd (try --help)" ;;
  esac
}

main "$@"
