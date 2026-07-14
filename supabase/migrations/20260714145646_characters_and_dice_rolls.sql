-- ============================================================
-- CHARACTER SHEETS (fully custom, per-character) + DICE HISTORY
-- ============================================================
-- Design notes:
--  * There is no shared "template" table. Each character carries its own
--    field layout AND values together in `sheet` (jsonb array of blocks).
--    This is what makes it "totalmente customizado": a player designs
--    their own sheet, the master designs NPC sheets independently.
--  * `board_objects.kind = 'sheet'` will reference a character via the
--    new `character_id` column instead of `file_id` (see bottom of file).
--  * `dice_rolls` is a campaign-wide realtime log, optionally linked to
--    the character/field that triggered the roll.

-- ============ CHARACTERS ============
CREATE TABLE public.characters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Novo personagem',
  portrait_path TEXT,
  -- sheet: ordered array of field blocks, e.g.
  -- [{"id":"f1","type":"number","label":"Força","value":10},
  --  {"id":"f2","type":"resource","label":"HP","value":18,"max":18},
  --  {"id":"f3","type":"dice","label":"Ataque","formula":"1d20+{f1}"},
  --  {"id":"f4","type":"list","label":"Inventário","items":["Espada","Corda"]}]
  sheet JSONB NOT NULL DEFAULT '[]'::jsonb,
  visible_to_players BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX characters_campaign_idx ON public.characters(campaign_id);
CREATE INDEX characters_owner_idx ON public.characters(owner_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.characters TO authenticated;
GRANT ALL ON public.characters TO service_role;
ALTER TABLE public.characters ENABLE ROW LEVEL SECURITY;

-- Members see their own characters + any visible-to-players ones;
-- the master sees everything (including hidden NPC sheets).
CREATE POLICY "characters_select" ON public.characters
  FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR public.is_campaign_master(campaign_id, auth.uid())
    OR (public.is_campaign_member(campaign_id, auth.uid()) AND visible_to_players = true)
  );

-- Any campaign member can create a character for themselves.
-- The master may create characters for anyone (e.g. quick NPCs).
CREATE POLICY "characters_insert" ON public.characters
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_campaign_member(campaign_id, auth.uid())
    AND (owner_id = auth.uid() OR public.is_campaign_master(campaign_id, auth.uid()))
  );

-- Owner edits their own sheet freely; master edits any sheet in the campaign.
CREATE POLICY "characters_update" ON public.characters
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() OR public.is_campaign_master(campaign_id, auth.uid()))
  WITH CHECK (owner_id = auth.uid() OR public.is_campaign_master(campaign_id, auth.uid()));

CREATE POLICY "characters_delete" ON public.characters
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid() OR public.is_campaign_master(campaign_id, auth.uid()));

CREATE TRIGGER characters_touch BEFORE UPDATE ON public.characters
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============ DICE ROLLS (history) ============
CREATE TABLE public.dice_rolls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  roller_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  character_id UUID REFERENCES public.characters(id) ON DELETE SET NULL,
  label TEXT,                 -- e.g. "Ataque", "Teste de Furtividade"
  formula TEXT NOT NULL,      -- e.g. "1d20+5"
  total INTEGER NOT NULL,
  breakdown JSONB NOT NULL DEFAULT '[]'::jsonb, -- e.g. [{"die":"d20","rolls":[14]},{"mod":5}]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dice_rolls_campaign_idx ON public.dice_rolls(campaign_id, created_at DESC);
GRANT SELECT, INSERT ON public.dice_rolls TO authenticated;
GRANT ALL ON public.dice_rolls TO service_role;
ALTER TABLE public.dice_rolls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dice_rolls_select" ON public.dice_rolls
  FOR SELECT TO authenticated
  USING (public.is_campaign_member(campaign_id, auth.uid()));

CREATE POLICY "dice_rolls_insert" ON public.dice_rolls
  FOR INSERT TO authenticated
  WITH CHECK (public.is_campaign_member(campaign_id, auth.uid()) AND roller_id = auth.uid());

-- Rolls are an immutable log: no update/delete policy on purpose.

-- ============ REALTIME ============
ALTER PUBLICATION supabase_realtime ADD TABLE public.characters;
ALTER PUBLICATION supabase_realtime ADD TABLE public.dice_rolls;
ALTER TABLE public.characters REPLICA IDENTITY FULL;
ALTER TABLE public.dice_rolls REPLICA IDENTITY FULL;

-- ============ BOARD INTEGRATION ============
-- board_objects.kind = 'sheet' will point at a character instead of a file.
ALTER TABLE public.board_objects
  ADD COLUMN character_id UUID REFERENCES public.characters(id) ON DELETE SET NULL;
CREATE INDEX board_objects_character_idx ON public.board_objects(character_id);
