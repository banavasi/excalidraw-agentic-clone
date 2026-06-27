# Phase 7 — Multi-user accounts + admin, open-source & self-hostable

**Status:** DRAFT v2 (hardened by adversarial review `wf_36c2d232`) — awaiting sign-off **Supersedes:** the Phase 6 single-user Cloudflare-Access door (CF Access becomes optional infra, not the identity source).

## 1. Goal

Turn the single-user excaliboard into a **multi-tenant, self-hostable open-source app** — "Lucidchart for Excalidraw". Anyone can `docker compose up`, sign up, log in, and keep their own private board library. One **admin** controls users. The whole thing is a clean, well-structured public GitHub repo others can fork and host.

**v1 scope (this phase):** free auth (email+password _with_ verification, or Google _without_) · password reset · admin to manage users · de-fleeted self-host packaging · OSS repo + license.

**Explicitly later (sketched §8, not built now):** AI diagram generation (BYO keys), board sharing/ACL, live multiplayer, presentations/mockups/templates, per-user MCP (Phase 8, §7).

## 2. Why this is mostly a "flip", not a rewrite

The architecture map (`wf_ccd0a358`) found the data layer is **already multi-tenant**: `app_user(id, external_sub UNIQUE)`, `board.user_id` FK, every store query already filters `WHERE user_id = $N` with per-user CAS locking. The only thing collapsing everyone into one account is `require_user()` returning a hardcoded `single_user_id`. E2E is already dropped (plaintext on a trusted server), so agent-readable/shareable boards have no crypto problem.

Real work: **(a)** in-app auth that returns the _real_ per-user `user_id`; **(b)** account lifecycle (signup/verify/login/reset); **(c)** admin; **(d)** de-fleet for self-host; **(e)** OSS.

## 3. Auth (in-app, self-hostable)

### 3.1 Data model — `002_auth.sql` (ALTER `app_user`, no new session table)

- `email citext UNIQUE NOT NULL`
- `password_hash text NULL` — null for OAuth-only accounts
- `email_verified bool NOT NULL DEFAULT false`
- `role text NOT NULL DEFAULT 'user'` — `user` | `admin`
- `disabled bool NOT NULL DEFAULT false`
- `display_name text NULL`
- `auth_method text NOT NULL` — `local` | `google` (one method per email in v1)
- `oauth_sub text NULL` — provider subject for `google`
- `session_epoch int NOT NULL DEFAULT 0` — bump to revoke all of a user's cookies (see §3.2)
- `token_nonce int NOT NULL DEFAULT 0` — bump to invalidate outstanding verify/reset tokens

