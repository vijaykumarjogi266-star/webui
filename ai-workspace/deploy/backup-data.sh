#!/usr/bin/env bash
# AI Workspace — data backup/restore.
#
# The JSON store is disposable; data/master.key is NOT. Losing master.key makes
# every saved provider API key permanently undecryptable (AES-256-GCM, no recovery
# path), which is the single worst failure mode this build has (BUILD_REVIEW §3).
# So this script tars the whole data dir, with the key inside it, into one 0600
# archive, and can put it back.
#
#   deploy/backup-data.sh                 # tar.gz into $DEST, prune to $KEEP
#   deploy/backup-data.sh show            # list available archives
#   deploy/backup-data.sh restore <file>  # stop service, swap data dir, restart
#
# Cron (02:15 daily):
#   15 2 * * * root APP_DIR=/opt/ai-workspace/ai-workspace /opt/ai-workspace/ai-workspace/deploy/backup-data.sh >/dev/null
# Ship the archive off-box afterwards (OCI Object Storage / rclone); a backup on the
# same disk is not a backup.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ai-workspace/ai-workspace}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
DEST="${DEST:-/var/backups/ai-workspace}"
KEEP="${KEEP:-14}"
SERVICE="${SERVICE:-ai-workspace}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

log() { printf '[backup] %s\n' "$*"; }

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

cmd="${1:-backup}"
case "$cmd" in
  backup)
    [ -d "$DATA_DIR" ] || { log "no data dir at $DATA_DIR — nothing to back up"; exit 0; }
    umask 077
    install -d -m 700 "$DEST"

    # Snapshot to a temp dir first: the store is written by a running process, and
    # copying an open file can yield a torn JSON. atomicWrite() means files are only
    # ever swapped by rename, so a copy is safe between writes — this just makes it
    # tidy and lets us verify before pruning.
    tmp="$(mktemp -d "$DEST/.staging.XXXXXX")"
    cp -a "$DATA_DIR"/. "$tmp/data/"
    archive="$DEST/ai-workspace-data-$STAMP.tar.gz"
    tar -czf "$archive" -C "$tmp" data
    chmod 600 "$archive"
    rm -rf "$tmp"

    # Verify the archive opens and the master key is actually inside it.
    tar -tzf "$archive" >/dev/null
    tar -tzf "$archive" | grep -q 'data/master.key' || log "WARNING: no master.key inside $archive (no key generated yet?)"
    log "wrote $archive ($(du -h "$archive" | cut -f1))"

    # Prune, newest-first, keeping $KEEP.
    ls -1t "$DEST"/ai-workspace-data-*.tar.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
      log "pruning $old"; rm -f "$old"
    done
    ;;

  show)
    ls -lh "$DEST"/ai-workspace-data-*.tar.gz 2>/dev/null || log "no archives in $DEST"
    ;;

  restore)
    archive="${2:-}"
    [ -f "$archive" ] || usage
    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
      log "stopping $SERVICE"
      systemctl stop "$SERVICE"
    fi
    [ -d "$DATA_DIR" ] && mv "$DATA_DIR" "$DATA_DIR.pre-restore.$STAMP" && log "kept old data at $DATA_DIR.pre-restore.$STAMP"
    install -d -m 700 "$(dirname "$DATA_DIR")"
    tar -xzf "$archive" -C "$(dirname "$DATA_DIR")"
    chown -R aiws:aiws "$DATA_DIR" 2>/dev/null || true
    log "restored $archive -> $DATA_DIR"
    log "start it with: systemctl start $SERVICE   (then curl localhost:${PORT:-3000}/api/health/ready)"
    ;;

  *) usage ;;
esac
