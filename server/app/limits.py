"""Request-body size guard.

FastAPI/uvicorn buffer the WHOLE request body into memory (and pydantic copies
it into a ``str``) before any handler — and before auth — runs. So the per-field
size caps in :mod:`app.b64` are far too late to stop a hostile multi-gigabyte
body. This ASGI middleware rejects oversized requests up front:

* if ``Content-Length`` exceeds the cap -> 413 immediately, before the app sees it;
* otherwise it counts bytes off ``receive()``; the moment the running total
  passes the cap it returns ``http.disconnect`` (so the app stops reading),
  swallows whatever response the app then produces, and emits a clean 413.

We can't raise an exception to signal this: FastAPI wraps body reading in a
try/except that turns any receive error into a generic 400. So the middleware,
which sits outside routing, must produce the 413 itself.
"""

from __future__ import annotations

from starlette.types import ASGIApp, Message, Receive, Scope, Send


def _content_length(scope: Scope) -> int | None:
    for key, value in scope.get("headers", []):
        if key == b"content-length":
            try:
                return int(value)
            except ValueError:
                return None
    return None


async def _send_413(send: Send) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [(b"content-type", b"application/json")],
        }
    )
    await send(
        {
            "type": "http.response.body",
            "body": b'{"detail":"request body too large"}',
        }
    )


class BodySizeLimitMiddleware:
    def __init__(self, app: ASGIApp, max_body_bytes: int) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        declared = _content_length(scope)
        if declared is not None and declared > self.max_body_bytes:
            await _send_413(send)
            return

        total = 0
        overflowed = False

        async def counting_receive() -> Message:
            nonlocal total, overflowed
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > self.max_body_bytes:
                    overflowed = True
                    # Stop the app's body read; its eventual response is swallowed.
                    return {"type": "http.disconnect"}
            return message

        async def gated_send(message: Message) -> None:
            if not overflowed:
                await send(message)

        await self.app(scope, counting_receive, gated_send)
        if overflowed:
            await _send_413(send)
