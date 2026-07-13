
-- ============ ENUMS ============
CREATE TYPE public.member_role AS ENUM ('master', 'player');
CREATE TYPE public.file_kind AS ENUM ('document', 'image', 'map');
CREATE TYPE public.board_object_kind AS ENUM ('map', 'pin', 'sheet', 'document', 'image');

-- ============ CAMPAIGNS ============
CREATE TABLE public.campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaigns TO authenticated;
GRANT ALL ON public.campaigns TO service_role;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

-- ============ CAMPAIGN MEMBERS ============
CREATE TABLE public.campaign_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.member_role NOT NULL DEFAULT 'player',
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign_members TO authenticated;
GRANT ALL ON public.campaign_members TO service_role;
ALTER TABLE public.campaign_members ENABLE ROW LEVEL SECURITY;

-- Security-definer helpers (avoid recursive RLS)
CREATE OR REPLACE FUNCTION public.is_campaign_member(_campaign_id UUID, _user_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.campaign_members
    WHERE campaign_id = _campaign_id AND user_id = _user_id
  ) OR EXISTS (
    SELECT 1 FROM public.campaigns
    WHERE id = _campaign_id AND owner_id = _user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_campaign_master(_campaign_id UUID, _user_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.campaigns
    WHERE id = _campaign_id AND owner_id = _user_id
  ) OR EXISTS (
    SELECT 1 FROM public.campaign_members
    WHERE campaign_id = _campaign_id AND user_id = _user_id AND role = 'master'
  );
$$;

-- ============ FOLDERS ============
CREATE TABLE public.folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES public.folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'moon',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX folders_campaign_idx ON public.folders(campaign_id);
CREATE INDEX folders_parent_idx ON public.folders(parent_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.folders TO authenticated;
GRANT ALL ON public.folders TO service_role;
ALTER TABLE public.folders ENABLE ROW LEVEL SECURITY;

-- ============ FILES ============
CREATE TABLE public.files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES public.folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind public.file_kind NOT NULL DEFAULT 'document',
  icon TEXT NOT NULL DEFAULT 'scroll',
  content TEXT,
  storage_path TEXT,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX files_campaign_idx ON public.files(campaign_id);
CREATE INDEX files_folder_idx ON public.files(folder_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.files TO authenticated;
GRANT ALL ON public.files TO service_role;
ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;

-- ============ BOARD OBJECTS ============
CREATE TABLE public.board_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  kind public.board_object_kind NOT NULL,
  file_id UUID REFERENCES public.files(id) ON DELETE SET NULL,
  label TEXT,
  icon TEXT,
  x DOUBLE PRECISION NOT NULL DEFAULT 0,
  y DOUBLE PRECISION NOT NULL DEFAULT 0,
  width DOUBLE PRECISION NOT NULL DEFAULT 320,
  height DOUBLE PRECISION NOT NULL DEFAULT 240,
  rotation DOUBLE PRECISION NOT NULL DEFAULT 0,
  z_index INTEGER NOT NULL DEFAULT 1,
  locked BOOLEAN NOT NULL DEFAULT false,
  visible_to_players BOOLEAN NOT NULL DEFAULT true,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX board_objects_campaign_idx ON public.board_objects(campaign_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.board_objects TO authenticated;
GRANT ALL ON public.board_objects TO service_role;
ALTER TABLE public.board_objects ENABLE ROW LEVEL SECURITY;

-- ============ RLS POLICIES ============
-- campaigns
CREATE POLICY "campaigns_select" ON public.campaigns
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR public.is_campaign_member(id, auth.uid()));
CREATE POLICY "campaigns_insert" ON public.campaigns
  FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY "campaigns_update" ON public.campaigns
  FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "campaigns_delete" ON public.campaigns
  FOR DELETE TO authenticated USING (owner_id = auth.uid());

-- campaign_members
CREATE POLICY "members_select" ON public.campaign_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_campaign_member(campaign_id, auth.uid()));
CREATE POLICY "members_insert_owner" ON public.campaign_members
  FOR INSERT TO authenticated
  WITH CHECK (public.is_campaign_master(campaign_id, auth.uid()) OR user_id = auth.uid());
CREATE POLICY "members_update_master" ON public.campaign_members
  FOR UPDATE TO authenticated
  USING (public.is_campaign_master(campaign_id, auth.uid()))
  WITH CHECK (public.is_campaign_master(campaign_id, auth.uid()));
CREATE POLICY "members_delete_master" ON public.campaign_members
  FOR DELETE TO authenticated
  USING (public.is_campaign_master(campaign_id, auth.uid()) OR user_id = auth.uid());

-- folders
CREATE POLICY "folders_select" ON public.folders
  FOR SELECT TO authenticated
  USING (public.is_campaign_member(campaign_id, auth.uid()));
CREATE POLICY "folders_write_master" ON public.folders
  FOR ALL TO authenticated
  USING (public.is_campaign_master(campaign_id, auth.uid()))
  WITH CHECK (public.is_campaign_master(campaign_id, auth.uid()));

-- files
CREATE POLICY "files_select" ON public.files
  FOR SELECT TO authenticated
  USING (public.is_campaign_member(campaign_id, auth.uid()));
CREATE POLICY "files_write_master" ON public.files
  FOR ALL TO authenticated
  USING (public.is_campaign_master(campaign_id, auth.uid()))
  WITH CHECK (public.is_campaign_master(campaign_id, auth.uid()));

-- board_objects: players see only visible ones; master sees all
CREATE POLICY "board_select_master" ON public.board_objects
  FOR SELECT TO authenticated
  USING (public.is_campaign_master(campaign_id, auth.uid()));
CREATE POLICY "board_select_player" ON public.board_objects
  FOR SELECT TO authenticated
  USING (public.is_campaign_member(campaign_id, auth.uid()) AND visible_to_players = true);
CREATE POLICY "board_write_master" ON public.board_objects
  FOR ALL TO authenticated
  USING (public.is_campaign_master(campaign_id, auth.uid()))
  WITH CHECK (public.is_campaign_master(campaign_id, auth.uid()));

-- ============ TRIGGERS ============
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER campaigns_touch BEFORE UPDATE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER folders_touch BEFORE UPDATE ON public.folders
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER files_touch BEFORE UPDATE ON public.files
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER board_objects_touch BEFORE UPDATE ON public.board_objects
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Auto-add owner as master on campaign creation
CREATE OR REPLACE FUNCTION public.add_owner_as_master() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.campaign_members (campaign_id, user_id, role)
  VALUES (NEW.id, NEW.owner_id, 'master')
  ON CONFLICT (campaign_id, user_id) DO UPDATE SET role = 'master';
  RETURN NEW;
END; $$;
CREATE TRIGGER campaigns_add_owner AFTER INSERT ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.add_owner_as_master();

-- ============ REALTIME ============
ALTER PUBLICATION supabase_realtime ADD TABLE public.board_objects;
ALTER PUBLICATION supabase_realtime ADD TABLE public.folders;
ALTER PUBLICATION supabase_realtime ADD TABLE public.files;
ALTER TABLE public.board_objects REPLICA IDENTITY FULL;
