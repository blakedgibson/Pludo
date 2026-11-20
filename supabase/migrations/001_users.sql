-- Users table
-- One row per authenticated Supabase user (email, OAuth, and anonymous).
-- Rows are created exclusively via the on_auth_user_created trigger; no direct
-- client INSERT is permitted. This means the row always exists by the time the
-- Unity client's first authenticated request arrives.
--
-- avatar_config stores the full equipped loadout as JSON so inventory lookups
-- are not required to render a player's avatar in a lobby. IInventoryService is
-- the write path; this column is a denormalized read cache updated on equip/unequip.
--
-- last_active_at is NOT maintained by a trigger. A trigger would fire on every
-- UPDATE to this table (including avatar_config mutations from inventory operations),
-- creating noise. It is updated explicitly via touch_last_active(), called by the
-- client on app foreground/resume.
--
-- Mutation convention for this table:
--   INSERT  — trigger only (on_auth_user_created), never direct client write
--   UPDATE  — SECURITY DEFINER RPCs only: update_user_profile, update_avatar_config,
--             touch_last_active. No UPDATE RLS policy exists.
--   SELECT  — RLS policy (any authenticated user reads any row)

CREATE TABLE public.users (
    id              uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username        text        NOT NULL,
    display_name    text        NOT NULL,
    avatar_config   jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_active_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT users_username_length CHECK (char_length(username) BETWEEN 3 AND 32),
    CONSTRAINT users_username_format CHECK (username ~ '^[a-zA-Z0-9_]+$')
);

-- Case-insensitive uniqueness enforced via expression index so the lower()
-- comparison is indexed efficiently rather than requiring a citext extension.
CREATE UNIQUE INDEX users_username_lower_idx ON public.users (lower(username));
CREATE INDEX        users_last_active_idx    ON public.users (last_active_at DESC);

-- Trigger: auto-provision a users row the moment auth.users gets a new record.
-- Fires for email sign-up, OAuth sign-in, and anonymous sign-in.
--
-- Username fallback chain:
--   1. raw_user_meta_data['username'] — supplied by the client on email sign-up
--   2. 'user_' + first 8 hex chars of the UUID — covers OAuth and anonymous
--
-- Display name fallback chain:
--   1. raw_user_meta_data['display_name']
--   2. Part before '@' in email — covers email/OAuth accounts
--   3. v_username — always non-empty, guaranteed fallback for anonymous accounts
--
-- Collision handling: the generated 'user_XXXXXXXX' username is derived from the
-- first 8 hex chars of the user UUID. A collision is extremely unlikely but not
-- impossible at scale. The EXCEPTION block falls back to 'u' + the full 32-char
-- UUID hex string (28 chars total), which is globally unique by construction.
-- ON CONFLICT (id) DO NOTHING makes both attempts safe to replay after rollback.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_username     text;
    v_display_name text;
BEGIN
    v_username := COALESCE(
        NULLIF(NEW.raw_user_meta_data->>'username', ''),
        'user_' || replace(substr(NEW.id::text, 1, 8), '-', '')
    );

    v_display_name := COALESCE(
        NULLIF(NEW.raw_user_meta_data->>'display_name', ''),
        NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), ''),
        v_username
    );

    INSERT INTO public.users (id, username, display_name)
    VALUES (NEW.id, v_username, v_display_name)
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
EXCEPTION WHEN unique_violation THEN
    -- Generated short username collided; fall back to full UUID hex.
    INSERT INTO public.users (id, username, display_name)
    VALUES (
        NEW.id,
        'u' || substr(replace(NEW.id::text, '-', ''), 1, 27),
        v_display_name
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_auth_user() FROM PUBLIC;
-- No GRANT: invoked by a trigger running as the trigger owner, not by clients.

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- Updates last_active_at for the calling user.
-- Called by the client on app foreground/resume.
CREATE OR REPLACE FUNCTION public.touch_last_active()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.users
    SET last_active_at = now()
    WHERE id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.touch_last_active() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_last_active() TO authenticated;

-- Updates username and/or display_name for the calling user.
-- Passing null or empty string for either field leaves it unchanged.
-- Raises 'username_already_taken' on uniqueness conflict so the client can
-- surface a specific error without string-matching on exception messages.
CREATE OR REPLACE FUNCTION public.update_user_profile(
    p_username     text,
    p_display_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.users
    SET username     = COALESCE(NULLIF(p_username, ''),     username),
        display_name = COALESCE(NULLIF(p_display_name, ''), display_name)
    WHERE id = auth.uid();
EXCEPTION
    WHEN unique_violation THEN
        RAISE EXCEPTION 'username_already_taken';
    WHEN check_violation THEN
        RAISE EXCEPTION 'invalid_username_format';
END;
$$;

REVOKE ALL ON FUNCTION public.update_user_profile(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_user_profile(text, text) TO authenticated;

-- Replaces avatar_config for the calling user.
-- Called by IInventoryService after an equip/unequip operation so the
-- denormalized lobby field stays in sync with the inventory source of truth.
CREATE OR REPLACE FUNCTION public.update_avatar_config(p_config jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_config IS NULL THEN
        RAISE EXCEPTION 'avatar_config_cannot_be_null';
    END IF;

    UPDATE public.users
    SET avatar_config = p_config
    WHERE id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.update_avatar_config(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_avatar_config(jsonb) TO authenticated;

-- Row Level Security
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read any profile row.
-- auth.uid() IS NOT NULL (not bare 'true') ensures the policy never matches
-- for the anon role even if it were granted table-level SELECT in the future.
-- All columns in public.users are intentionally public: id, username,
-- display_name, avatar_config, created_at, last_active_at. Sensitive auth data
-- (email, password hash, provider tokens) lives exclusively in auth.users, which
-- is never exposed via PostgREST. If a private column is added later, the correct
-- path is a security-definer view, not column-level grants alongside RLS.
CREATE POLICY "users_select_authenticated"
    ON public.users FOR SELECT
    TO authenticated
    USING (auth.uid() IS NOT NULL);

-- No INSERT policy: handled exclusively by the on_auth_user_created trigger.
-- No UPDATE policy: all writes go through update_user_profile / update_avatar_config
--                   / touch_last_active, which are SECURITY DEFINER and bypass RLS.
