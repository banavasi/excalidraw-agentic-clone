"""App factory + ASGI entrypoint.

``create_app`` is parameterized so tests can inject an ``InMemoryStore`` and a
``Settings`` with a known bearer. The module-level ``app`` (built from env) is
what uvicorn serves in the container.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .api import build_router
from .config import SINGLE_USER_SUB, Settings
from .limits import BodySizeLimitMiddleware
from .observability import instrument_app, tracer
from .store.base import Store

log = logging.getLogger("excaliboard")


def _build_store(settings: Settings) -> Store:
    caps = {
        "max_boards_per_user": settings.max_boards_per_user,
        "max_files_per_board": settings.max_files_per_board,
    }
    if settings.database_url:
        from .store.postgres import PostgresStore

        return PostgresStore(settings.database_url, **caps)
    from .store.memory import InMemoryStore

    return InMemoryStore(**caps)


def create_app(store: Store | None = None, settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    store = store or _build_store(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await store.startup()
        app.state.single_user_id = await store.ensure_user(SINGLE_USER_SUB)
        try:
            reaped = await store.reap_tombstones(settings.tombstone_grace_seconds)
            if reaped:
                log.info("reaped %d stale tombstoned board(s) at startup", reaped)
        except Exception as e:  # noqa: BLE001 — reaping must never break boot
            log.warning("tombstone reap skipped: %s", e)
        tracer()  # register OTLP → Phoenix once (no-op if disabled/unavailable)
        try:
            yield
        finally:
            await store.shutdown()

    app = FastAPI(
        title="Excaliboard Sync",
        version=__version__,
        lifespan=lifespan,
    )
    # State the request handlers read. (single_user_id is filled in at startup.)
    app.state.settings = settings
    app.state.store = store

    # Cloudflare Access JWT verifier (the browser door). None => bearer-only door.
    app.state.cf_jwks_client = None
    if settings.cf_access_team_domain and settings.cf_access_aud:
        from jwt import PyJWKClient

        app.state.cf_jwks_client = PyJWKClient(
            f"https://{settings.cf_access_team_domain}/cdn-cgi/access/certs"
        )

    # Body-limit runs just inside CORS (added first => inner), so it still rejects
    # oversized bodies before routing/buffering while CORS decorates the 413.
    app.add_middleware(BodySizeLimitMiddleware, max_body_bytes=settings.max_body_bytes)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    instrument_app(app)
    app.include_router(build_router())
    return app


app = create_app()
