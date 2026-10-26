ALTER TABLE settings ADD COLUMN ai JSONB NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN moderation_exempt BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN violation_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN content_ban TEXT CHECK (content_ban IN ('auto','manual'));
ALTER TABLE users ADD COLUMN auto_ban_threshold INTEGER;

CREATE TABLE image_reviews (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','running','passed','blocked','review','failed','exempt')),
    reason TEXT NOT NULL DEFAULT '',
    categories JSONB NOT NULL DEFAULT '[]',
    hold_public BOOLEAN NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    counted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id,content_hash)
);
CREATE INDEX image_review_queue ON image_reviews(next_attempt) WHERE status='pending';
ALTER TABLE images ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'unreviewed';
ALTER TABLE images ADD COLUMN moderation_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE images ADD COLUMN moderation_hold BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE ai_conversations (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ai_conversations_owner ON ai_conversations(user_id,created_at DESC);
CREATE TABLE ai_messages (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    prompt TEXT NOT NULL,
    reference_id UUID REFERENCES images(id) ON DELETE SET NULL,
    had_reference BOOLEAN NOT NULL DEFAULT FALSE,
    image_id UUID REFERENCES images(id) ON DELETE SET NULL,
    had_image BOOLEAN NOT NULL DEFAULT FALSE,
    response_id TEXT,
    text TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
    error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ai_messages_queue ON ai_messages(created_at) WHERE status='queued';
CREATE INDEX ai_messages_owner ON ai_messages(user_id,created_at);
