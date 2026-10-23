ALTER TABLE images ADD COLUMN content_hash TEXT;
CREATE INDEX images_content_lookup ON images(user_id, size_bytes, content_hash) WHERE deleted_at IS NULL;
