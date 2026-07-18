-- ============================================================
-- PLAYER TOKEN CONTROL
-- ============================================================
-- board_objects writes were master-only ("board_write_master" is the only
-- write policy on the table), so a player could never move their own
-- character's token or turn its vision cone during a scene — the
-- move/rotate handles in BoardCanvas.tsx were gated on isMaster and, even
-- if they hadn't been, the UPDATE would've been rejected by RLS.
--
-- Opening board_objects writes to players via RLS would let a player edit
-- ANY column on ANY object (not just their own token), so instead these
-- are narrow SECURITY DEFINER entry points: a player may move x/y or set
-- light_angle ONLY on a pin that is linked (character_id) to a character
-- THEY own, in a campaign they belong to, and only while it's unlocked.
-- Everything else (has_light, light_shape, light_radius, light_cone_width,
-- reorder, lock, visibility, remove, resize, ...) still requires master.

CREATE OR REPLACE FUNCTION public.owns_linked_board_object(_object_id UUID, _user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.board_objects bo
    JOIN public.characters c ON c.id = bo.character_id
    WHERE bo.id = _object_id
      AND bo.locked = false
      AND c.owner_id = _user_id
      AND public.is_campaign_member(bo.campaign_id, _user_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.move_own_token(_object_id UUID, _x DOUBLE PRECISION, _y DOUBLE PRECISION)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _caller UUID := auth.uid();
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.owns_linked_board_object(_object_id, _caller) THEN
    RAISE EXCEPTION 'Not your token, or it is locked' USING ERRCODE = '42501';
  END IF;

  UPDATE public.board_objects SET x = _x, y = _y WHERE id = _object_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.rotate_own_light(_object_id UUID, _angle DOUBLE PRECISION)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _caller UUID := auth.uid();
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.owns_linked_board_object(_object_id, _caller) THEN
    RAISE EXCEPTION 'Not your token, or it is locked' USING ERRCODE = '42501';
  END IF;

  UPDATE public.board_objects SET light_angle = _angle WHERE id = _object_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.owns_linked_board_object(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.move_own_token(UUID, DOUBLE PRECISION, DOUBLE PRECISION) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.rotate_own_light(UUID, DOUBLE PRECISION) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_own_token(UUID, DOUBLE PRECISION, DOUBLE PRECISION) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_own_light(UUID, DOUBLE PRECISION) TO authenticated;
