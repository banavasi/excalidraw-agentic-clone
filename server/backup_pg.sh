#!/usr/bin/env bash
# Nightly pg_dump for excaliboard — clone of Phoenix's, port 5436, 14-day retention.
# Register on cosmos at 03:15 UTC (staggered vs Honcho 02:30 / Phoenix 03:00):
#   15 03 * * *  cd /opt/excaliboard && set -a && . ./.env && set +a && \
#                DB_PORT=5436 ./backup_pg.sh >> /var/log/excaliboard-backup.log 2>&1
# Backups land in /mnt/backups/excaliboard (on the shared cosmos-backups volume);
# add the newest dump to ~/bin/offsite_sync.sh.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/mnt/backups/excaliboard}"
DB_NAME="${DB_NAME:-excaliboard}"
DB_USER="${DB_USER:-excaliboard}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5436}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

: "${DB_PASSWORD:?DB_PASSWORD must be set (source /opt/excaliboard/.env first)}"
export PGPASSWORD="${DB_PASSWORD}"

TS="$(date -u +%Y%m%d_%H%M%S)"
OUT="${BACKUP_DIR}/excaliboard_${TS}.sql.gz"
mkdir -p "${BACKUP_DIR}"

pg_dump -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" "${DB_NAME}" | gzip > "${OUT}"
chmod 0600 "${OUT}"
echo "backup ok: ${OUT}"

# Prune dumps older than the retention window.
find "${BACKUP_DIR}" -name 'excaliboard_*.sql.gz' -type f -mtime +"${RETENTION_DAYS}" -delete
echo "pruned dumps older than ${RETENTION_DAYS} days"
