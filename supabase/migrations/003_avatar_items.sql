-- Avatar items catalog
-- Items are created by the Unity client immediately after the AI generation
-- pipeline returns mesh and thumbnail URLs. The row is not inserted until
-- generation is complete, so mesh_url and thumbnail_url are effectively
-- always populated on insert. If a staged/draft state is needed in a future
-- migration, add is_ready boolean NOT NULL DEFAULT false and filter it in queries.
--
-- generation_prompt is visible to any user who can SELECT the row (i.e., public
-- items expose their prompt to all authenticated users). This is intentional:
-- publishing an item implicitly shares its creative provenance. Private items'
-- prompts are visible only to the creator.
--
-- One-per-type equip constraint is enforced in equip_item() in 004_user_inventory.sql.
--
-- Mutation convention:
--   INSERT  — direct client write with RLS (no business logic needed at insert time)
--   UPDATE  — update_avatar_item() RPC (protects item_type, mesh_url, thumbnail_url)
--   DELETE  — direct client write with RLS; handle_avatar_item_deleted() trigger
--             scrubs users.avatar_config before the user_inventory CASCADE fires
--   SELECT  — RLS policy

CREATE TYPE public.avatar_item_type AS ENUM (
    'head', 'hair', 'face', 'neck', 'top', 'bottom',
    'shoes', 'accessory', 'back', 'front', 'waist'
);

CREATE TABLE public.avatar_items (
    id                  uuid                    PRIMARY KEY DEFAULT gen_random_uuid(),
    name                text                    NOT NULL,
    description         text,
    item_type           public.avatar_item_type NOT NULL,
    mesh_url            text,
    thumbnail_url       text,
    generation_prompt   text,
    -- ON DELETE SET NULL: deleted creators' public items persist as community catalog.
    -- Private items become invisible (null != auth.uid() in the SELECT policy).
    created_by_user_id  uuid                    REFERENCES public.users(id) ON DELETE SET NULL,
    is_public           boolean                 NOT NULL DEFAULT false,
    created_at          timestamptz             NOT NULL DEFAULT now()
);

CREATE INDEX avatar_items_creator_idx  ON public.avatar_items (created_by_user_id);
CREATE INDEX avatar_items_type_idx     ON public.avatar_items (item_type) WHERE is_public = true;
CREATE INDEX avatar_items_public_idx   ON public.avatar_items (created_at DESC) WHERE is_public = true;

-- Allows the creator to update name, description, and is_public (publish/unpublish).
-- item_type, mesh_url, thumbnail_url, and generation_prompt are immutable after insert.
CREATE OR REPLACE FUNCTION public.update_avatar_item(
    p_id          uuid,
    p_name        text,
    p_description text,
    p_is_public   boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.avatar_items
    SET name        = COALESCE(p_name,        name),
        description = COALESCE(p_description, description),
        is_public   = COALESCE(p_is_public,   is_public)
    WHERE id                 = p_id
      AND created_by_user_id = auth.uid();

    IF NOT FOUND THEN
        RAISE EXCEPTION 'item_not_found_or_forbidden';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.update_avatar_item(uuid, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_avatar_item(uuid, text, text, boolean) TO authenticated;

-- Fires BEFORE DELETE on avatar_items, before the FK CASCADE removes rows from
-- user_inventory. Clears users.avatar_config for any user who had this item
-- equipped, so the denormalized cache does not hold a dangling item reference.
--
-- The UPDATE touches only users whose avatar_config slot matches exactly this
-- item id — other slots are left untouched. Because item deletions are rare and
-- equip counts per item are small, the sequential scan on avatar_config is
-- acceptable for v1. A GIN index can be added if this becomes a bottleneck.
--
-- OLD is still fully accessible here: the trigger fires before the parent row
-- is deleted, so OLD.item_type and OLD.id are readable.
CREATE OR REPLACE FUNCTION public.handle_avatar_item_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.users
    SET avatar_config = avatar_config - OLD.item_type::text
    WHERE avatar_config->>OLD.item_type::text = OLD.id::text;

    RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_avatar_item_deleted() FROM PUBLIC;

CREATE TRIGGER on_avatar_item_deleted
    BEFORE DELETE ON public.avatar_items
    FOR EACH ROW EXECUTE FUNCTION public.handle_avatar_item_deleted();

-- Row Level Security
ALTER TABLE public.avatar_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "avatar_items_select_public_or_own"
    ON public.avatar_items FOR SELECT
    TO authenticated
    USING (
        is_public = true
        OR created_by_user_id = auth.uid()
    );

CREATE POLICY "avatar_items_insert_creator"
    ON public.avatar_items FOR INSERT
    TO authenticated
    WITH CHECK (created_by_user_id = auth.uid());

-- No UPDATE policy. See update_avatar_item().

CREATE POLICY "avatar_items_delete_creator"
    ON public.avatar_items FOR DELETE
    TO authenticated
    USING (created_by_user_id = auth.uid());
