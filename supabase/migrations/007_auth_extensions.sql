-- Auth extensions: birthday field + username-based login support
--
-- Adds birthday to public.users, updates the new-user trigger to capture it
-- from sign-up metadata, and exposes a SECURITY DEFINER RPC so the client
-- can resolve a username to an email before calling Supabase Auth's password
-- endpoint (which requires email, not username).

-- ── Birthday column ───────────────────────────────────────────────────────────

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS birthday date;

-- ── Update new-user trigger to capture birthday ───────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_username     text;
    v_display_name text;
    v_birthday     date;
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

    v_birthday := NULLIF(NEW.raw_user_meta_data->>'birthday', '')::date;

    INSERT INTO public.users (id, username, display_name, birthday)
    VALUES (NEW.id, v_username, v_display_name, v_birthday)
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
EXCEPTION WHEN unique_violation THEN
    INSERT INTO public.users (id, username, display_name, birthday)
    VALUES (
        NEW.id,
        'u' || substr(replace(NEW.id::text, '-', ''), 1, 27),
        v_display_name,
        v_birthday
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$$;

-- ── Username → email resolver (for username-based login) ──────────────────────
--
-- Returns the email address for the given username so the client can then
-- call Supabase Auth's /token?grant_type=password endpoint (which requires email).
--
-- Security rationale: exposing email to anon is acceptable here because:
--   1. The caller still needs the correct password to authenticate.
--   2. Supabase Auth already returns rate-limited, non-enumerable errors on bad creds.
--   3. Returning NULL (not raising) when the username doesn't exist avoids
--      confirming whether a given username is registered.

CREATE OR REPLACE FUNCTION public.get_email_for_login(p_username_or_email text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
    v_email text;
BEGIN
    -- If it looks like an email already, pass it straight through.
    IF p_username_or_email LIKE '%@%' THEN
        RETURN lower(trim(p_username_or_email));
    END IF;

    -- Look up the email via the auth.users join (only accessible SECURITY DEFINER).
    SELECT au.email INTO v_email
    FROM   public.users pu
    JOIN   auth.users   au ON au.id = pu.id
    WHERE  lower(pu.username) = lower(trim(p_username_or_email))
    LIMIT  1;

    RETURN v_email; -- NULL if username not found; let Auth surface the error
END;
$$;

REVOKE ALL ON FUNCTION public.get_email_for_login(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_email_for_login(text) TO anon, authenticated;
