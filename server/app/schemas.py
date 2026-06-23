"""Request/response models. Ciphertext + IV travel as base64 strings."""

from __future__ import annotations

from pydantic import BaseModel, Field


class PushRequest(BaseModel):
    # The server scene_version this edit was based on (compare-and-swap token).
    base_version: int = Field(ge=0)
    # The new scene_version the client computed = max(element.version).
    scene_version: int = Field(ge=0)
    iv: str
    ciphertext: str
    # Optional encrypted board name, updated on an accepted push.
    name_iv: str | None = None
    name_ct: str | None = None


class FilePutRequest(BaseModel):
    iv: str
    ciphertext: str
