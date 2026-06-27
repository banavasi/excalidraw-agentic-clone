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

    # Cloudflare Access (optional network gate, NOT the identity source as of
    # Phase 7): if both set, a verified Access JWT is honored as a browser door.
    # Empty => disabled (the default OSS/self-host path).
    cf_access_team_domain: str = ""
    cf_access_aud: str = ""

    # --- Phase 7: multi-user in-app auth ---------------------------------------
    # Signs the session cookie AND the verify/reset email tokens. REQUIRED once
    # auth is used; generate with `openssl rand -hex 32`. Empty => auth disabled.
    secret_key: str = ""
    # Public base URL of the app (used in email links + to decide cookie Secure).
    # e.g. https://app.example.com  (http://localhost:3000 in dev).
    public_url: str = "http://localhost:3000"
    # Session cookie lifetime.
    session_ttl_seconds: int = 14 * 24 * 3600
    # Verify/reset email token TTLs.
    verify_ttl_seconds: int = 24 * 3600
    reset_ttl_seconds: int = 3600

    # SMTP for verification/reset email. If smtp_host is empty, links are LOGGED
    # to stdout so a fresh self-host can bootstrap with no mail server.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_pass: str = ""
    smtp_from: str = "Excaliboard <no-reply@localhost>"
    smtp_starttls: bool = True

    # Google OAuth (optional). Both empty => the Google button is hidden and the
    # /auth/google/* routes 404.
    google_client_id: str = ""
    google_client_secret: str = ""

    # The email granted role=admin on first verify/sign-in, and the identity the
    # legacy static bearer (SYNC_BEARER) maps to during the Phase 8 transition.
    admin_email: str = ""

    # OAuth 2.0 device-authorization grant (Phase 8: per-user MCP).
    device_code_ttl_seconds: int = 600
    device_poll_interval_seconds: int = 5

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
