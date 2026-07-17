-- ============================================================
-- TABLE VISUAL THEMES (presets, not free-form uploads)
-- ============================================================
-- `campaigns.theme` is the master's default for the table.
-- `campaign_theme_overrides` lets any individual member pick their own
-- look for the same table without affecting anyone else — a row here
-- simply means "this user prefers this preset instead of the default".
-- Preset ids/definitions live in the frontend (src/lib/board-themes.ts),
-- not in the database — this column just stores which one was picked.

ALTER TABLE public.campaigns ADD COLUMN theme TEXT NOT NULL DEFAULT 'padrao';

CREATE TABLE public.campaign_theme_overrides (
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  theme TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign_theme_overrides TO authenticated;
GRANT ALL ON public.campaign_theme_overrides TO service_role;
ALTER TABLE public.campaign_theme_overrides ENABLE ROW LEVEL SECURITY;

-- Only your own override ever matters to you; no reason to expose it to
-- (or let it be edited by) anyone else, master included.
CREATE POLICY "theme_overrides_select" ON public.campaign_theme_overrides
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "theme_overrides_insert" ON public.campaign_theme_overrides
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.is_campaign_member(campaign_id, auth.uid()));

CREATE POLICY "theme_overrides_update" ON public.campaign_theme_overrides
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "theme_overrides_delete" ON public.campaign_theme_overrides
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

ALTER PUBLICATION supabase_realtime ADD TABLE public.campaign_theme_overrides;
ALTER TABLE public.campaign_theme_overrides REPLICA IDENTITY FULL;
