# Excaliboard Phase 2 — Automatic Cloud Sync (design spec)

> **Status:** APPROVED for build — signed off 2026-06-22 (D1 exposure finalized at deploy). **Drafted:** 2026-06-21. Depends on Phase 1 (Workboards). Parent: `docs/design/excaliboard-spec.md` §5 (this is the executable expansion).

## 1. Goal & shape

Single-user, multi-device cloud sync: your boards follow you across web + desktop, saved automatically. **No live multiplayer in v1** (data model stays multiplayer-ready). The **board id is the sync unit** (it already is, from Phase 1). The server is a **versioned, opaque-ciphertext blob store** — it never sees plaintext; `reconcileElements` runs client-side because only the client holds the key.

```
[Web/Desktop client]                         [cosmos /opt/excaliboard]
 Excalidraw editor                            FastAPI sync service :8789
 Phase-1 IndexedDB ─► SyncEngine ──HTTPS──►   ├─ Postgres 17 (board, scene, file_blob, device, app_user)
 (board blobs +       push/pull/outbox        └─ nightly pg_dump → /mnt/backups/excaliboard
  index)              reconcileElements()      exposure: Cloudflare tunnel → nginx /sync/  (or tailnet)
```

## 2. Reuse, don't reinvent

The collab stack's room model is the **wrong** primitive (key-in-URL, ephemeral, multi-peer). The **reusable** assets (verified in-repo) are reused verbatim:

- `packages/excalidraw/data/reconcile.ts` → `reconcileElements`, `shouldDiscardRemoteElement` (tie-break: keep local when editing, or `local.version > remote.version`, or equal version & `local.versionNonce <= remote.versionNonce`).
- `packages/excalidraw/data/encryption.ts` → `generateEncryptionKey`, `getCryptoKey`, `encryptData`, `decryptData`, `createIV`, `IV_LENGTH_BYTES=12` (AES-128-GCM / JWK).
- `excalidraw-app/data/firebase.ts` patterns → `saveToFirebase` (read→reconcile→encrypt→write), `isSavedToFirebase` (skip-redundant), file up/download — **ported into a new `SyncBackend`**, not forked.
- `excalidraw-app/collab/Collab.tsx` → `getSceneVersion`, `getSyncableElements`, `_reconcileElements`, `handleRemoteSceneUpdate`, the 20s throttle (`SYNC_FULL_SCENE_INTERVAL_MS`).

The one structural change: Firestore's in-transaction `read→reconcile→write` becomes **server-side compare-and-swap (`scene_version`) + client-side reconcile-on-409** (the server can't decrypt).

## 3. Server data model (Postgres 17)

Five tables; payloads are opaque ciphertext; the server only reasons over the integer `scene_version` (= `max(element.version)`) and IVs.

- `app_user(id, external_sub unique, created_at)` — single user in v1, modeled so multi-account is a non-breaking add.
- `board(id /*=client board id*/, user_id, name bytea, name_iv bytea, scene_version int, deleted bool, created_at, updated_at)` — server mirror of the Phase-1 index; **name is encrypted**.
- `scene(board_id pk, scene_version int, iv bytea, ciphertext bytea, byte_size, updated_at)` — the board's encrypted scene; `scene_version` is the optimistic-concurrency token.
- `file_blob(board_id, file_id, iv, ciphertext, byte_size, created_at, pk(board_id,file_id))` — images, encrypted separately (same key, fresh IV); last-write-wins per id (Excalidraw fileIds are content-addressed → collisions are identical bytes).
- `device(id, user_id, label, last_seen_at)` — replaces the `WeakMap<Socket>` version cache with a real persisted cursor; diagnostics.

Board-level deletes use `board.deleted` (so other devices learn of removals); a periodic job prunes flagged rows after a grace window. Element tombstones live inside the ciphertext (client honors `DELETED_ELEMENT_TIMEOUT` via `getSyncableElements`).

## 4. Sync API (REST/JSON, ciphertext base64, mounted at `/sync/`)

