-- User inventory
-- Tracks which avatar items a player owns and which are currently equipped.
--
-- One-per-type constraint: only one item per avatar_item_type slot may be
-- equipped at a time (e.g. one head, one top). This is enforced in equip_item()
-- rather than via a partial unique index because the enforcement requires an
-- atomic swap (unequip old, equip new) and a simultaneous write to
-- users.avatar_config. A partial unique index alone cannot enforce the swap
-- atomically, and would block valid mid-swap states from landing.
--
-- users.avatar_config is the denormalized equipped loadout used for lobby
-- rendering. equip_item() and unequip_item() keep it in sync with the
-- equipped column in this table. handle_avatar_item_deleted() in
-- 003_avatar_items.sql cleans avatar_config when an item is deleted.
--
-- Mutation convention:
--   All writes go through SECURITY DEFINER RPCs. RLS governs SELECT only.
--
-- RPCs in this file:
--   acquire_item  — add an item to the caller's inventory
--   equip_item    — equip an owned item; unequips any same-type item already equipped;
--                   updates users.avatar_config atomically
--   unequip_item  — unequip an owned item; removes the slot from users.avatar_config

CREATE TABLE public.user_inventory (
    user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    item_id     uuid        NOT NULL REFERENCES public.avatar_items(id) ON DELETE CASCADE,
    acquired_at timestamptz NOT NULL DEFAULT now(),
    equipped    boolean     NOT NULL DEFAULT false,

    PRIMARY KEY (user_id, item_id)
);

CREATE INDEX user_inventory_user_idx          ON public.user_inventory (user_id);
CREATE INDEX user_inventory_user_equipped_idx ON public.user_inventory (user_id) WHERE equipped = true;
CREATE INDEX user_inventory_item_idx          ON public.user_inventory (item_id);

-- Adds an item to the caller's inventory.
-- The item must be public, or the caller must be its creator.
-- Silently succeeds if the item is already owned (idempotent acquire).
-- v1: any authenticated user may acquire any public item freely.
-- Future: add acquisition_type (earned/purchased/granted) and gate here.
CREATE OR REPLACE FUNCTION public.acquire_item(p_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.avatar_items
        WHERE id = p_item_id
          AND (is_public = true OR created_by_user_id = auth.uid())
    ) THEN
        RAISE EXCEPTION 'item_not_found_or_forbidden';
    END IF;

    INSERT INTO public.user_inventory (user_id, item_id)
    VALUES (auth.uid(), p_item_id)
    ON CONFLICT (user_id, item_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_item(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_item(uuid) TO authenticated;

-- Equips an owned item and updates users.avatar_config atomically.
-- If another item of the same type is already equipped, it is unequipped first
-- (swap, not error). Silently succeeds if the item is already equipped (idempotent).
-- Raises 'item_not_owned' if the caller does not own the item.
--
-- avatar_config slot key is the item_type enum value cast to text ('head', 'top', etc).
-- avatar_config slot value is the item id cast to text (uuid hyphenated string).
CREATE OR REPLACE FUNCTION public.equip_item(p_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_item_type   public.avatar_item_type;
    v_is_equipped boolean;
BEGIN
    -- Lock the target row to prevent concurrent equip of the same item,
    -- and get its type and current equipped state in one query.
    SELECT ai.item_type, ui.equipped
    INTO v_item_type, v_is_equipped
    FROM public.user_inventory ui
    JOIN public.avatar_items   ai ON ai.id = ui.item_id
    WHERE ui.user_id = auth.uid()
      AND ui.item_id = p_item_id
    FOR UPDATE OF ui;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'item_not_owned';
    END IF;

    IF v_is_equipped THEN
        RETURN;  -- Already equipped; idempotent no-op.
    END IF;

    -- Lock all same-type inventory rows for this user to serialize concurrent
    -- slot-swaps. Without this lock, two concurrent equips of different items
    -- of the same type could both unequip the current slot occupant and both
    -- proceed to equip, leaving two items equipped in the same slot.
    PERFORM 1
    FROM public.user_inventory ui
    JOIN public.avatar_items   ai ON ai.id = ui.item_id
    WHERE ui.user_id    = auth.uid()
      AND ai.item_type  = v_item_type
    FOR UPDATE OF ui;

    -- Unequip any currently equipped item of the same type.
    UPDATE public.user_inventory
    SET equipped = false
    WHERE user_id  = auth.uid()
      AND equipped = true
      AND item_id IN (
          SELECT id FROM public.avatar_items WHERE item_type = v_item_type
      );

    -- Equip the new item.
    UPDATE public.user_inventory
    SET equipped = true
    WHERE user_id = auth.uid()
      AND item_id = p_item_id;

    -- Overwrite the avatar_config slot for this item type.
    -- Uses jsonb concatenation (||) so all other slots are preserved.
    UPDATE public.users
    SET avatar_config = avatar_config || jsonb_build_object(v_item_type::text, p_item_id::text)
    WHERE id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.equip_item(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.equip_item(uuid) TO authenticated;

-- Unequips an owned item and removes its slot from users.avatar_config.
-- Raises 'item_not_owned' if the caller does not own the item.
-- Silently succeeds if the item is owned but already unequipped (idempotent).
CREATE OR REPLACE FUNCTION public.unequip_item(p_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_item_type public.avatar_item_type;
BEGIN
    -- Verify ownership first to give a clear error if the item isn't owned.
    IF NOT EXISTS (
        SELECT 1 FROM public.user_inventory
        WHERE user_id = auth.uid() AND item_id = p_item_id
    ) THEN
        RAISE EXCEPTION 'item_not_owned';
    END IF;

    SELECT item_type INTO v_item_type
    FROM public.avatar_items
    WHERE id = p_item_id;

    UPDATE public.user_inventory
    SET equipped = false
    WHERE user_id = auth.uid()
      AND item_id = p_item_id
      AND equipped = true;

    IF NOT FOUND THEN
        RETURN;  -- Already unequipped; idempotent no-op.
    END IF;

    -- Remove the slot from avatar_config only if it still points to this item.
    -- Guards against the edge case where a concurrent equip replaced the slot
    -- with a different item between the equipped check and this UPDATE.
    UPDATE public.users
    SET avatar_config = avatar_config - v_item_type::text
    WHERE id = auth.uid()
      AND avatar_config->>v_item_type::text = p_item_id::text;
END;
$$;

REVOKE ALL ON FUNCTION public.unequip_item(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unequip_item(uuid) TO authenticated;

-- Row Level Security
ALTER TABLE public.user_inventory ENABLE ROW LEVEL SECURITY;

-- Users can only read their own inventory.
CREATE POLICY "inventory_select_own"
    ON public.user_inventory FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- No INSERT, UPDATE, or DELETE policies. All writes go through RPCs above.
