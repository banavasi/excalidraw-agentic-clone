"""In-memory store for tests and local dev.

NOTE on atomicity: methods never ``await`` between read and write, so the
single-threaded event loop serializes operations for free. That is a *modeling
convenience*, not proof of the SQL path's concurrency safety — in particular it
cannot reproduce the Postgres create-vs-create race. True concurrency safety is
verified only by the Postgres integration test, never by the in-memory suite.
"""

from __future__ import annotations

import time
import uuid

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


def _now_ms() -> int:
    return int(time.time() * 1000)


def _to_user(row: dict) -> User:
    return User(
        id=row["id"],
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


class InMemoryStore:
    def __init__(
        self, *, max_boards_per_user: int = 5000, max_files_per_board: int = 5000
    ) -> None:
        self._users: dict[str, str] = {}  # external_sub -> id (legacy idempotency)
        self._user_rows: dict[str, dict] = {}  # id -> full user record
        self._email_index: dict[str, str] = {}  # email.lower() -> id
        self._tokens: dict[str, dict] = {}  # token_hash -> {user_id, revoked}
        self._device: dict[str, dict] = {}  # device_code -> grant dict
        self._user_code_index: dict[str, str] = {}  # user_code -> device_code
        self._boards: dict[tuple[str, str], dict] = {}
        self._scenes: dict[tuple[str, str], SceneRecord] = {}
        self._files: dict[tuple[str, str, str], Blob] = {}
        self._max_boards = max_boards_per_user
        self._max_files = max_files_per_board

    async def startup(self) -> None:
        return None

    async def shutdown(self) -> None:
        return None

    async def healthcheck(self) -> bool:
        return True

    def _new_row(self, **overrides) -> dict:
        row = {
            "id": str(uuid.uuid4()),
            "external_sub": None,
            "email": None,
            "password_hash": None,
            "email_verified": False,
            "role": "user",
            "disabled": False,
            "display_name": None,
            "auth_method": None,
            "oauth_sub": None,
            "session_epoch": 0,
            "token_nonce": 0,
        }
        row.update(overrides)
        self._user_rows[row["id"]] = row
        if row["external_sub"]:
            self._users[row["external_sub"]] = row["id"]
        if row["email"]:
            self._email_index[row["email"].lower()] = row["id"]
        return row

    async def ensure_user(self, external_sub: str) -> str:
        if external_sub not in self._users:
            self._new_row(external_sub=external_sub)
        return self._users[external_sub]

    async def get_index(
        self, user_id: str, since_ms: int | None
    ) -> list[BoardIndexRow]:
        rows: list[BoardIndexRow] = []
        for (uid, bid), b in self._boards.items():
            if uid != user_id:
                continue
            # Inclusive (>=) so a board stamped in the cursor's ms is never missed;
            # the client de-dupes by board_id.
            if since_ms is not None and b["updated_at"] < since_ms:
                continue
            rows.append(
                BoardIndexRow(
                    board_id=bid,
                    name_iv=b["name_iv"],
                    name_ct=b["name_ct"],
                    scene_version=b["scene_version"],
                    deleted=b["deleted"],
                    updated_at_ms=b["updated_at"],
                )
            )
        rows.sort(key=lambda r: r.updated_at_ms)
        return rows

    async def get_scene(self, user_id: str, board_id: str) -> SceneRecord | None:
        b = self._boards.get((user_id, board_id))
        if b is None or b["deleted"]:
            return None
        return self._scenes.get((user_id, board_id))

    async def push_scene(
        self,
        user_id: str,
        board_id: str,
        base_version: int,
        new_version: int,
        blob: Blob,
        name: Blob | None = None,
    ) -> PushResult:
        key = (user_id, board_id)
        b = self._boards.get(key)
        if b is None:
            board_count = sum(1 for (uid, _bid) in self._boards if uid == user_id)
            if board_count >= self._max_boards:
                raise LimitExceeded("boards-per-user")
            # Board absent: nothing to conflict with, client data is authoritative.
            self._boards[key] = {
                "name_iv": name.iv if name else None,
                "name_ct": name.ciphertext if name else None,
                "scene_version": new_version,
                "deleted": False,
                "updated_at": _now_ms(),
            }
            self._scenes[key] = SceneRecord(new_version, blob.iv, blob.ciphertext)
            return PushAccepted(new_version)

        cur = self._scenes.get(key)
        if b["scene_version"] != base_version and cur is not None:
            return PushConflict(cur.scene_version, cur.iv, cur.ciphertext)

        # CAS hit (or a board with no scene yet -> nothing to conflict, recreate).
        # A push does NOT revive a soft-deleted board — deletion wins (a stray or
        # racing push can never bring a deleted board back).
        b["scene_version"] = new_version
        b["updated_at"] = _now_ms()
        if name is not None:
            b["name_iv"] = name.iv
            b["name_ct"] = name.ciphertext
        self._scenes[key] = SceneRecord(new_version, blob.iv, blob.ciphertext)
        return PushAccepted(new_version)

    async def soft_delete_board(self, user_id: str, board_id: str) -> bool:
        b = self._boards.get((user_id, board_id))
        if b is None:
            return False
        b["deleted"] = True
        b["updated_at"] = _now_ms()
        return True

    async def get_file(
        self, user_id: str, board_id: str, file_id: str
    ) -> Blob | None:
        if (user_id, board_id) not in self._boards:
            return None
        return self._files.get((user_id, board_id, file_id))

    async def put_file(
        self, user_id: str, board_id: str, file_id: str, blob: Blob
    ) -> None:
        if (user_id, board_id) not in self._boards:
            raise BoardNotFound()
        k = (user_id, board_id, file_id)
        if k not in self._files:
            file_count = sum(
                1 for (u, b, _f) in self._files if u == user_id and b == board_id
            )
            if file_count >= self._max_files:
                raise LimitExceeded("files-per-board")
        # Content-addressed fileIds: collisions are identical bytes, so keep-first
        # is indistinguishable from last-write and avoids needless churn.
        self._files.setdefault(k, blob)

    async def reap_tombstones(self, grace_seconds: int) -> int:
        cutoff = _now_ms() - grace_seconds * 1000
        stale = [
            key
            for key, b in self._boards.items()
            if b["deleted"] and b["updated_at"] < cutoff
        ]
        for key in stale:
            self._boards.pop(key, None)
            self._scenes.pop(key, None)
            for fkey in [k for k in self._files if (k[0], k[1]) == key]:
                self._files.pop(fkey, None)
        return len(stale)

    # --- Phase 7: accounts -----------------------------------------------------

    async def create_local_user(
        self, email: str, password_hash: str, display_name: str | None
    ) -> User:
        ek = email.lower()
        if ek in self._email_index:
            existing = self._user_rows[self._email_index[ek]]
            raise EmailTaken(existing["auth_method"] or "local")
        row = self._new_row(
            external_sub=f"local:{email}",
            email=email,
            password_hash=password_hash,
            auth_method="local",
            display_name=display_name,
        )
        return _to_user(row)

    async def upsert_google_user(
        self, email: str, sub: str, display_name: str | None
    ) -> User:
        ek = email.lower()
        if ek in self._email_index:
            existing = self._user_rows[self._email_index[ek]]
            if existing["auth_method"] == "google":
                return _to_user(existing)
            raise EmailTaken(existing["auth_method"] or "local")
        row = self._new_row(
            external_sub=f"google:{sub}",
            email=email,
            email_verified=True,
            auth_method="google",
            oauth_sub=sub,
            display_name=display_name,
        )
        return _to_user(row)

    async def get_user_by_id(self, user_id: str) -> User | None:
        row = self._user_rows.get(user_id)
        return _to_user(row) if row else None

    async def get_user_by_email(self, email: str) -> User | None:
        uid = self._email_index.get(email.lower())
        return _to_user(self._user_rows[uid]) if uid else None

    async def set_email_verified(self, user_id: str) -> None:
        if user_id in self._user_rows:
            self._user_rows[user_id]["email_verified"] = True

    async def set_password(self, user_id: str, password_hash: str) -> None:
        row = self._user_rows.get(user_id)
        if row:
            row["password_hash"] = password_hash
            row["session_epoch"] += 1
            row["token_nonce"] += 1

    async def bump_token_nonce(self, user_id: str) -> None:
        if user_id in self._user_rows:
            self._user_rows[user_id]["token_nonce"] += 1

    async def set_role(self, user_id: str, role: str) -> None:
        if user_id in self._user_rows:
            self._user_rows[user_id]["role"] = role

    async def set_disabled(self, user_id: str, disabled: bool) -> None:
        row = self._user_rows.get(user_id)
        if row:
            row["disabled"] = disabled
            if disabled:
                row["session_epoch"] += 1

    async def delete_user(self, user_id: str) -> bool:
        row = self._user_rows.pop(user_id, None)
        if row is None:
            return False
        if row["email"]:
            self._email_index.pop(row["email"].lower(), None)
        if row["external_sub"]:
            self._users.pop(row["external_sub"], None)
        for key in [k for k in self._boards if k[0] == user_id]:
            self._boards.pop(key, None)
            self._scenes.pop(key, None)
        for fkey in [k for k in self._files if k[0] == user_id]:
            self._files.pop(fkey, None)
        return True

    async def list_users(self) -> list[tuple[User, int]]:
        out: list[tuple[User, int]] = []
        for uid, row in self._user_rows.items():
            count = sum(
                1
                for (u, _b), b in self._boards.items()
                if u == uid and not b["deleted"]
            )
            out.append((_to_user(row), count))
        return out

    async def grant_admin_by_email(self, email: str) -> bool:
        uid = self._email_index.get(email.lower())
        if uid is None:
            return False
        self._user_rows[uid]["role"] = "admin"
        return True

    async def count_admins(self) -> int:
        return sum(1 for r in self._user_rows.values() if r["role"] == "admin")

    async def adopt_legacy_single_user(self, email: str) -> User | None:
        uid = self._users.get("single-user")
        row = self._user_rows.get(uid) if uid else None
        if row is None or row["email"] is not None:
            return None
        # Only adopt a legacy account that actually has boards worth keeping.
        if not any(u == row["id"] for (u, _b) in self._boards):
            return None
        if email.lower() in self._email_index:
            return None
        row["email"] = email
        row["email_verified"] = True
        row["role"] = "admin"
        row["auth_method"] = "google"
        self._email_index[email.lower()] = row["id"]
        return _to_user(row)

    # --- Phase 8: API tokens + device grant ------------------------------------

    async def create_api_token(
        self, user_id: str, token_hash: str, name: str | None
    ) -> None:
        self._tokens[token_hash] = {"user_id": user_id, "revoked": False, "name": name}

    async def user_id_for_token(self, token_hash: str) -> str | None:
        t = self._tokens.get(token_hash)
        if t is None or t["revoked"]:
            return None
        return t["user_id"]

    async def create_device_grant(
        self, device_code: str, user_code: str, expires_at_ms: int
    ) -> None:
        self._device[device_code] = {
            "user_code": user_code,
            "user_id": None,
            "approved": False,
            "consumed": False,
            "expires_at_ms": expires_at_ms,
        }
        self._user_code_index[user_code] = device_code

    def _to_grant(self, device_code: str, d: dict) -> DeviceGrant:
        return DeviceGrant(
            device_code=device_code,
            user_code=d["user_code"],
            user_id=d["user_id"],
            approved=d["approved"],
            consumed=d["consumed"],
            expired=_now_ms() > d["expires_at_ms"],
        )

    async def get_device_grant_by_user_code(self, user_code: str) -> DeviceGrant | None:
        dc = self._user_code_index.get(user_code)
        if dc is None:
            return None
        return self._to_grant(dc, self._device[dc])

    async def approve_device_grant(self, user_code: str, user_id: str) -> bool:
        dc = self._user_code_index.get(user_code)
        d = self._device.get(dc) if dc else None
        if d is None or d["consumed"] or _now_ms() > d["expires_at_ms"]:
            return False
        d["approved"] = True
        d["user_id"] = user_id
        return True

    async def get_device_grant(self, device_code: str) -> DeviceGrant | None:
        d = self._device.get(device_code)
        return self._to_grant(device_code, d) if d else None

    async def consume_device_grant(self, device_code: str) -> str | None:
        d = self._device.get(device_code)
        if (
            d is None
            or d["consumed"]
            or not d["approved"]
            or d["user_id"] is None
            or _now_ms() > d["expires_at_ms"]
        ):
            return None
        d["consumed"] = True
        return d["user_id"]
