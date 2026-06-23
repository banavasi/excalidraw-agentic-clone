"""Store contract: the data model and the compare-and-swap semantics.

The server is an opaque blob store. The only field it reasons over is the
integer ``scene_version`` (= max(element.version), computed client-side). A
push is an optimistic compare-and-swap on ``base_version``:

* board absent              -> create (client data is authoritative), Accepted
* board.scene_version == base_version -> overwrite scene, Accepted(new_version)
* board.scene_version != base_version -> Conflict(current scene)  [HTTP 409]

On Conflict the client decrypts the returned current scene, runs
``reconcileElements`` locally, re-encrypts, and retries with the new base. The
server never decrypts, so the merge MUST happen on the client.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Union, runtime_checkable


class BoardNotFound(Exception):
    """Raised when a file push targets a board that does not exist for the user."""


class LimitExceeded(Exception):
    """Raised when an aggregate cap (boards-per-user, files-per-board) is hit."""

    def __init__(self, what: str) -> None:
        super().__init__(what)
        self.what = what


@dataclass(frozen=True)
class Blob:
    """An encrypted payload: opaque ciphertext + its IV. Never inspected."""

    iv: bytes
    ciphertext: bytes

    @property
    def byte_size(self) -> int:
        return len(self.ciphertext)


@dataclass(frozen=True)
class SceneRecord:
    scene_version: int
    iv: bytes
    ciphertext: bytes


@dataclass(frozen=True)
class BoardIndexRow:
    board_id: str
    name_iv: bytes | None
    name_ct: bytes | None
    scene_version: int
    deleted: bool
    updated_at_ms: int


@dataclass(frozen=True)
class PushAccepted:
    scene_version: int


@dataclass(frozen=True)
class PushConflict:
    scene_version: int
    iv: bytes
    ciphertext: bytes


PushResult = Union[PushAccepted, PushConflict]


@runtime_checkable
class Store(Protocol):
    async def startup(self) -> None: ...

    async def shutdown(self) -> None: ...

    async def healthcheck(self) -> bool: ...

    async def ensure_user(self, external_sub: str) -> str:
        """Idempotently create the user; return its id (uuid as str)."""

    async def get_index(
        self, user_id: str, since_ms: int | None
    ) -> list[BoardIndexRow]:
        """Boards for the user, optionally only those updated at or after
        ``since_ms`` (INCLUSIVE — the client de-dupes by board_id; inclusive
        avoids permanently missing a board stamped in the cursor's millisecond).
        Includes soft-deleted boards so tombstones propagate."""

    async def get_scene(self, user_id: str, board_id: str) -> SceneRecord | None:
        """Current scene for a live (non-deleted) board, or None."""

    async def push_scene(
        self,
        user_id: str,
        board_id: str,
        base_version: int,
        new_version: int,
        blob: Blob,
        name: Blob | None = None,
    ) -> PushResult:
        """Atomic compare-and-swap. See module docstring for semantics."""

    async def soft_delete_board(self, user_id: str, board_id: str) -> bool:
        """Tombstone a board (returns False if it does not exist)."""

    async def get_file(
        self, user_id: str, board_id: str, file_id: str
    ) -> Blob | None: ...

    async def put_file(
        self, user_id: str, board_id: str, file_id: str, blob: Blob
    ) -> None:
        """Store a file blob (idempotent; raises BoardNotFound if board absent,
        LimitExceeded if the per-board file cap is hit)."""

    async def reap_tombstones(self, grace_seconds: int) -> int:
        """Permanently drop boards soft-deleted longer than ``grace_seconds`` ago.
        Returns the number reaped. Runs at startup (spec §3)."""
