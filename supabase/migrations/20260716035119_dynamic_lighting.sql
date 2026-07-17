-- ============================================================
-- DYNAMIC LIGHT / VISION (fog of war)
-- ============================================================
-- Two independent flags per board object:
--   has_light          — this object casts light in a radius around itself.
--   hidden_when_dark    — this object is only rendered at all when it falls
--                          inside SOME object's light radius; otherwise it's
--                          fully invisible to non-master viewers. Objects
--                          without this flag (e.g. the map background) stay
--                          visible everywhere but get visually darkened by
--                          the ambient light overlay instead of hidden.
-- Both are evaluated live from current positions (dynamic, not "fog memory"
-- — moving away from a light re-hides/re-darkens the area immediately).

ALTER TABLE public.board_objects
  ADD COLUMN has_light BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN light_radius NUMERIC NOT NULL DEFAULT 300,
  ADD COLUMN hidden_when_dark BOOLEAN NOT NULL DEFAULT false;
