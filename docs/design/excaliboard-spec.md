# Excaliboard — Design Spec

> **Working codename:** _Excaliboard_ (placeholder — a self-hosted, multi-board, cloud-synced, desktop-capable Excalidraw with an agentic diagram-generation skill). Rename later.
>
> **Status:** DRAFT — awaiting sign-off. **Author:** Claude (Opus 4.8) + Shashank. **Date:** 2026-06-21. **Repo:** `excalidraw-agentic-clone` (branch `add-new-workboard`).

---

## 1. Vision

Take the Excalidraw I already love and add the three things it's missing for me, plus an agentic authoring layer:

1. **Workboards** — many independent canvases in one workspace; switch between them and reopen old ones (today there is exactly **one** canvas and no way back to an old one). _This is the #1 pain._
2. **Automatic cloud sync** — my boards follow me across web + desktop, saved automatically. The Excalidraw-Plus experience, self-built and self-hosted.
3. **Self-host + desktop** — served from my own infra, plus a Tauri desktop app (local-first).
4. **Agentic diagrams** — a Claude Code skill that generates _beautiful_ Excalidraw explanation diagrams and auto-files them per workspace **and** into the `~/brain` vault.

## 2. Decisions locked (this session)

| # | Decision | Choice |
| --- | --- | --- |
| Sync scope | What kind of sync? | **Multi-device, single user** (no live multiplayer in v1). Data model kept multiplayer-ready. |
| Sync backend | How is it built? | **Custom service on the cosmos OCI fleet** (`cosmos-service-pattern`: docker-compose under `/opt`, own Postgres, tailnet+localhost binds, nightly `pg_dump`, secrets via 1Password **Mithra**). |
| Hosting | Where is the web app served? | **Cosmos OCI fleet (self-host)** (the "honcho" in the original ask resolves to self-hosting on my own infra). |
| First milestone | Where do we start? | **Multi-canvas (Workboards), local-first** — ship it, then layer sync → Tauri → skill. |

Profile preferences applied throughout: design-doc-first (this doc), plan-execution (execute a signed-off phase end-to-end), secrets in 1P Mithra, cosmos-service-pattern for the backend, `fleet-obs` for backend observability, never auto-commit, update the machine/project maps.

## 3. The load-bearing architectural fact

A "board" / "document" / "tab" is **not a first-class concept anywhere in the editor.** There is exactly **one `Scene` per `App`**, and that singleton assumption is baked into ~200 event handlers, the `Renderer`, `LinearElementEditor`, the laser/eraser/lasso trail objects, `Store` snapshots, and the `History` stacks.

- `packages/element/src/Scene.ts` — single live Scene (element maps).
- `packages/element/src/store.ts` — single `StoreSnapshot` (the golden copy for delta tracking).
- `packages/excalidraw/history.ts` — single undo/redo pair.
- `packages/excalidraw/components/App.tsx` — monolithic; instantiates Scene/Store/History once (~L827–835); `updateScene` (~L4572) is the one mutation entry point.

**Therefore the strategy for every workstream is _document-swap, not multi-Scene_:** keep one live `Scene`/`Store`/`History` and treat a **workboard as a swappable persisted document** loaded into that single Scene via the existing `resetScene` → `updateScene` → `addFiles` contract (the same path share-links and collaboration already use). This deliberately avoids the CRITICAL core refactor.

> **Editor core stays untouched.** `Scene.ts`, `store.ts`, `App.tsx` core, `history.ts` are left as they are (one tiny additive hook to clear history on switch — see §4). All the real work lives in the **app** layer (`excalidraw-app/`).

## 4. Phase 1 — Workboards (local-first) **[FIRST MILESTONE]**

### 4.1 Model

A **workspace** holds many **workboards**. Storage is split by size:

- **localStorage** (small, fast, drives tab-sync events):
  - `excaliboard:index` → `[{ id, name, createdAt, updatedAt, lastOpenedAt, thumbnailRef }]`
  - `excaliboard:active` → active board id
  - `version-dataState:<id>`, `version-files:<id>` → **per-board** tab-sync stamps (today these are global in `app_constants.ts`; making them per-board fixes the two-tabs-fight risk).
  - legacy `excalidraw` / `excalidraw-state` kept read-only for one-time migration.
- **IndexedDB** (`idb-keyval`, large blobs):
  - new store `boards-store` (DB `boards-db`): key = `boardId` → `{ name, elements, appState }` persisted via `serializeAsJSON(...,"local")` shape so it round-trips through the editor.
  - existing `files-db` / `files-store` **kept single** (one store), but `clearObsoleteFiles()` is made board-aware: the live file set = union of `fileId`s referenced across **all** boards (derived on demand — no separate ref map to drift). Fixes the cross-board image-deletion bug.

