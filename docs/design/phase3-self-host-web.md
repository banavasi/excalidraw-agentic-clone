# Excaliboard Phase 3 (web) — self-host the editor on cosmos (design spec)

> **Status:** DRAFT — awaiting sign-off. **Date:** 2026-06-23. **Depends on** Phase 2 (cloud sync, live).
> **Parent:** the executable expansion of `excaliboard-spec.md` §6 ("Self-host + Tauri"), scoped to the
> **static web** build only — **Tauri desktop is deferred** to a later doc. Supersedes §6's
> Firebase/WS-at-cosmos + Dockerfile-on-box framing for the web case.

## 1. Goal & shape

Host the fork's editor as a **static build on cosmos** so any device just opens a URL — no per-device
`yarn start`. It's the same SPA that runs locally; it talks only to the already-live Phase-2 sync API.

```
you (any browser, anywhere)
  └─ https://app.shashankshandilya.me
       └─ Cloudflare Access  (email gate — only you)         ← who can load the app
            └─ cloudflared wildcard tunnel  → nginx :80 (cosmos)
                 └─ /var/www/excaliboard-app  (static dist, try_files → index.html)
                      └─ browser JS ──HTTPS──► excaliboard.shashankshandilya.me   (Phase-2 sync API)
                                               bearer + E2E key (entered in-app, localStorage)
```

**Two planes, two secrets:** Cloudflare Access (email) gates *loading the app*; the **bearer + E2E key**
(entered once per browser in the Cloud-sync dialog) gate *the data*. The app build is **environment-agnostic
and secret-free** — one artifact, no boards or keys baked in.

## 2. Self-host build: what gets stripped (telemetry / phone-home)

Upstream excalidraw-app ships third-party calls we must disable for a clean self-host. Two classes:

| Surface | Fires? | Disable how | Evidence |
|---|---|---|---|
| **Sentry** | on load (off excalidraw.com host, but baked) | `VITE_APP_DISABLE_SENTRY=true` | `sentry.ts:5-24` |
| **SimpleAnalytics** | on every PROD load (NOT gated by tracking flag) | **delete / EJS-gate** the script block | `index.html:217-250` |
| **Google preconnect** | on load | remove | `index.html:96-97` |
| **Excalidraw+ auto-redirect** | on load | remove | `index.html:100-118` |
| **Fonts CDN** (`OSS_FONTS_CDN`) | on load (degrades offline) | point to local/self-hosted root | `woff2-vite-plugins.js:2`, `index.html:121` |
| Firebase (collab/shared images) | only in a collab room / shared image | empty `VITE_APP_FIREBASE_CONFIG` (no-ops silently) | `firebase.ts:60-65`, `env-production:17` |
| Collab WS · AI backend · JSON-share | only on room link / TTD / export-link | empty their `VITE_APP_*` URLs | `Collab.tsx:524`, `AI.tsx:45`, `data/index.ts:207` |

- **Loud** surfaces (Sentry, SimpleAnalytics, preconnect, redirect, fonts CDN) load on a *normal* page view
  → must be off. **Dormant** ones no-op unless you trigger their feature → emptying their env vars is
  belt-and-suspenders.
- Mechanism: a committed **`.env.selfhost`** at the repo root (Vite `envDir: ../`, `vite.config.mts:23`) with
  the non-secret flags, built via `vite build --mode selfhost` (so `.env.production`'s upstream URLs don't
  load). The `index.html` blocks are HTML, not env — **EJS-gate** them on a `VITE_APP_SELFHOST` flag (the app
  already runs `vite-plugin-ejs`) rather than hand-deleting upstream lines (keeps merges clean).
- **Keep** the PWA service worker (offline boards, no web-push anywhere) and **do not touch** the Phase-2
  sync config (`excaliboard:sync-config` in localStorage).

## 3. The static build

- **Command:** `yarn build` → `excalidraw-app` `build:app && build:version` → `vite build`. **Output:
  `excalidraw-app/build/`** (Vite `outDir: "build"`, *not* `dist/`; `vite.config.mts:88`).
- **Base path `/`** (no `base:` set) → the app **must be served at the domain root** of
  `app.shashankshandilya.me`, not a sub-path.
- **No build-time secret/URL is required** for sync — see §4. The only baked value is the public
  default URL.
- **Service worker** (`VitePWA registerType:"autoUpdate"`, `vite.config.mts:150`): nginx must serve
  `index.html` + the SW file `no-cache` and hashed `/assets/*` `immutable` — otherwise a stale SW pins an old
  build after redeploy.

## 4. Pre-fill the sync URL; keep secrets out of the build

So the hosted app needs the user to enter only **bearer + E2E key** (not the URL):

- Add `VITE_APP_EXCALIBOARD_URL` (declared in `vite-env.d.ts`), set **only** in `.env.selfhost` to
  `https://excaliboard.shashankshandilya.me`. Use it as the *default* for the dialog's serverUrl:
  `SyncSettingsDialog.tsx:21` → `useState(existing?.serverUrl ?? import.meta.env.VITE_APP_EXCALIBOARD_URL ?? "")`.
  A local `yarn start` build (var unset) keeps today's empty default.
- **Invariant — no secret is ever a `VITE_APP_*` var.** The **bearer** and **E2E key** stay user-entered and
  live only in browser localStorage (`excaliboard:sync-config`), never in the dist, CI env, or any committed
  `.env` (`excaliboardSync.ts:29-38,66-82`; dialog `SyncSettingsDialog.tsx:71-92`).

## 5. Serve + deploy (build in CI, ship only the static dist)

