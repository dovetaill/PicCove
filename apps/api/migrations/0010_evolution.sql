ALTER TABLE ai_conversations ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN totp_recovery_hashes JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE images ADD COLUMN source_hash TEXT;
CREATE INDEX images_source_lookup ON images(user_id, source_hash)
    WHERE deleted_at IS NULL AND source_hash IS NOT NULL;

CREATE TABLE api_tokens (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    default_album_id UUID REFERENCES albums(id) ON DELETE SET NULL,
    default_public BOOLEAN NOT NULL DEFAULT TRUE,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX api_tokens_user_idx ON api_tokens(user_id, created_at DESC);

CREATE TABLE image_shares (
    id UUID PRIMARY KEY,
    image_id UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX image_shares_image_idx ON image_shares(image_id, created_at DESC);
