-- Fixes the invite flow: previously nothing ever inserted an invited player
-- into public.campaign_members, so campaigns_select RLS ("owner_id = auth.uid()
-- OR is_campaign_member(...)") always blocked the invited user, even though
-- members_insert_owner already allowed self-insertion (user_id = auth.uid()).
--
-- This RPC is the single, safe entry point for that self-insertion:
--   * SECURITY DEFINER lets it check campaign existence even though the
--     caller cannot SELECT a campaign they are not a member of yet.
--   * It only ever inserts the CALLER as 'player' (never 'master'), so it
--     cannot be used to escalate privileges on someone else's campaign.
--   * ON CONFLICT DO NOTHING keeps it idempotent for repeat visits and for
--     the owner (who is already a member via add_owner_as_master()).
CREATE OR REPLACE FUNCTION public.join_campaign(_campaign_id UUID)
RETURNS TABLE (
  id UUID,
  name TEXT,
  description TEXT,
  owner_id UUID,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller UUID := auth.uid();
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.campaigns c WHERE c.id = _campaign_id) THEN
    RAISE EXCEPTION 'Campaign not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.campaign_members (campaign_id, user_id, role)
  VALUES (_campaign_id, _caller, 'player')
  ON CONFLICT (campaign_id, user_id) DO NOTHING;

  RETURN QUERY
  SELECT c.id, c.name, c.description, c.owner_id, c.created_at, c.updated_at
  FROM public.campaigns c
  WHERE c.id = _campaign_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.join_campaign(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_campaign(UUID) TO authenticated;
