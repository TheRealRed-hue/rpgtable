// src/lib/character-sheet-types.ts
//
// A character's `sheet` is a freeform, ordered list of blocks. There is no
// shared template — each character (player-owned or NPC) carries its own
// layout. This file defines the block "palette" and shared helpers used by
// both the sheet editor and the compact board preview.

export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "resource"
  | "checkbox"
  | "select"
  | "list"
  | "dice"
  | "image"
  | "section";

interface BaseField {
  id: string; // stable id, referenced by dice formulas as {id}
  type: FieldType;
  label: string;
}

export interface TextField extends BaseField {
  type: "text" | "textarea";
  value: string;
}

export interface NumberField extends BaseField {
  type: "number";
  value: number;
}

export interface ResourceField extends BaseField {
  type: "resource"; // e.g. HP, mana, sanity — current/max bar
  value: number;
  max: number;
}

export interface CheckboxField extends BaseField {
  type: "checkbox";
  value: boolean;
}

export interface SelectField extends BaseField {
  type: "select";
  value: string;
  options: string[];
}

export interface ListField extends BaseField {
  type: "list"; // repeatable rows — inventory, spells, attacks...
  items: string[];
}

export interface DiceField extends BaseField {
  type: "dice";
  formula: string; // e.g. "1d20+{forca}" — {id} interpolates other field values
}

export interface ImageField extends BaseField {
  type: "image";
  storagePath: string | null;
}

export interface SectionField extends BaseField {
  type: "section"; // visual divider only, no value
}

export type SheetField =
  | TextField
  | NumberField
  | ResourceField
  | CheckboxField
  | SelectField
  | ListField
  | DiceField
  | ImageField
  | SectionField;

// ---- Tabs (categories) ----
// A character's `sheet` column is an array of tabs, each holding its own
// fields — e.g. "Atributos", "Inventário", "Magias". Sheets created before
// tabs existed stored a flat SheetField[] instead; normalizeSheet() below
// upgrades that shape on read so old characters keep working untouched.

export interface SheetTab {
  id: string;
  name: string;
  fields: SheetField[];
}

export function makeTab(name: string, id: string): SheetTab {
  return { id, name, fields: [] };
}

/** Accepts either the current `SheetTab[]` shape or a legacy flat
 * `SheetField[]`, and always returns at least one tab. */
export function normalizeSheet(raw: unknown): SheetTab[] {
  const arr = Array.isArray(raw) ? raw : [];
  if (arr.length === 0) return [makeTab("Geral", "geral")];
  const looksLikeTabs = "fields" in (arr[0] as object) && "name" in (arr[0] as object);
  if (looksLikeTabs) return arr as SheetTab[];
  // legacy: arr is actually SheetField[]
  return [{ id: "geral", name: "Geral", fields: arr as SheetField[] }];
}

export const FIELD_PALETTE: { type: FieldType; label: string; icon: string }[] = [
  { type: "text", label: "Texto curto", icon: "❦" },
  { type: "textarea", label: "Texto longo", icon: "❧" },
  { type: "number", label: "Atributo (número)", icon: "✦" },
  { type: "resource", label: "Recurso (barra atual/máx.)", icon: "❈" },
  { type: "checkbox", label: "Marcador", icon: "☑" },
  { type: "select", label: "Lista de opções", icon: "▾" },
  { type: "list", label: "Lista repetível", icon: "❁" },
  { type: "dice", label: "Rolagem de dado", icon: "⚄" },
  { type: "image", label: "Imagem", icon: "◈" },
  { type: "section", label: "Divisor de seção", icon: "—" },
];

export function makeField(type: FieldType, id: string): SheetField {
  const label = FIELD_PALETTE.find((f) => f.type === type)?.label ?? "Campo";
  switch (type) {
    case "text":
    case "textarea":
      return { id, type, label, value: "" };
    case "number":
      return { id, type, label, value: 0 };
    case "resource":
      return { id, type, label, value: 10, max: 10 };
    case "checkbox":
      return { id, type, label, value: false };
    case "select":
      return { id, type, label, value: "", options: [] };
    case "list":
      return { id, type, label, items: [] };
    case "dice":
      return { id, type, label, formula: "1d20" };
    case "image":
      return { id, type, label, storagePath: null };
    case "section":
      return { id, type, label };
  }
}

// ---- Dice rolling ----

export interface DiceBreakdownPart {
  die?: string; // e.g. "d20"
  rolls?: number[];
  mod?: number;
}

export interface RollResult {
  formula: string;
  total: number;
  breakdown: DiceBreakdownPart[];
}

/**
 * Resolves {field_id} references in a formula against the character's
 * current field values, then rolls it. Supports forms like:
 *   "1d20+5", "2d6+{forca}", "{destreza}+1d8-1"
 */
export function rollFormula(formula: string, fields: SheetField[]): RollResult {
  const resolved = formula.replace(/\{(\w+)\}/g, (_, id) => {
    const field = fields.find((f) => f.id === id);
    if (field && (field.type === "number" || field.type === "resource")) {
      return String(field.value);
    }
    return "0";
  });

  const tokens = resolved.match(/([+-]?\s*\d*d\d+|[+-]?\s*\d+)/g) ?? [];
  const breakdown: DiceBreakdownPart[] = [];
  let total = 0;

  for (const raw of tokens) {
    const token = raw.replace(/\s+/g, "");
    const sign = token.startsWith("-") ? -1 : 1;
    const clean = token.replace(/^[+-]/, "");

    if (clean.includes("d")) {
      const [countStr, sidesStr] = clean.split("d");
      const count = countStr ? parseInt(countStr, 10) : 1;
      const sides = parseInt(sidesStr, 10);
      const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
      const sum = rolls.reduce((a, b) => a + b, 0) * sign;
      total += sum;
      breakdown.push({ die: `d${sides}`, rolls: sign === -1 ? rolls.map((r) => -r) : rolls });
    } else {
      const mod = parseInt(clean, 10) * sign;
      total += mod;
      breakdown.push({ mod });
    }
  }

  return { formula, total, breakdown };
}