Migrations run via a **lightweight runner** (not Alembic): on startup, scan `app/sql/*.sql` in filename order, run any not yet recorded in a `schema_version(filename, applied_at)` table. Files stay idempotent (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`).

### 3.2 Password & sessions (signed cookie + epoch — no session table)

- **Hashing:** `argon2-cffi` (argon2id).
- **Session = signed HttpOnly cookie** carrying `{user_id, epoch, iat}`, signed with `SECRET_KEY` (`itsdangerous`). Every request: verify signature → load user → reject if `disabled`, if `cookie.epoch != user.session_epoch`, or if expired. No session rows to GC.
  - **Cookie flags:** `HttpOnly`, `SameSite=Lax`, and **`Secure` conditional** — on only when the request is HTTPS (`PUBLIC_URL` is `https://` or `X-Forwarded-Proto: https`). This is required or `http://localhost` self-host can't log in.
  - **Rotation/revocation:** issue a fresh cookie on login. Logout clears the cookie. **Password change / "log out everywhere" / admin-disable** → bump `session_epoch` (invalidates all existing cookies). Per-device session management = deferred.
- **CSRF:** same-origin JSON API + `SameSite=Lax` covers v1. Double-submit token only if/when we add cross-site embeds.

### 3.3 Email + password signup (verification required)

1. `POST /auth/signup {email, password, name}` → if email exists, see §3.4 collision rule; else create `auth_method='local'`, `email_verified=false`, argon2 hash.
2. Send a verification email: signed token `{user_id, nonce, purpose:'verify'}` (`URLSafeTimedSerializer`, **TTL 24h**). Link → `PUBLIC_URL/auth/verify?token=…`.
3. `GET /auth/verify` → check token + `nonce == user.token_nonce` → set `email_verified=true`, **bump `token_nonce`** (token now single-use; replay rejected).
4. **Login blocked until verified.** Resend regenerates (bumps nonce, killing old links).

- **SMTP** is generic env (`SMTP_HOST/PORT/USER/PASS/FROM`, sent via `aiosmtplib`). If SMTP is unset, the link is **logged to stdout** so a fresh self-host can bootstrap with no mail server.

### 3.4 Google OAuth (no email verification needed) + collision rule

- OAuth2 auth-code flow via `authlib`; **`state` param required** (authlib enforces; covered by a test). `/auth/google/login` → Google; `/auth/google/callback` → read `email`+`sub`.
- **Collision rule (v1, no auto-merge):** one `app_user` per email.
  - Email unknown → create `auth_method='google'`, `email_verified=true`.
  - Email exists with `auth_method='google'` → log in.
  - Email exists with `auth_method='local'` → **reject**: "This email is registered with a password — sign in with your password." (and the mirror case for local-signup over a google email). Account-linking is a later feature.

### 3.5 Password reset

1. `POST /auth/forgot {email}` → if a `local` account exists, email a signed reset token `{user_id, nonce, purpose:'reset'}` (**TTL 1h**). Response is **identical whether or not the email exists** (no enumeration).
2. `GET /auth/reset?token=…` → reset form.
3. `POST /auth/reset {token, password}` → verify token + nonce → set new hash, **bump `token_nonce` and `session_epoch`** (token single-use; all sessions killed → re-login).

### 3.6 Abuse controls (all auth endpoints)

- Rate limits (per-IP + per-email): signup 3/15min/IP · login 5/15min per (IP,email) · resend-verify & forgot 3/15min/email. Backed by a small in-process limiter (Redis only if a self-host scales out — YAGNI for v1).
- **Enumeration-safe:** login returns one error ("Invalid email or password") for both unknown email and wrong password; forgot always returns success.

### 3.7 `require_user` rewrite

Replace the CF-JWT path with: read session cookie → load user → return real `user_id` (reject disabled / unverified-local). All routes already thread `user_id`, so this is the multi-tenant flip. **Keep the static bearer door (deprecated) in v1** so the existing MCP tool keeps working until Phase 8 device-flow replaces it (§7). CF Access JWT verification moves to an **optional module** loaded only when CF env vars are set (fleet overlay) — off the default OSS path.

## 4. Admin

- **Seed first admin:** `ADMIN_EMAIL` env → that account is granted `role=admin` on verify/sign-in. CLI fallback `python -m app.admin grant <email>` to bootstrap if unset.
- **Endpoints (admin-only, `require_admin`):** `GET /admin/users` (id, email, verified, role, disabled, created_at, **board_count**) · `POST /admin/users/{id}/disable|enable` (disable bumps their `session_epoch`) · `POST /admin/users/{id}/role` · `DELETE /admin/users/{id}`.
- **Self-protection:** an admin **cannot disable, delete, or demote itself** → 403. Prevents last-admin lockout.
- **UI:** admin-only React route `/admin` — flat user table with the actions above. No search/sort/pagination in v1 (cap list, defer).

## 5. Web app changes

- **Auth pages:** login, signup, verify, forgot/reset. Conditional "Sign in with Google" button.
- **Account menu** (top-right): email + log out. Multi-account-per-browser = later.
- **Clear local board state on logout** (`WORKBOARDS_INDEX/ACTIVE/RECOVERY` + IndexedDB). No per-user namespacing in v1 (one account per browser is the real case).
- **API base = runtime-configurable, same-origin default** — stop baking `VITE_APP_EXCALIBOARD_URL` into the bundle so self-hosters point at their own API without a rebuild. Keep the self-destroying service worker.

## 6. De-fleet & self-host packaging (the OSS deliverable)

Default must be vanilla and runnable by anyone:

- **Root `docker-compose.yml`:** `web` (built static + nginx) · `api` (FastAPI) · `db` (Postgres 17). Healthcheck-gated. Current root compose → `docker-compose.dev.yml`.
- **Root `.env.example`:** `DATABASE_URL`, `SECRET_KEY` (`openssl rand -hex 32`), `PUBLIC_URL`, `SMTP_*` (optional), `GOOGLE_CLIENT_ID/SECRET` (optional), `ADMIN_EMAIL`. **No 1Password / CF / Tailscale** in the default path; the cosmos CI/CD + CF Access live in `deploy/cosmos/` overlay.
- **New config fields** in `server/app/config.py`: `secret_key`, `public_url`, `smtp_*`, `google_*`, `admin_email`, `cookie_secure` (auto). **New deps** in `pyproject.toml`: `argon2-cffi`, `authlib`, `itsdangerous`, `aiosmtplib`.
- **Web image:** builds `yarn build:selfhost`, served by nginx; `api` from `server/Dockerfile`.

## 7. Phase 8 (designed now, built next) — per-user MCP via OAuth device flow

Each user connects their **own** local Claude/Codex; the agent acts only on that user's boards.

- MCP server runs an **OAuth 2.0 device authorization grant**: `POST /oauth/device/code` → `{device_code, user_code, verification_uri}`; user approves at `verification_uri` (already logged in); MCP polls `POST /oauth/device/token` → per-user token in `api_token(user_id, token_hash, scopes, created, last_used, revoked)`.
- `require_user` gains a token door: `Bearer <user-token>` → hash-lookup → user_id. This is what finally **retires the deprecated static bearer**. Existing `excaliboard__authenticate` / `complete_authentication` stubs map onto device-code + poll.
- MCP wire switches to **plaintext base64** (E2E already dropped) — the known follow-up.

## 8. Roadmap after v1 (sketch only)

AI diagram generation w/ BYO API keys · board sharing (`board_member(board_id, user_id, role)`) · live multiplayer on shared boards (self-host the socket.io collab server + replace Firebase file storage — the collab code already exists, just points at Excalidraw's public server) · templates: presentations, low-fi mockups, flow diagrams, storyboards, timelines, trip planning.

## 9. Licensing & attribution (OSS compliance)

- **Allowed:** Excalidraw core is MIT → fork, modify, self-host, redistribute, rebrand. ✅ (Precedent: AstraDraw.)
- **Must keep:** MIT text + `Copyright (c) 2020 Excalidraw`; **append** our own copyright line. Ship `THIRD-PARTY-LICENSES.md`: Excalidraw attribution + each bundled font (Excalifont, Virgil, Assistant, Nunito, Lilita, Xiaolai → OFL · Cascadia → MIT/Microsoft · Liberation → OFL/GPL font exception · ComicShanns → ships `.sfd` source, confirm its license). Add a license header to each `fonts/*/index.ts` that lacks one.
- **Must not:** brand the product "Excalidraw" / use its logo (trademark ≠ MIT). **Pick a new product name** (decision #1). **Rebrand checklist** (exact brand-leak sites the audit found): `packages/common/src/constants.ts:12` (`APP_NAME`) · `packages/excalidraw/index.tsx:308` (`displayName`) · `excalidraw-app/index.html` titles/OG/twitter metas + hidden `<h1>` · `manifest.webmanifest` name/short_name/description · the 5 `packages/*/package.json` descriptions · `app_constants.ts` `excalidraw-theme` localStorage key + `window.name = '_excalidraw'` · favicon / apple-touch-icon / `og-image-3.png` (replace with distinct assets; hardcoded `excalidraw.com` OG URLs → relative/configurable).
- **Repo polish:** README (what/screenshots/`docker compose up`/features/roadmap), CONTRIBUTING, LICENSE, THIRD-PARTY-LICENSES, `.env.example`, CI (lint+typecheck+server tests), issue/PR templates. Repo flips **public** only on explicit say-so.

## 10. Decisions (resolved 2026-06-25)

1. **Product name** — DEFERRED. Codename `excaliboard` stays; rebrand is the final pass (§9 checklist) before the repo goes public. Not blocking the build.
2. **Phase 8 (per-user MCP device flow) → IN v1.** Build the server-side device-code grant + `api_token` table + token door now. (The MCP _tool_ itself lives in the separate agentic-os repo; this phase ships the server endpoints + plaintext wire it depends on.)
3. **Cosmos first.** Deploy to the existing cosmos box via the current CI/CD (the health-gated deploy is the integration test, per `build:rails-on-fleet`); harden the generic OSS `docker compose` packaging (§6) as a follow-on track.

## 11. Test plan (security-critical)

signup→verify→login happy path · login blocked pre-verification · enumeration-safe login/forgot · password reset happy + token single-use (replay rejected) · verify token single-use · email collision (local↔google) rejected, no merge · argon2 verify · Google upsert (new + returning) · OAuth `state` rejects forged callback · rate-limits trip · admin guard (non-admin → 403) · admin can't self-disable · disable bumps epoch → user kicked next request · two users' boards fully isolated (A can't read/write B) · cookie `Secure` off on http localhost, on under https · migration runner applies 002 idempotently · device-code grant issues user-scoped token (Phase 8).
