"""Admin user management (role=admin only).

Self-protection: an admin cannot disable, delete, or demote ITSELF, so the last
admin can't accidentally lock everyone out.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..auth import require_admin


class RoleBody(BaseModel):
    role: str  # 'user' | 'admin'


def _guard_not_self(request: Request, target_id: str, action: str) -> None:
    if request.state.user.id == target_id:
        raise HTTPException(status_code=403, detail=f"You cannot {action} yourself.")


def build_admin_router() -> APIRouter:
    r = APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])

    @r.get("/users")
    async def list_users(request: Request) -> list[dict]:
        rows = await request.app.state.store.list_users()
        return [
            {
                "id": u.id,
                "email": u.email,
                "display_name": u.display_name,
                "role": u.role,
                "auth_method": u.auth_method,
                "email_verified": u.email_verified,
                "disabled": u.disabled,
                "board_count": count,
            }
            for (u, count) in rows
        ]

    @r.post("/users/{user_id}/disable")
    async def disable(user_id: str, request: Request) -> dict:
        _guard_not_self(request, user_id, "disable")
        if not await _exists(request, user_id):
            raise HTTPException(status_code=404, detail="user not found")
        await request.app.state.store.set_disabled(user_id, True)
        return {"ok": True}

    @r.post("/users/{user_id}/enable")
    async def enable(user_id: str, request: Request) -> dict:
        if not await _exists(request, user_id):
            raise HTTPException(status_code=404, detail="user not found")
        await request.app.state.store.set_disabled(user_id, False)
        return {"ok": True}

    @r.post("/users/{user_id}/role")
    async def set_role(user_id: str, body: RoleBody, request: Request) -> dict:
        if body.role not in ("user", "admin"):
            raise HTTPException(status_code=422, detail="role must be 'user' or 'admin'")
        if body.role != "admin":
            _guard_not_self(request, user_id, "demote")
        if not await _exists(request, user_id):
            raise HTTPException(status_code=404, detail="user not found")
        await request.app.state.store.set_role(user_id, body.role)
        return {"ok": True}

    @r.delete("/users/{user_id}")
    async def delete(user_id: str, request: Request) -> dict:
        _guard_not_self(request, user_id, "delete")
        if not await request.app.state.store.delete_user(user_id):
            raise HTTPException(status_code=404, detail="user not found")
        return {"ok": True}

    return r


async def _exists(request: Request, user_id: str) -> bool:
    return (await request.app.state.store.get_user_by_id(user_id)) is not None
