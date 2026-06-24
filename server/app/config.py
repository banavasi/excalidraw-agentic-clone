"""Runtime configuration (pydantic-settings).

Env var names match the spec / docker-compose verbatim (case-insensitive):
``DATABASE_URL``, ``SYNC_BEARER``, ``MAX_CIPHERTEXT_BYTES``, ``CORS_ORIGINS``.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# Single-user v1: the static bearer authenticates the one account. Modeled so a
# real multi-account ``external_sub`` is a non-breaking add later (see app_user).
SINGLE_USER_SUB = "single-user"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # None => InMemoryStore (dev/tests). A postgresql:// DSN => PostgresStore.
    database_url: str | None = None

    # Static bearer token — the MACHINE door (the MCP tool, which can't ride a
    # browser cookie). Empty => the bearer door is closed.
    sync_bearer: str = ""

    # Cloudflare Access (the BROWSER door): verify the signed JWT Access injects as
    # `Cf-Access-Jwt-Assertion`. team_domain => issuer `https://<team_domain>` and
    # JWKS `https://<team_domain>/cdn-cgi/access/certs`; aud is the Access app's AUD
    # tag. BOTH empty => the JWT door is disabled (bearer-only; tests/local dev).
    cf_access_team_domain: str = ""
    cf_access_aud: str = ""

    # Hard cap on a single decoded scene ciphertext (anti-DoS). Default 25 MiB.
    max_ciphertext_bytes: int = 25 * 1024 * 1024

    # Cap on a decoded IV (AES-GCM IV is 12 bytes; small slack guards abuse).
    max_iv_bytes: int = 64

    # Cap on a decoded encrypted board name.
    max_name_bytes: int = 8 * 1024

    # Whole-request body cap, enforced BEFORE the body is buffered/parsed.
    # base64 inflates ~4/3, so 36 MiB comfortably covers the 25 MiB ciphertext
    # cap plus JSON framing. The middleware rejects anything larger with 413.
    max_body_bytes: int = 36 * 1024 * 1024

    # Aggregate anti-DoS caps. Single-user v1 still bounds worst-case disk on the
    # shared cosmos host: a leaked bearer cannot mint unlimited boards/files.
    max_boards_per_user: int = 5000
    max_files_per_board: int = 5000

    # Soft-deleted boards older than this are reaped at startup (spec §3).
    tombstone_grace_seconds: int = 7 * 24 * 3600

    service_name: str = "excaliboard-sync"

    # Browser client is cross-origin; tighten to real hosts at deploy.
    # NoDecode: take the env var as a raw comma-separated string (don't JSON-decode
    # it), so values like "*" or "https://a,https://b" parse via the validator below.
    cors_origins: Annotated[list[str], NoDecode] = ["*"]

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v
