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


class EmailTaken(Exception):
    """Signup collides with an existing account on a DIFFERENT auth method.

    ``existing_method`` is the method already registered for that email, so the
    caller can say "sign in with Google / your password" (no silent merge — v1).
    """

    def __init__(self, existing_method: str) -> None:
        super().__init__(existing_method)
        self.existing_method = existing_method


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


@dataclass(frozen=True)
class User:
    id: str
    email: str | None
    password_hash: str | None
    email_verified: bool
    role: str
    disabled: bool
    display_name: str | None
    auth_method: str | None  # 'local' | 'google'
    oauth_sub: str | None
    session_epoch: int
    token_nonce: int


@dataclass(frozen=True)
class DeviceGrant:
    device_code: str
    user_code: str
    user_id: str | None
    approved: bool
    consumed: bool
    expired: bool


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

    # --- Phase 7: accounts -----------------------------------------------------

    async def create_local_user(
        self, email: str, password_hash: str, display_name: str | None
    ) -> User:
        """Create an unverified email+password account. Raises EmailTaken if the
        email already exists (with its existing auth method)."""

    async def upsert_google_user(
        self, email: str, sub: str, display_name: str | None
    ) -> User:
        """Return the existing google account for ``email`` (logging in), or create
        a verified one. Raises EmailTaken('local') if the email is a password
        account — no silent merge (v1)."""

    async def get_user_by_id(self, user_id: str) -> User | None: ...

    async def get_user_by_email(self, email: str) -> User | None: ...

    async def set_email_verified(self, user_id: str) -> None: ...

    async def set_password(self, user_id: str, password_hash: str) -> None:
        """Set a new password AND bump session_epoch + token_nonce (kills existing
        sessions and outstanding verify/reset links)."""

    async def bump_token_nonce(self, user_id: str) -> None: ...

    async def set_role(self, user_id: str, role: str) -> None: ...

    async def set_disabled(self, user_id: str, disabled: bool) -> None:
        """Disable/enable; disabling bumps session_epoch (kicks the user)."""

    async def delete_user(self, user_id: str) -> bool: ...

    async def list_users(self) -> list[tuple[User, int]]:
        """All users with their (non-deleted) board count, for the admin panel."""

    async def grant_admin_by_email(self, email: str) -> bool:
        """Promote an existing account to admin (admin seeding). False if absent."""

    async def count_admins(self) -> int: ...

    async def adopt_legacy_single_user(self, email: str) -> User | None:
        """One-shot migration: if a legacy ``external_sub='single-user'`` row exists
        with no email and ``email`` is free, attach it to that admin email
        (keeping its boards). Returns the adopted user or None."""

    # --- Phase 8: per-user API tokens + device grant ---------------------------

    async def create_api_token(
        self, user_id: str, token_hash: str, name: str | None
    ) -> None: ...

    async def user_id_for_token(self, token_hash: str) -> str | None:
        """Resolve a (non-revoked) API token hash to its user_id; touches
        last_used_at. None if unknown/revoked."""

    async def create_device_grant(
        self, device_code: str, user_code: str, expires_at_ms: int
    ) -> None: ...

    async def get_device_grant_by_user_code(self, user_code: str) -> DeviceGrant | None:
        ...

    async def approve_device_grant(self, user_code: str, user_id: str) -> bool:
        """Mark the grant approved + attach the approving user. False if unknown
        or expired."""

    async def get_device_grant(self, device_code: str) -> DeviceGrant | None: ...

    async def consume_device_grant(self, device_code: str) -> str | None:
        """If approved & unconsumed & unexpired, mark consumed and return the
        approving user_id (so a token is minted exactly once). Else None."""
