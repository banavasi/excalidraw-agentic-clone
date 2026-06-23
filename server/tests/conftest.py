"""Test fixtures: an httpx client wired to the app over an in-memory store.

LifespanManager runs the app's startup/shutdown so app.state (settings, store,
single_user_id) is populated exactly as in production. FLEET_OBS_DISABLE keeps
tracing fully offline.
"""

from __future__ import annotations

import os

os.environ["FLEET_OBS_DISABLE"] = "1"

import pytest
import pytest_asyncio
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.main import create_app
from app.store.memory import InMemoryStore
from tests.util import BEARER


def build_app(settings: Settings | None = None, store: InMemoryStore | None = None):
    settings = settings or Settings(sync_bearer=BEARER, database_url=None, cors_origins=["*"])
    store = store or InMemoryStore()
    return create_app(store=store, settings=settings)


@pytest_asyncio.fixture
async def client():
    """Authenticated client (default Authorization header set)."""
    app = build_app()
    async with LifespanManager(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport,
            base_url="http://test",
            headers={"Authorization": f"Bearer {BEARER}"},
        ) as ac:
            yield ac


@pytest_asyncio.fixture
async def anon_client():
    """Client with no auth header (for auth tests)."""
    app = build_app()
    async with LifespanManager(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
