# Self-hosting Excaliboard

A self-contained `db` + `api` + `web` stack. One command and you have a multi-user whiteboard at `http://localhost:8080`.

## Quick start

```bash
cd selfhost
cp .env.example .env
# edit .env: set DB_PASSWORD and SECRET_KEY (openssl rand -hex 32), and ADMIN_EMAIL
docker compose up --build
```

Open <http://localhost:8080>, **create an account**, then confirm your email:

- If you set up SMTP, click the link in your inbox.
- If you didn't, the link is printed to the server log: `docker compose logs api | grep verify`

The first account that signs up with `ADMIN_EMAIL` becomes the **admin** — the admin user table is at `/manage`.

## What's in the box

| Service | Image / build | Notes |
| --- | --- | --- |
| `db` | `postgres:17-alpine` | own volume, not published |
| `api` | `../server` (FastAPI) | auth + sync; not published (web proxies it) |
| `web` | `../` built via Vite + nginx | serves the editor, proxies `/auth /sync /oauth /admin` to `api` |

Everything is same-origin behind nginx, so the session cookie just works. Only the `web` port is published; `api` and `db` stay on the internal network.

## Going to production

- Front `web` with TLS (a reverse proxy / tunnel) and set `PUBLIC_URL=https://…` so the session cookie gets the `Secure` flag.
- Configure `SMTP_*` so users get real confirmation/reset emails.
- For "Continue with Google", create an OAuth client and set `GOOGLE_CLIENT_ID/SECRET` with redirect URI `<PUBLIC_URL>/auth/google/callback`.
- Back up the `pgdata` volume.

## Connect a local AI agent (MCP)

Each user can connect their own local Claude/Codex via the OAuth **device flow**: the agent requests a code, you approve it at `<PUBLIC_URL>/device`, and it gets a per-user token scoped to your boards.
