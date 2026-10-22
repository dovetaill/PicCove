-- Preserve existing public links; Android explicitly requests private uploads.
ALTER TABLE images ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT TRUE;
