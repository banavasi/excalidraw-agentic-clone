# Excaliboard — CI/CD deploy to cosmos

Mirrors the **agentic-os** fleet pattern: GitHub Actions builds/tests the server, then SSHes
to `cosmos-pub` and runs an idempotent on-box deploy. The JS monorepo never lands on cosmos —
CI `rsync`s only the `server/` subtree to `/opt/excaliboard`.

```
push server/** (or manual dispatch)
  └─ GitHub Actions: pytest gate
       └─ deploy job: rsync server/ ─SSH(deploy key)─► cosmos:/opt/excaliboard
            └─ deploy-cosmos.sh: docker compose up -d --build → /sync/healthz gate
                 → (healthy) install nginx vhost · (unhealthy) roll back API image
cloudflared wildcard tunnel *.shashankshandilya.me → nginx :80 → /sync/ → 127.0.0.1:8789
```

Files: `../.github/workflows/excaliboard-deploy.yml` (pipeline) · `deploy-cosmos.sh` (on-box deploy)
· `nginx/excaliboard.conf` (vhost) · `known_hosts` (pinned cosmos host keys) · `bootstrap-cosmos.sh`
(one-time provisioning).

## One-time bootstrap

**1. 1Password (vault `Mithra`) — create:**
- `excaliboard-db-cosmos` → field `password` (Postgres password; `openssl rand -base64 32`)
- `excaliboard-sync-auth` → field `static_bearer` (client auth token; `openssl rand -base64 32`)
- `excaliboard-e2e-key` → the E2E encryption key — **client-only, never on the server** (generate in
  the app's Cloud-sync dialog → "Generate a new key", store here for your other devices).

**2. GitHub Actions secrets** (repo `banavasi/excalidraw-agentic-clone`) — a dedicated deploy key:
```bash
ssh-keygen -t ed25519 -N "" -f /tmp/excaliboard_deploy -C "excaliboard-ci@cosmos"
# add the PUBLIC key to cosmos (authorized_keys for the deploy user):
ssh ubuntu@cosmos-pub "cat >> ~/.ssh/authorized_keys" < /tmp/excaliboard_deploy.pub
# set the secrets:
gh secret set COSMOS_SSH_KEY -R banavasi/excalidraw-agentic-clone < /tmp/excaliboard_deploy
gh secret set COSMOS_HOST    -R banavasi/excalidraw-agentic-clone -b "129.153.87.154"
gh secret set COSMOS_USER    -R banavasi/excalidraw-agentic-clone -b "ubuntu"
shred -u /tmp/excaliboard_deploy /tmp/excaliboard_deploy.pub   # wipe the local private key
```

**3. Provision cosmos** (run on the box, after step 1):
```bash
# ship the bootstrap script (or git-pull this repo's server/deploy on the box)
scp server/deploy/bootstrap-cosmos.sh server/backup_pg.sh ubuntu@cosmos-pub:/tmp/
ssh ubuntu@cosmos-pub 'bash /tmp/bootstrap-cosmos.sh'
```
This creates `/opt/excaliboard` (+ `.env` seeded from 1P, 0600), the `/mnt/backups/excaliboard`
symlink, and the 03:15 UTC backup cron. (The first CI deploy lays down `backup_pg.sh` + the rest
via rsync.)

**4. DNS** (one line — the wildcard tunnel already points the zone at nginx):
```bash
ssh ubuntu@cosmos-pub 'cloudflared tunnel route dns cosmos excaliboard.shashankshandilya.me'
```

**5. Deploy:** push a change under `server/**` to `add-new-workboard`, or run the **excaliboard
deploy** workflow manually (`gh workflow run "excaliboard deploy"`). Verify:
`curl https://excaliboard.shashankshandilya.me/sync/healthz`.

## Client setup
In the app: **menu → Cloud sync…** → server `https://excaliboard.shashankshandilya.me`, the
`static_bearer` token, and the **same E2E key on every device**, then enable.

## Notes
- Schema is applied idempotently at server startup — no migration step in the pipeline.
- The deploy gates on `/sync/healthz` and rolls the API image back on failure; Postgres data and
  `.env` survive deploys (rsync excludes them).
- Tailnet `100.107.79.35:8789` stays a LAN fallback; public HTTPS is via the tunnel.
