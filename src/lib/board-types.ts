import type { Database } from "@/integrations/supabase/types";

export type Campaign = Database["public"]["Tables"]["campaigns"]["Row"];
export type Folder = Database["public"]["Tables"]["folders"]["Row"];
export type FileRow = Database["public"]["Tables"]["files"]["Row"];
export type BoardObject = Database["public"]["Tables"]["board_objects"]["Row"];
export type BoardKind = Database["public"]["Enums"]["board_object_kind"];
export type FileKind = Database["public"]["Enums"]["file_kind"];
export type Character = Database["public"]["Tables"]["characters"]["Row"];
export type DiceRoll = Database["public"]["Tables"]["dice_rolls"]["Row"];
export type CampaignPage = Database["public"]["Tables"]["campaign_pages"]["Row"];

// ---------- Grimório (campaign_pages.blocks) ----------
// Deliberately a flat list of typed blocks (no nested arrays) so the editor
// stays simple: every list item is its own block, reordered/added/removed
// exactly like a paragraph would be. This mirrors the "Notion-lite" model
// most people already have muscle memory for.
export type PageBlockType =
  | "heading1"
  | "heading2"
  | "paragraph"
  | "bulleted_list"
  | "numbered_list"
  | "quote"
  | "divider";

export interface PageBlock {
  id: string;
  type: PageBlockType;
  /** Unused (and omitted) for "divider", which is just a visual rule. */
  text?: string;
}

export const PAGE_BLOCK_LABELS: Record<PageBlockType, string> = {
  heading1: "Título grande",
  heading2: "Título",
  paragraph: "Parágrafo",
  bulleted_list: "Lista",
  numbered_list: "Lista numerada",
  quote: "Citação",
  divider: "Divisória",
};

export const PAGE_ICONS: Record<string, string> = {
  scroll: "❦",
  book: "❧",
  crown: "♛",
  sword: "⚔",
  shield: "◈",
  star: "✦",
  flame: "❈",
  hex: "⌬",
};


export const FOLDER_ICONS: Record<string, string> = {
  moon: "☽",
  sun: "☉",
  star: "✦",
  crown: "♛",
  sword: "⚔",
  eye: "◉",
  key: "⚷",
  scroll: "❦",
  flame: "❈",
  hex: "⌬",
  mercury: "☿",
  saturn: "♄",
  diamond: "◈",
  ankh: "☥",
};

export const FILE_ICONS: Record<string, string> = {
  scroll: "❦",
  book: "❧",
  map: "✧",
  potion: "❁",
  shield: "◈",
  crystal: "◇",
};

// ---------- Skill Tree ("Sistema") ----------
// Free-canvas talent constellation: the master places nodes anywhere and
// wires them together by hand (no computed layout, no tiers). An edge IS
// the prerequisite — a node lights up once it or a connected node is
// unlocked. See supabase/migrations/20260720120000_skill_trees.sql.
export type SkillTree = Database["public"]["Tables"]["skill_trees"]["Row"];
export type SkillNode = Database["public"]["Tables"]["skill_nodes"]["Row"];
export type SkillEdge = Database["public"]["Tables"]["skill_edges"]["Row"];
export type CharacterSkillUnlock =
  Database["public"]["Tables"]["character_skill_unlocks"]["Row"];

export type SkillNodeColor = "gold" | "blue" | "green" | "purple" | "red";

export const SKILL_NODE_COLORS: Record<SkillNodeColor, { glow: string; label: string }> = {
  gold: { glow: "#e8c766", label: "Dourado" },
  blue: { glow: "#6ec3e0", label: "Azul" },
  green: { glow: "#7fd394", label: "Verde" },
  purple: { glow: "#b48ee0", label: "Roxo" },
  red: { glow: "#e08a7d", label: "Vermelho" },
};

/** Effect payload written by the master, shown verbatim on the sheet — the
 * app never interprets it, since every table's rules differ. */
export interface SkillNodeEffect {
  text?: string;
}
