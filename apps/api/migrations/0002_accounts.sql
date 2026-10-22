CREATE TABLE users (
    id UUID PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    disabled BOOLEAN NOT NULL DEFAULT FALSE,
    quota_bytes BIGINT NOT NULL DEFAULT 1073741824 CHECK (quota_bytes >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE settings (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    registration_open BOOLEAN NOT NULL DEFAULT FALSE
);
INSERT INTO settings DEFAULT VALUES;
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE rate_limits (
    key TEXT PRIMARY KEY,
    hits INTEGER NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE albums (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    UNIQUE (id, user_id)
);
ALTER TABLE images ADD COLUMN user_id UUID REFERENCES users(id);
ALTER TABLE images ADD COLUMN album_id UUID;
ALTER TABLE images ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE images ADD CONSTRAINT image_album_owner FOREIGN KEY (album_id, user_id) REFERENCES albums(id, user_id);
CREATE INDEX images_user_created ON images(user_id, created_at DESC);
