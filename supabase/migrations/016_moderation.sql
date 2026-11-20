-- 016_moderation.sql — UGC moderation storage + database-level name guard.
--
-- The api-server (src/moderation/) does the real work: leetspeak/homoglyph
-- normalization, phrase lists, PII detection, AI review of titles/prompts/3D
-- thumbnails, strikes and mutes. This migration adds:
--
--   1. moderation_events   — audit log of every reject / flag / mute (service role only)
--   2. content_reports     — user reports with server-verified snapshots (service role only)
--   3. moderation_terms    — admin-added blocklist terms, loaded by the server at boot
--   4. moderation_name_terms + public.is_name_allowed(text)
--        A compact name blocklist enforced INSIDE Postgres, because sign-up goes
--        Unity → Supabase Auth directly and never touches the api-server. The
--        trigger and update_user_profile both call it, so a client that skips
--        the /api/moderation/check pre-check still can't register "FuckBoy".
--   5. users.needs_rename  — set when sign-up metadata carried a blocked name and
--        the trigger substituted a generated one; the client prompts a rename.

-- ── 1. Audit events ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.moderation_events (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at   timestamptz NOT NULL DEFAULT now(),
    context      text        NOT NULL,
    action       text        NOT NULL,
    actor_id     text,
    actor_name   text,
    target_type  text,
    target_id    text,
    excerpt      text        NOT NULL DEFAULT '',
    categories   text[]      NOT NULL DEFAULT '{}',
    matches      text[]      NOT NULL DEFAULT '{}',
    source       text        NOT NULL DEFAULT 'lexicon'
);
CREATE INDEX IF NOT EXISTS moderation_events_created_idx ON public.moderation_events (created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_events_actor_idx   ON public.moderation_events (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_events_target_idx  ON public.moderation_events (target_type, target_id);

-- ── 2. Reports ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.content_reports (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at   timestamptz NOT NULL DEFAULT now(),
    reporter_id  text        NOT NULL,
    target_type  text        NOT NULL CHECK (target_type IN ('user','game','chat','comment','avatar_item','asset')),
    target_id    text        NOT NULL,
    reason       text        NOT NULL,
    details      text        NOT NULL DEFAULT '',
    snapshot     text        NOT NULL DEFAULT '',
    verified     boolean     NOT NULL DEFAULT false,
    status       text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
    priority     smallint    NOT NULL DEFAULT 3,
    resolution   text,
    resolved_at  timestamptz
);
CREATE INDEX IF NOT EXISTS content_reports_open_idx   ON public.content_reports (status, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS content_reports_target_idx ON public.content_reports (target_type, target_id);

-- ── 3. Admin-managed terms ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.moderation_terms (
    term        text        PRIMARY KEY,
    category    text        NOT NULL,
    severity    text        NOT NULL CHECK (severity IN ('low','medium','high')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- All three tables are written/read only by the api-server's service role.
-- RLS on with no policies = invisible to anon/authenticated clients.
ALTER TABLE public.moderation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_reports   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moderation_terms  ENABLE ROW LEVEL SECURITY;

-- ── 4. Database-level name guard ─────────────────────────────────────────────
-- match_mode 'sub'   → blocked if the term appears anywhere in the squashed name
-- match_mode 'token' → blocked only if a camelCase/underscore/digit-separated
--                      part equals the term (short/ambiguous words: ass, cum, fag)

CREATE TABLE IF NOT EXISTS public.moderation_name_terms (
    term        text PRIMARY KEY,
    match_mode  text NOT NULL DEFAULT 'sub' CHECK (match_mode IN ('sub','token'))
);
ALTER TABLE public.moderation_name_terms ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.moderation_name_allow (
    word text PRIMARY KEY
);
ALTER TABLE public.moderation_name_allow ENABLE ROW LEVEL SECURITY;

INSERT INTO public.moderation_name_terms (term, match_mode) VALUES
  ('fuck','sub'),('fuk','token'),('fck','token'),('phuck','sub'),('shit','sub'),('bitch','sub'),
  ('cunt','sub'),('dick','sub'),('cock','token'),('pussy','sub'),('penis','sub'),('vagina','sub'),
  ('porn','sub'),('hentai','sub'),('nude','sub'),('naked','sub'),('sexy','token'),('sex','token'),
  ('horny','sub'),('boobs','sub'),('tits','token'),('cum','token'),('rape','sub'),('rapist','sub'),
  ('molest','sub'),('pedo','sub'),('loli','sub'),('shota','sub'),('nigger','sub'),('nigga','sub'),
  ('nigg','sub'),('faggot','sub'),('fag','token'),('tranny','sub'),('kike','sub'),('spic','token'),
  ('chink','sub'),('retard','sub'),('nazi','sub'),('hitler','sub'),('kkk','token'),('isis','token'),
  ('whore','sub'),('slut','sub'),('asshole','sub'),('ass','token'),('bastard','sub'),('twat','token'),
  ('wank','sub'),('jizz','sub'),('dildo','sub'),('milf','sub'),('nsfw','sub'),('kys','token'),
  ('cocaine','sub'),('heroin','sub'),('meth','token'),('weed','token'),
  ('admin','sub'),('moderator','sub'),('pludo','sub'),('official','sub'),('mod','token'),('staff','token'),
  ('support','token'),('system','token')
ON CONFLICT (term) DO NOTHING;

INSERT INTO public.moderation_name_allow (word) VALUES
  ('scunthorpe'),('therap'),('grape'),('drape'),('scrape'),('trape'),('dickens'),('dickinson'),
  ('shiitake'),('shitake'),('analys'),('analog'),('canal'),('banal'),('spice'),('spicy'),
  ('heroine'),('snigger'),('niggle'),('niggard'),('nigeria'),('niger'),('skyscraper'),('pedal'),
  ('pedest'),('pedometer'),('torpedo'),('lollipop'),('retardant'),('swank'),('basement'),
  ('badminton'),('hancock'),('peacock'),('cockpit'),('cocktail'),('cockatoo'),('thorny'),('snaked'),
  ('hospice'),('pissarro'),('assassin'),('classic'),('bass'),('passion'),('sussex'),('essex')
ON CONFLICT (word) DO NOTHING;

-- Lowercase, strip accents (via unaccent if available is not assumed), map
-- leetspeak, drop separators. Kept IMMUTABLE so it can back an index later.
CREATE OR REPLACE FUNCTION public.moderation_squash(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT regexp_replace(
             translate(lower(coalesce(p, '')), '013457@$!|8', 'oieastasiib'),
             '[^a-z]', '', 'g');
$$;

CREATE OR REPLACE FUNCTION public.is_name_allowed(p_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_squashed text;
    v_masked   text;
    v_parts    text[];
    r          record;
BEGIN
    IF p_name IS NULL OR btrim(p_name) = '' THEN
        RETURN true;
    END IF;

    v_squashed := public.moderation_squash(p_name);
    -- collapse 3+ repeated letters ("fuuuuck") to one
    v_squashed := regexp_replace(v_squashed, '([a-z])\1{2,}', '\1', 'g');

    v_masked := v_squashed;
    FOR r IN SELECT word FROM public.moderation_name_allow ORDER BY length(word) DESC LOOP
        v_masked := replace(v_masked, r.word, repeat('#', length(r.word)));
    END LOOP;

    -- camelCase / underscore / digit separated parts, leet-mapped
    v_parts := ARRAY(
        SELECT public.moderation_squash(x)
        FROM regexp_split_to_table(
               regexp_replace(p_name, '([a-z])([A-Z])', '\1 \2', 'g'),
               '[^A-Za-z]+') AS x
        WHERE x <> ''
    );

    FOR r IN SELECT term, match_mode FROM public.moderation_name_terms LOOP
        IF r.match_mode = 'sub' AND position(r.term IN v_masked) > 0 THEN
            RETURN false;
        END IF;
        IF r.match_mode = 'token' AND (r.term = ANY (v_parts) OR v_squashed = r.term) THEN
            RETURN false;
        END IF;
    END LOOP;
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.is_name_allowed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_name_allowed(text) TO anon, authenticated;

-- ── 5. Enforce on sign-up and profile updates ────────────────────────────────

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS needs_rename boolean NOT NULL DEFAULT false;

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
    v_generated    text := 'user_' || replace(substr(NEW.id::text, 1, 8), '-', '');
    v_needs_rename boolean := false;
BEGIN
    v_username := COALESCE(NULLIF(NEW.raw_user_meta_data->>'username', ''), v_generated);
    IF NOT public.is_name_allowed(v_username) THEN
        v_username := v_generated;
        v_needs_rename := true;
    END IF;

    v_display_name := COALESCE(
        NULLIF(NEW.raw_user_meta_data->>'display_name', ''),
        NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), ''),
        v_username
    );
    IF NOT public.is_name_allowed(v_display_name) THEN
        v_display_name := v_username;
        v_needs_rename := true;
    END IF;

    v_birthday := NULLIF(NEW.raw_user_meta_data->>'birthday', '')::date;

    INSERT INTO public.users (id, username, display_name, birthday, needs_rename)
    VALUES (NEW.id, v_username, v_display_name, v_birthday, v_needs_rename)
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
EXCEPTION WHEN unique_violation THEN
    INSERT INTO public.users (id, username, display_name, birthday, needs_rename)
    VALUES (
        NEW.id,
        'u' || substr(replace(NEW.id::text, '-', ''), 1, 27),
        v_display_name,
        v_birthday,
        v_needs_rename
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$$;

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
    IF NULLIF(p_username, '') IS NOT NULL AND NOT public.is_name_allowed(p_username) THEN
        RAISE EXCEPTION 'username_not_allowed';
    END IF;
    IF NULLIF(p_display_name, '') IS NOT NULL AND NOT public.is_name_allowed(p_display_name) THEN
        RAISE EXCEPTION 'display_name_not_allowed';
    END IF;

    UPDATE public.users
    SET username     = COALESCE(NULLIF(p_username, ''),     username),
        display_name = COALESCE(NULLIF(p_display_name, ''), display_name),
        needs_rename = CASE WHEN NULLIF(p_username, '') IS NOT NULL THEN false ELSE needs_rename END
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

-- Sign-up availability check now also reports blocked names as unavailable,
-- so the existing "checkUsername" UI path rejects them without new client code.
CREATE OR REPLACE FUNCTION public.check_username_available(p_username text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.is_name_allowed(p_username)
       AND NOT EXISTS (SELECT 1 FROM public.users WHERE lower(username) = lower(p_username));
$$;

GRANT EXECUTE ON FUNCTION public.check_username_available(text) TO anon, authenticated;
