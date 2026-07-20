-- ============================================================
-- SKILL TREE ("Sistema") — free-canvas talent constellation
-- ============================================================
-- Design notes:
--  * Deliberately separate from campaign_pages (Grimório Book). The Book is
--    editorial content the master writes and publishes for players to read;
--    the Skill Tree is a mechanical system the master configures and players
--    interact with through their character sheet. Different authoring model,
--    different visibility model — they don't share a table.
--  * Node position is free-form (x, y as floats), not computed from tiers —
--    the master arranges the constellation however they like (see reference:
--    Path-of-Exile-style node graph, not an org-chart tree).
--  * An edge between two nodes IS the prerequisite relationship: a node can
--    be unlocked once at least one connected, already-unlocked node exists
--    (root nodes have no incoming requirement and are always unlockable).
--  * "effect" is intentionally a freeform jsonb blob, not a fixed schema —
--    every table's house rules are different, so this app doesn't try to
--    model a generic rules engine. The master writes what the node grants;
--    it's surfaced on the character sheet as plain text/data, not executed.

-- ============ SKILL TREES ============
CREATE TABLE public.skill_trees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Árvore de habilidades',
  description TEXT,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX skill_trees_campaign_idx ON public.skill_trees(campaign_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.skill_trees TO authenticated;
GRANT ALL ON public.skill_trees TO service_role;
ALTER TABLE public.skill_trees ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER skill_trees_touch BEFORE UPDATE ON public.skill_trees
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE POLICY "skill_trees_master_all" ON public.skill_trees
  FOR ALL TO authenticated
  USING (public.is_campaign_master(campaign_id, auth.uid()))
  WITH CHECK (public.is_campaign_master(campaign_id, auth.uid()));

-- Players just need to see the constellation exists to view it — the tree
-- itself has no "published" gate the way pages do; it's always live once
-- the master has started building it.
CREATE POLICY "skill_trees_player_select" ON public.skill_trees
  FOR SELECT TO authenticated
  USING (public.is_campaign_member(campaign_id, auth.uid()));

-- ============ SKILL NODES ============
CREATE TABLE public.skill_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tree_id UUID NOT NULL REFERENCES public.skill_trees(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Novo nó',
  description TEXT,
  cost INTEGER NOT NULL DEFAULT 1 CHECK (cost >= 0),
  color TEXT NOT NULL DEFAULT 'gold', -- gold | blue | green | purple | red — glow tint
  -- Freeform grant text/data shown on the sheet once unlocked, e.g.
  -- {"text": "+2 em testes de Furtividade"} — never interpreted by the app.
  effect JSONB NOT NULL DEFAULT '{}'::jsonb,
  x DOUBLE PRECISION NOT NULL DEFAULT 0,
  y DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX skill_nodes_tree_idx ON public.skill_nodes(tree_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.skill_nodes TO authenticated;
GRANT ALL ON public.skill_nodes TO service_role;
ALTER TABLE public.skill_nodes ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER skill_nodes_touch BEFORE UPDATE ON public.skill_nodes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE POLICY "skill_nodes_master_all" ON public.skill_nodes
  FOR ALL TO authenticated
  USING (
    public.is_campaign_master(
      (SELECT campaign_id FROM public.skill_trees st WHERE st.id = tree_id), auth.uid()
    )
  )
  WITH CHECK (
    public.is_campaign_master(
      (SELECT campaign_id FROM public.skill_trees st WHERE st.id = tree_id), auth.uid()
    )
  );

CREATE POLICY "skill_nodes_player_select" ON public.skill_nodes
  FOR SELECT TO authenticated
  USING (
    public.is_campaign_member(
      (SELECT campaign_id FROM public.skill_trees st WHERE st.id = tree_id), auth.uid()
    )
  );

-- ============ SKILL EDGES (connections = prerequisites) ============
CREATE TABLE public.skill_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tree_id UUID NOT NULL REFERENCES public.skill_trees(id) ON DELETE CASCADE,
  from_node_id UUID NOT NULL REFERENCES public.skill_nodes(id) ON DELETE CASCADE,
  to_node_id UUID NOT NULL REFERENCES public.skill_nodes(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT skill_edges_no_self_link CHECK (from_node_id <> to_node_id),
  CONSTRAINT skill_edges_unique UNIQUE (tree_id, from_node_id, to_node_id)
);
CREATE INDEX skill_edges_tree_idx ON public.skill_edges(tree_id);
CREATE INDEX skill_edges_from_idx ON public.skill_edges(from_node_id);
CREATE INDEX skill_edges_to_idx ON public.skill_edges(to_node_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.skill_edges TO authenticated;
GRANT ALL ON public.skill_edges TO service_role;
ALTER TABLE public.skill_edges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "skill_edges_master_all" ON public.skill_edges
  FOR ALL TO authenticated
  USING (
    public.is_campaign_master(
      (SELECT campaign_id FROM public.skill_trees st WHERE st.id = tree_id), auth.uid()
    )
  )
  WITH CHECK (
    public.is_campaign_master(
      (SELECT campaign_id FROM public.skill_trees st WHERE st.id = tree_id), auth.uid()
    )
  );

CREATE POLICY "skill_edges_player_select" ON public.skill_edges
  FOR SELECT TO authenticated
  USING (
    public.is_campaign_member(
      (SELECT campaign_id FROM public.skill_trees st WHERE st.id = tree_id), auth.uid()
    )
  );

-- ============ CHARACTER PROGRESS ============
-- Skill points are a per-character resource, same spirit as HP/mana on the
-- sheet, but kept as a real column (not a sheet block) since it's read and
-- written by the unlock RPC below, not by the freeform sheet editor.
ALTER TABLE public.characters
  ADD COLUMN skill_points_available INTEGER NOT NULL DEFAULT 0 CHECK (skill_points_available >= 0);

CREATE TABLE public.character_skill_unlocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id UUID NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  node_id UUID NOT NULL REFERENCES public.skill_nodes(id) ON DELETE CASCADE,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT character_skill_unlocks_unique UNIQUE (character_id, node_id)
);
CREATE INDEX character_skill_unlocks_character_idx ON public.character_skill_unlocks(character_id);
CREATE INDEX character_skill_unlocks_node_idx ON public.character_skill_unlocks(node_id);
GRANT SELECT ON public.character_skill_unlocks TO authenticated;
GRANT ALL ON public.character_skill_unlocks TO service_role;
ALTER TABLE public.character_skill_unlocks ENABLE ROW LEVEL SECURITY;

-- Read-only from the client. Rows are only ever written by unlock_skill_node()
-- (owner-driven) or reverted by the master via revert_skill_node() below —
-- both SECURITY DEFINER — so "can this character see this node lit up" and
-- "can this node actually be unlocked" always agree with each other.
CREATE POLICY "character_skill_unlocks_select" ON public.character_skill_unlocks
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.characters c
      WHERE c.id = character_id
        AND (c.owner_id = auth.uid() OR public.is_campaign_master(c.campaign_id, auth.uid()))
    )
  );

-- ============ UNLOCK RPC ============
-- Single entry point for "spend points, light up a node": validates
-- ownership, prerequisites (root node, or at least one connected node
-- already unlocked) and cost/points atomically, so the client never has to
-- (and never can) fake an unlock by inserting directly.
CREATE OR REPLACE FUNCTION public.unlock_skill_node(_character_id UUID, _node_id UUID)
RETURNS public.character_skill_unlocks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller UUID := auth.uid();
  _char public.characters;
  _node public.skill_nodes;
  _has_prereq BOOLEAN;
  _row public.character_skill_unlocks;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _char FROM public.characters WHERE id = _character_id;
  IF _char IS NULL THEN
    RAISE EXCEPTION 'Character not found' USING ERRCODE = 'P0002';
  END IF;
  IF _char.owner_id <> _caller THEN
    RAISE EXCEPTION 'Not your character' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _node FROM public.skill_nodes WHERE id = _node_id;
  IF _node IS NULL THEN
    RAISE EXCEPTION 'Node not found' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.character_skill_unlocks
    WHERE character_id = _character_id AND node_id = _node_id
  ) THEN
    RAISE EXCEPTION 'Node already unlocked' USING ERRCODE = '23505';
  END IF;

  -- Root nodes (no edges pointing at them) are always unlockable. Otherwise
  -- at least one side of some connected edge must already be lit.
  SELECT NOT EXISTS (SELECT 1 FROM public.skill_edges WHERE to_node_id = _node_id)
      OR EXISTS (
        SELECT 1 FROM public.skill_edges e
        JOIN public.character_skill_unlocks u
          ON u.node_id = e.from_node_id AND u.character_id = _character_id
        WHERE e.to_node_id = _node_id
      )
    INTO _has_prereq;

  IF NOT _has_prereq THEN
    RAISE EXCEPTION 'Prerequisites not met' USING ERRCODE = '55000';
  END IF;

  IF _char.skill_points_available < _node.cost THEN
    RAISE EXCEPTION 'Not enough skill points' USING ERRCODE = '55000';
  END IF;

  UPDATE public.characters
    SET skill_points_available = skill_points_available - _node.cost
    WHERE id = _character_id;

  INSERT INTO public.character_skill_unlocks (character_id, node_id)
  VALUES (_character_id, _node_id)
  RETURNING * INTO _row;

  RETURN _row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.unlock_skill_node(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unlock_skill_node(UUID, UUID) TO authenticated;

-- ============ REVERT RPC (master-only "undo") ============
-- Lets the master walk back a mistaken unlock during a session — refunds
-- the points rather than leaving the character short-changed.
CREATE OR REPLACE FUNCTION public.revert_skill_node(_character_id UUID, _node_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller UUID := auth.uid();
  _char public.characters;
  _node public.skill_nodes;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _char FROM public.characters WHERE id = _character_id;
  IF _char IS NULL OR NOT public.is_campaign_master(_char.campaign_id, _caller) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _node FROM public.skill_nodes WHERE id = _node_id;

  DELETE FROM public.character_skill_unlocks
  WHERE character_id = _character_id AND node_id = _node_id;

  IF FOUND AND _node IS NOT NULL THEN
    UPDATE public.characters
      SET skill_points_available = skill_points_available + _node.cost
      WHERE id = _character_id;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revert_skill_node(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revert_skill_node(UUID, UUID) TO authenticated;
