"""The /sync REST surface (see spec §4).

All payloads are opaque base64 ciphertext; the server only moves bytes and
reasons over the integer ``scene_version``. A push that loses the compare-and-swap
returns 409 with the current server scene so the client can reconcile locally.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from .. import __version__
from ..auth import require_user
from ..b64 import decode_b64, encode_b64
from ..schemas import FilePutRequest, PushRequest
from ..store.base import Blob, BoardNotFound, LimitExceeded, PushAccepted


def build_router() -> APIRouter:
    r = APIRouter()

    @r.get("/sync/healthz")
    async def healthz(request: Request) -> JSONResponse:
        settings = request.app.state.settings
        ok = await request.app.state.store.healthcheck()
        return JSONResponse(
            status_code=200 if ok else 503,
            content={
                "status": "ok" if ok else "degraded",
                "service": settings.service_name,
                "version": __version__,
                "db": ok,
            },
        )

    @r.get("/sync/whoami")
    async def whoami(
        request: Request,
        user_id: str = Depends(require_user),
    ) -> dict:
        # email is set only on the Cloudflare Access (browser) door; None for bearer.
        return {"email": getattr(request.state, "email", None)}

    @r.get("/sync/index")
    async def get_index(
        request: Request,
        since: int | None = Query(default=None, ge=0),
        user_id: str = Depends(require_user),
    ) -> list[dict]:
        rows = await request.app.state.store.get_index(user_id, since)
        return [
            {
                "board_id": x.board_id,
                "name_iv": encode_b64(x.name_iv),
                "name_ct": encode_b64(x.name_ct),
                "scene_version": x.scene_version,
                "deleted": x.deleted,
                "updated_at": x.updated_at_ms,
            }
            for x in rows
        ]

    @r.get("/sync/boards/{board_id}")
    async def get_board(
        board_id: str,
        request: Request,
        user_id: str = Depends(require_user),
    ) -> dict:
        sc = await request.app.state.store.get_scene(user_id, board_id)
        if sc is None:
            raise HTTPException(status_code=404, detail="board not found")
        return {
            "scene_version": sc.scene_version,
            "iv": encode_b64(sc.iv),
            "ciphertext": encode_b64(sc.ciphertext),
        }

    @r.put("/sync/boards/{board_id}")
    async def put_board(
        board_id: str,
        body: PushRequest,
        request: Request,
        user_id: str = Depends(require_user),
    ):
        settings = request.app.state.settings
        iv = decode_b64(body.iv, field="iv", max_bytes=settings.max_iv_bytes)
        ct = decode_b64(
            body.ciphertext, field="ciphertext", max_bytes=settings.max_ciphertext_bytes
        )
        name: Blob | None = None
        if body.name_iv is not None and body.name_ct is not None:
            name = Blob(
                decode_b64(body.name_iv, field="name_iv", max_bytes=settings.max_iv_bytes),
                decode_b64(body.name_ct, field="name_ct", max_bytes=settings.max_name_bytes),
            )

        try:
            result = await request.app.state.store.push_scene(
                user_id, board_id, body.base_version, body.scene_version, Blob(iv, ct), name
            )
        except LimitExceeded as e:
            raise HTTPException(status_code=413, detail=f"limit exceeded: {e.what}")
        except BoardNotFound:
            raise HTTPException(status_code=404, detail="board not found")
        if isinstance(result, PushAccepted):
            return {"scene_version": result.scene_version}
        # Conflict: hand back the current server scene for client-side reconcile.
        return JSONResponse(
            status_code=409,
            content={
                "scene_version": result.scene_version,
                "iv": encode_b64(result.iv),
                "ciphertext": encode_b64(result.ciphertext),
            },
        )

    @r.delete("/sync/boards/{board_id}")
    async def delete_board(
        board_id: str,
        request: Request,
        user_id: str = Depends(require_user),
    ) -> dict:
        ok = await request.app.state.store.soft_delete_board(user_id, board_id)
        if not ok:
            raise HTTPException(status_code=404, detail="board not found")
        return {"deleted": True}

    @r.get("/sync/boards/{board_id}/files/{file_id}")
    async def get_file(
        board_id: str,
        file_id: str,
        request: Request,
        user_id: str = Depends(require_user),
    ) -> dict:
        blob = await request.app.state.store.get_file(user_id, board_id, file_id)
        if blob is None:
            raise HTTPException(status_code=404, detail="file not found")
        return {"iv": encode_b64(blob.iv), "ciphertext": encode_b64(blob.ciphertext)}

    @r.put("/sync/boards/{board_id}/files/{file_id}")
    async def put_file(
        board_id: str,
        file_id: str,
        body: FilePutRequest,
        request: Request,
        user_id: str = Depends(require_user),
    ) -> dict:
        settings = request.app.state.settings
        iv = decode_b64(body.iv, field="iv", max_bytes=settings.max_iv_bytes)
        ct = decode_b64(
            body.ciphertext, field="ciphertext", max_bytes=settings.max_ciphertext_bytes
        )
        try:
            await request.app.state.store.put_file(
                user_id, board_id, file_id, Blob(iv, ct)
            )
        except BoardNotFound:
            raise HTTPException(status_code=404, detail="board not found")
        except LimitExceeded as e:
            raise HTTPException(status_code=413, detail=f"limit exceeded: {e.what}")
        return {"ok": True}

    return r
