-- Friendships
-- Bidirectional row strategy: a pending request is ONE row
-- (requester → recipient, status = 'pending'). On acceptance,
-- accept_friend_request() atomically inserts the reverse row and updates
-- both to 'accepted'. This means "get my friends" is a simple
--   WHERE user_id = auth.uid() AND status = 'accepted'
-- with no UNION over both directions.
--
-- blocked status:
--   A block row (blocker → blocked, status = 'blocked') prevents the blocked
--   user from sending a new request. send_friend_request() silently no-ops if
--   the recipient has blocked the caller — the caller does not learn a block
--   exists (standard social-app privacy practice).
--   The RLS SELECT policy also hides block rows from the blocked party:
--   a blocked user cannot SELECT the row where they appear as friend_id and
--   status = 'blocked', so they cannot discover the block via the API.
--
-- Mutation convention:
--   All writes go through SECURITY DEFINER RPCs. RLS governs SELECT only.
--
-- RPCs in this file:
--   send_friend_request    — create a pending row; silent no-op if blocked
--   accept_friend_request  — atomically insert reverse row, flip both to accepted
--   decline_friend_request — delete a pending request directed at the caller
--   remove_friend          — delete both rows of an accepted friendship
--   block_user             — upsert a blocked row, remove existing friendship
--   unblock_user           — remove the caller's block on a user
--
-- Note: IFriendService requires a corresponding UnblockUserAsync method.

CREATE TYPE public.friendship_status AS ENUM ('pending', 'accepted', 'blocked');

CREATE TABLE public.friendships (
    user_id     uuid                     NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    friend_id   uuid                     NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status      public.friendship_status NOT NULL DEFAULT 'pending',
    created_at  timestamptz              NOT NULL DEFAULT now(),
    accepted_at timestamptz,

    PRIMARY KEY (user_id, friend_id),
    CONSTRAINT friendships_no_self CHECK (user_id <> friend_id)
);

-- (user_id, status): "what are my outgoing requests / who are my friends?"
-- (friend_id, status): "what requests came in to me / who are my friends?"
-- Both directions are queried during the pending state, so both composites
-- are indexed rather than a bare friend_id index.
CREATE INDEX friendships_user_status_idx   ON public.friendships (user_id,   status);
CREATE INDEX friendships_friend_status_idx ON public.friendships (friend_id, status);

