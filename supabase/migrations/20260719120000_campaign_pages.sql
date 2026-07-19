-- ============ CAMPAIGN PAGES (Grimório) ============
-- A dedicated full-screen area, separate from the board and from `files`,
-- where the master builds long-form campaign resources (lore, system rules,
-- character/skill guides) as block-based pages organized in a folder tree.
--
-- Deliberately its own table rather than reusing `files` (the board asset
-- library): those rows back board_objects (kind = document/image/map) and
-- hold a single plain-text blob copied onto the board. Pages here hold
-- structured block content (headings, paragraphs, lists, quotes...) and each
-- one has its own publish flag, since players should only ever see what the
-- master has explicitly released — not just "if the object is on the board".
CREATE TABLE public.campaign_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES public.campaign_pages(id) ON DELETE CASCADE,
  is_folder BOOLEAN NOT NULL DEFAULT false,
  title TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'scroll',
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Array of { id, type, text } blocks — see src/lib/page-blocks.ts for the
  -- shape the client reads/writes. Folders (is_folder = true) never carry
  -- blocks; they exist purely to organize the sidebar tree.
  blocks JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_published BOOLEAN NOT NULL DEFAULT false,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX campaign_pages_campaign_idx ON public.campaign_pages(campaign_id);
CREATE INDEX campaign_pages_parent_idx ON public.campaign_pages(parent_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign_pages TO authenticated;
GRANT ALL ON public.campaign_pages TO service_role;
ALTER TABLE public.campaign_pages ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER campaign_pages_touch BEFORE UPDATE ON public.campaign_pages
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============ RLS POLICIES ============

-- Master (owner or campaign_members.role = 'master'): full CRUD on every
-- page/folder in their own campaign.
CREATE POLICY "campaign_pages_master_all" ON public.campaign_pages
  FOR ALL TO authenticated
  USING (public.is_campaign_master(campaign_id, auth.uid()))
  WITH CHECK (public.is_campaign_master(campaign_id, auth.uid()));

-- Players: read-only, and only pages the master has explicitly published.
-- Folders are structural only (no content of their own), so they're left
-- out of this policy entirely — the client fetches published pages as a
-- flat list for non-masters instead of reconstructing a filtered tree.
CREATE POLICY "campaign_pages_player_select_published" ON public.campaign_pages
  FOR SELECT TO authenticated
  USING (
    is_published = true
    AND is_folder = false
    AND public.is_campaign_member(campaign_id, auth.uid())
  );
