
REVOKE EXECUTE ON FUNCTION public.is_campaign_member(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_campaign_master(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.add_owner_as_master() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_campaign_member(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_campaign_master(UUID, UUID) TO authenticated;

-- Storage policies for private bucket 'campaign-assets': path = campaign_id/filename
CREATE POLICY "campaign_assets_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'campaign-assets'
    AND public.is_campaign_member((split_part(name, '/', 1))::uuid, auth.uid())
  );

CREATE POLICY "campaign_assets_write_master" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'campaign-assets'
    AND public.is_campaign_master((split_part(name, '/', 1))::uuid, auth.uid())
  );

CREATE POLICY "campaign_assets_update_master" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'campaign-assets'
    AND public.is_campaign_master((split_part(name, '/', 1))::uuid, auth.uid())
  );

CREATE POLICY "campaign_assets_delete_master" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'campaign-assets'
    AND public.is_campaign_master((split_part(name, '/', 1))::uuid, auth.uid())
  );
