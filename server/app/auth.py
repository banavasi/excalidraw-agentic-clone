"""Static-bearer auth (single-user v1).

The bearer authenticates the one account; ``request.app.state.single_user_id``
(resolved once at startup) is returned as the caller identity. Constant-time
compare avoids a timing oracle. Fails closed if no bearer is configured.
"""

from __future__ import annotations

import secrets

from fastapi import HTTPException, Request

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


async def require_user(request: Request) -> str:
    settings = request.app.state.settings
    expected = settings.sync_bearer
    token = _extract_bearer(request.headers.get("authorization"))
    if not expected or not token or not secrets.compare_digest(token, expected):
        raise _UNAUTH
    return request.app.state.single_user_id
