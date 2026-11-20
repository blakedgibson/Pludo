-- Returns true if the username is not already taken (case-insensitive).
-- SECURITY DEFINER so anon-role callers bypass RLS during sign-up.
CREATE OR REPLACE FUNCTION public.check_username_available(p_username text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT NOT EXISTS (
        SELECT 1 FROM public.users WHERE lower(username) = lower(p_username)
    );
$$;

GRANT EXECUTE ON FUNCTION public.check_username_available(text) TO anon, authenticated;
