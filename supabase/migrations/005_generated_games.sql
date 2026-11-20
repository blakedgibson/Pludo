-- Generated games catalog
-- Rows created by the Unity client after the ai-game.dev generation pipeline
-- completes. bundle_url points to a Cloudflare R2 asset; thumbnail_url may
-- point to R2 or a CDN-fronted URL.
--
-- Mutation convention for this table:
--   INSERT  — direct client write with RLS. Straightforward ownership check;
--             no business logic that warrants an RPC.
--   UPDATE  — update_generated_game() RPC only. Prevents clients from writing
--             play_count or bundle_url, which are managed server-side.
--   DELETE  — direct client write with RLS. Unambiguous ownership; CASCADE
--             handles session cleanup automatically.
--   SELECT  — RLS policy.

CREATE TABLE public.generated_games (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    title               text        NOT NULL,
    description         text,
    generation_prompt   text,
    bundle_url          text,
    thumbnail_url       text,
    -- ON DELETE SET NULL: when a creator is deleted, public games persist as
    -- community artifacts (still readable, no longer editable). Private games
    -- (is_public = false) become invisible because the SELECT policy requires
    -- is_public = true OR created_by_user_id = auth.uid(), and null ≠ auth.uid().
    created_by_user_id  uuid        REFERENCES public.users(id) ON DELETE SET NULL,
    play_count          integer     NOT NULL DEFAULT 0,
    is_public           boolean     NOT NULL DEFAULT true,
    tags                text[]      NOT NULL DEFAULT '{}',
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX games_play_count_idx    ON public.generated_games (play_count DESC) WHERE is_public = true;
CREATE INDEX games_created_at_idx    ON public.generated_games (created_at DESC)  WHERE is_public = true;
CREATE INDEX games_creator_idx       ON public.generated_games (created_by_user_id);
CREATE INDEX games_tags_idx          ON public.generated_games USING gin (tags)   WHERE is_public = true;

-- Allows the creator to update title, description, is_public, and tags.
-- Explicitly excludes play_count (owned by increment_play_count RPC in
-- 006_game_sessions.sql) and bundle_url / thumbnail_url (written once at
-- generation time by the server pipeline, not editable by the client).
CREATE OR REPLACE FUNCTION public.update_generated_game(
    p_id          uuid,
    p_title       text,
    p_description text,
    p_is_public   boolean,
    p_tags        text[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.generated_games
    SET title       = COALESCE(p_title,       title),
        description = COALESCE(p_description, description),
        is_public   = COALESCE(p_is_public,   is_public),
        tags        = COALESCE(p_tags,        tags)
    WHERE id                 = p_id
      AND created_by_user_id = auth.uid();

    IF NOT FOUND THEN
        RAISE EXCEPTION 'game_not_found_or_forbidden';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_generated_game(uuid, text, text, boolean, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_generated_game(uuid, text, text, boolean, text[]) TO authenticated;

-- Row Level Security
ALTER TABLE public.generated_games ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read public games, or their own private games.
CREATE POLICY "games_select_public_or_own"
    ON public.generated_games FOR SELECT
    TO authenticated
    USING (
        is_public = true
        OR created_by_user_id = auth.uid()
    );

-- Only the creator may insert. play_count defaults to 0; bundle_url is supplied
-- by the client immediately after the generation pipeline completes.
CREATE POLICY "games_insert_creator"
    ON public.generated_games FOR INSERT
    TO authenticated
    WITH CHECK (created_by_user_id = auth.uid());

-- No UPDATE policy: all updates go through update_generated_game().

-- Only the creator may delete. CASCADE removes dependent sessions.
CREATE POLICY "games_delete_creator"
    ON public.generated_games FOR DELETE
    TO authenticated
    USING (created_by_user_id = auth.uid());
