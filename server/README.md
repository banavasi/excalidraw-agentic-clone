# Excaliboard sync server

Phase 2 of [excaliboard](../docs/design/phase2-cloud-sync.md): a **versioned, opaque-ciphertext blob store** for single-user multi-device sync. The server never sees plaintext — every payload is client-encrypted (AES-GCM / JWK) and the server reasons only over the integer `scene_version` (the optimistic-concurrency token) and IVs. Conflict resolution (`reconcileElements`) runs on the client.

## Architecture

```
client ──HTTPS (base64 ciphertext)──► FastAPI :8789 ──► Postgres 17
         push / pull / 409-reconcile        │
                                            └─ store abstraction:
                                               InMemoryStore (tests/dev)
                                               PostgresStore  (asyncpg, prod)
```

The HTTP contract and the safety-critical logic (compare-and-swap, 409-reconcile, auth, base64, `since` filtering, file last-write-wins) live above the `Store` protocol, so they are fully unit-tested against the in-memory backend. The asyncpg SQL path is exercised by an integration test that runs when `DATABASE_URL` is set (i.e. on cosmos / against a real Postgres).

## API (mounted at `/sync`)

| Method & path | Purpose |
| --- | --- |
| `GET /sync/healthz` | health (no auth) — `{status, db}` |
| `GET /sync/index?since=<epoch_ms>` | board index for the user (drives the list); `since` is inclusive, client de-dupes by id |
| `GET /sync/boards/{id}` | pull one board's scene, or 404 |
| `PUT /sync/boards/{id}` | push (CAS on `base_version`) → `200 {scene_version}` or `409 {scene_version, iv, ciphertext}` |
| `DELETE /sync/boards/{id}` | soft-delete (tombstone) |
| `GET/PUT /sync/boards/{id}/files/{fileId}` | pull/push a file blob |

All requests except `healthz` need `Authorization: Bearer <SYNC_BEARER>`.

**Hardening** (adversarial review): a whole-request body cap rejects oversized bodies _before_ buffering (anti-OOM, pre-auth); aggregate caps bound disk (boards-per-user, files-per-board → 413); the concurrent create-vs-create race resolves to one Accepted + one 409 (never 500); soft-deleted boards are reaped at startup. See `.env.example` for the knobs.

## Develop & test

```bash
cd server
uv run --extra test pytest -q          # in-memory; no Postgres needed
```

Run locally against the in-memory store:

```bash
SYNC_BEARER=dev-token uv run uvicorn app.main:app --reload --port 8789
```

## Deploy (cosmos)

Service `excaliboard` at `/opt/excaliboard`, API `:8789`, Postgres `:5436`. Secrets come from 1Password Mithra (`excaliboard-db-cosmos`, `excaliboard-sync-auth`); see `.env.example`, `docker-compose.yml`, and `backup_pg.sh` (nightly dump 03:15 UTC, 14-day retention).

Deploy is **CI/CD** — GitHub Actions builds/tests then SSHes to cosmos and runs the on-box deploy. The pipeline (`../.github/workflows/excaliboard-deploy.yml`), the on-box script, nginx vhost, and the one-time bootstrap runbook live in [`deploy/`](deploy/README.md).
