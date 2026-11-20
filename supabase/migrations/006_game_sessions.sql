-- Game sessions and participants
-- A session is created when a player starts a Photon room.
-- photon_room_name is the canonical room identifier shared between
-- Supabase (social layer) and Photon Fusion (netcode layer). It is generated
-- server-side inside create_game_session() so names are unguessable and cannot
-- be fabricated by clients to grief other players' rooms.
--
-- Mutation convention for these tables:
--   All INSERT and UPDATE operations go through SECURITY DEFINER RPCs.
--   No direct client writes are permitted. RLS governs SELECT only.
--   This is intentional: session lifecycle involves multi-row atomicity,
--   idempotency flags, and player-count maintenance that direct writes
--   cannot enforce without race conditions or policy complexity.
--
-- RPCs in this file:
--   create_game_session   — open a session, returns (session_id, room_name)
--   join_game_session     — add a participant to an active session
--   end_game_session      — stamp left_at; close session if host or last player
--   increment_play_count  — increment play_count exactly once per ended session

CREATE TABLE public.game_sessions (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id          uuid        NOT NULL REFERENCES public.generated_games(id) ON DELETE CASCADE,
    host_user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    photon_room_name text        NOT NULL,
    started_at       timestamptz NOT NULL DEFAULT now(),
    ended_at         timestamptz,
    player_count     integer     NOT NULL DEFAULT 0,
    -- Set true exactly once when increment_play_count() succeeds.
    -- Never reset. Prevents double-increment on client retry.
    -- If the session row is deleted (CASCADE from generated_games), the flag
    -- dies with it; no orphaned state possible.
    play_count_incremented boolean NOT NULL DEFAULT false,

    CONSTRAINT sessions_room_name_format CHECK (
        char_length(photon_room_name) BETWEEN 6 AND 64
        AND photon_room_name ~ '^[a-zA-Z0-9_]+$'
    )
);

CREATE UNIQUE INDEX sessions_room_name_idx ON public.game_sessions (photon_room_name)
    WHERE ended_at IS NULL;
CREATE INDEX sessions_game_id_idx         ON public.game_sessions (game_id);
CREATE INDEX sessions_host_idx            ON public.game_sessions (host_user_id);
CREATE INDEX sessions_active_idx          ON public.game_sessions (started_at DESC)
    WHERE ended_at IS NULL;

