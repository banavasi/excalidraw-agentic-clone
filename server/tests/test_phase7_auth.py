"""Phase 7 multi-user auth — the security-critical test plan (spec §11).

Uses the in-memory store. We introspect the store directly to mint the verify/
reset tokens a real flow would email, and to set up users without SMTP.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.main import create_app
from app.security import hash_password
from app.store.base import EmailTaken
from app.store.memory import InMemoryStore
from tests.util import IV, BEARER, b

SECRET = "test-secret-key-0123456789abcdef0123456789abcdef"


def _settings(**kw) -> Settings:
    base = dict(
        secret_key=SECRET,
        public_url="http://test",
        admin_email="",  # adoption/seeding OFF unless a test opts in
        sync_bearer=BEARER,
        database_url=None,
        cors_origins=["*"],
    )
    base.update(kw)
    return Settings(**base)


@asynccontextmanager
async def auth_app(**kw):
    store = InMemoryStore()
    app = create_app(store=store, settings=_settings(**kw))
    async with LifespanManager(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            yield ac, store, app


def _client(app) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _verified(store, email, password):
    u = await store.create_local_user(email, hash_password(password), None)
    await store.set_email_verified(u.id)
    return await store.get_user_by_email(email)


async def test_signup_verify_login_and_token_single_use():
    async with auth_app() as (ac, store, app):
        r = await ac.post(
            "/auth/signup",
            json={"email": "a@example.com", "password": "password123", "name": "A"},
        )
        assert r.status_code == 200
        user = await store.get_user_by_email("a@example.com")
        assert user and not user.email_verified

        # login blocked before verification
        r = await ac.post(
            "/auth/login", json={"email": "a@example.com", "password": "password123"}
        )
        assert r.status_code == 403

        token = app.state.tokens.make_email_token("verify", user.id, user.token_nonce)
        r = await ac.get(f"/auth/verify?token={token}", follow_redirects=False)
        assert r.status_code == 303
        assert (await store.get_user_by_email("a@example.com")).email_verified

        # replay rejected — verify token is single-use (nonce bumped)
        r = await ac.get(f"/auth/verify?token={token}", follow_redirects=False)
        assert "error=bad_link" in r.headers["location"]

        r = await ac.post(
            "/auth/login", json={"email": "a@example.com", "password": "password123"}
        )
        assert r.status_code == 200
        assert (await ac.get("/auth/me")).json()["authenticated"] is True


async def test_signup_short_password_rejected():
    async with auth_app() as (ac, store, app):
        r = await ac.post("/auth/signup", json={"email": "x@example.com", "password": "short"})
        assert r.status_code == 422


async def test_login_enumeration_safe():
    async with auth_app() as (ac, store, app):
        r = await ac.post(
            "/auth/login", json={"email": "nobody@example.com", "password": "whatever1"}
        )
        assert r.status_code == 401
        assert r.json()["detail"] == "Invalid email or password"

        await _verified(store, "b@example.com", "password123")
        r = await ac.post(
            "/auth/login", json={"email": "b@example.com", "password": "wrongpass1"}
        )
        assert r.status_code == 401
        assert r.json()["detail"] == "Invalid email or password"


async def test_forgot_reset_and_single_use():
    async with auth_app() as (ac, store, app):
        u = await _verified(store, "c@example.com", "password123")
        # forgot is always 200 even for an unknown email (no enumeration)
        assert (
            await ac.post("/auth/forgot", json={"email": "unknown@example.com"})
        ).status_code == 200

        token = app.state.tokens.make_email_token("reset", u.id, u.token_nonce)
        assert (
            await ac.post("/auth/reset", json={"token": token, "password": "newpass1234"})
        ).status_code == 200

        # old password no longer works; new one does
        assert (
            await ac.post(
                "/auth/login", json={"email": "c@example.com", "password": "password123"}
            )
        ).status_code == 401
        assert (
            await ac.post(
                "/auth/login", json={"email": "c@example.com", "password": "newpass1234"}
            )
        ).status_code == 200

        # reset token is single-use (set_password bumped the nonce)
        assert (
            await ac.post("/auth/reset", json={"token": token, "password": "another1234"})
        ).status_code == 400


async def test_email_collision_no_merge():
    async with auth_app() as (ac, store, app):
        await _verified(store, "dup@example.com", "password123")
        with pytest.raises(EmailTaken):
            await store.upsert_google_user("dup@example.com", "google-sub-1", "Dup")

        # signup over an existing google account is rejected at the API
        await store.upsert_google_user("g@example.com", "sub-2", "G")
        r = await ac.post(
            "/auth/signup", json={"email": "g@example.com", "password": "password123"}
        )
        assert r.status_code == 409


async def test_two_user_board_isolation():
    async with auth_app() as (_ac, store, app):
        await _verified(store, "u1@example.com", "password123")
        await _verified(store, "u2@example.com", "password123")
        async with _client(app) as c1, _client(app) as c2:
            await c1.post(
                "/auth/login", json={"email": "u1@example.com", "password": "password123"}
            )
            await c2.post(
                "/auth/login", json={"email": "u2@example.com", "password": "password123"}
            )
            push = {
                "base_version": 0,
                "scene_version": 1,
                "iv": IV,
                "ciphertext": b(b"u1-secret"),
            }
            assert (await c1.put("/sync/boards/board-1", json=push)).status_code == 200
            assert any(
                x["board_id"] == "board-1" for x in (await c1.get("/sync/index")).json()
            )
            assert (await c2.get("/sync/index")).json() == []
            assert (await c2.get("/sync/boards/board-1")).status_code == 404


async def test_admin_guard_and_self_protection():
    async with auth_app() as (_ac, store, app):
        admin = await _verified(store, "admin@example.com", "password123")
        await store.grant_admin_by_email("admin@example.com")
        user = await _verified(store, "user@example.com", "password123")
        async with _client(app) as ca, _client(app) as cu:
            await ca.post(
                "/auth/login", json={"email": "admin@example.com", "password": "password123"}
            )
            await cu.post(
                "/auth/login", json={"email": "user@example.com", "password": "password123"}
            )
            assert (await cu.get("/admin/users")).status_code == 403  # non-admin
            assert len((await ca.get("/admin/users")).json()) >= 2

            # admin cannot disable itself
            assert (await ca.post(f"/admin/users/{admin.id}/disable")).status_code == 403
            # admin disables the user -> epoch bump kicks them on the next request
            assert (await ca.post(f"/admin/users/{user.id}/disable")).status_code == 200
            assert (await cu.get("/sync/index")).status_code == 401


async def test_device_flow_issues_user_scoped_token():
    async with auth_app() as (_ac, store, app):
        await _verified(store, "dev@example.com", "password123")
        async with _client(app) as agent, _client(app) as browser:
            d = (await agent.post("/oauth/device/code", json={"client_name": "claude"})).json()
            assert d["user_code"] and d["device_code"]

            # poll before approval
            r = await agent.post("/oauth/device/token", json={"device_code": d["device_code"]})
            assert r.status_code == 400  # authorization_pending

            await browser.post(
                "/auth/login", json={"email": "dev@example.com", "password": "password123"}
            )
            assert (
                await browser.post("/oauth/device/approve", json={"user_code": d["user_code"]})
            ).status_code == 200

            r = await agent.post("/oauth/device/token", json={"device_code": d["device_code"]})
            assert r.status_code == 200
            tok = r.json()["access_token"]
            assert tok.startswith("exb_")

            # the token authenticates as that user, scoped to their boards
            r = await agent.get("/sync/whoami", headers={"Authorization": f"Bearer {tok}"})
            assert r.json()["email"] == "dev@example.com"

            # token is minted exactly once — a second poll fails
            r = await agent.post("/oauth/device/token", json={"device_code": d["device_code"]})
            assert r.status_code == 400


async def test_admin_email_adoption_keeps_legacy_boards():
    # A legacy single-user WITH boards is adopted onto admin_email at startup, so
    # the operator's existing boards stay reachable via Google login + the bearer.
    from app.store.base import Blob

    store = InMemoryStore()
    sid = await store.ensure_user("single-user")  # pre-seed legacy account + a board
    await store.push_scene(sid, "old-board", 0, 1, Blob(b"", b"data"))
    app = create_app(store=store, settings=_settings(admin_email="owner@example.com"))
    async with LifespanManager(app):
        owner = await store.get_user_by_email("owner@example.com")
        assert owner is not None
        # adopted as a passwordless local admin -> claimable via "Forgot password"
        assert owner.role == "admin" and owner.auth_method == "local"
        assert owner.password_hash is None
        assert owner.id == sid == app.state.single_user_id  # same row, boards intact
        idx = await store.get_index(owner.id, None)
        assert any(r.board_id == "old-board" for r in idx)

        # it's a local account now, so a Google sign-in with that email is rejected
        # (no silent auto-link) — consistent with the collision rule
        with pytest.raises(EmailTaken):
            await store.upsert_google_user("owner@example.com", "g-sub", "Owner")


async def test_empty_legacy_not_adopted_so_admin_can_sign_up():
    # No legacy boards -> the admin email stays free for a normal local signup,
    # which is promoted to admin on verification.
    async with auth_app(admin_email="boss@example.com") as (ac, store, app):
        assert await store.get_user_by_email("boss@example.com") is None
        u = await store.create_local_user("boss@example.com", hash_password("password123"), None)
        token = app.state.tokens.make_email_token("verify", u.id, u.token_nonce)
        await ac.get(f"/auth/verify?token={token}", follow_redirects=False)
        assert (await store.get_user_by_email("boss@example.com")).role == "admin"
