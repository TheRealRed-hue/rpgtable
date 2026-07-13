import type { Database } from "@/integrations/supabase/types";

export type Campaign = Database["public"]["Tables"]["campaigns"]["Row"];
export type Folder = Database["public"]["Tables"]["folders"]["Row"];
export type FileRow = Database["public"]["Tables"]["files"]["Row"];
export type BoardObject = Database["public"]["Tables"]["board_objects"]["Row"];
export type BoardKind = Database["public"]["Enums"]["board_object_kind"];
export type FileKind = Database["public"]["Enums"]["file_kind"];

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
