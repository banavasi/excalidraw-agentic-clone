"""Shared test helpers."""

from __future__ import annotations

import base64
from contextlib import asynccontextmanager

BEARER = "test-bearer-token"

# A valid 12-byte AES-GCM IV, base64-encoded (reused where IV content is irrelevant).
IV = base64.b64encode(b"\x00" * 12).decode("ascii")


def b(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def ub(s: str) -> bytes:
    return base64.b64decode(s)


@asynccontextmanager
async def make_client(**setting_overrides):
    """An authenticated client over an app built from Settings overrides.

    The store is built from the same Settings, so caps (max_boards_per_user,
    max_files_per_board, max_body_bytes, ...) take effect.
    """
    from asgi_lifespan import LifespanManager
    from httpx import ASGITransport, AsyncClient

    from app.config import Settings
    from app.main import create_app

    settings = Settings(
        sync_bearer=BEARER, database_url=None, cors_origins=["*"], **setting_overrides
    )
    app = create_app(settings=settings)
    async with LifespanManager(app):
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"Authorization": f"Bearer {BEARER}"},
        ) as ac:
            yield ac