> Why not localStorage per board: 5–10 MB cap blows up with several boards. Why not one IndexedDB DB per board: `idb-keyval`'s `createStore` is one-store-per-DB → DB-count explosion. **One store, board-namespaced keys.**

### 4.2 Switch orchestration (the correctness-critical path)

On switch from board A → B (`excalidraw-app/App.tsx`):

1. `LocalData.flushSave()` — **force** the 300 ms global debounce to land **before** anything else. (Without this, A's pending save can write into B's storage — explicit risk.)
2. Persist A's blob to `boards-store[A]` + update `excaliboard:index` (updatedAt, thumbnail).
3. Read B's blob from `boards-store[B]`; gather B's referenced files.
4. `restoreElements(rawB, null, { repairBindings: true })` + `restoreAppState(...)` — **mandatory** (regenerates/validates IDs, repairs arrow bindings & orphan `frameId`s).
5. `excalidrawAPI.updateScene({ elements, appState, captureUpdate: CaptureUpdateAction.NEVER })`
   - `excalidrawAPI.addFiles(filesForB)`. `NEVER` so the load is not an undoable action.
6. **Clear history** so undo can't reach across boards. Needs a thin additive hook to reset the `History` stacks via the imperative API (the only editor-package change in Phase 1; small & safe).
7. Set `excaliboard:active = B`.

`App.tsx onChange` keeps writing through `LocalData.save`, but board-scoped to `excaliboard:active`.

### 4.3 Migration (idempotent)

On load: if legacy `excalidraw`/`excalidraw-state` exist and `excaliboard:index` is empty → create "My first board" from the legacy scene, write index + active, leave legacy keys in place (harmless). Re-running converges to the same bytes.

### 4.4 UI

A **board switcher** built on the existing `Sidebar` / `AppSidebar` + `AppMainMenu` infra:

- List of boards with thumbnails (generated via `exportToBlob`/`exportToCanvas`, throttled on save).
- Actions: **New**, **Rename**, **Duplicate**, **Delete** (with confirm), reorder.
- Active board highlighted; click to switch. (A Cmd/Ctrl-P quick-switcher is a fast-follow.)

### 4.5 Files touched (Phase 1)

`excalidraw-app/app_constants.ts` (keys), `excalidraw-app/data/localStorage.ts` (`importFromLocalStorage`/`saveDataStateToLocalStorage` → board-scoped), `excalidraw-app/data/LocalData.ts`

- `excalidraw-app/data/FileManager.ts` (board-scoped persist + board-aware cleanup), `excalidraw-app/data/tabSync.ts` (per-board version keys), `excalidraw-app/App.tsx` (`initializeScene`/`onChange`/switch), new `excalidraw-app/workboards/*` (index store, switcher UI), one additive history-reset hook on the imperative API.

### 4.6 Edge cases / risks → mitigations

- Rapid switching → **flush before switch** (§4.2.1).
- Two tabs, two boards → **per-board version stamps** (§4.1).
- Image shared by two boards deleted → **board-aware cleanup** (§4.1).
- Cross-board binding/`frameId` leakage → **`restoreElements({repairBindings:true})` on every load**.
- Undo crossing boards → **clear history on switch** (§4.2.6).

### 4.7 Testing (per repo `CLAUDE.md`)

New tests in `excalidraw-app/tests/`: create/switch (content preserved), delete, duplicate, legacy migration, file isolation across boards, history does not cross boards. Gate with `yarn test:typecheck` + `yarn test:update`.

## 5. Phase 2 — Automatic cloud sync (multi-device, single user)

**Reuse the reconciliation core, discard the room model.** The existing collab stack (`collab/Collab.tsx`, `collab/Portal.tsx`, `data/firebase.ts`) is room-based, ephemeral, key-in-URL, unauthenticated, multi-peer — wrong primitive for "my private boards follow me." The genuinely reusable asset is **`packages/excalidraw/data/reconcile.ts`** (`reconcileElements` + `version`/`versionNonce` discipline) and the transactional write pattern of `firebase.ts:saveToFirebase` (read → decrypt → reconcile → encrypt → atomic write).

