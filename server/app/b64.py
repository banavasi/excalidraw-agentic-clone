"""Base64 codec for opaque payloads on the wire.

Standard base64 (no MIME newlines) so it interops with the browser client's
``btoa``-style encoding. Decoding validates strictly and enforces a size cap;
the server never interprets the bytes.
"""

from __future__ import annotations

import base64
import binascii

from fastapi import HTTPException


def decode_b64(value: str, *, field: str, max_bytes: int) -> bytes:
    # Reject by ENCODED length first so an oversized payload never allocates the
    # decoded buffer. Standard base64 is ceil(n/3)*4 chars; +4 slack for padding.
    if len(value) > ((max_bytes + 2) // 3) * 4 + 4:
        raise HTTPException(status_code=413, detail=f"{field}: payload too large")
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail=f"{field}: invalid base64")
    # Exact final guard (the pre-check over-admits only by a few bytes).
    if len(raw) > max_bytes:
        raise HTTPException(status_code=413, detail=f"{field}: payload too large")
    return raw


def encode_b64(raw: bytes | None) -> str | None:
    if raw is None:
        return None
    return base64.b64encode(raw).decode("ascii")
