-- Snapshot of a game's user-facing fields at the moment of publish.
-- Before this change, /api/game-ws and /api/game/:id always served the draft
-- (forge_games.game_code et al), so any edits made after publishing leaked
-- into the public play feed. With these columns the publish handler freezes
-- the script and metadata; the play path reads from these columns so the
-- public version stays stable until the creator re-publishes.
--
-- All columns are nullable so existing rows remain valid. Code paths that
-- read the snapshot fall back to the live column when the snapshot is NULL,
-- which preserves behavior for games published before this migration.

ALTER TABLE public.forge_games
    ADD COLUMN IF NOT EXISTS published_game_code         text,
    ADD COLUMN IF NOT EXISTS published_title             text,
    ADD COLUMN IF NOT EXISTS published_description       text,
    ADD COLUMN IF NOT EXISTS published_genre             text,
    ADD COLUMN IF NOT EXISTS published_thumbnail_url     text,
    ADD COLUMN IF NOT EXISTS published_asset_urls_json   jsonb,
    ADD COLUMN IF NOT EXISTS published_humanoid_ids_json jsonb,
    ADD COLUMN IF NOT EXISTS published_at                timestamptz;
