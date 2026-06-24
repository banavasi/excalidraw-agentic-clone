"""Two-door auth (single-user v1).

The BROWSER authenticates with the Cloudflare Access JWT (``Cf-Access-Jwt-Assertion``
header, or the ``CF_Authorization`` cookie) — Access already verified the email via
Google OIDC; we re-verify the signature so a spoofed header on the tailnet/bearer path
can't impersonate. The MACHINE (MCP tool) authenticates with the static bearer.

Either valid identity maps to ``request.app.state.single_user_id`` (one human, one
account). A JWT that is present-but-invalid fails closed (401, never falls through to
the bearer). If Cloudflare Access isn't configured (no aud/team), the JWT door is simply
absent and only the bearer is honored — that's the test/local-dev path.
"""

from __future__ import annotations

import logging
import secrets

from fastapi import HTTPException, Request
from fastapi.concurrency import run_in_threadpool

log = logging.getLogger("excaliboard")

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


def _cf_jwt(request: Request) -> str:
    """The Cloudflare Access assertion, from the injected header or the cookie."""
    return (
        request.headers.get("cf-access-jwt-assertion")
        or request.cookies.get("CF_Authorization")
        or ""
    )


async def _verify_cf_access(request: Request) -> dict | None:
    """Return the verified Access claims, or None if the JWT door is absent/empty.

    Raises 401 if a token IS present but fails verification (bad signature, wrong
    audience/issuer, expired) — a present-but-bad token must never fall through.
    """
    settings = request.app.state.settings
    client = getattr(request.app.state, "cf_jwks_client", None)
    if not settings.cf_access_aud or not settings.cf_access_team_domain or client is None:
        return None  # JWT door disabled (no Cloudflare Access configured)
    token = _cf_jwt(request)
    if not token:
        return None  # let the bearer door try
    import jwt  # PyJWT — lazy so the bearer-only path needs no crypto dep at import

    try:
        signing_key = await run_in_threadpool(
            client.get_signing_key_from_jwt, token
        )
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=settings.cf_access_aud,
            issuer=f"https://{settings.cf_access_team_domain}",
            options={"require": ["exp", "aud", "iss"]},
        )
    except jwt.InvalidTokenError as exc:
        # Token is PRESENT but cryptographically/claim-invalid (bad signature, aud,
        # iss, expired, garbage) — fail closed, never fall through to the bearer.
        raise _UNAUTH from exc
    except Exception:  # noqa: BLE001
        # Could not EVALUATE the JWT door (e.g. JWKS endpoint briefly unreachable).
        # Don't take the machine/bearer door down with it: return None so require_user
        # can still honor a valid bearer. A browser request (no bearer) then 401s
        # anyway at the end of require_user — unavoidable while JWKS is unreachable.
        log.warning("cloudflare access JWT could not be evaluated (JWKS?)", exc_info=True)
        return None


async def require_user(request: Request) -> str:
    # Browser door: Cloudflare Access JWT (verified email).
    claims = await _verify_cf_access(request)
    if claims is not None:
        request.state.email = claims.get("email")
        return request.app.state.single_user_id
    # Machine door: static bearer (MCP tool).
    settings = request.app.state.settings
    expected = settings.sync_bearer
    token = _extract_bearer(request.headers.get("authorization"))
    if expected and token and secrets.compare_digest(token, expected):
        request.state.email = None
        return request.app.state.single_user_id
    raise _UNAUTH
