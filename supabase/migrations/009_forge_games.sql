-- forge_games: stores AI-generated Luau games created via the /api/forge-game pipeline.
-- id is bigserial (integer sequence) to match the numeric IDs used by the API server.
-- No FK on created_by_user_id so inserts succeed regardless of public.users trigger state.

CREATE TABLE public.forge_games (
    id                  bigserial   PRIMARY KEY,
    title               text        NOT NULL DEFAULT 'Untitled',
    description         text        NOT NULL DEFAULT '',
    genre               text        NOT NULL DEFAULT 'Action',
    game_code           text        NOT NULL DEFAULT '',
    creator_name        text        NOT NULL DEFAULT 'Player',
    created_by_user_id  uuid,
    generation_prompt   text        NOT NULL DEFAULT '',
    asset_urls_json     text        NOT NULL DEFAULT '{}',
    humanoid_ids_json   text        NOT NULL DEFAULT '[]',
    plays               integer     NOT NULL DEFAULT 0,
    is_published        boolean     NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX forge_games_creator_idx    ON public.forge_games (created_by_user_id);
CREATE INDEX forge_games_created_at_idx ON public.forge_games (created_at DESC);

ALTER TABLE public.forge_games ENABLE ROW LEVEL SECURITY;

-- The API server reads with the anon key (server-side trusted reads filtered by userId in the URL).
CREATE POLICY "forge_games_anon_select"
    ON public.forge_games FOR SELECT
    TO anon
    USING (true);

-- Authenticated clients (user JWT) see their own games plus published games.
CREATE POLICY "forge_games_auth_select"
    ON public.forge_games FOR SELECT
    TO authenticated
    USING (created_by_user_id = auth.uid() OR is_published = true);

-- Only the owner may insert their own rows.
CREATE POLICY "forge_games_insert"
    ON public.forge_games FOR INSERT
    TO authenticated
    WITH CHECK (created_by_user_id = auth.uid());

-- Only the owner may update their own rows.
CREATE POLICY "forge_games_update"
    ON public.forge_games FOR UPDATE
    TO authenticated
    USING (created_by_user_id = auth.uid());
