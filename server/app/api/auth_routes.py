"""In-app auth routes: signup / verify / login / logout / forgot / reset / google.

Enumeration-safe: login returns one error for unknown-email and wrong-password;
forgot/resend always return 200. Verify/reset tokens are single-use (a
``token_nonce`` bump invalidates them). Proving control of the email via either
the verify OR the reset link marks the account verified.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, EmailStr, Field

from ..auth import clear_session_cookie, current_user, set_session_cookie
from ..email import send_reset, send_verification
from ..store.base import EmailTaken, User


class SignupBody(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    name: str | None = Field(default=None, max_length=120)


class LoginBody(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)


class EmailBody(BaseModel):
    email: EmailStr


class ResetBody(BaseModel):
    token: str
    password: str = Field(min_length=8, max_length=200)


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _public(request: Request, path: str) -> str:
    return request.app.state.settings.public_url.rstrip("/") + path


def _limit(request: Request, key: str, limit: int, window: int) -> None:
    if not request.app.state.ratelimit.allow(key, limit, window):
        raise HTTPException(status_code=429, detail="too many requests, slow down")


async def _maybe_grant_admin(request: Request, user: User) -> None:
    admin_email = request.app.state.settings.admin_email
    if admin_email and user.email and user.email.lower() == admin_email.lower():
        if user.role != "admin":
            await request.app.state.store.set_role(user.id, "admin")


def build_auth_router() -> APIRouter:
    r = APIRouter()

    @r.get("/auth/config")
    async def auth_config(request: Request) -> dict:
        s = request.app.state.settings
        return {"google": bool(s.google_client_id and s.google_client_secret)}

    @r.get("/auth/me")
    async def me(request: Request) -> dict:
        user = await current_user(request)
        if user is None:
            return {"authenticated": False}
        return {
            "authenticated": True,
            "email": user.email,
            "role": user.role,
            "display_name": user.display_name,
        }

    @r.post("/auth/signup")
    async def signup(body: SignupBody, request: Request) -> dict:
        _limit(request, f"signup:{_client_ip(request)}", 5, 900)
        store = request.app.state.store
        from ..security import hash_password

        try:
            user = await store.create_local_user(
                str(body.email), hash_password(body.password), body.name
            )
        except EmailTaken as e:
            raise HTTPException(
                status_code=409,
                detail=f"That email is already registered (sign in with "
                f"{'Google' if e.existing_method == 'google' else 'your password'}).",
            )
        await _send_verify(request, user)
        return {"ok": True, "verification_required": True}

    @r.get("/auth/verify")
    async def verify(token: str, request: Request):
        store = request.app.state.store
        s = request.app.state.settings
        data = request.app.state.tokens.read_email_token(
            "verify", token, s.verify_ttl_seconds
        )
        user = await store.get_user_by_id(data["uid"]) if data else None
        if user is None or data.get("nonce") != user.token_nonce:
            return RedirectResponse(_public(request, "/login?error=bad_link"), 303)
        await store.set_email_verified(user.id)
        await store.bump_token_nonce(user.id)  # single-use
        await _maybe_grant_admin(request, user)
        fresh = await store.get_user_by_id(user.id)
        resp = RedirectResponse(_public(request, "/?verified=1"), 303)
        set_session_cookie(resp, request, fresh)  # auto-login
        return resp

    @r.post("/auth/resend")
    async def resend(body: EmailBody, request: Request) -> dict:
        _limit(request, f"resend:{str(body.email).lower()}", 3, 900)
        store = request.app.state.store
        user = await store.get_user_by_email(str(body.email))
        if user and user.auth_method == "local" and not user.email_verified:
            await store.bump_token_nonce(user.id)  # invalidate old links
            await _send_verify(request, await store.get_user_by_id(user.id))
        return {"ok": True}  # always 200 (no enumeration)

    @r.post("/auth/login")
    async def login(body: LoginBody, request: Request) -> JSONResponse:
        _limit(request, f"login:{_client_ip(request)}:{str(body.email).lower()}", 8, 900)
        from ..security import verify_password

        store = request.app.state.store
        user = await store.get_user_by_email(str(body.email))
        bad = JSONResponse(status_code=401, content={"detail": "Invalid email or password"})
        if user is None or user.auth_method != "local" or user.disabled:
            return bad
        if not verify_password(user.password_hash, body.password):
            return bad
        if not user.email_verified:
            return JSONResponse(
                status_code=403,
                content={"detail": "Please confirm your email first.", "unverified": True},
            )
        resp = JSONResponse(
            content={"email": user.email, "role": user.role, "display_name": user.display_name}
        )
        set_session_cookie(resp, request, user)
        return resp

    @r.post("/auth/logout")
    async def logout(request: Request) -> JSONResponse:
        resp = JSONResponse(content={"ok": True})
        clear_session_cookie(resp, request)
        return resp

    @r.post("/auth/forgot")
    async def forgot(body: EmailBody, request: Request) -> dict:
        _limit(request, f"forgot:{str(body.email).lower()}", 3, 900)
        store = request.app.state.store
        user = await store.get_user_by_email(str(body.email))
        if user and user.auth_method == "local":
            token = request.app.state.tokens.make_email_token(
                "reset", user.id, user.token_nonce
            )
            await send_reset(
                request.app.state.settings,
                user.email,
                _public(request, f"/reset?token={token}"),
            )
        return {"ok": True}  # always 200 (no enumeration)

    @r.post("/auth/reset")
    async def reset(body: ResetBody, request: Request) -> dict:
        store = request.app.state.store
        s = request.app.state.settings
        data = request.app.state.tokens.read_email_token("reset", body.token, s.reset_ttl_seconds)
        user = await store.get_user_by_id(data["uid"]) if data else None
        if user is None or data.get("nonce") != user.token_nonce:
            raise HTTPException(status_code=400, detail="This reset link is invalid or expired.")
        from ..security import hash_password

        await store.set_email_verified(user.id)  # the reset link proves email control
        await store.set_password(user.id, hash_password(body.password))  # bumps epoch+nonce
        return {"ok": True}

    # --- Google OAuth ---
    @r.get("/auth/google/login")
    async def google_login(request: Request):
        oauth = getattr(request.app.state, "oauth", None)
        if oauth is None:
            raise HTTPException(status_code=404, detail="Google sign-in not configured")
        return await oauth.google.authorize_redirect(
            request, _public(request, "/auth/google/callback")
        )

    @r.get("/auth/google/callback")
    async def google_callback(request: Request):
        oauth = getattr(request.app.state, "oauth", None)
        if oauth is None:
            raise HTTPException(status_code=404, detail="Google sign-in not configured")
        store = request.app.state.store
        try:
            token = await oauth.google.authorize_access_token(request)  # validates state (CSRF)
        except Exception:  # noqa: BLE001 — forged/expired callback
            return RedirectResponse(_public(request, "/login?error=oauth"), 303)
        info = token.get("userinfo") or {}
        email, sub = info.get("email"), info.get("sub")
        if not email or not sub:
            return RedirectResponse(_public(request, "/login?error=oauth"), 303)
        try:
            user = await store.upsert_google_user(email, sub, info.get("name"))
        except EmailTaken:
            return RedirectResponse(_public(request, "/login?error=use_password"), 303)
        await _maybe_grant_admin(request, user)
        fresh = await store.get_user_by_id(user.id)
        resp = RedirectResponse(_public(request, "/"), 303)
        set_session_cookie(resp, request, fresh)
        return resp

    return r


async def _send_verify(request: Request, user: User) -> None:
    # The verify link hits the BACKEND endpoint, which marks verified, auto-logs-in,
    # and redirects into the app. (nginx routes /auth/* to the API in prod.)
    token = request.app.state.tokens.make_email_token("verify", user.id, user.token_nonce)
    await send_verification(
        request.app.state.settings, user.email, _public(request, f"/auth/verify?token={token}")
    )
