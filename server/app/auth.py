"""Auth doors (Phase 7 multi-user).

``require_user`` resolves a request to a real per-user id via, in order:

1. **Session cookie** (browser) — a signed ``{uid, epoch}`` cookie. The user is
   re-loaded every request and rejected if ``disabled``, if the cookie's epoch is
   stale (``session_epoch`` was bumped → logout-everywhere / disable / password
   change), or if a local account is unverified.
2. **Per-user API token** (Phase 8 MCP) — ``Authorization: Bearer exb_…``, resolved
   by SHA-256 hash to its owning user.
3. **Legacy static bearer** (deprecated) — the single ``SYNC_BEARER`` still maps to
   the original single-user account, so the existing MCP tool keeps working until
   the device-flow tokens replace it. (Cloudflare Access, if deployed, is now just
   a network gate in front — no longer an identity source.)

The resolved ``User`` is stashed on ``request.state.user`` (and ``.email``) so
routes and ``require_admin`` can read role/identity without a second lookup.
"""

from __future__ import annotations

import secrets

from fastapi import HTTPException, Request

from .security import cookie_secure, hash_token
from .store.base import User

SESSION_COOKIE = "exb_session"

_UNAUTH = HTTPException(
    status_code=401,
    detail="unauthorized",
    headers={"WWW-Authenticate": "Bearer"},
)


def _extract_bearer(authorization: str | None) -> str:
    if not authorization:
        return ""
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return ""
    return parts[1].strip()


async def _from_cookie(request: Request) -> User | None:
    tokens = getattr(request.app.state, "tokens", None)
    if tokens is None:
        return None
    raw = request.cookies.get(SESSION_COOKIE)
    if not raw:
        return None
    settings = request.app.state.settings
    data = tokens.read_session(raw, settings.session_ttl_seconds)
    if not data:
        return None
    user = await request.app.state.store.get_user_by_id(data.get("uid", ""))
    if user is None or user.disabled:
        return None
    if user.session_epoch != data.get("epoch"):
        return None  # epoch bumped -> this cookie is revoked
    if user.auth_method == "local" and not user.email_verified:
        return None
    return user


async def _from_bearer(request: Request) -> User | None:
    token = _extract_bearer(request.headers.get("authorization"))
    if not token:
        return None
    store = request.app.state.store
    settings = request.app.state.settings
    # Per-user API token (Phase 8).
    uid = await store.user_id_for_token(hash_token(token))
    if uid:
        user = await store.get_user_by_id(uid)
        if user and not user.disabled:
            return user
        return None
    # Legacy static bearer -> the original single-user account (deprecated).
    expected = settings.sync_bearer
    sid = getattr(request.app.state, "single_user_id", None)
    if expected and sid and secrets.compare_digest(token, expected):
        user = await store.get_user_by_id(sid)
        if user and not user.disabled:
            return user
    return None


async def current_user(request: Request) -> User | None:
    user = await _from_cookie(request)
    if user is None:
        user = await _from_bearer(request)
    if user is not None:
        request.state.user = user
        request.state.email = user.email
    return user


async def require_user(request: Request) -> str:
    user = await current_user(request)
    if user is None:
        raise _UNAUTH
    return user.id


async def require_admin(request: Request) -> str:
    user_id = await require_user(request)
    user: User = request.state.user
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="admin only")
    return user_id


def set_session_cookie(response, request: Request, user: User) -> None:
    settings = request.app.state.settings
    token = request.app.state.tokens.make_session(user.id, user.session_epoch)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=settings.session_ttl_seconds,
        httponly=True,
        secure=cookie_secure(settings.public_url),
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response, request: Request) -> None:
    settings = request.app.state.settings
    response.delete_cookie(
        SESSION_COOKIE,
        httponly=True,
        secure=cookie_secure(settings.public_url),
        samesite="lax",
        path="/",
    )
