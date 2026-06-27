-- Phase 7: multi-user in-app auth. Extends the already-multi-tenant app_user with
-- account/credential columns, and adds per-user API tokens (Phase 8 MCP device
-- flow) + the device-authorization grant table. Idempotent (ADD COLUMN / IF NOT
-- EXISTS) so it is safe to re-run by the migration runner.

CREATE EXTENSION IF NOT EXISTS citext;

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS email          citext;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS password_hash  text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS role           text    NOT NULL DEFAULT 'user';
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS disabled       boolean NOT NULL DEFAULT false;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS display_name   text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS auth_method    text;          -- 'local' | 'google'
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS oauth_sub      text;          -- provider subject (google)
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS session_epoch  integer NOT NULL DEFAULT 0;  -- bump to revoke all cookies
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS token_nonce    integer NOT NULL DEFAULT 0;  -- bump to kill verify/reset links

-- One account per email (partial: the legacy single-user row has NULL email).
CREATE UNIQUE INDEX IF NOT EXISTS app_user_email_key ON app_user (email) WHERE email IS NOT NULL;

-- Per-user API tokens (Phase 8): the MCP device flow mints these. We store only a
-- SHA-256 hash; the plaintext is shown to the user once.
CREATE TABLE IF NOT EXISTS api_token (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    token_hash   text UNIQUE NOT NULL,
    name         text,
    scopes       text NOT NULL DEFAULT 'boards',
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked      boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS api_token_user_idx ON api_token (user_id);

-- OAuth 2.0 device-authorization grant (RFC 8628). A local agent requests a
-- device_code + user_code; the user approves in the browser; the agent polls.
CREATE TABLE IF NOT EXISTS device_grant (
    device_code  text PRIMARY KEY,
    user_code    text UNIQUE NOT NULL,
    user_id      uuid REFERENCES app_user(id) ON DELETE CASCADE,  -- set on approval
    client_name  text,
    approved     boolean NOT NULL DEFAULT false,
    consumed     boolean NOT NULL DEFAULT false,                  -- token issued once
    expires_at   timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
