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
    LimitExceeded,
    PushAccepted,
    PushConflict,
    PushResult,
    SceneRecord,
)


def _now_ms() -> int:
    return int(time.time() * 1000)


class InMemoryStore:
    def __init__(
        self, *, max_boards_per_user: int = 5000, max_files_per_board: int = 5000
    ) -> None:
        self._users: dict[str, str] = {}
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

    async def ensure_user(self, external_sub: str) -> str:
        if external_sub not in self._users:
            self._users[external_sub] = str(uuid.uuid4())
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
        # Undelete: any push implies the board is live.
        b["scene_version"] = new_version
        b["deleted"] = False
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
