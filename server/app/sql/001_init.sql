-- Excaliboard sync schema (Postgres 17). Applied idempotently at startup.
-- Payloads are opaque ciphertext (bytea); the server reasons only over the
-- integer scene_version and IVs. gen_random_uuid() is core since PG13.

CREATE TABLE IF NOT EXISTS app_user (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    external_sub text UNIQUE NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS board (
    id            text PRIMARY KEY,                              -- client board id
    user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    name_iv       bytea,                                         -- encrypted name (nullable)
    name_ct       bytea,
    scene_version integer NOT NULL DEFAULT 0,                    -- optimistic-concurrency token
    deleted       boolean NOT NULL DEFAULT false,                -- tombstone for cross-device deletes
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS board_user_updated_idx ON board (user_id, updated_at);

CREATE TABLE IF NOT EXISTS scene (
    board_id      text PRIMARY KEY REFERENCES board(id) ON DELETE CASCADE,
    scene_version integer NOT NULL,
    iv            bytea NOT NULL,
    ciphertext    bytea NOT NULL,
    byte_size     integer NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS file_blob (
    board_id   text NOT NULL REFERENCES board(id) ON DELETE CASCADE,
    file_id    text NOT NULL,
    iv         bytea NOT NULL,
    ciphertext bytea NOT NULL,
    byte_size  integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (board_id, file_id)
);

CREATE TABLE IF NOT EXISTS device (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    label        text,
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
