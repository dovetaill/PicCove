CREATE TABLE storage_locations (
    id UUID PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    identity TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE images ADD COLUMN import_key TEXT UNIQUE;
CREATE TABLE file_jobs (
    id UUID PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('migration','cleanup','import')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
    source_id UUID REFERENCES storage_locations(id),
    target_id UUID REFERENCES storage_locations(id),
    user_id UUID REFERENCES users(id),
    album_id UUID,
    is_public BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE file_job_items (
    id UUID PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES file_jobs(id),
    source_key TEXT NOT NULL,
    image_id UUID NOT NULL,
    sha256 TEXT,
    source_signature TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
    error TEXT,
    UNIQUE(job_id, source_key)
);
CREATE INDEX file_job_items_pending ON file_job_items(job_id, status);
