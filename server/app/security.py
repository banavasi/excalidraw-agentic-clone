"""Password hashing, signed cookies/tokens, and API-token minting.

Pure helpers over ``itsdangerous`` (HMAC-signed, server-secret) + ``argon2``.
The session cookie carries only ``{uid, epoch}`` — every request re-loads the
user to check ``disabled`` and that ``cookie.epoch == user.session_epoch`` (so a
single ``session_epoch`` bump revokes all of a user's cookies). Verify/reset
email tokens carry ``{uid, nonce}``; a ``token_nonce`` bump invalidates
outstanding links (single-use). The server never stores an API token in the
clear — only its SHA-256 hash.
"""

from __future__ import annotations

import hashlib
import secrets

from argon2 import PasswordHasher
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

_ph = PasswordHasher()


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    if not password_hash:
        return False
    try:
        return _ph.verify(password_hash, password)
    except Exception:  # noqa: BLE001 — mismatch/invalid-hash/etc. all mean "no"
        return False


def cookie_secure(public_url: str) -> bool:
    """`Secure` on for https; OFF for http://localhost (browsers reject Secure
    cookies on plain http, which would brick a localhost self-host)."""
    return public_url.lower().startswith("https://")


def hash_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def new_api_token() -> tuple[str, str]:
    """Return (plaintext, sha256-hash). Plaintext is shown to the user once."""
    plaintext = "exb_" + secrets.token_urlsafe(32)
    return plaintext, hash_token(plaintext)


def new_device_code() -> str:
    return secrets.token_urlsafe(32)


def new_user_code() -> str:
    """Human-typeable device user_code, e.g. ``WDJB-MJHT`` (no ambiguous chars)."""
    alphabet = "BCDFGHJKLMNPQRSTVWXYZ23456789"
    pick = "".join(secrets.choice(alphabet) for _ in range(8))
    return f"{pick[:4]}-{pick[4:]}"


class TokenService:
    """Signed-cookie / email-token (de)serialization, bound to ``secret_key``."""

    def __init__(self, secret_key: str) -> None:
        self._session = URLSafeTimedSerializer(secret_key, salt="excaliboard.session")
        self._email = {
            "verify": URLSafeTimedSerializer(secret_key, salt="excaliboard.verify"),
            "reset": URLSafeTimedSerializer(secret_key, salt="excaliboard.reset"),
        }

    # --- session cookie ---
    def make_session(self, user_id: str, epoch: int) -> str:
        return self._session.dumps({"uid": user_id, "epoch": epoch})

    def read_session(self, token: str, max_age: int) -> dict | None:
        try:
            data = self._session.loads(token, max_age=max_age)
        except (BadSignature, SignatureExpired):
            return None
        return data if isinstance(data, dict) else None

    # --- email (verify / reset) tokens ---
    def make_email_token(self, kind: str, user_id: str, nonce: int) -> str:
        return self._email[kind].dumps({"uid": user_id, "nonce": nonce})

    def read_email_token(self, kind: str, token: str, max_age: int) -> dict | None:
        try:
            data = self._email[kind].loads(token, max_age=max_age)
        except (BadSignature, SignatureExpired):
            return None
        return data if isinstance(data, dict) else None
