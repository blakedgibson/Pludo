-- Add thumbnail_url to forge_games for game card previews.
-- Empty string default keeps existing rows valid; the column will be populated
-- by the server when a thumbnail is generated or manually uploaded.
ALTER TABLE public.forge_games ADD COLUMN IF NOT EXISTS thumbnail_url TEXT NOT NULL DEFAULT '';