CREATE TABLE public.session_participants (
    session_id  uuid        NOT NULL REFERENCES public.game_sessions(id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    joined_at   timestamptz NOT NULL DEFAULT now(),
    left_at     timestamptz,

    PRIMARY KEY (session_id, user_id)
);

CREATE INDEX participants_session_idx ON public.session_participants (session_id);
CREATE INDEX participants_user_idx    ON public.session_participants (user_id);
-- Hot path: "what session is this user currently in?"
CREATE INDEX participants_user_active_idx ON public.session_participants (user_id)
    WHERE left_at IS NULL;

-- Helper used by RLS policies on both game_sessions and session_participants.
-- SECURITY DEFINER bypasses RLS when reading session_participants, preventing
-- the infinite recursion that arises when a policy on session_participants
-- contains a subquery that also reads session_participants.
-- STABLE allows the planner to call it once per row rather than once per query.
CREATE OR REPLACE FUNCTION public.is_session_participant(p_session_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.session_participants
        WHERE session_id = p_session_id
          AND user_id    = auth.uid()
    );
$$;

REVOKE ALL ON FUNCTION public.is_session_participant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_session_participant(uuid) TO authenticated;

-- Creates a session and adds the host as the first participant atomically.
-- Generates an unguessable room name server-side (requires pgcrypto, which
-- Supabase enables by default). Returns both the session id and the room name
-- so the client can pass the room name to Photon without a second round-trip.
--
-- Security guards:
--   1. host_user_id = auth.uid() — set server-side, never trusted from client.
--   2. game_id must be public or owned by the caller.
CREATE OR REPLACE FUNCTION public.create_game_session(p_game_id uuid)
RETURNS TABLE (session_id uuid, room_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_session_id uuid;
    v_room_name  text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.generated_games
        WHERE id = p_game_id
          AND (is_public = true OR created_by_user_id = auth.uid())
    ) THEN
        RAISE EXCEPTION 'game_not_found_or_forbidden';
    END IF;

    v_room_name := 'pludo_' || encode(gen_random_bytes(8), 'hex');

    INSERT INTO public.game_sessions (game_id, host_user_id, photon_room_name, player_count)
    VALUES (p_game_id, auth.uid(), v_room_name, 1)
    RETURNING id INTO v_session_id;

    INSERT INTO public.session_participants (session_id, user_id)
    VALUES (v_session_id, auth.uid());

    RETURN QUERY SELECT v_session_id, v_room_name;
EXCEPTION WHEN unique_violation THEN
    -- Room name collision (astronomically unlikely with 2^64 names, but handled
    -- to match the pattern in handle_new_auth_user). One retry is sufficient.
    v_room_name := 'pludo_' || encode(gen_random_bytes(8), 'hex');

    INSERT INTO public.game_sessions (game_id, host_user_id, photon_room_name, player_count)
    VALUES (p_game_id, auth.uid(), v_room_name, 1)
    RETURNING id INTO v_session_id;

    INSERT INTO public.session_participants (session_id, user_id)
    VALUES (v_session_id, auth.uid());

    RETURN QUERY SELECT v_session_id, v_room_name;
END;
$$;

REVOKE ALL ON FUNCTION public.create_game_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_game_session(uuid) TO authenticated;

-- Adds the calling user to an active session as a participant.
-- Silently succeeds (no error) if the user is already an active participant,
-- so callers do not need to pre-check membership.
-- Does NOT allow rejoining a session the user has already left (left_at IS NOT
-- NULL); the Photon room would need to be rejoined separately anyway.
--
-- Security guards:
--   1. Session must exist and have ended_at IS NULL.
CREATE OR REPLACE FUNCTION public.join_game_session(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.game_sessions
        WHERE id       = p_session_id
          AND ended_at IS NULL
    ) THEN
        RAISE EXCEPTION 'session_not_found_or_ended';
    END IF;

    -- Reject rejoins: a player who has already left cannot re-enter the same
    -- Supabase session row. Photon handles reconnection at the network layer;
    -- from the social/stats perspective, left means left.
    IF EXISTS (
        SELECT 1 FROM public.session_participants
        WHERE session_id = p_session_id
          AND user_id    = auth.uid()
          AND left_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'already_left_session';
    END IF;

    INSERT INTO public.session_participants (session_id, user_id)
    VALUES (p_session_id, auth.uid())
    ON CONFLICT (session_id, user_id) DO NOTHING;

    IF FOUND THEN
        UPDATE public.game_sessions
        SET player_count = player_count + 1
        WHERE id = p_session_id;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.join_game_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_game_session(uuid) TO authenticated;

-- Stamps the caller's left_at and closes the session when appropriate.
--
-- Close rules:
--   Host leaving: session ends immediately. All remaining players lose their
--   active session. This assumes Photon is configured to destroy the room when
--   the host disconnects (no host migration). If host migration is enabled,
--   this rule needs revisiting — ended_at should only be set when the last
--   participant leaves, and a separate transfer_host() RPC is needed.
--   Last participant: session closes if no active participants remain after
--   this call, regardless of who is host (covers host-crash scenarios).
--
-- Race condition: SELECT FOR UPDATE on game_sessions serializes concurrent
-- end_game_session calls on the same session. Without the lock, two players
-- disconnecting simultaneously could both observe zero remaining participants
-- and both attempt to set ended_at. The lock forces serial execution: the
-- second caller blocks until the first commits, then reads the already-reduced
-- count and makes the correct close decision.
--
-- Security guards:
--   1. Caller must be a recorded participant in this session.
CREATE OR REPLACE FUNCTION public.end_game_session(p_session_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_remaining integer;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.session_participants
        WHERE session_id = p_session_id
          AND user_id    = auth.uid()
    ) THEN
        RAISE EXCEPTION 'not_a_participant';
    END IF;

    -- Lock the session row to serialize concurrent leave operations.
    PERFORM 1 FROM public.game_sessions
    WHERE id = p_session_id
    FOR UPDATE;

    UPDATE public.session_participants
    SET left_at = now()
    WHERE session_id = p_session_id
      AND user_id    = auth.uid()
      AND left_at IS NULL;

    IF FOUND THEN
        UPDATE public.game_sessions
        SET player_count = GREATEST(player_count - 1, 0)
        WHERE id = p_session_id;
    END IF;

    SELECT COUNT(*) INTO v_remaining
    FROM public.session_participants
    WHERE session_id = p_session_id
      AND left_at IS NULL;

    IF EXISTS (
        SELECT 1 FROM public.game_sessions
        WHERE id           = p_session_id
          AND host_user_id = auth.uid()
    ) OR v_remaining = 0 THEN
        UPDATE public.game_sessions
        SET ended_at = now()
        WHERE id       = p_session_id
          AND ended_at IS NULL;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.end_game_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.end_game_session(uuid) TO authenticated;

-- Increments play_count for a game exactly once per ended session.
-- Called by SessionService.IncrementPlayCountAsync after EndSessionAsync succeeds.
--
-- Security guards:
--   1. Caller must exist in session_participants for p_session_id (any participant
--      may trigger the increment, not just the host).
--   2. p_session_id must reference p_game_id (prevents cross-game contamination).
--   3. ended_at IS NOT NULL — session must already be closed.
--   4. play_count_incremented = false — atomic idempotency per session. The UPDATE
--      claims the flag in a single statement; a concurrent or retried call sees no
--      matching row (FOUND = false) and skips the play_count increment.
CREATE OR REPLACE FUNCTION public.increment_play_count(
    p_game_id    uuid,
    p_session_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.game_sessions
    SET play_count_incremented = true
    WHERE id                     = p_session_id
      AND game_id                = p_game_id
      AND ended_at IS NOT NULL
      AND play_count_incremented = false
      AND EXISTS (
          SELECT 1 FROM public.session_participants sp
          WHERE sp.session_id = p_session_id
            AND sp.user_id    = auth.uid()
      );

    IF FOUND THEN
        UPDATE public.generated_games
        SET play_count = play_count + 1
        WHERE id = p_game_id;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_play_count(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_play_count(uuid, uuid) TO authenticated;

-- Row Level Security
-- All write operations go through RPCs above. No INSERT or UPDATE policies exist.

ALTER TABLE public.game_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sessions_select_participant"
    ON public.game_sessions FOR SELECT
    TO authenticated
    USING (
        host_user_id = auth.uid()
        OR is_session_participant(id)
    );

ALTER TABLE public.session_participants ENABLE ROW LEVEL SECURITY;

-- is_session_participant() is used here instead of an inline EXISTS subquery.
-- An inline subquery on session_participants inside a policy on session_participants
-- causes infinite recursion. The SECURITY DEFINER helper breaks the cycle.
CREATE POLICY "participants_select_session_member"
    ON public.session_participants FOR SELECT
    TO authenticated
    USING (
        user_id = auth.uid()
        OR is_session_participant(session_id)
    );