Reuse the agentic-os SSH/known_hosts/rsync/nginx/cloudflared skeleton, but **invert the build location**:
the JS monorepo must never land on cosmos (consistent with Phase 2), so we build in the GitHub runner and
ship only `build/`.

- **nginx vhost** — new file `server/deploy/nginx/excaliboard-app.conf` (separate from the sync proxy vhost),
  modeled on the agentic-os telemetry SPA block (`dashboards.conf:79-103`):
  ```nginx
  server {
    listen 127.0.0.1:80;
    server_name app.shashankshandilya.me;
    root /var/www/excaliboard-app;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }                 # SPA fallback
    location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
    location = /index.html { add_header Cache-Control "no-cache"; }
    location ~* (sw\.js|registerSW\.js|manifest\.webmanifest)$ { add_header Cache-Control "no-cache"; }
  }
  ```
- **CI** — extend `.github/workflows/excaliboard-deploy.yml` with a **`build-app`** job
  (`setup-node` → `yarn install --frozen-lockfile` → `vite build --mode selfhost`) and a **`deploy-app`** job
  that rsyncs **only** `excalidraw-app/build/` to `cosmos:/var/www/excaliboard-app/` over SSH (reuse
  `COSMOS_SSH_KEY/HOST/USER` + pinned `deploy/known_hosts`), then installs the app vhost + `nginx -t && reload`.
  Add `excalidraw-app/**` + `packages/**` to the path filter.
- **One-time bootstrap:** `cloudflared tunnel route dns cosmos app.shashankshandilya.me` (wildcard already
  covers it — no tunnel-config edit) and `sudo install -d -o $DEPLOY_USER /var/www/excaliboard-app`.
- **CORS (optional hardening):** server `CORS_ORIGINS=*` already permits the app; can tighten to
  `https://app.shashankshandilya.me` in `/opt/excaliboard/.env`.

## 6. Cloudflare Access (email gate) — manual, by design

There is **no Access policy as config-as-code** anywhere in the fleet (grep confirmed); every gated hostname's
email policy lives in the Cloudflare Zero-Trust dashboard. nginx needs **no** auth config (it routes by Host;
Access enforces at the edge). So: **Zero Trust → Access → Applications → add a self-hosted app for
`app.shashankshandilya.me` with an Allow policy on `shashank.v.shandilya@gmail.com`.** Document this manual
step in the deploy README (matches the rest of the fleet). The sync API host stays bearer-only (not Access),
so the app's cross-origin `fetch` to it is unaffected.

## 7. Build-vs-deploy boundary

- **CI (GitHub runner):** install deps, `vite build --mode selfhost` (bakes only `VITE_APP_EXCALIBOARD_URL`
  + the strip flags), rsync `excalidraw-app/build/` to cosmos. **Nothing else** crosses to cosmos.
- **cosmos:** owns only nginx (static root + SPA fallback + cache headers), the Cloudflare tunnel route, and
  the Access app. No node, no monorepo, no build.

## 8. KEY DECISIONS (recommendations)

| # | Decision | Recommended | Why |
|---|---|---|---|
| D1 | Exposure / auth | **Cloudflare Access (email)** | reachable anywhere, only you; sync API stays bearer-only ✓ signed off |
| D2 | Build location | **build in CI, ship `build/` only** | keeps the JS monorepo off cosmos (Phase-2 invariant); diverges from agentic-os's build-on-box |
| D3 | Strip mechanism | **`.env.selfhost` + `--mode selfhost` + EJS-gate `index.html`** | config-driven, minimal upstream divergence, clean merges |
| D4 | Sync URL | **bake the public URL only** (`VITE_APP_EXCALIBOARD_URL`) | user enters just bearer + key; no secret ever in the build |
| D5 | Hostname | **`app.shashankshandilya.me`** | wildcard tunnel already covers it; pure naming choice |
| D6 | Tauri desktop | **defer** | web-host delivers "open a URL on any device" now; Tauri is a separate doc |

## 9. Definition of done

- `https://app.shashankshandilya.me` loads the editor (behind your email gate), **zero** third-party/telemetry
  requests on a normal load (verify Network tab: no Sentry, SimpleAnalytics, Google, fonts-CDN).
- The Cloud-sync dialog **pre-fills the server URL**; entering bearer + E2E key syncs your boards; a board made
  by `/excaliboard --sync` or `excaliboard__create` appears here.
- Redeploy serves the new build immediately (no stale-SW), via the CI `build-app`/`deploy-app` jobs.
- No secret in the dist or CI env; the monorepo never lands on cosmos.

## 10. Build order (on sign-off)

1. App changes: `.env.selfhost`, `VITE_APP_EXCALIBOARD_URL` default (`SyncSettingsDialog.tsx` + `vite-env.d.ts`),
   EJS-gate the `index.html` telemetry blocks on `VITE_APP_SELFHOST`. Verify a local `--mode selfhost` build is
   clean (Network tab).
2. `server/deploy/nginx/excaliboard-app.conf` + the `cloudflared route` + webroot in `bootstrap-cosmos.sh`.
3. CI `build-app` + `deploy-app` jobs in `excaliboard-deploy.yml`.
4. Cloudflare Access app (manual) + README note. Deploy, then verify §9 end-to-end.

## Open questions

- **SW filename** for the nginx `no-cache` rule — confirm the exact emitted name(s) (`sw.js` / `registerSW.js`)
  from a real `vite build` before pinning the location regex.
- `.env.selfhost` **committed at repo root** vs CI-inline env — recommend committed (reproducible local
  self-host builds), since it holds only public config.
- Hide/disable the collab/share/AI **UI buttons** (they point at excalidraw.com) for self-host, or leave them
  inert? Cosmetic; can be a fast-follow.