| Method & path | Purpose | Response |
| --- | --- | --- |
| `GET /sync/index?since=` | board index for the user (drives the Phase-1 list); `since` is an **inclusive** epoch-ms cursor (`updated_at >= since`) and the client de-dupes by `board_id` — inclusive so a board stamped in the cursor's millisecond is never permanently missed | `[{board_id, name_iv, name_ct, scene_version, deleted, updated_at}]` |
| `GET /sync/boards/{id}` | pull one board's scene | `{scene_version, iv, ciphertext}` or 404 |
| `PUT /sync/boards/{id}` | push (compare-and-swap on `base_version`) | `200 {scene_version}` or **`409 {scene_version, iv, ciphertext}`** |
| `DELETE /sync/boards/{id}` | soft-delete (`board.deleted`) | 200 |
| `GET/PUT /sync/boards/{id}/files/{fileId}` | pull/push a file blob | `{iv, ciphertext}` |
| `GET /sync/healthz` | health (compose healthcheck + fleet-obs) | 200 |

The `409` returns the current server scene so the client reconciles locally and retries — the server-can't-decrypt analogue of `saveToFirebase`'s in-transaction reconcile.

## 5. Conflict resolution (client-side, deterministic)

On a `409` (or a pull with newer `scene_version`): `decryptData` → `restoreElements` → `reconcileElements(local, remote, appState)` → `bumpElementVersions` → `updateScene({captureUpdate: NEVER})` (exactly `Collab._reconcileElements` + `handleRemoteSceneUpdate`) → recompute `scene_version`, re-encrypt with fresh IV, `PUT` with the merged `base_version`; bounded retry loop. **No new merge algorithm** — identical to the live collab path, driven by HTTP.

## 6. Client sync engine — `excalidraw-app/data/excaliboardSync.ts`

A `SyncBackend` interface + REST implementation (do not fork `firebase.ts`). Sits between Phase-1's per-board IndexedDB store and the server.

- **Push on change** (debounced 20s, `leading:false`): compute `getSceneVersion(getSyncableElements(...))`; skip if unchanged vs the **per-board last-synced version persisted in IndexedDB** (fixes the orphaned-`WeakMap`-on-reauth gap); else encrypt + `PUT base_version=lastSynced`.
- **Pull on focus / `visibilitychange→visible` / 20s timer:** `GET /sync/index`; for boards where server `scene_version` > local, pull+reconcile. Only the **active** board reconciles into the live scene; background boards just update their IndexedDB blob + index entry.
- **Offline-first:** Phase-1 IndexedDB stays the source of truth; add an **`outbox`** object store (`{board_id, base_version, scene_version, iv, ciphertext, queued_at}`). Writes land locally first (Phase 1 unchanged), then enqueue; a flusher drains on `online` + interval with the §5 retry loop. This is the persistent write buffer absent today.
- **Files:** on push, diff referenced fileIds vs server (404 check) and `PUT` the missing ones (orthogonal to elements, like `saveFilesToFirebase`).
- **Auth/config UI:** a small settings panel (server URL + the secret/sign-in) so non-dev devices can connect.

## 7. Cosmos deployment (cosmos-service-pattern)

Service `excaliboard`, port `:8789` (8787/8788 taken), Postgres `127.0.0.1:5436` (avoids Phoenix 5434). `/opt/excaliboard/{docker-compose.yml, .env(0600), backups→/mnt/backups/excaliboard, data/postgres, backup_pg.sh}`.

