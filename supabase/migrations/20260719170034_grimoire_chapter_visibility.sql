-- ============ GRIMÓRIO: CAPÍTULOS VISÍVEIS AOS JOGADORES ============
-- Previously, folders (capítulos) were excluded from the player SELECT
-- policy entirely, which meant a published page nested inside a folder
-- was fetched but had no parent in the client's tree to render under —
-- it silently disappeared. This migration:
--   1. Adds `is_locked`, letting the master show a chapter's title while
--      keeping everything inside it closed off ("cadeado").
--   2. Replaces the flat "is_published + is_folder = false" player policy
--      with a recursive check that walks the parent chain, so a chapter
--      is visible to players once published (default false — starts
--      hidden, matching the folder default), and a locked ancestor hides
--      everything beneath it even if a child page is itself published.

ALTER TABLE public.campaign_pages
  ADD COLUMN is_locked BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.campaign_pages.is_locked IS
  'Only meaningful on folders. Locked folders remain visible to players '
  '(name + icon, so they know it exists) but their descendants are hidden '
  'from the player SELECT policy until the master unlocks it.';

-- Walks from `page_id` up through parent_id. A row is visible to a player
-- when every node in the chain (itself and all ancestors) is published,
-- and no *ancestor* folder is locked. A locked folder still returns true
-- for itself (players see the padlock) — only its descendants are cut off.
CREATE OR REPLACE FUNCTION public.campaign_page_visible_to_player(page_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_id UUID := page_id;
  is_origin BOOLEAN := true;
  rec RECORD;
BEGIN
  LOOP
    SELECT is_published, is_locked, is_folder, parent_id
      INTO rec
      FROM public.campaign_pages
      WHERE id = current_id;

    IF NOT FOUND THEN
      RETURN false;
    END IF;

    IF NOT rec.is_published THEN
      RETURN false;
    END IF;

    IF NOT is_origin AND rec.is_folder AND rec.is_locked THEN
      RETURN false;
    END IF;

    IF rec.parent_id IS NULL THEN
      RETURN true;
    END IF;

    current_id := rec.parent_id;
    is_origin := false;
  END LOOP;
END;
$$;

DROP POLICY IF EXISTS "campaign_pages_player_select_published" ON public.campaign_pages;

CREATE POLICY "campaign_pages_player_select_visible" ON public.campaign_pages
  FOR SELECT TO authenticated
  USING (
    public.is_campaign_member(campaign_id, auth.uid())
    AND public.campaign_page_visible_to_player(id)
  );
