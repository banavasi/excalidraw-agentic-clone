"""Cloudflare Access JWT door (Phase 6).

The server re-verifies the JWT signature/aud/iss itself — it must NOT trust the raw
`Cf-Access-Jwt-Assertion` header, because the origin is also reachable via the
bearer host + tailnet bind where that header could be spoofed. These tests sign real
RS256 tokens and stub the JWKS lookup with the matching public key.
"""

from __future__ import annotations

import time

import jwt
import pytest_asyncio
from asgi_lifespan import LifespanManager
from cryptography.hazmat.primitives.asymmetric import rsa
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.main import create_app
from app.store.memory import InMemoryStore
from tests.util import BEARER

TEAM = "testteam.cloudflareaccess.com"
AUD = "test-aud-tag"
EMAIL = "user@example.com"

_PRIV = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUB = _PRIV.public_key()
_OTHER = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class _FakeKey:
    def __init__(self, key) -> None:
        self.key = key


class _FakeJWKClient:
    """Stands in for PyJWKClient: always returns our test public key."""

    def __init__(self, key) -> None:
        self._key = key

    def get_signing_key_from_jwt(self, token: str) -> _FakeKey:  # noqa: ARG002
        return _FakeKey(self._key)


class _DownJWKClient:
    """JWKS endpoint unreachable — get_signing_key raises (not an InvalidTokenError)."""

    def get_signing_key_from_jwt(self, token: str):  # noqa: ARG002
        from jwt import PyJWKClientError

        raise PyJWKClientError("jwks endpoint unreachable")


def _token(signer=_PRIV, *, aud=AUD, iss=f"https://{TEAM}", exp_delta=3600, **extra) -> str:
    claims = {"aud": aud, "iss": iss, "email": EMAIL, "exp": int(time.time()) + exp_delta}
    claims.update(extra)
    return jwt.encode(claims, signer, algorithm="RS256")


@pytest_asyncio.fixture
async def cf_client():
    settings = Settings(
        sync_bearer=BEARER,
        database_url=None,
        cors_origins=["*"],
        cf_access_team_domain=TEAM,
        cf_access_aud=AUD,
    )
    app = create_app(store=InMemoryStore(), settings=settings)
    app.state.cf_jwks_client = _FakeJWKClient(_PUB)  # stub the network JWKS fetch
    async with LifespanManager(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


def _hdr(token: str) -> dict:
    return {"Cf-Access-Jwt-Assertion": token}


async def test_valid_jwt_authenticates_and_whoami_returns_email(cf_client):
    r = await cf_client.get("/sync/index", headers=_hdr(_token()))
    assert r.status_code == 200

    who = await cf_client.get("/sync/whoami", headers=_hdr(_token()))
    assert who.status_code == 200
    assert who.json()["email"] == EMAIL


async def test_jwt_via_cookie_also_works(cf_client):
    cf_client.cookies.set("CF_Authorization", _token())
    r = await cf_client.get("/sync/index")
    assert r.status_code == 200


async def test_wrong_audience_rejected(cf_client):
    r = await cf_client.get("/sync/index", headers=_hdr(_token(aud="someone-else")))
    assert r.status_code == 401


async def test_wrong_issuer_rejected(cf_client):
    r = await cf_client.get(
        "/sync/index", headers=_hdr(_token(iss="https://evil.cloudflareaccess.com"))
    )
    assert r.status_code == 401


async def test_token_signed_by_other_key_rejected(cf_client):
    # Right shape, wrong signer — the spoof the signature check exists to stop.
    r = await cf_client.get("/sync/index", headers=_hdr(_token(signer=_OTHER)))
    assert r.status_code == 401


async def test_expired_jwt_rejected(cf_client):
    r = await cf_client.get("/sync/index", headers=_hdr(_token(exp_delta=-60)))
    assert r.status_code == 401


async def test_garbage_jwt_rejected(cf_client):
    r = await cf_client.get("/sync/index", headers=_hdr("not.a.jwt"))
    assert r.status_code == 401


async def test_bearer_still_works_when_jwt_door_open(cf_client):
    # No JWT present → fall through to the machine (bearer) door.
    r = await cf_client.get("/sync/index", headers={"Authorization": f"Bearer {BEARER}"})
    assert r.status_code == 200
    who = await cf_client.get("/sync/whoami", headers={"Authorization": f"Bearer {BEARER}"})
    assert who.json()["email"] is None


async def test_no_credentials_rejected(cf_client):
    r = await cf_client.get("/sync/index")
    assert r.status_code == 401


@pytest_asyncio.fixture
async def cf_client_jwks_down():
    """JWT door configured but the JWKS endpoint is unreachable."""
    settings = Settings(
        sync_bearer=BEARER,
        database_url=None,
        cors_origins=["*"],
        cf_access_team_domain=TEAM,
        cf_access_aud=AUD,
    )
    app = create_app(store=InMemoryStore(), settings=settings)
    app.state.cf_jwks_client = _DownJWKClient()
    async with LifespanManager(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


async def test_jwks_down_does_not_block_a_valid_bearer(cf_client_jwks_down):
    # A request carrying BOTH a CF header and a valid bearer must fall through to the
    # bearer when the JWT door can't be evaluated — JWKS outage ≠ bad token.
    r = await cf_client_jwks_down.get(
        "/sync/index",
        headers={**_hdr(_token()), "Authorization": f"Bearer {BEARER}"},
    )
    assert r.status_code == 200


async def test_jwks_down_browser_only_still_401(cf_client_jwks_down):
    # No bearer to fall through to → fail closed (can't verify without the keys).
    r = await cf_client_jwks_down.get("/sync/index", headers=_hdr(_token()))
    assert r.status_code == 401