- docker-compose: pinned `postgres:17` + the FastAPI service, `127.0.0.1` binds only (tailnet reaches via `100.107.79.35:8789`), `restart: unless-stopped`, healthcheck on `/sync/healthz`.
- `.env` from 1P Mithra: `op read op://Mithra/excaliboard-db-cosmos/password`, `op read op://Mithra/excaliboard-sync-auth/static_bearer` (chmod 0600).
- `backup_pg.sh` (clone of Phoenix's, port 5436, 14-day retention), cron **03:15 UTC** (staggered vs Honcho 02:30 / Phoenix 03:00); add its dump to `~/bin/offsite_sync.sh`.
- Observability: OTLP → Phoenix `http://127.0.0.1:4317` (plain OTEL FastAPI instrumentation; the gateway TOOL-span pattern doesn't apply).
- Hardening (from the adversarial server review): the app enforces a whole-request **body cap** before buffering (`MAX_BODY_BYTES`, default 36 MiB) so the public-HTTPS path can't be OOM'd even on the tailnet bind that bypasses nginx; aggregate **caps** bound disk (`MAX_BOARDS_PER_USER`, `MAX_FILES_PER_BOARD` → 413); the concurrent **create-vs-create** race is resolved (`ON CONFLICT` + re-lock → one Accepted + one 409, never 500); soft-deleted boards are **reaped** at startup after `TOMBSTONE_GRACE_SECONDS`. Still add `client_max_body_size` + basic rate-limiting at the nginx/cloudflared front as defense-in-depth.

## 8. Build vs. deploy boundary

On sign-off I'll build, in this order, end-to-end:

1. **Server** (`server/` in-repo or a sibling): FastAPI app + migrations + tests (CRUD-over-ciphertext, 409 CAS), `docker-compose.yml`, `backup_pg.sh`, `Dockerfile`.
2. **Client** (`excalidraw-app/data/excaliboardSync.ts` + settings UI + wiring into Phase-1 onChange/focus), with tests (encrypt→push→pull→reconcile round-trip, outbox flush, 409 retry).
3. **Deploy to cosmos — via CI/CD** (mirrors the agentic-os fleet pattern). `.github/workflows/excaliboard-deploy.yml`: on `server/**` push (or manual dispatch) → `pytest` gate → SSH to `cosmos-pub` → rsync the `server/` subtree to `/opt/excaliboard` → idempotent `deploy-cosmos.sh` (`docker compose up -d --build` → `/sync/healthz` gate → image-tag rollback → nginx vhost). CI never reads 1P; secrets are 1P-Mithra-seeded into `/opt/excaliboard/.env` on the box. **One-time bootstrap** (see `server/deploy/README.md`): create the 1P Mithra items, set the `COSMOS_SSH_KEY/HOST/USER` Actions secrets (dedicated deploy key), run `bootstrap-cosmos.sh` on cosmos, and `cloudflared tunnel route dns cosmos excaliboard.shashankshandilya.me`. Edge reuses the existing Cloudflare wildcard tunnel + an nginx `excaliboard.shashankshandilya.me → :8789` vhost.

## 9. KEY DECISIONS (recommendations)

| # | Decision | Options | Recommended | Why |
| --- | --- | --- | --- | --- |
| D1 | **Exposure** | Tailnet-only (your default; `100.107.79.35:8789`) vs **public HTTPS** via the existing cloudflared tunnel + nginx `/sync/` | **Public HTTPS** (tailnet as LAN fallback) | "Follow me across devices" needs phones/LTE/non-tailnet machines. Reuses the live MCP-connector infra. ⚠️ This is the one choice that diverges from your tailnet-only default — confirm. |
| D2 | **Encryption** | Server-key (server can read) vs **E2E** (client-only key) | **E2E**, key in `op://Mithra/excaliboard-e2e-key`, imported once per device | Matches Excalidraw's `#key=` privacy model + your "secrets never plaintext" posture; reuses `encryptData`/`decryptData` unchanged. Server is pure ciphertext. |
| D3 | **Auth** | Static bearer vs OAuth 2.1+PKCE | **Static bearer (HTTPS) v1** (`op://Mithra/excaliboard-sync-auth`) | Single user; one secret. The `SingleUserProvider` OAuth code (`gateway/app/mcp_auth.py`) is a drop-in upgrade later. |
| D4 | **Backend lang** | FastAPI vs Rust vs Node | **Python FastAPI** | Matches the cosmos fleet stack (gateway is FastAPI), trivial fleet-obs/OTEL wiring; crypto is client-side so no CPU concern. |
| D5 | **Realtime** | Poll (20s + focus) vs WebSocket | **Poll** | No multiplayer v1; stateless, reconnect-safe; reconcile handles drift. WS is a later add. |

## 10. Definition of done — Phase 2

- Edit on device A → appears on device B (after focus/within 20s); offline edits queue and flush on reconnect; concurrent edits to the same board reconcile without loss (deterministic via `reconcileElements`).
- Server stores only ciphertext (verifiable: DB rows are opaque); board deletes propagate.
- Service live on cosmos under `/opt/excaliboard` with nightly backups + offsite; health green; traces in Phoenix.
- Client + server tests green; editor packages still untouched.
