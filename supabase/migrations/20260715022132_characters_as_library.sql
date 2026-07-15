-- ============================================================
-- CHARACTERS BECOME A PER-USER LIBRARY (not campaign-bound)
-- ============================================================
-- Previously a character belonged to exactly one campaign. Now a character
-- belongs to its owner and can be brought into any campaign that owner is
-- part of — created from a global "character library" screen, and placed
-- on any table's board via board_objects.character_id (already decoupled
-- since the first migration).
--
-- `characters.campaign_id` is kept as a nullable "home/default campaign"
-- hint (nice for pre-filtering a new character's initial context) but is
-- no longer required and is no longer the basis for visibility.

ALTER TABLE public.characters ALTER COLUMN campaign_id DROP NOT NULL;
ALTER TABLE public.dice_rolls ALTER COLUMN campaign_id DROP NOT NULL;

-- ---- helpers ----
CREATE OR REPLACE FUNCTION public.shares_campaign(_user_a UUID, _user_b UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.campaign_members m1
    JOIN public.campaign_members m2 ON m1.campaign_id = m2.campaign_id
    WHERE m1.user_id = _user_a AND m2.user_id = _user_b
  );
$$;
REVOKE EXECUTE ON FUNCTION public.shares_campaign(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shares_campaign(UUID, UUID) TO authenticated;

-- True when `_master` is the master of some campaign that `_owner` belongs to
-- (covers both the campaign creator and any member with role='master').
CREATE OR REPLACE FUNCTION public.masters_owner(_master UUID, _owner UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.campaign_members cm
    WHERE cm.user_id = _owner
      AND public.is_campaign_master(cm.campaign_id, _master)
  );
$$;
REVOKE EXECUTE ON FUNCTION public.masters_owner(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.masters_owner(UUID, UUID) TO authenticated;

-- ---- characters RLS, rewritten around ownership instead of campaign_id ----
DROP POLICY IF EXISTS "characters_select" ON public.characters;
DROP POLICY IF EXISTS "characters_insert" ON public.characters;
DROP POLICY IF EXISTS "characters_update" ON public.characters;
DROP POLICY IF EXISTS "characters_delete" ON public.characters;

-- Always see your own library. Also see another player's character if you
-- master a campaign they belong to, or if it's marked visible and you
-- share any campaign with them (e.g. NPCs the master shows at the table).
CREATE POLICY "characters_select" ON public.characters
  FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR public.masters_owner(auth.uid(), owner_id)
    OR (visible_to_players = true AND public.shares_campaign(auth.uid(), owner_id))
  );

-- Anyone creates characters for themselves — no campaign membership check,
-- since the library is no longer campaign-scoped.
CREATE POLICY "characters_insert" ON public.characters
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "characters_update" ON public.characters
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() OR public.masters_owner(auth.uid(), owner_id))
  WITH CHECK (owner_id = auth.uid() OR public.masters_owner(auth.uid(), owner_id));

CREATE POLICY "characters_delete" ON public.characters
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid() OR public.masters_owner(auth.uid(), owner_id));

-- ---- dice_rolls RLS, same idea: ownership/sharing instead of a required campaign ----
DROP POLICY IF EXISTS "dice_rolls_select" ON public.dice_rolls;
DROP POLICY IF EXISTS "dice_rolls_insert" ON public.dice_rolls;

CREATE POLICY "dice_rolls_select" ON public.dice_rolls
  FOR SELECT TO authenticated
  USING (
    roller_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.characters c
      WHERE c.id = dice_rolls.character_id
        AND (
          c.owner_id = auth.uid()
          OR public.masters_owner(auth.uid(), c.owner_id)
          OR (c.visible_to_players = true AND public.shares_campaign(auth.uid(), c.owner_id))
        )
    )
    OR (campaign_id IS NOT NULL AND public.is_campaign_member(campaign_id, auth.uid()))
  );

CREATE POLICY "dice_rolls_insert" ON public.dice_rolls
  FOR INSERT TO authenticated
  WITH CHECK (roller_id = auth.uid());