-- Creates a pending request from auth.uid() to p_recipient_id.
-- Silent no-op (no error, no row) if:
--   - The recipient has blocked the caller (privacy: do not reveal the block)
--   - A row in this direction already exists (idempotent re-send)
-- Raises if the caller tries to add themselves.
CREATE OR REPLACE FUNCTION public.send_friend_request(p_recipient_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_recipient_id = auth.uid() THEN
        RAISE EXCEPTION 'cannot_friend_self';
    END IF;

    -- Silent no-op if the recipient has blocked the caller.
    IF EXISTS (
        SELECT 1 FROM public.friendships
        WHERE user_id   = p_recipient_id
          AND friend_id = auth.uid()
          AND status    = 'blocked'
    ) THEN
        RETURN;
    END IF;

    INSERT INTO public.friendships (user_id, friend_id, status)
    VALUES (auth.uid(), p_recipient_id, 'pending')
    ON CONFLICT (user_id, friend_id) DO NOTHING;
    -- Idempotent: DO NOTHING if a row already exists in this direction
    -- (covers pending, accepted, or caller's own block on this user).
END;
$$;

REVOKE ALL ON FUNCTION public.send_friend_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_friend_request(uuid) TO authenticated;

-- Accepts the pending request from p_requester_id to auth.uid().
-- Atomically: updates the original row to 'accepted', then inserts the reverse
-- row. Both rows share the same accepted_at timestamp.
-- ON CONFLICT on the reverse insert handles the edge case where a reciprocal
-- row already exists (e.g., after a retry or a previous decline-and-resend).
-- Raises 'request_not_found' if no matching pending row exists.
CREATE OR REPLACE FUNCTION public.accept_friend_request(p_requester_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now timestamptz := now();
BEGIN
    UPDATE public.friendships
    SET status      = 'accepted',
        accepted_at = v_now
    WHERE user_id   = p_requester_id
      AND friend_id = auth.uid()
      AND status    = 'pending';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'request_not_found';
    END IF;

    INSERT INTO public.friendships (user_id, friend_id, status, accepted_at)
    VALUES (auth.uid(), p_requester_id, 'accepted', v_now)
    ON CONFLICT (user_id, friend_id) DO UPDATE
        SET status      = 'accepted',
            accepted_at = v_now;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_friend_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_friend_request(uuid) TO authenticated;

-- Deletes the pending row from p_requester_id directed at auth.uid().
-- Only the recipient can decline; the requester uses remove_friend() to retract.
-- Raises 'request_not_found' if no matching pending row exists.
CREATE OR REPLACE FUNCTION public.decline_friend_request(p_requester_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    DELETE FROM public.friendships
    WHERE user_id   = p_requester_id
      AND friend_id = auth.uid()
      AND status    = 'pending';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'request_not_found';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.decline_friend_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decline_friend_request(uuid) TO authenticated;

-- Deletes both rows of an accepted friendship (or a pending request in either
-- direction). Does not remove block rows; use unblock_user() for that.
-- Silently succeeds if no friendship exists (idempotent unfriend/retract).
CREATE OR REPLACE FUNCTION public.remove_friend(p_friend_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    DELETE FROM public.friendships
    WHERE status != 'blocked'
      AND (
          (user_id = auth.uid() AND friend_id = p_friend_id)
          OR
          (user_id = p_friend_id AND friend_id = auth.uid())
      );
END;
$$;

REVOKE ALL ON FUNCTION public.remove_friend(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_friend(uuid) TO authenticated;

-- Inserts (auth.uid() → p_user_id, 'blocked').
-- First removes any pending or accepted friendship rows in either direction,
-- leaving any existing block from p_user_id → auth.uid() untouched.
-- Silently succeeds if the caller is already blocking this user.
CREATE OR REPLACE FUNCTION public.block_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_user_id = auth.uid() THEN
        RAISE EXCEPTION 'cannot_block_self';
    END IF;

    DELETE FROM public.friendships
    WHERE status != 'blocked'
      AND (
          (user_id = auth.uid() AND friend_id = p_user_id)
          OR
          (user_id = p_user_id   AND friend_id = auth.uid())
      );

    INSERT INTO public.friendships (user_id, friend_id, status)
    VALUES (auth.uid(), p_user_id, 'blocked')
    ON CONFLICT (user_id, friend_id) DO UPDATE
        SET status      = 'blocked',
            accepted_at = NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.block_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.block_user(uuid) TO authenticated;

-- Removes the caller's block on p_user_id.
-- Silently succeeds if the caller is not blocking this user (idempotent).
-- Does not automatically re-create any friendship; the user must send a
-- new friend request after unblocking if they wish to reconnect.
CREATE OR REPLACE FUNCTION public.unblock_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    DELETE FROM public.friendships
    WHERE user_id   = auth.uid()
      AND friend_id = p_user_id
      AND status    = 'blocked';
END;
$$;

REVOKE ALL ON FUNCTION public.unblock_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unblock_user(uuid) TO authenticated;

-- Row Level Security
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;

-- Both parties in a pending or accepted row can see it.
-- Block rows are intentionally hidden from the blocked party: a user where
-- auth.uid() = friend_id cannot see rows where status = 'blocked'.
-- This prevents the blocked user from discovering the block via the API.
-- The blocker (user_id = auth.uid()) can always see their own block rows.
CREATE POLICY "friendships_select_participant"
    ON public.friendships FOR SELECT
    TO authenticated
    USING (
        auth.uid() = user_id
        OR (auth.uid() = friend_id AND status != 'blocked')
    );

-- No INSERT, UPDATE, or DELETE policies. All writes go through RPCs above.
