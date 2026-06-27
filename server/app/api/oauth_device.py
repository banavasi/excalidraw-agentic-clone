"""OAuth 2.0 Device Authorization Grant (RFC 8628) — per-user MCP (Phase 8).

A local agent (Claude/Codex via the excaliboard MCP server) requests a
``device_code`` + ``user_code``, tells the user to approve at the verification
URI (where they're logged into the app), then polls for an access token. The
token is a per-user API token scoped to that user's boards — it replaces the
single static bearer.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..auth import require_user
from ..security import new_api_token, new_device_code, new_user_code


class DeviceCodeBody(BaseModel):
    client_name: str | None = None


class DeviceTokenBody(BaseModel):
    device_code: str


class ApproveBody(BaseModel):
    user_code: str


def build_device_router() -> APIRouter:
    r = APIRouter(prefix="/oauth/device")

    @r.post("/code")
    async def device_code(body: DeviceCodeBody, request: Request) -> dict:
        s = request.app.state.settings
        device = new_device_code()
        user_code = new_user_code()
        expires_at_ms = int(time.time() * 1000) + s.device_code_ttl_seconds * 1000
        await request.app.state.store.create_device_grant(device, user_code, expires_at_ms)
        base = s.public_url.rstrip("/")
        return {
            "device_code": device,
            "user_code": user_code,
            "verification_uri": f"{base}/device",
            "verification_uri_complete": f"{base}/device?code={user_code}",
            "expires_in": s.device_code_ttl_seconds,
            "interval": s.device_poll_interval_seconds,
        }

    @r.post("/token")
    async def device_token(body: DeviceTokenBody, request: Request) -> dict:
        store = request.app.state.store
        grant = await store.get_device_grant(body.device_code)
        if grant is None or grant.expired or grant.consumed:
            raise HTTPException(status_code=400, detail={"error": "expired_token"})
        if not grant.approved:
            raise HTTPException(status_code=400, detail={"error": "authorization_pending"})
        user_id = await store.consume_device_grant(body.device_code)
        if user_id is None:
            # Lost the race (already consumed) or just expired between checks.
            raise HTTPException(status_code=400, detail={"error": "expired_token"})
        plaintext, token_hash = new_api_token()
        await store.create_api_token(user_id, token_hash, "MCP device")
        return {"access_token": plaintext, "token_type": "bearer", "scope": "boards"}

    @r.get("/info")
    async def device_info(user_code: str, request: Request) -> dict:
        grant = await request.app.state.store.get_device_grant_by_user_code(user_code)
        if grant is None:
            return {"valid": False}
        return {"valid": not grant.expired and not grant.approved, "expired": grant.expired}

    @r.post("/approve")
    async def device_approve(body: ApproveBody, request: Request) -> dict:
        user_id = await require_user(request)  # must be logged in
        ok = await request.app.state.store.approve_device_grant(body.user_code, user_id)
        if not ok:
            raise HTTPException(status_code=400, detail="invalid or expired code")
        return {"ok": True}

    return r
