<div align="center">

# Excaliboard

**A self-hostable, multi-user whiteboard — Excalidraw with accounts, cloud sync, and AI.**

Think "Lucidchart for Excalidraw": people sign up, draw on their own private boards that sync across devices, and connect their local AI agent (Claude / Codex via MCP) to build diagrams for them.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE) &nbsp;·&nbsp; Built on [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT)

</div>

> [!NOTE] > **`Excaliboard` is a working codename.** Pick a name that isn't derived from "Excalidraw" before making this repo public — the Excalidraw _name and logo_ are trademarks (the MIT license covers the code, not the brand). See the rebrand checklist in [`docs/design/phase7-multiuser-oss.md`](docs/design/phase7-multiuser-oss.md) §9.

## Features

- 🔐 **Accounts** — email + password (with confirmation) or Google sign-in. One admin manages users at `/manage`.
- ☁️ **Per-user cloud sync** — your boards follow you across devices; conflict resolution runs client-side, the server is a versioned blob store.
- 🤖 **AI via MCP** — connect a local Claude/Codex with the OAuth device flow; the agent acts only on your boards.
- 🏠 **Self-hostable** — `docker compose up` and you own the whole thing.
- 🎨 **The full Excalidraw editor** — hand-drawn feel, shapes, libraries, export, live multiplayer rooms.

## Quick start (self-host)

```bash
cd selfhost
cp .env.example .env          # set DB_PASSWORD + SECRET_KEY (openssl rand -hex 32)
docker compose up --build
```

Open <http://localhost:8080>, sign up, and you're in. Full guide: [`selfhost/README.md`](selfhost/README.md).

## Architecture

```
Browser ──► nginx (same-origin) ──┬──► static editor (Vite build of the Excalidraw monorepo)
                                  └──► FastAPI  ── Postgres
                                        /auth   accounts, sessions, Google OAuth, admin
                                        /sync   versioned per-user board blob store
                                        /oauth  device flow → per-user MCP tokens
```

- **`packages/*`** — the Excalidraw editor library (core, element, math, common, utils).
- **`excalidraw-app/`** — the web app (editor + `account/` auth UI gating it).
- **`server/`** — the Python (FastAPI) auth + sync API.
- **`selfhost/`** — the `db + api + web` Docker stack.
- **`docs/design/`** — phase specs (auth model, sync, MCP, multi-user/OSS).

## Develop

```bash
yarn install
yarn start                                  # editor on :3001 (proxies the API)
cd server && uv run uvicorn app.main:app --port 8789   # the API (in-memory store for dev)
cd server && uv run --extra test pytest -q  # server tests
```

## License & attribution

Excaliboard is MIT-licensed (see [`LICENSE`](./LICENSE)). It is a fork of [Excalidraw](https://github.com/excalidraw/excalidraw) © 2020 Excalidraw, also MIT. Bundled fonts retain their own licenses — see [`THIRD-PARTY-LICENSES.md`](./THIRD-PARTY-LICENSES.md).
