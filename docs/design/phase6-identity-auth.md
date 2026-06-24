# Phase 6 — Identity auth (Cloudflare Access) + drop E2E

Replaces the manual **server-URL + bearer + encryption-key** triad in the cloud-sync dialog with **zero-secret, identity-derived** sync. Signed off in the spike on the two calls that mattered: (1) **don't build an OAuth page — verify Cloudflare Access's JWT**; (2) **drop E2E** (the server is your own trusted box).

```
  app.shashankshandilya.me                     (one Access-gated origin)
   └─ Cloudflare Access (Google OIDC → signed JWT, verified email)   ← who gets in
        └─ cloudflared tunnel → nginx :80 (cosmos)
             ├─ /            → static editor  (/var/www/excaliboard-app)
             └─ /sync/       → 127.0.0.1:8789  (FastAPI)   ← SAME ORIGIN
                                  └─ verifies Cf-Access-Jwt-Assertion → email
  excaliboard.shashankshandilya.me  (kept, bearer-only)  ← machine door (MCP tool)
```

## 1. Why no OAuth redirect page

Cloudflare Access already runs the Google OIDC dance and, after login, **mints a signed JWT** carrying the verified `email`, injected on every proxied request as `Cf-Access-Jwt-Assertion` (and the `CF_Authorization` cookie). Building our own redirect + JWT-minting page re-implements Cloudflare for free. The server just **verifies** that JWT (RS256, against the team JWKS, checking `aud` + `iss`) and trusts the `email`.

## 2. The topology fix (the load-bearing change)

Today only the **app** host is behind Access; the **sync API** host (`excaliboard.shashankshandilya.me`) is deliberately bearer-only-public (`phase3-self-host-web.md:111`). So "Cloudflare protects us" was true for _loading the app_, false for the API.

**Fix:** serve the API **same-origin under the Access-gated app host** — add `location /sync/ { proxy_pass 127.0.0.1:8789 }` to `app.shashankshandilya.me`. Now the browser's `fetch("/sync/…")` is same-origin, the `CF_Authorization` cookie rides along automatically, Cloudflare injects the JWT to the origin → **no CORS, no cross-origin cookie pain, and the `serverUrl` field disappears**.

The old `excaliboard.shashankshandilya.me` host stays exactly as-is (bearer-only) as the **machine door** for the non-browser MCP tool, which can't ride a browser cookie.

> Trust note: `127.0.0.1:8789` is _also_ reachable via the bearer host and the tailnet bind, so an attacker could spoof the `Cf-Access-Jwt-Assertion` header on those paths. The server therefore **verifies the JWT signature** — it never trusts the raw header.

## 3. Server auth (`server/app/auth.py`)

`require_user` becomes two-door, single-user v1 (any valid identity → the one account):

1. **Browser** — a `Cf-Access-Jwt-Assertion` header (or `CF_Authorization` cookie) present: verify (RS256, `aud`=`CF_ACCESS_AUD`, `iss`=`https://CF_ACCESS_TEAM_DOMAIN`, JWKS at `…/cdn-cgi/access/certs`). Valid → stash `request.state.email`, return the user. A JWT that is _present but invalid_ → **401** (never fall through).
2. **Machine** — no JWT: fall back to the static `SYNC_BEARER` (constant-time compare), as today. Used by the MCP tool.
3. Neither → 401.

New config (`config.py`): `cf_access_team_domain`, `cf_access_aud`. **Both empty ⇒ JWT door disabled** (bearer-only) — so tests and local dev are unchanged and the existing 29 server tests stay green. New dep: `pyjwt[crypto]`. New route `GET /sync/whoami` → `{email}` for the dialog's "Signed in as …".

**Single-user, not multi-tenant (YAGNI).** The `app_user.external_sub` schema already supports per-email tenancy, but there is one human and one Access policy. Every valid identity (JWT _or_ bearer) maps to the one `single_user_id`, so browser and MCP tool share one board set with **no migration and no board-id collision**. True multi-user (key on `email`, composite `board` PK) is a flagged one-step upgrade, not built.

## 4. Drop E2E (`excalidraw-app/data/excaliboardSync.ts`)

E2E existed to defend against an _untrusted_ server. This is your own cosmos box (your tunnel, your backups, tailnet binds, behind your email gate). Trading "my own server can read my diagrams" for "zero secrets, no key to hand-carry between devices" is the whole point.

- The opaque-blob **wire + server are unchanged** — the client just stops encrypting: plaintext JSON (base64) goes in the existing `ciphertext` field, empty `iv`. The server is a byte store; it never cared what the bytes were.
- The crypto wrappers (`encryptElements`/`decryptElements`/`encryptString`/`decryptString`) keep their signatures (incl. the now-ignored `key` arg) so the engine call sites and ~all of its 15 tests stay put — the only ripple is one name-presence guard that now keys on the ciphertext instead of the empty iv. Marked with a `ponytail:` note. `SyncConfig` collapses to `{ enabled }` — the browser is always same-origin (relative `/sync/`), so a stored `serverUrl`/`bearer`/`encryptionKey` from a legacy blob is read back as nothing.
- Dialog collapses 4 fields → **one toggle** + "Signed in as `<email>`" from `/sync/whoami`.

> ⚠️ **Migration / downstream:**
>
> - **MCP tool (separate repo):** the agentic-os `excaliboard__*` tool currently AES-encrypts with the shared key. It must switch to the same plaintext-base64 wire, or it will read garbage. Follow-up; not in this branch.
> - **Legacy server ciphertext:** boards already on the server from the E2E era are AES bytes — the new client reads them as plaintext and `JSON.parse` throws (the pull's try/catch logs and retries, so no crash, but that board won't load). The server DB was truncated last session, so N/A; if any exist, wipe them and let the client re-push plaintext.

## 5. Decisions

| # | Decision | Choice | Why |
| --- | --- | --- | --- |
| D1 | Identity source | **Verify CF Access JWT** (no custom OAuth) | Cloudflare already mints a verified-email JWT for free |
| D2 | Topology | **API same-origin under the Access-gated app host** | same-origin cookie ⇒ no CORS, no cross-origin pain, kills `serverUrl` |
| D3 | Machine clients | **Keep `SYNC_BEARER` as a second door** | MCP tool can't ride a browser cookie |
| D4 | Encryption | **Drop E2E — plaintext on your own box** ✓ signed off | server is trusted; removes the last pasted secret (the key) |
| D5 | Tenancy | **Single-user (any valid identity → one account)** | one human, one Access policy; multi-user is YAGNI |

## 6. Deploy

- `server/deploy/nginx/excaliboard-app.conf` — add the `/sync/` proxy block.
- Cloudflare Zero-Trust (manual): add `app.shashankshandilya.me` (incl. its `/sync/` path) to the Access app; copy its **AUD tag** + **team domain** into `/opt/excaliboard/.env` (`CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`), 1P-Mithra-seeded like the other secrets.
- `SYNC_BEARER` stays for the MCP tool. </content>
