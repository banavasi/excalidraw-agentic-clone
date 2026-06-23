"""Integration coverage for the asyncpg SQL path.

Skipped unless DATABASE_URL points at a real Postgres (i.e. on cosmos, or a
local PG). Exercises the actual CAS transaction, index, files, and soft-delete
against the database — the one path the in-memory tests can't cover.
"""

import asyncio
import os
import uuid

import pytest

from app.store.base import Blob, PushAccepted, PushConflict

DSN = os.getenv("DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not DSN, reason="DATABASE_URL not set; PostgresStore integration runs on cosmos"
)


async def test_postgres_cas_roundtrip():
    from app.store.postgres import PostgresStore

    store = PostgresStore(DSN)
    await store.startup()
    try:
        uid = await store.ensure_user("itest-" + uuid.uuid4().hex)
        bid = "itest-" + uuid.uuid4().hex

        created = await store.push_scene(uid, bid, 0, 1, Blob(b"\x00" * 12, b"c1"))
        assert isinstance(created, PushAccepted)
        assert created.scene_version == 1

        sc = await store.get_scene(uid, bid)
        assert sc is not None and sc.ciphertext == b"c1"

        # Stale base -> conflict with the current scene.
        conflict = await store.push_scene(uid, bid, 0, 2, Blob(b"\x00" * 12, b"c2"))
        assert isinstance(conflict, PushConflict)
        assert conflict.scene_version == 1 and conflict.ciphertext == b"c1"

        # Correct base -> accepted.
        ok = await store.push_scene(uid, bid, 1, 2, Blob(b"\x00" * 12, b"c2"))
        assert isinstance(ok, PushAccepted)

        # Files require an existing board.
        await store.put_file(uid, bid, "f1", Blob(b"\x00" * 12, b"img"))
        f = await store.get_file(uid, bid, "f1")
        assert f is not None and f.ciphertext == b"img"

        idx = await store.get_index(uid, None)
        assert any(row.board_id == bid for row in idx)

        assert await store.soft_delete_board(uid, bid) is True
        assert await store.get_scene(uid, bid) is None
    finally:
        await store.shutdown()


async def test_postgres_concurrent_create_no_500():
    """Two devices first-creating the same board id concurrently must resolve as
    one Accepted + one Accepted-or-Conflict, never an unhandled UniqueViolation."""
    from app.store.postgres import PostgresStore

    store = PostgresStore(DSN)
    await store.startup()
    try:
        uid = await store.ensure_user("itest-" + uuid.uuid4().hex)
        bid = "itest-" + uuid.uuid4().hex

        results = await asyncio.gather(
            store.push_scene(uid, bid, 0, 1, Blob(b"\x00" * 12, b"A")),
            store.push_scene(uid, bid, 0, 1, Blob(b"\x00" * 12, b"B")),
            return_exceptions=True,
        )

        assert all(not isinstance(r, Exception) for r in results), results
        assert all(isinstance(r, (PushAccepted, PushConflict)) for r in results)
        assert any(isinstance(r, PushAccepted) for r in results)
    finally:
        await store.shutdown()
