#!/usr/bin/env bash
# bootstrap-cosmos.sh — ONE-TIME provisioning for excaliboard on cosmos. Run by hand on the box.
#
# Prereqs:
#   - 1Password items exist in vault Mithra: excaliboard-db-cosmos (field: password),
#     excaliboard-sync-auth (field: static_bearer).
#   - `op` signed in (or OP_SERVICE_ACCOUNT_TOKEN set in the environment).
#   - docker + compose v2; the running user in the docker group; passwordless sudo.
#
# Idempotent: re-running converges (it overwrites .env from 1P and re-asserts the cron line).
set -euo pipefail

SVC_DIR=/opt/excaliboard
BACKUP_DIR=/mnt/backups/excaliboard

# Service dir + local Postgres data dir, owned by the deploying user.
sudo install -d -o "$USER" -g "$USER" "$SVC_DIR"
install -d "$SVC_DIR/data"

# Backups live on the shared cosmos-backups volume (14-day retention via backup_pg.sh).
sudo install -d "$BACKUP_DIR"
[ -e "$SVC_DIR/backups" ] || ln -s "$BACKUP_DIR" "$SVC_DIR/backups"

# Seed .env from 1Password Mithra (never committed; 0600).
umask 077
cat > "$SVC_DIR/.env" <<EOF
DB_PASSWORD=$(op read "op://Mithra/excaliboard-db-cosmos/password")
SYNC_BEARER=$(op read "op://Mithra/excaliboard-sync-auth/static_bearer")
# Tighten to the origin your client runs from (the fork's app host). "*" is fine for a
# single-user E2E system (the bearer + client-only key are the real protection).
CORS_ORIGINS=*
PHOENIX_COLLECTOR_ENDPOINT=http://100.107.79.35:6006
EOF
chmod 600 "$SVC_DIR/.env"
echo "seeded $SVC_DIR/.env (0600)"

# Nightly pg_dump cron 03:15 UTC (staggered vs Honcho 02:30 / Phoenix 03:00).
CRON_LINE='15 03 * * * cd /opt/excaliboard && set -a && . ./.env && set +a && DB_PORT=5436 ./backup_pg.sh >> /var/log/excaliboard-backup.log 2>&1'
( crontab -l 2>/dev/null | grep -v 'excaliboard/backup_pg.sh'; echo "$CRON_LINE" ) | crontab -
echo "registered backup cron 03:15 UTC"

echo
echo "DONE. Remaining one-time steps (off-box):"
echo "  1. DNS:    cloudflared tunnel route dns cosmos excaliboard.shashankshandilya.me"
echo "  2. Backup: add the newest excaliboard dump to ~/bin/offsite_sync.sh"
echo "  3. Deploy: push to add-new-workboard (server/**) or run the 'excaliboard deploy' workflow."
