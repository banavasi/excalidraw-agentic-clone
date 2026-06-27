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
from datetime import datetime, timezone

from importlib.resources import files

from .base import (
    Blob,
    BoardIndexRow,
    BoardNotFound,
    DeviceGrant,
    EmailTaken,
    LimitExceeded,
    PushAccepted,
    PushConflict,
    PushResult,
    SceneRecord,
    User,
)


def _user(row) -> User:
    return User(
        id=str(row["id"]),
        email=row["email"],
        password_hash=row["password_hash"],
        email_verified=row["email_verified"],
        role=row["role"],
        disabled=row["disabled"],
        display_name=row["display_name"],
        auth_method=row["auth_method"],
        oauth_sub=row["oauth_sub"],
        session_epoch=row["session_epoch"],
        token_nonce=row["token_nonce"],
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
        await self._migrate()

    async def _migrate(self) -> None:
        """Run every app/sql/NNN_*.sql once, in filename order, tracked in
        schema_version. Files stay idempotent so re-running is harmless, but the
        ledger avoids re-executing applied migrations on every boot."""
        async with self._pool.acquire() as conn:
            await conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_version ("
                "filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
            )
            applied = {
                r["filename"]
                for r in await conn.fetch("SELECT filename FROM schema_version")
            }
            sql_dir = files("app.sql")
            names = sorted(
                p.name
                for p in sql_dir.iterdir()
                if p.name.endswith(".sql")
            )
            for name in names:
                if name in applied:
                    continue
                sql = sql_dir.joinpath(name).read_text(encoding="utf-8")
                async with conn.transaction():
                    await conn.execute(sql)
                    await conn.execute(
                        "INSERT INTO schema_version (filename) VALUES ($1) "
                        "ON CONFLICT DO NOTHING",
                        name,
                    )

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

    # --- Phase 7: accounts -----------------------------------------------------

    @staticmethod
    async def _by_email(conn, email: str) -> User | None:
        row = await conn.fetchrow("SELECT * FROM app_user WHERE email = $1", email)
        return _user(row) if row else None

    async def create_local_user(
        self, email: str, password_hash: str, display_name: str | None
    ) -> User:
        import asyncpg

        async with self._pool.acquire() as conn:
            existing = await self._by_email(conn, email)
            if existing is not None:
                raise EmailTaken(existing.auth_method or "local")
            try:
                row = await conn.fetchrow(
                    "INSERT INTO app_user "
                    "(external_sub, email, password_hash, auth_method, display_name) "
                    "VALUES ($1, $2, $3, 'local', $4) RETURNING *",
                    f"local:{email}",
                    email,
                    password_hash,
                    display_name,
                )
            except asyncpg.UniqueViolationError as exc:  # race: lost to a concurrent signup
                existing = await self._by_email(conn, email)
                raise EmailTaken(existing.auth_method if existing else "local") from exc
            return _user(row)

    async def upsert_google_user(
        self, email: str, sub: str, display_name: str | None
    ) -> User:
        import asyncpg

        async with self._pool.acquire() as conn:
            existing = await self._by_email(conn, email)
            if existing is not None:
                if existing.auth_method == "google":
                    return existing
                raise EmailTaken(existing.auth_method or "local")
            try:
                row = await conn.fetchrow(
                    "INSERT INTO app_user "
                    "(external_sub, email, email_verified, auth_method, oauth_sub, "
                    " display_name) "
                    "VALUES ($1, $2, true, 'google', $3, $4) RETURNING *",
                    f"google:{sub}",
                    email,
                    sub,
                    display_name,
                )
            except asyncpg.UniqueViolationError as exc:
                existing = await self._by_email(conn, email)
                if existing and existing.auth_method == "google":
                    return existing
                raise EmailTaken(existing.auth_method if existing else "local") from exc
            return _user(row)

    async def get_user_by_id(self, user_id: str) -> User | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("SELECT * FROM app_user WHERE id = $1", _uid(user_id))
            return _user(row) if row else None

    async def get_user_by_email(self, email: str) -> User | None:
        async with self._pool.acquire() as conn:
            return await self._by_email(conn, email)

    async def set_email_verified(self, user_id: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "UPDATE app_user SET email_verified = true WHERE id = $1", _uid(user_id)
            )

    async def set_password(self, user_id: str, password_hash: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "UPDATE app_user SET password_hash = $2, "
                "session_epoch = session_epoch + 1, token_nonce = token_nonce + 1 "
                "WHERE id = $1",
                _uid(user_id),
                password_hash,
            )

    async def bump_token_nonce(self, user_id: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "UPDATE app_user SET token_nonce = token_nonce + 1 WHERE id = $1",
                _uid(user_id),
            )

    async def set_role(self, user_id: str, role: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "UPDATE app_user SET role = $2 WHERE id = $1", _uid(user_id), role
            )

    async def set_disabled(self, user_id: str, disabled: bool) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "UPDATE app_user SET disabled = $2, "
                "session_epoch = session_epoch + CASE WHEN $2 THEN 1 ELSE 0 END "
                "WHERE id = $1",
                _uid(user_id),
                disabled,
            )

    async def delete_user(self, user_id: str) -> bool:
        async with self._pool.acquire() as conn:
            r = await conn.fetchval(
                "DELETE FROM app_user WHERE id = $1 RETURNING id", _uid(user_id)
            )
            return r is not None

    async def list_users(self) -> list[tuple[User, int]]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT u.*, "
                "COUNT(b.id) FILTER (WHERE b.deleted = false) AS board_count "
                "FROM app_user u LEFT JOIN board b ON b.user_id = u.id "
                "GROUP BY u.id ORDER BY u.created_at ASC"
            )
            return [(_user(r), r["board_count"]) for r in rows]

    async def grant_admin_by_email(self, email: str) -> bool:
        async with self._pool.acquire() as conn:
            r = await conn.fetchval(
                "UPDATE app_user SET role = 'admin' WHERE email = $1 RETURNING id", email
            )
            return r is not None

    async def count_admins(self) -> int:
        async with self._pool.acquire() as conn:
            return await conn.fetchval("SELECT count(*) FROM app_user WHERE role = 'admin'")

    async def adopt_legacy_single_user(self, email: str) -> User | None:
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                legacy = await conn.fetchrow(
                    "SELECT id FROM app_user "
                    "WHERE external_sub = 'single-user' AND email IS NULL FOR UPDATE"
                )
                if legacy is None:
                    return None
                # Only adopt a legacy account that actually has boards worth
                # keeping; otherwise let normal signup/promote claim the email.
                n_boards = await conn.fetchval(
                    "SELECT count(*) FROM board WHERE user_id = $1", legacy["id"]
                )
                if not n_boards:
                    return None
                taken = await conn.fetchval(
                    "SELECT 1 FROM app_user WHERE email = $1", email
                )
                if taken:
                    return None
                row = await conn.fetchrow(
                    "UPDATE app_user SET email = $2, email_verified = true, "
                    "role = 'admin', auth_method = 'google' WHERE id = $1 RETURNING *",
                    legacy["id"],
                    email,
                )
                return _user(row)

    # --- Phase 8: API tokens + device grant ------------------------------------

    async def create_api_token(
        self, user_id: str, token_hash: str, name: str | None
    ) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO api_token (user_id, token_hash, name) VALUES ($1, $2, $3)",
                _uid(user_id),
                token_hash,
                name,
            )

    async def user_id_for_token(self, token_hash: str) -> str | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id, user_id FROM api_token "
                "WHERE token_hash = $1 AND revoked = false",
                token_hash,
            )
            if row is None:
                return None
            await conn.execute(
                "UPDATE api_token SET last_used_at = now() WHERE id = $1", row["id"]
            )
            return str(row["user_id"])

    async def create_device_grant(
        self, device_code: str, user_code: str, expires_at_ms: int
    ) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO device_grant (device_code, user_code, expires_at) "
                "VALUES ($1, $2, to_timestamp($3::double precision / 1000))",
                device_code,
                user_code,
                expires_at_ms,
            )

    @staticmethod
    def _grant(row) -> DeviceGrant:
        expired = row["expires_at"] < datetime.now(timezone.utc)
        return DeviceGrant(
            device_code=row["device_code"],
            user_code=row["user_code"],
            user_id=str(row["user_id"]) if row["user_id"] else None,
            approved=row["approved"],
            consumed=row["consumed"],
            expired=expired,
        )

    async def get_device_grant_by_user_code(self, user_code: str) -> DeviceGrant | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM device_grant WHERE user_code = $1", user_code
            )
            return self._grant(row) if row else None

    async def approve_device_grant(self, user_code: str, user_id: str) -> bool:
        async with self._pool.acquire() as conn:
            r = await conn.fetchval(
                "UPDATE device_grant SET approved = true, user_id = $2 "
                "WHERE user_code = $1 AND consumed = false AND expires_at > now() "
                "RETURNING device_code",
                user_code,
                _uid(user_id),
            )
            return r is not None

    async def get_device_grant(self, device_code: str) -> DeviceGrant | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM device_grant WHERE device_code = $1", device_code
            )
            return self._grant(row) if row else None

    async def consume_device_grant(self, device_code: str) -> str | None:
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM device_grant WHERE device_code = $1 FOR UPDATE",
                    device_code,
                )
                if (
                    row is None
                    or row["consumed"]
                    or not row["approved"]
                    or row["user_id"] is None
                    or row["expires_at"] < datetime.now(timezone.utc)
                ):
                    return None
                await conn.execute(
                    "UPDATE device_grant SET consumed = true WHERE device_code = $1",
                    device_code,
                )
                return str(row["user_id"])