- **Backend (cosmos-service-pattern):** `/opt/excaliboard-sync` docker-compose; own Postgres; tailnet+localhost binds (never `0.0.0.0`); `.env` 0600; nightly time-offset `pg_dump` → `backups/` (14-day retention); secrets from 1P **Mithra** via `op`. Instrument with `fleet-obs` (traces → Phoenix). Exposed through the FastAPI gateway per profile pref.
- **Doc model:** `user → board → { sceneVersion, ciphertext, iv, name, updatedAt }`, one row per board (composes with Phase 1's per-board blobs). Per-**user** encryption key stored under the account — **not** in a URL hash.
- **Sync:** push on debounced `onChange`; pull via WS / Postgres `LISTEN/NOTIFY` snapshot → `reconcileElements` → `updateScene({captureUpdate: NEVER})`. Last-write-wins per board, server reconciled. Phase 1's IndexedDB store is the offline cache; reconcile on reconnect.
- **Files:** reuse `saveFilesToFirebase`/`fetch...` patterns, re-pathed `user/<uid>/files/<id>`, **with a real retention/cleanup policy** (the original never deletes).
- **Auth:** new dependency (custom JWT to start). The `excplus-auth` cookie / `app.excalidraw.com` redirect is **not** reusable auth — just a redirect heuristic to strip.

## 6. Phase 3 — Self-host + Tauri (local-first desktop)

**Dominant constraint:** all backend URLs + Firebase config are **compile-time `import.meta.env.VITE_APP_*` constants** (`data/index.ts`, `vite.config.mts`). Self-host/desktop is a **separate build with a different `.env` + feature gating**, not a runtime toggle.

- **Self-host web:** new `.env.selfhost` → point WS/backend/Firebase at cosmos (or drop them for offline single-user); `VITE_APP_ENABLE_TRACKING=false`, `VITE_APP_DISABLE_SENTRY=true` (the `Dockerfile` already builds this way). Bundle fonts locally (drop Google Fonts preconnect in `index.html`); strip the Excalidraw+ auto-redirect. Deploy via existing `Dockerfile` → nginx under `/opt` on cosmos, tailnet/localhost-bound, behind the gateway.
- **Tauri shell:** disable PWA/service-worker for the desktop build (`sw.js` + `tauri://` cache hazards); verify WebCrypto (`getRandomValues`) in the webview; confirm `isRunningInIframe()` doesn't false-positive and disable features; optionally route durable per-board storage to native FS via Tauri APIs (storage layer already abstracted behind `LocalData`); disable/redirect `window.location.origin`-based share-link construction.

## 7. Phase 4 — Agentic diagram skill (`/excaliboard` or extend `/visualize`)

**Extend, don't reinvent.** A `visualize` skill (topic → diagram PNG) and the `~/brain` `journal`/`pref` ecosystem already exist, plus `mcp__claude_ai_Excalidraw__*` tools. Compose them.

1. **Generate** Excalidraw element JSON with a fixed **style preset** in `appState` (font, roundness, palette tokens, arrow styles) for visual coherence.
2. **Guard:** always pipe through `restoreElements(raw, null, {repairBindings:true})` (top generator failure modes are ID collision + dropped bindings).
3. **Serialize** via `serializeAsJSON(...,"local")` → canonical `.excalidraw` (full fidelity).
4. **Preview** via `exportToBlob(..., "image/png")` (PNG embeds the scene for round-trip) **with a `getDimensions(w,h)` callback** (`exportToBlob` silently rejects past max canvas size).
5. **Dual-home filing:**
   - **Per workspace** → write a new Phase-1 workboard (board-scoped IndexedDB/FS keys via `serializeAsJSON` shape) so it opens in the editor.
   - **Into `~/brain`** → per `~/brain/CLAUDE.md` contract: PNG inline + `.excalidraw` as editable source, routed by `journal`/`pref` conventions, committed (vault is git-versioned).

## 8. Sequencing

```
Phase 1 Workboards (local)  ──►  Phase 2 Cloud sync  ──►  Phase 3 Self-host + Tauri
        │                                                          │
        └────────────────────────►  Phase 4 Agentic skill  ◄──────┘   (composes onto 1 & 4)
```

Phase 1 is the foundation 2/3/4 all build on. Highest-leverage first files: `data/localStorage.ts` + `app_constants.ts` → `data/LocalData.ts` + `FileManager.ts` → `App.tsx` (`initializeScene`/`onChange`/switch).

## 9. Open questions (non-blocking; defaults chosen)

1. **Product name** — keep _Excaliboard_ or pick another? (Default: placeholder for now.)
2. **Auth provider (Phase 2)** — custom JWT vs. a hosted IdP. (Default: custom JWT on cosmos.)
3. **Tauri durability** — native FS vs. webview IndexedDB. (Default: IndexedDB v1, native FS later.)
4. **Skill packaging** — new `/excaliboard` skill vs. extend `/visualize`. (Default: new skill that reuses `visualize` internals.)
5. **Board switcher UX** — sidebar list (default) vs. top tab-bar.

## 10. Definition of done — Phase 1

- Create / switch / rename / duplicate / delete workboards; old boards reopen with full fidelity.
- Legacy single-scene auto-migrates to a default board.
- No content/file/history bleed across boards; two-tab safety holds.
- `yarn test:typecheck` + `yarn test:update` green; new workboard tests included.
- Editor core packages unmodified except one additive history-reset hook.
