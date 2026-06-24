"""Postgres-backed store (asyncpg).

``asyncpg`` is imported lazily so tests (which use the in-memory store) need not
install or import the native driver. The schema is applied idempotently at
startup from ``app/sql/001_init.sql`` (all ``CREATE ... IF NOT EXISTS``).

Concurrency: a push is serialized with ``SELECT ... FOR UPDATE`` on the board
row. That lock only protects an *existing* row, so the create path additionally
uses ``INSERT ... ON CONFLICT (id) DO NOTHING`` and, on losing the race,
re-locks the now-committed row and falls through to the normal CAS branches — so
two concurrent first-creates resolve as one Accepted + one 409, never a 500.
All SQL is parameterized — no string interpolation of user input.
"""

from __future__ import annotations

import uuid

from importlib.resources import files

from .base import (
    Blob,
    BoardIndexRow,
    BoardNotFound,
    LimitExceeded,
    PushAccepted,
    PushConflict,
    PushResult,
    SceneRecord,
)

_SCENE_UPSERT = (
    "INSERT INTO scene (board_id, scene_version, iv, ciphertext, byte_size) "
    "VALUES ($1, $2, $3, $4, $5) "
    "ON CONFLICT (board_id) DO UPDATE SET "
    "scene_version = EXCLUDED.scene_version, iv = EXCLUDED.iv, "
    "ciphertext = EXCLUDED.ciphertext, byte_size = EXCLUDED.byte_size, "
    "updated_at = now()"
)


def _uid(user_id: str) -> uuid.UUID:
    return uuid.UUID(user_id)


