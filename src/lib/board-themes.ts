// src/lib/board-themes.ts
//
import type { CSSProperties } from "react";
// Presets for the visual look of the table itself (background, accent
// color, ambient lighting). Applied as a CSS custom-property override on
// the board's container — everything inside (cards, tokens, controls)
// already reads color via var(--color-*) chains that resolve to these
// tokens, so overriding them here re-themes the table without touching
// the app chrome (sidebar, headers) elsewhere.

export interface BoardTheme {
  id: string;
  name: string;
  /** Small CSS gradient used as a preview swatch in the picker. */
  swatch: string;
  vars: {
    ink: string;
    ink2: string;
    gold: string;
    wax: string;
  };
  /** Faint accent dot color for the tabletop's dot-grid pattern. */
  dot: string;
  /** Ambient lighting overlay — a radial gradient laid over the whole table. */
  vignette: string;
}

export const BOARD_THEMES: BoardTheme[] = [
  {
    id: "padrao",
    name: "Grimório",
    swatch: "linear-gradient(135deg, oklch(0.16 0.012 60), oklch(0.72 0.11 78))",
    vars: {
      ink: "oklch(0.16 0.012 60)",
      ink2: "oklch(0.22 0.015 60)",
      gold: "oklch(0.72 0.11 78)",
      wax: "oklch(0.38 0.13 32)",
    },
    dot: "oklch(0.72 0.11 78 / 0.06)",
    vignette:
      "radial-gradient(ellipse at 50% 40%, transparent 45%, oklch(0.16 0.012 60 / 0.55) 100%)",
  },
  {
    id: "masmorra",
    name: "Masmorra",
    swatch: "linear-gradient(135deg, oklch(0.14 0.01 240), oklch(0.62 0.12 55))",
    vars: {
      ink: "oklch(0.14 0.008 240)",
      ink2: "oklch(0.19 0.012 235)",
      gold: "oklch(0.62 0.12 55)",
      wax: "oklch(0.32 0.1 25)",
    },
    dot: "oklch(0.62 0.12 55 / 0.07)",
    vignette:
      "radial-gradient(ellipse at 50% 35%, transparent 35%, oklch(0.1 0.01 240 / 0.7) 100%)",
  },
  {
    id: "floresta",
    name: "Floresta",
    swatch: "linear-gradient(135deg, oklch(0.18 0.03 150), oklch(0.74 0.1 95))",
    vars: {
      ink: "oklch(0.17 0.025 150)",
      ink2: "oklch(0.23 0.03 148)",
      gold: "oklch(0.74 0.1 95)",
      wax: "oklch(0.35 0.11 140)",
    },
    dot: "oklch(0.74 0.1 95 / 0.07)",
    vignette:
      "radial-gradient(ellipse at 50% 40%, transparent 45%, oklch(0.15 0.03 150 / 0.5) 100%)",
  },
  {
    id: "taverna",
    name: "Taverna",
    swatch: "linear-gradient(135deg, oklch(0.2 0.03 40), oklch(0.78 0.14 70))",
    vars: {
      ink: "oklch(0.19 0.025 40)",
      ink2: "oklch(0.25 0.03 42)",
      gold: "oklch(0.78 0.14 70)",
      wax: "oklch(0.4 0.14 35)",
    },
    dot: "oklch(0.78 0.14 70 / 0.08)",
    vignette:
      "radial-gradient(ellipse at 50% 45%, transparent 40%, oklch(0.18 0.03 40 / 0.5) 100%)",
  },
];

export function getBoardTheme(id: string | null | undefined): BoardTheme {
  return BOARD_THEMES.find((t) => t.id === id) ?? BOARD_THEMES[0];
}

/** CSS custom properties to apply on the board container's inline style. */
export function themeCssVars(theme: BoardTheme): CSSProperties {
  return {
    ["--ink" as string]: theme.vars.ink,
    ["--ink-2" as string]: theme.vars.ink2,
    ["--gold" as string]: theme.vars.gold,
    ["--wax" as string]: theme.vars.wax,
  };
}
