-- ============================================================
-- DAY / NIGHT TOGGLE
-- ============================================================
-- Dynamic lighting (the darkness overlay + hidden_when_dark fog-of-war)
-- was always on for every non-master viewer, with no way to turn it off
-- for scenes that don't need it (a daytime tavern scene, a fully-lit
-- dungeon room already explored, etc). This is a per-campaign switch,
-- same shape as `theme`: the master flips it, every player's view follows
-- via the existing campaigns UPDATE realtime subscription — no new
-- subscription needed.
--
-- true  (default, matches current behavior) — darkness + fog-of-war active.
-- false — "day mode": no darkness overlay, hidden_when_dark objects are
--          shown to everyone regardless of light.

ALTER TABLE public.campaigns
  ADD COLUMN dynamic_lighting BOOLEAN NOT NULL DEFAULT true;