class PostgresStore:
    def __init__(
        self,
        dsn: str,
        *,
        max_boards_per_user: int = 5000,
        max_files_per_board: int = 5000,
    ) -> None:
        self._dsn = dsn
        self._pool = None
        self._max_boards = max_boards_per_user
        self._max_files = max_files_per_board

    async def startup(self) -> None:
        import asyncpg

        self._pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=10)
        schema = files("app.sql").joinpath("001_init.sql").read_text(encoding="utf-8")
        async with self._pool.acquire() as conn:
            await conn.execute(schema)

    async def shutdown(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    async def healthcheck(self) -> bool:
        if self._pool is None:
            return False
        try:
            async with self._pool.acquire() as conn:
                return await conn.fetchval("SELECT 1") == 1
        except Exception:
            return False

    async def ensure_user(self, external_sub: str) -> str:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO app_user (external_sub) VALUES ($1) "
                "ON CONFLICT (external_sub) DO NOTHING",
                external_sub,
            )
            row = await conn.fetchval(
                "SELECT id FROM app_user WHERE external_sub=$1", external_sub
            )
            return str(row)

    async def get_index(
        self, user_id: str, since_ms: int | None
    ) -> list[BoardIndexRow]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, name_iv, name_ct, scene_version, deleted,
                       floor(EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS up
                FROM board
                WHERE user_id = $1
                  AND ($2::bigint IS NULL
                       OR updated_at >= to_timestamp($2::double precision / 1000))
                ORDER BY updated_at ASC
                """,
                _uid(user_id),
                since_ms,
            )
            return [
                BoardIndexRow(
                    board_id=r["id"],
                    name_iv=bytes(r["name_iv"]) if r["name_iv"] is not None else None,
                    name_ct=bytes(r["name_ct"]) if r["name_ct"] is not None else None,
                    scene_version=r["scene_version"],
                    deleted=r["deleted"],
                    updated_at_ms=r["up"],
                )
                for r in rows
            ]

    async def get_scene(self, user_id: str, board_id: str) -> SceneRecord | None:
        async with self._pool.acquire() as conn:
            r = await conn.fetchrow(
                """
                SELECT s.scene_version, s.iv, s.ciphertext
                FROM scene s
                JOIN board b ON b.id = s.board_id
                WHERE s.board_id = $1 AND b.user_id = $2 AND b.deleted = false
                """,
                board_id,
                _uid(user_id),
            )
            if r is None:
                return None
            return SceneRecord(r["scene_version"], bytes(r["iv"]), bytes(r["ciphertext"]))

    async def push_scene(
        self,
        user_id: str,
        board_id: str,
        base_version: int,
        new_version: int,
        blob: Blob,
        name: Blob | None = None,
    ) -> PushResult:
        uid = _uid(user_id)
        name_iv = name.iv if name else None
        name_ct = name.ciphertext if name else None
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                current = await conn.fetchval(
                    "SELECT scene_version FROM board "
                    "WHERE id = $1 AND user_id = $2 FOR UPDATE",
                    board_id,
                    uid,
                )
                if current is None:
                    count = await conn.fetchval(
                        "SELECT count(*) FROM board WHERE user_id = $1", uid
                    )
                    if count >= self._max_boards:
                        raise LimitExceeded("boards-per-user")
                    # Race-safe create: ON CONFLICT waits for a concurrent creator
                    # to commit, then returns no row (we lost) so we re-resolve.
                    created = await conn.fetchval(
                        "INSERT INTO board "
                        "(id, user_id, name_iv, name_ct, scene_version, deleted) "
                        "VALUES ($1, $2, $3, $4, $5, false) "
                        "ON CONFLICT (id) DO NOTHING RETURNING scene_version",
                        board_id,
                        uid,
                        name_iv,
                        name_ct,
                        new_version,
                    )
                    if created is not None:
                        await conn.execute(
                            _SCENE_UPSERT,
                            board_id,
                            new_version,
                            blob.iv,
                            blob.ciphertext,
                            blob.byte_size,
                        )
                        return PushAccepted(new_version)
                    # Lost the create race; the winner is committed. Re-lock and
                    # fall through so this push resolves as a normal CAS / 409.
                    current = await conn.fetchval(
                        "SELECT scene_version FROM board "
                        "WHERE id = $1 AND user_id = $2 FOR UPDATE",
                        board_id,
                        uid,
                    )
                    if current is None:
                        # board id owned by another user (impossible in single-user
                        # v1: board.id is a global PK). Defensive.
                        raise BoardNotFound()

                if current != base_version:
                    r = await conn.fetchrow(
                        "SELECT s.scene_version, s.iv, s.ciphertext FROM scene s "
                        "JOIN board b ON b.id = s.board_id "
                        "WHERE s.board_id = $1 AND b.user_id = $2",
                        board_id,
                        uid,
                    )
                    if r is not None:
                        return PushConflict(
                            r["scene_version"], bytes(r["iv"]), bytes(r["ciphertext"])
                        )
                    # board exists with no scene row (anomaly): nothing to conflict
                    # against -> fall through and (re)create the scene.

                # CAS hit (or scene-less board). The FOR UPDATE lock above serializes
                # concurrent pushers. A push does NOT revive a soft-deleted board —
                # deletion wins, so a stray/racing push can never bring a board back.
                await conn.execute(
                    "UPDATE board SET scene_version = $1, "
                    "updated_at = now(), "
                    "name_iv = COALESCE($4, name_iv), "
                    "name_ct = COALESCE($5, name_ct) "
                    "WHERE id = $2 AND user_id = $3",
                    new_version,
                    board_id,
                    uid,
                    name_iv,
                    name_ct,
                )
                await conn.execute(
                    _SCENE_UPSERT,
                    board_id,
                    new_version,
                    blob.iv,
                    blob.ciphertext,
                    blob.byte_size,
                )
                return PushAccepted(new_version)

    async def soft_delete_board(self, user_id: str, board_id: str) -> bool:
        async with self._pool.acquire() as conn:
            r = await conn.fetchval(
                "UPDATE board SET deleted = true, updated_at = now() "
                "WHERE id = $1 AND user_id = $2 RETURNING id",
                board_id,
                _uid(user_id),
            )
            return r is not None

    async def get_file(
        self, user_id: str, board_id: str, file_id: str
    ) -> Blob | None:
        async with self._pool.acquire() as conn:
            r = await conn.fetchrow(
                """
                SELECT fb.iv, fb.ciphertext
                FROM file_blob fb
                JOIN board b ON b.id = fb.board_id
                WHERE fb.board_id = $1 AND fb.file_id = $2 AND b.user_id = $3
                """,
                board_id,
                file_id,
                _uid(user_id),
            )
            if r is None:
                return None
            return Blob(bytes(r["iv"]), bytes(r["ciphertext"]))

    async def put_file(
        self, user_id: str, board_id: str, file_id: str, blob: Blob
    ) -> None:
        uid = _uid(user_id)
        async with self._pool.acquire() as conn:
            exists = await conn.fetchval(
                "SELECT 1 FROM board WHERE id = $1 AND user_id = $2", board_id, uid
            )
            if not exists:
                raise BoardNotFound()
            already = await conn.fetchval(
                "SELECT 1 FROM file_blob WHERE board_id = $1 AND file_id = $2",
                board_id,
                file_id,
            )
            if already:
                return  # idempotent: content-addressed id already stored
            count = await conn.fetchval(
                "SELECT count(*) FROM file_blob WHERE board_id = $1", board_id
            )
            if count >= self._max_files:
                raise LimitExceeded("files-per-board")
            await conn.execute(
                "INSERT INTO file_blob "
                "(board_id, file_id, iv, ciphertext, byte_size) "
                "VALUES ($1, $2, $3, $4, $5) "
                "ON CONFLICT (board_id, file_id) DO NOTHING",
                board_id,
                file_id,
                blob.iv,
                blob.ciphertext,
                blob.byte_size,
            )

    async def reap_tombstones(self, grace_seconds: int) -> int:
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM board WHERE deleted = true "
                "AND updated_at < now() - make_interval(secs => $1::double precision)",
                float(grace_seconds),
            )
        try:
            return int(result.split()[-1])
        except (ValueError, IndexError):
            return 0
