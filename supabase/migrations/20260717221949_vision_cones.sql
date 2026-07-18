-- ============================================================
-- VISION CONES (directional light, as an alternative to the
-- omnidirectional circle already supported by has_light/light_radius)
-- ============================================================
-- light_shape picks which shape `light_radius` describes:
--   'circle' — existing behavior, lights a full circle around the object.
--   'cone'   — lights a wedge, facing `light_angle` degrees, `light_cone_width`
--              degrees wide. Angle convention: 0° = facing right (east),
--              increasing clockwise (90° = down, 180° = left, 270° = up) —
--              matches atan2(dy, dx) on screen coordinates directly, so the
--              frontend's drag-to-rotate handle needs no angle conversion
--              beyond the CSS conic-gradient offset (which is a rendering
--              detail, not a stored-data one).
--
-- `character_id` on board_objects already exists (added for "sheet" cards)
-- and had no kind restriction, so pins can link to a character for free —
-- no schema change needed there, just a frontend feature.

ALTER TABLE public.board_objects
  ADD COLUMN light_shape TEXT NOT NULL DEFAULT 'circle'
    CHECK (light_shape IN ('circle', 'cone')),
  ADD COLUMN light_angle NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN light_cone_width NUMERIC NOT NULL DEFAULT 90;

-- ============================================================
-- CHARACTER PORTRAITS (storage)
-- ============================================================
-- The existing "campaign-assets" bucket policies require the path's first
-- segment to be a campaign id, and only let the campaign *master* write —
-- fine for maps/tokens the GM uploads, but characters are a per-user
-- library now (not campaign-bound), so a player needs to be able to upload
-- their own portrait without being anyone's master. Portraits get their
-- own prefix — "portraits/{character_id}/{filename}" — checked against
-- characters.owner_id instead of campaign membership.

CREATE POLICY "character_portraits_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'campaign-assets'
    AND split_part(name, '/', 1) = 'portraits'
    AND EXISTS (
      SELECT 1 FROM public.characters c
      WHERE c.id = (split_part(name, '/', 2))::uuid
        AND (
          c.owner_id = auth.uid()
          OR public.masters_owner(auth.uid(), c.owner_id)
          OR (c.visible_to_players = true AND public.shares_campaign(auth.uid(), c.owner_id))
        )
    )
  );

CREATE POLICY "character_portraits_write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'campaign-assets'
    AND split_part(name, '/', 1) = 'portraits'
    AND EXISTS (
      SELECT 1 FROM public.characters c
      WHERE c.id = (split_part(name, '/', 2))::uuid AND c.owner_id = auth.uid()
    )
  );

CREATE POLICY "character_portraits_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'campaign-assets'
    AND split_part(name, '/', 1) = 'portraits'
    AND EXISTS (
      SELECT 1 FROM public.characters c
      WHERE c.id = (split_part(name, '/', 2))::uuid AND c.owner_id = auth.uid()
    )
  );

CREATE POLICY "character_portraits_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'campaign-assets'
    AND split_part(name, '/', 1) = 'portraits'
    AND EXISTS (
      SELECT 1 FROM public.characters c
      WHERE c.id = (split_part(name, '/', 2))::uuid AND c.owner_id = auth.uid()
    )
  );
