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
from .api.admin_routes import build_admin_router
from .api.auth_routes import build_auth_router
from .api.oauth_device import build_device_router
from .config import SINGLE_USER_SUB, Settings
from .limits import BodySizeLimitMiddleware
from .observability import instrument_app, tracer
from .ratelimit import RateLimiter
from .security import TokenService, cookie_secure
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
        # The legacy single-user account is preserved so the existing static
        # bearer / MCP tool keeps working through the Phase 8 transition.
        app.state.single_user_id = await store.ensure_user(SINGLE_USER_SUB)
        if settings.admin_email:
            # Adopt the legacy single-user row onto the admin email (keeps the
            # operator's existing boards), or promote an already-signed-up account.
            adopted = await store.adopt_legacy_single_user(settings.admin_email)
            if adopted is None:
                await store.grant_admin_by_email(settings.admin_email)
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
    # Phase 7 auth wiring. tokens=None disables the cookie door (bearer-only;
    # tests that don't exercise auth).
    app.state.tokens = TokenService(settings.secret_key) if settings.secret_key else None
    app.state.ratelimit = RateLimiter()

    # Google OAuth (optional). app.state.oauth=None => the /auth/google/* routes 404.
    app.state.oauth = None
    if settings.google_client_id and settings.google_client_secret:
        from authlib.integrations.starlette_client import OAuth

        oauth = OAuth()
        oauth.register(
            name="google",
            client_id=settings.google_client_id,
            client_secret=settings.google_client_secret,
            server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
            client_kwargs={"scope": "openid email profile"},
        )
        app.state.oauth = oauth

    # Body-limit runs just inside CORS (added first => inner), so it still rejects
    # oversized bodies before routing/buffering while CORS decorates the 413.
    app.add_middleware(BodySizeLimitMiddleware, max_body_bytes=settings.max_body_bytes)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,  # session cookie flows; Starlette echoes the origin
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    # SessionMiddleware backs authlib's OAuth state (CSRF). Outermost so it wraps
    # the OAuth routes. Only meaningful when a secret_key is configured.
    if settings.secret_key:
        from starlette.middleware.sessions import SessionMiddleware

        app.add_middleware(
            SessionMiddleware,
            secret_key=settings.secret_key,
            https_only=cookie_secure(settings.public_url),
            same_site="lax",
        )

    instrument_app(app)
    app.include_router(build_router())
    app.include_router(build_auth_router())
    app.include_router(build_admin_router())
    app.include_router(build_device_router())
    return app


app = create_app()
