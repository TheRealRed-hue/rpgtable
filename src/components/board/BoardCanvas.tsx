import { useEffect, useRef, useState, useCallback, useMemo, memo } from "react";
import { AOE_COLORS, DEFAULT_AOE_COLOR, type BoardObject, type Character, type FileRow } from "@/lib/board-types";
import { normalizeSheet, type NumberField, type ResourceField } from "@/lib/character-sheet-types";
import { getBoardTheme, themeCssVars } from "@/lib/board-themes";
import { supabase } from "@/integrations/supabase/client";
import {
  Lock,
  Unlock,
  Eye,
  EyeOff,
  X,
  Move,
  ChevronsUp,
  ChevronsDown,
  Grid3x3,
  Flame,
  Ghost,
  Pencil,
  Check,
  UserRound,
  Sun,
  Moon,
  Copy,
  Sparkles,
  Circle,
  Triangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";

interface Props {
  objects: BoardObject[];
  isMaster: boolean;
  /** Logged-in viewer's user id. Lets a player move/rotate the one pin
   * linked to a character they own, even though they aren't the master. */
  currentUserId?: string | null;
  onDropFromSidebar: (fileId: string, worldX: number, worldY: number) => void;
  /**
   * Called with the settled (x, y) whenever an object finishes moving —
   * either via mouse drag or keyboard nudge. The campaign page uses this to
   * patch the React Query cache optimistically, so a re-render that happens
   * while the network request to Supabase is still in flight doesn't cause
   * the object to visibly jump back to its old position before Realtime
   * confirms the update.
   */
  onObjectMove?: (id: string, x: number, y: number) => void;
  /** Same idea as onObjectMove, but for width/height after a corner-handle resize. */
  onObjectResize?: (id: string, width: number, height: number) => void;
  characters?: Character[];
  /** Campaign's archived files — used by the pin properties panel to let
   * the master pick an already-uploaded gallery image for a pin's portrait,
   * as an alternative to linking a character or pasting an external URL. */
  files?: FileRow[];
  onDropCharacterFromSidebar?: (characterId: string, worldX: number, worldY: number) => void;
  onOpenCharacter?: (character: Character) => void;
  /** Effective preset id for this viewer — the player's personal override
   * if they have one, otherwise the campaign's default. */
  themeId?: string;
  /**
   * Reorder/lock/visibility/delete used to be done as raw Supabase calls
   * right here with no cache patch, so the change only showed up once
   * Realtime looped back — these callbacks let the campaign page do the
   * write AND patch the cache immediately, the same pattern as
   * onObjectMove/onObjectResize above.
   */
  onReorder?: (obj: BoardObject, dir: "front" | "back") => void;
  onToggleLock?: (obj: BoardObject) => void;
  onToggleVisibility?: (obj: BoardObject) => void;
  onRemoveObject?: (obj: BoardObject) => void;
  onEditDocument?: (obj: BoardObject, content: string) => void;
  onLinkCharacter?: (obj: BoardObject, characterId: string | null) => void;
  onSetLight?: (
    obj: BoardObject,
    patch: Partial<Pick<
      BoardObject,
      "has_light" | "light_radius" | "hidden_when_dark" | "light_shape" | "light_angle" | "light_cone_width"
    >>,
  ) => void;
  /** Merges into an AoE marker's `data` (currently just `{ color }`) — kept
   * separate from onSetLight since it writes a JSONB column, not the
   * light_* columns the two share for shape/radius/angle. */
  onSetAoeData?: (obj: BoardObject, patch: { color?: string }) => void;
  /** Cache-only patch for a player rotating their own token's cone — the
   * actual write goes through the rotate_own_light RPC (see startObjRotate),
   * this just keeps the UI from flashing back before Realtime confirms it. */
  onRotateOwnLight?: (id: string, angle: number) => void;
  /** Campaign-wide day/night switch (campaigns.dynamic_lighting). true (the
   * default) keeps the existing darkness overlay + hidden_when_dark
   * fog-of-war active for non-master viewers; false ("day mode") shows
   * everything to everyone regardless of light. Defaults to true so a
   * campaign that predates this column behaves exactly as before. */
  dynamicLighting?: boolean;
  /** Master-only toggle for dynamicLighting — omitted entirely for players. */
  onToggleDynamicLighting?: () => void;
  /** Currently selected object id — controlled so the "Camadas" panel and
   * the canvas can share/reflect the same selection either way. */
  selectedId?: string | null;
  onSelectedIdChange?: (id: string | null) => void;
  /** Bumped (new id+nonce) whenever the "Camadas" panel selects an object —
   * BoardCanvas reacts by selecting it here too and panning it into view. */
  focusRequest?: { id: string; nonce: number } | null;
  /** Free-form property edit (label, etc.) from the double-click properties
   * panel — patches whatever fields are given. */
  onUpdateObject?: (obj: BoardObject, patch: Partial<BoardObject>) => void;
  /** Creates a copy of the object (same properties, slightly offset) from
   * the double-click properties panel's "Duplicar" button. */
  onDuplicateObject?: (obj: BoardObject) => void;
}

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

const KEYBOARD_NUDGE_STEP = 10;
const KEYBOARD_NUDGE_STEP_LARGE = 40;

// Tactical movement grid — one square (slot) is defined as 1.5m, the
// standard combat-square size in systems like Ordem Paranormal. The value
// here is in world px at 100% zoom; it lives in world space (a child of
// worldLayerRef) so it pans/zooms in perfect sync with the objects sitting
// on top of it without any extra transform math.
const GRID_CELL_PX = 60;

const MIN_OBJECT_SIZE: Partial<Record<BoardObject["kind"], { width: number; height: number }>> = {
  pin: { width: 28, height: 28 },
  map: { width: 120, height: 120 },
  image: { width: 80, height: 80 },
  sheet: { width: 180, height: 100 },
  document: { width: 160, height: 120 },
};

export function BoardCanvas({
  objects,
  isMaster,
  currentUserId,
  onDropFromSidebar,
  onObjectMove,
  onObjectResize,
  characters = [],
  files = [],
  onDropCharacterFromSidebar,
  onOpenCharacter,
  themeId,
  onReorder,
  onToggleLock,
  onToggleVisibility,
  onRemoveObject,
  onEditDocument,
  onSetLight,
  onSetAoeData,
  onLinkCharacter,
  onRotateOwnLight,
  dynamicLighting = true,
  onToggleDynamicLighting,
  selectedId: selectedIdProp,
  onSelectedIdChange,
  focusRequest,
  onUpdateObject,
  onDuplicateObject,
}: Props) {
  const theme = getBoardTheme(themeId);
  // Canvas background (dot texture, and the tactical grid when shown) is
  // painted entirely with CSS backgroundImage/backgroundPosition/
  // backgroundSize on the root container instead of an absolutely-
  // positioned child sized to a fixed world-space box. A repeating CSS
  // pattern tiles forever no matter how far the viewport pans or zooms out
  // — the old grid div (a fixed 6000×6000 box centered on the origin) ran
  // out of squares once you scrolled past its edge, showing bare canvas
  // beyond it. Grid layers are appended before the dot layers (order must
  // match across backgroundImage/backgroundSize/backgroundPosition, which
  // are comma-separated per layer) so the two call sites below — the JSX
  // style prop and the direct DOM write during an active pan/pinch — always
  // agree on layer count.
  const getCanvasBackground = (v: Viewport, grid: boolean) => {
    const dotImages = [
      `radial-gradient(${theme.dot} 1px, transparent 1px)`,
      `radial-gradient(oklch(0.25 0.02 60) 1px, transparent 1px)`,
    ];
    const dotSizes = [`${40 * v.scale}px ${40 * v.scale}px`, `${8 * v.scale}px ${8 * v.scale}px`];
    const dotPosition = `${v.x}px ${v.y}px`;
    if (!grid) {
      return {
        backgroundImage: dotImages.join(", "),
        backgroundSize: dotSizes.join(", "),
        backgroundPosition: `${dotPosition}, ${dotPosition}`,
      };
    }
    const gridImages = [
      "linear-gradient(to right, oklch(0.72 0.11 78 / 0.22) 1px, transparent 1px)",
      "linear-gradient(to bottom, oklch(0.72 0.11 78 / 0.22) 1px, transparent 1px)",
    ];
    const gridSize = `${GRID_CELL_PX * v.scale}px ${GRID_CELL_PX * v.scale}px`;
    return {
      backgroundImage: [...gridImages, ...dotImages].join(", "),
      backgroundSize: [gridSize, gridSize, ...dotSizes].join(", "),
      backgroundPosition: [dotPosition, dotPosition, dotPosition, dotPosition].join(", "),
    };
  };
  const containerRef = useRef<HTMLDivElement>(null);
  const worldLayerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const [showGrid, setShowGrid] = useState(false);
  // Used only to size the darkness overlay below (so it always covers what's
  // actually on screen) — a generous default keeps the very first paint,
  // before the ResizeObserver reports real numbers, from under-covering.
  const [containerSize, setContainerSize] = useState({ width: 1600, height: 900 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [isPanning, setIsPanning] = useState(false);
  // Reorder/lock/visibility controls used to only reveal on :hover, which
  // has no touch equivalent — tapping an object now selects it and keeps
  // those controls visible until something else is tapped.
  // Controlled by the parent when selectedIdProp/onSelectedIdChange are
  // given (so the "Camadas" panel can share selection with the canvas),
  // otherwise falls back to purely-internal state.
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);
  const selectedId = selectedIdProp !== undefined ? selectedIdProp : internalSelectedId;
  const setSelectedId = onSelectedIdChange ?? setInternalSelectedId;
  // Bottom-toolbar "lock tool" (master only): while armed, clicking an
  // object toggles its lock instead of selecting it, so several objects can
  // be locked/unlocked in a row without opening each one's own toolbar.
  const [lockToolActive, setLockToolActive] = useState(false);
  useEffect(() => {
    if (!lockToolActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLockToolActive(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lockToolActive]);
  // Double-clicking a pin opens a side panel with its full properties
  // (label, size, character link, light, lock, visibility) instead of the
  // small floating toolbar — and the resize handle only shows up once this
  // is open, so a stray drag near a selected pin doesn't accidentally
  // resize it.
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => {
    if (editingId && !objects.some((o) => o.id === editingId)) setEditingId(null);
  }, [editingId, objects]);
  useEffect(() => {
    if (!editingId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditingId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingId]);
  const editingObj = editingId ? (objects.find((o) => o.id === editingId) ?? null) : null;
  const panStart = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  // Tracks every pointer currently down on the canvas background (by
  // pointerId), so we can tell a one-finger pan from a two-finger pinch —
  // Pointer Events unify mouse/touch/pen, which is what makes touch dragging
  // work the same as desktop without a separate code path.
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{
    initialDist: number;
    initialScale: number;
    /** World-space point under the pinch midpoint at gesture start — kept
     * fixed under the fingers as they move, same idea as the wheel-zoom
     * anchor below. */
    wx: number;
    wy: number;
  } | null>(null);

  const [dragObj, setDragObj] = useState<{
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const [resizeObj, setResizeObj] = useState<{
    id: string;
    kind: BoardObject["kind"];
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);

  // Cone direction is rotated by dragging its handle around the pin. Only
  // the center (screen coords, captured once at drag start) is needed —
  // the angle is just atan2 of the pointer relative to it, which is
  // unaffected by pan/zoom since those don't rotate the viewport.
  const [rotateObj, setRotateObj] = useState<{
    id: string;
    centerX: number;
    centerY: number;
  } | null>(null);

  // Pan (one finger/mouse) + pinch-zoom (two fingers) on canvas background
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).dataset.canvasBg !== "1" && e.button !== 1) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 2 && containerRef.current) {
      // Second finger just touched down — switch from pan to pinch-zoom.
      setIsPanning(false);
      panStart.current = null;
      const [p1, p2] = Array.from(pointersRef.current.values());
      const rect = containerRef.current.getBoundingClientRect();
      const midX = (p1.x + p2.x) / 2 - rect.left;
      const midY = (p1.y + p2.y) / 2 - rect.top;
      pinchRef.current = {
        initialDist: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1,
        initialScale: viewport.scale,
        wx: (midX - viewport.x) / viewport.scale,
        wy: (midY - viewport.y) / viewport.scale,
      };
    } else if (pointersRef.current.size === 1) {
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY, vx: viewport.x, vy: viewport.y };
    }
  };

  // Tracks the viewport during an active pan/pinch without touching React
  // state on every pointermove — same idea as the object-drag optimization
  // below. Writing transform/backgroundPosition straight to the DOM avoids
  // re-rendering every object on the board on every pixel of mouse movement,
  // which is what was making panning feel sluggish with several objects on
  // the scene. React state is only synced once, when the gesture ends.
  const pendingViewportRef = useRef<Viewport | null>(null);

  const applyViewportToDom = (v: Viewport) => {
    if (worldLayerRef.current) {
      worldLayerRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
    }
    if (containerRef.current) {
      const bg = getCanvasBackground(v, showGrid);
      containerRef.current.style.backgroundImage = bg.backgroundImage;
      containerRef.current.style.backgroundSize = bg.backgroundSize;
      containerRef.current.style.backgroundPosition = bg.backgroundPosition;
    }
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (pointersRef.current.has(e.pointerId)) {
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      if (pinchRef.current && pointersRef.current.size === 2 && containerRef.current) {
        const [p1, p2] = Array.from(pointersRef.current.values());
        const rect = containerRef.current.getBoundingClientRect();
        const midX = (p1.x + p2.x) / 2 - rect.left;
        const midY = (p1.y + p2.y) / 2 - rect.top;
        const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1;
        const { initialDist, initialScale, wx, wy } = pinchRef.current;
        const newScale = Math.max(0.25, Math.min(2.5, initialScale * (dist / initialDist)));
        const next = { x: midX - wx * newScale, y: midY - wy * newScale, scale: newScale };
        pendingViewportRef.current = next;
        applyViewportToDom(next);
        return;
      }

      const start = panStart.current;
      if (!isPanning || !start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      const next = { x: start.vx + dx, y: start.vy + dy, scale: viewport.scale };
      pendingViewportRef.current = next;
      applyViewportToDom(next);
    };
    const onUp = (e: PointerEvent) => {
      pointersRef.current.delete(e.pointerId);
      if (pointersRef.current.size < 2) pinchRef.current = null;
      if (pointersRef.current.size === 0) {
        setIsPanning(false);
        panStart.current = null;
      }
      // Commit the final position to React state exactly once — this is
      // what makes zoom buttons, reset-view, and everything else that reads
      // `viewport` from state see the up-to-date value after the gesture.
      if (pendingViewportRef.current) {
        setViewport(pendingViewportRef.current);
        pendingViewportRef.current = null;
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [isPanning, viewport.scale]);

  // Zoom with wheel. Attached natively with { passive: false } instead of
  // React's onWheel prop — React registers wheel listeners as passive by
  // default (for scroll performance), which silently blocks preventDefault
  // and spams "Unable to preventDefault inside passive event listener".
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      setViewport((v) => {
        const delta = -e.deltaY * 0.0015;
        const newScale = Math.max(0.25, Math.min(2.5, v.scale * (1 + delta)));
        // Keep the point under cursor fixed
        const wx = (mx - v.x) / v.scale;
        const wy = (my - v.y) / v.scale;
        return { x: mx - wx * newScale, y: my - wy * newScale, scale: newScale };
      });
    };
    node.addEventListener("wheel", handleWheel, { passive: false });
    return () => node.removeEventListener("wheel", handleWheel);
  }, []);

  // Whether this viewer may move/rotate a given object: the master can
  // touch anything, a player only the one pin linked to a character they
  // own — same rule ObjectViewImpl uses to decide whether to show the
  // move handle / cone-rotation handle in the first place.
  const canControlObject = useCallback(
    (obj: BoardObject) =>
      isMaster ||
      (!!currentUserId &&
        !!obj.character_id &&
        characters.find((c) => c.id === obj.character_id)?.owner_id === currentUserId),
    [isMaster, currentUserId, characters],
  );

  // Object drag
  const startObjDrag = useCallback(
    (obj: BoardObject, e: React.PointerEvent) => {
      if (!canControlObject(obj) || obj.locked) {
        return;
      }
      e.stopPropagation();
      setDragObj({
        id: obj.id,
        startX: e.clientX,
        startY: e.clientY,
        origX: obj.x,
        origY: obj.y,
      });
    },
    [canControlObject],
  );

  useEffect(() => {
    if (!dragObj) return;
    let latest: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - dragObj.startX) / viewport.scale;
      const dy = (e.clientY - dragObj.startY) / viewport.scale;
      latest = { x: dragObj.origX + dx, y: dragObj.origY + dy };
      // Direct DOM write during the drag itself — avoids a React re-render
      // (and the cost of re-sorting/re-rendering every object) on every
      // mousemove, which matters once a scene has many objects on it.
      const el = document.getElementById(`bo-${dragObj.id}`);
      if (el) {
        el.style.transform = `translate(${latest.x}px, ${latest.y}px) scale(1.03)`;
      }
    };
    const onUp = async () => {
      if (latest) {
        // Snap to the nearest grid intersection when the movement grid is
        // on, so a drag always lands cleanly on a slot instead of some
        // fractional pixel offset — that's what makes counting slots for
        // movement (1 slot = 1.5m) actually work.
        const { x, y } = showGrid
          ? {
              x: Math.round(latest.x / GRID_CELL_PX) * GRID_CELL_PX,
              y: Math.round(latest.y / GRID_CELL_PX) * GRID_CELL_PX,
            }
          : latest;
        // Optimistically patch the cache immediately so that if anything
        // else triggers a re-render before Supabase confirms the write, the
        // object doesn't flash back to its pre-drag position.
        onObjectMove?.(dragObj.id, x, y);
        // Master writes any object directly; a player moving their own
        // linked token goes through the RPC, since board_objects writes
        // are otherwise master-only at the RLS level (see move_own_token).
        const { error } = isMaster
          ? await supabase.from("board_objects").update({ x, y }).eq("id", dragObj.id)
          : await supabase.rpc("move_own_token", { _object_id: dragObj.id, _x: x, _y: y });
        if (error) {
          toast.error("Não foi possível salvar a posição: " + error.message);
          // Revert both the DOM and the optimistic cache patch on failure.
          const el = document.getElementById(`bo-${dragObj.id}`);
          if (el) el.style.transform = `translate(${dragObj.origX}px, ${dragObj.origY}px)`;
          onObjectMove?.(dragObj.id, dragObj.origX, dragObj.origY);
        }
      }
      setDragObj(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragObj, viewport.scale, onObjectMove, showGrid, isMaster]);

  // Object resize (drag the corner handle)
  const commitObjectResize = async (obj: BoardObject, width: number, height: number) => {
    onObjectResize?.(obj.id, width, height);
    const { error } = await supabase
      .from("board_objects")
      .update({ width, height })
      .eq("id", obj.id);
    if (error) {
      toast.error("Não foi possível salvar o tamanho: " + error.message);
      onObjectResize?.(obj.id, obj.width, obj.kind === "pin" ? obj.width : obj.height);
    }
  };

  const startObjResize = useCallback(
    (obj: BoardObject, e: React.PointerEvent) => {
      if (!isMaster || obj.locked) return;
      e.stopPropagation();
      e.preventDefault();
      setResizeObj({
        id: obj.id,
        kind: obj.kind,
        startX: e.clientX,
        startY: e.clientY,
        origW: obj.width,
        origH: obj.kind === "pin" ? obj.width : obj.height,
      });
    },
    [isMaster],
  );

  useEffect(() => {
    if (!resizeObj) return;
    const min = MIN_OBJECT_SIZE[resizeObj.kind] ?? { width: 80, height: 60 };
    let latest: { width: number; height: number } | null = null;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - resizeObj.startX) / viewport.scale;
      const dy = (e.clientY - resizeObj.startY) / viewport.scale;
      // Pins resize as a square (one handle drags both dimensions together)
      // since they're a circular token, not a rectangular card.
      const width = Math.max(min.width, resizeObj.origW + dx);
      const height =
        resizeObj.kind === "pin" ? width : Math.max(min.height, resizeObj.origH + dy);
      latest = { width, height };
      const el = document.getElementById(`bo-${resizeObj.id}`);
      if (el) {
        el.style.width = `${width}px`;
        if (resizeObj.kind !== "pin") el.style.height = `${height}px`;
      }
    };
    const onUp = async () => {
      if (latest) {
        onObjectResize?.(resizeObj.id, latest.width, latest.height);
        const { error } = await supabase
          .from("board_objects")
          .update({ width: latest.width, height: latest.height })
          .eq("id", resizeObj.id);
        if (error) {
          toast.error("Não foi possível salvar o tamanho: " + error.message);
          onObjectResize?.(resizeObj.id, resizeObj.origW, resizeObj.origH);
        }
      }
      setResizeObj(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [resizeObj, viewport.scale, onObjectResize]);

  // Facing rotation (drag the direction handle around the pin). Writes
  // light_angle regardless of has_light — it doubles as "which way this
  // token is facing" and, only when has_light + light_shape "cone" are also
  // on, as the cone's direction too.
  const startObjRotate = useCallback((obj: BoardObject, e: React.PointerEvent) => {
    if (!canControlObject(obj) || obj.locked) return;
    e.stopPropagation();
    e.preventDefault();
    const el = document.getElementById(`bo-${obj.id}-light-anchor`);
    const rect = el?.getBoundingClientRect();
    if (!rect) return;
    setRotateObj({
      id: obj.id,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
    });
  }, [canControlObject]);

  useEffect(() => {
    if (!rotateObj) return;
    let latestAngle = 0;
    const onMove = (e: PointerEvent) => {
      const rad = Math.atan2(e.clientY - rotateObj.centerY, e.clientX - rotateObj.centerX);
      latestAngle = (rad * 180) / Math.PI;
      const anchor = document.getElementById(`bo-${rotateObj.id}-light-anchor`);
      if (anchor) anchor.style.transform = `rotate(${latestAngle}deg)`;
    };
    const onUp = async () => {
      const obj = objects.find((o) => o.id === rotateObj.id) as BoardObject;
      if (isMaster) {
        onSetLight?.(obj, { light_angle: latestAngle });
      } else {
        // Same reasoning as move_own_token: a player rotating their own
        // token's cone can't write board_objects directly (master-only
        // RLS), so this goes through a narrow RPC instead. Patch the cache
        // ourselves too, so it doesn't wait on Realtime to look settled.
        onRotateOwnLight?.(rotateObj.id, latestAngle);
        const { error } = await supabase.rpc("rotate_own_light", {
          _object_id: rotateObj.id,
          _angle: latestAngle,
        });
        if (error) {
          toast.error("Não foi possível girar a direção: " + error.message);
          onRotateOwnLight?.(rotateObj.id, obj.light_angle);
        }
      }
      setRotateObj(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [rotateObj, objects, onSetLight, isMaster, onRotateOwnLight]);

  // Drop from sidebar
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const wx = (e.clientX - rect.left - viewport.x) / viewport.scale;
    const wy = (e.clientY - rect.top - viewport.y) / viewport.scale;

    const characterId = e.dataTransfer.getData("text/character-id");
    if (characterId) {
      onDropCharacterFromSidebar?.(characterId, wx, wy);
      return;
    }
    const fileId = e.dataTransfer.getData("text/file-id");
    if (fileId) onDropFromSidebar(fileId, wx, wy);
  };

  const resetView = () => setViewport({ x: 0, y: 0, scale: 1 });

  // Kept up to date without being a dependency of the effect below, so a
  // fresh focusRequest always reads the latest objects without re-running
  // every time some other viewer's drag updates the objects array.
  const objectsRef = useRef(objects);
  useEffect(() => {
    objectsRef.current = objects;
  }, [objects]);

  // "Camadas" panel → canvas: select the requested object and pan it into
  // view. Keyed on focusRequest (id + nonce) rather than just the id, so
  // clicking the same row twice in a row still re-centers it.
  useEffect(() => {
    if (!focusRequest) return;
    const obj = objectsRef.current.find((o) => o.id === focusRequest.id);
    if (!obj) return;
    setSelectedId(obj.id);
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const w = obj.width || 80;
    const h = obj.kind === "pin" ? w : obj.height || 80;
    const cx = obj.kind === "aoe" ? obj.x : obj.x + w / 2;
    const cy = obj.kind === "aoe" ? obj.y : obj.y + h / 2;
    setViewport((v) => ({
      x: rect.width / 2 - cx * v.scale,
      y: rect.height / 2 - cy * v.scale,
      scale: v.scale,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  // Bring-to-front / send-to-back is now handled by the campaign page's
  // onReorder (it needs to patch the query cache immediately, not just
  // write to Supabase and wait for Realtime — see the Props comment above).

  // Dynamic light/vision: recomputed from current object positions (no
  // persisted "revealed" memory) — but only when `objects` itself changes,
  // not on every render (panning, selecting, opening a popover...). This
  // was rebuilding the whole light map — and, worse, the darkness overlay's
  // gradient string below — on every single render.
  const getObjectCenter = useCallback(
    (o: BoardObject) =>
      o.kind === "aoe"
        ? { cx: o.x, cy: o.y }
        : {
            cx: o.x + o.width / 2,
            cy: o.y + (o.kind === "pin" ? o.width : o.height) / 2,
          },
    [],
  );
  const lightSources = useMemo(
    () =>
      objects
        .filter((o) => o.has_light)
        .map((o) => ({
          id: o.id,
          ...getObjectCenter(o),
          radius: o.light_radius,
          shape: o.light_shape,
          angle: o.light_angle,
          coneWidth: o.light_cone_width,
        })),
    [objects, getObjectCenter],
  );
  const isLit = useCallback(
    (o: BoardObject) => {
      if (lightSources.length === 0) return false;
      const { cx, cy } = getObjectCenter(o);
      return lightSources.some((l) => {
        const dx = cx - l.cx;
        const dy = cy - l.cy;
        if (dx * dx + dy * dy > l.radius ** 2) return false;
        if (l.shape !== "cone") return true;
        const pointAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
        const diff = (((pointAngle - l.angle + 180) % 360) + 360) % 360 - 180;
        return Math.abs(diff) <= l.coneWidth / 2;
      });
    },
    [lightSources, getObjectCenter],
  );

  // The darkness overlay used to cover a fixed 6000px square centered on
  // the origin — fine for a small scene, but a token placed (or a map
  // panned to) further out than that sat outside the overlay entirely and
  // showed up fully lit regardless of has_light/hidden_when_dark. Sized
  // from the actual extent of whatever is on the board, padded out
  // generously so panning a bit past the edge still reads as dark — and
  // also unioned with whatever's currently visible in the viewport, so
  // zooming out or panning to an empty stretch of the board never outruns
  // the overlay either (a sane floor still covers an empty/near-empty scene
  // before the container has been measured).
  const BOUNDS_PADDING = 2000;
  const BOUNDS_MIN_SIZE = 6000;
  const boardBounds = useMemo(() => {
    let minX = -viewport.x / viewport.scale;
    let minY = -viewport.y / viewport.scale;
    let maxX = minX + containerSize.width / viewport.scale;
    let maxY = minY + containerSize.height / viewport.scale;
    for (const o of objects) {
      const w = o.width;
      const h = o.kind === "pin" ? o.width : o.height;
      minX = Math.min(minX, o.x);
      minY = Math.min(minY, o.y);
      maxX = Math.max(maxX, o.x + w);
      maxY = Math.max(maxY, o.y + h);
    }
    const left = minX - BOUNDS_PADDING;
    const top = minY - BOUNDS_PADDING;
    const size = Math.max(maxX + BOUNDS_PADDING - left, maxY + BOUNDS_PADDING - top, BOUNDS_MIN_SIZE);
    return { left, top, size };
  }, [objects, viewport, containerSize]);

  // Each light is its own layer (mix-blend-mode: screen unions it with the
  // others) instead of one flat stack of CSS background-images — a circle
  // is just a radial gradient, but a cone additionally needs a conic-
  // gradient mask to clip that gradient down to a wedge, and CSS has no way
  // to give only *some* of several stacked background-images their own
  // mask. `isolation: isolate` on the wrapper keeps the screen-blending
  // contained to these layers rather than bleeding into the board below —
  // the wrapper's own mix-blend-mode: multiply (applied to the isolated
  // group as a whole) is what actually darkens the board content.
  const lightLayers = useMemo(
    () =>
      lightSources.map((l) => {
        const x = l.cx - boardBounds.left;
        const y = l.cy - boardBounds.top;
        const style: React.CSSProperties = {
          position: "absolute",
          inset: 0,
          mixBlendMode: "screen",
          // Old curve faded linearly from the very center (white 0% straight
          // to transparent at the radius), so even the middle of a light's
          // radius was already dimmed — reads as "weak" even at full radius.
          // Keeping it fully bright out to ~55% before fading gives a real
          // lit core, with the falloff only doing its job near the edge.
          backgroundImage: `radial-gradient(circle at ${x}px ${y}px, white 0px, white ${l.radius * 0.55}px, transparent ${l.radius}px)`,
        };
        if (l.shape === "cone") {
          // My angle convention is 0°=east, clockwise (matches atan2 on
          // screen coords). CSS conic-gradient's 0deg points north/up and
          // also increases clockwise, so converting is just a +90° shift.
          const cssFrom = (((l.angle - l.coneWidth / 2 + 90) % 360) + 360) % 360;
          const mask = `conic-gradient(from ${cssFrom}deg at ${x}px ${y}px, white 0deg, white ${l.coneWidth}deg, transparent ${l.coneWidth}deg, transparent 360deg)`;
          style.maskImage = mask;
          style.WebkitMaskImage = mask;
        }
        return { id: l.id, style };
      }),
    [lightSources, boardBounds],
  );

  const fogStyle = useMemo(
    (): React.CSSProperties => ({
      left: boardBounds.left,
      top: boardBounds.top,
      width: boardBounds.size,
      height: boardBounds.size,
      zIndex: 5000,
      mixBlendMode: "multiply",
      isolation: "isolate",
      opacity: 0.85,
      backgroundColor: "var(--ink)",
    }),
    [boardBounds],
  );

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setSelectedId(null);
          setEditingId(null);
        }
      }}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      className="relative h-full w-full overflow-hidden select-none touch-none"
      style={{
        cursor: isPanning ? "grabbing" : "default",
        touchAction: "none",
        ...getCanvasBackground(viewport, showGrid),
        ...themeCssVars(theme),
      }}
      data-canvas-bg="1"
    >
      {/* World layer */}
      <div
        ref={worldLayerRef}
        className="absolute left-0 top-0 origin-top-left"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
        }}
      >
        {/* Dynamic light/vision — darkens everything for non-master viewers,
            with soft holes carved out around each light-emitting object.
            Master-toggleable per campaign via dynamicLighting ("day mode"
            turns this off entirely, showing everything to everyone). */}
        {!isMaster && dynamicLighting && (
          <div aria-hidden="true" className="pointer-events-none absolute" style={fogStyle}>
            {lightLayers.map((l) => (
              <div key={l.id} style={l.style} />
            ))}
          </div>
        )}

        {objects
          .slice()
          .sort((a, b) => a.z_index - b.z_index)
          .map((o) => (
            <ObjectView
              key={o.id}
              obj={o}
              isMaster={isMaster}
              currentUserId={currentUserId}
              onDragStart={startObjDrag}
              onObjectMove={onObjectMove}
              onReorder={onReorder}
              onToggleLock={onToggleLock}
              onToggleVisibility={onToggleVisibility}
              onRemoveObject={onRemoveObject}
              onEditDocument={onEditDocument}
              onSetLight={onSetLight}
              onSetAoeData={onSetAoeData}
              onLinkCharacter={onLinkCharacter}
              isDragging={dragObj?.id === o.id}
              showGrid={showGrid}
              characters={characters}
              onOpenCharacter={onOpenCharacter}
              isSelected={selectedId === o.id}
              lockToolActive={lockToolActive}
              onSelect={() => {
                if (lockToolActive && isMaster) {
                  onToggleLock?.(o);
                  return;
                }
                setSelectedId(o.id);
              }}
              onResizeStart={startObjResize}
              onRotateStart={startObjRotate}
              isResizing={resizeObj?.id === o.id}
              isEditing={editingId === o.id}
              onOpenProperties={() => setEditingId(o.id)}
              hiddenByFog={!isMaster && dynamicLighting && o.hidden_when_dark && !isLit(o)}
            />
          ))}


        {objects.length === 0 && (
          <div
            className="pointer-events-none absolute grimoire-title text-3xl text-muted-foreground/40 italic"
            style={{ left: 200, top: 200, width: 500 }}
          >
            Arraste um mapa, ficha ou pergaminho do arquivo à direita para começar a cena…
          </div>
        )}
      </div>

      {/* Ambient lighting overlay for the current table theme */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: theme.vignette }}
      />

      {isMaster && editingObj && editingObj.kind === "pin" && (
        <PinPropertiesPanel
          obj={editingObj}
          characters={characters}
          files={files}
          onClose={() => setEditingId(null)}
          onUpdateObject={onUpdateObject}
          onResizeCommit={commitObjectResize}
          onSetLight={onSetLight}
          onToggleLock={onToggleLock}
          onToggleVisibility={onToggleVisibility}
          onLinkCharacter={onLinkCharacter}
          onReorder={onReorder}
          onRemoveObject={(o) => {
            onRemoveObject?.(o);
            setEditingId(null);
          }}
          onDuplicateObject={onDuplicateObject}
        />
      )}

      {/* Zoom controls */}
      <div
        role="group"
        aria-label="Controles de zoom"
        className="absolute bottom-4 left-1/2 -translate-x-1/2 flex max-w-[calc(100vw-1.5rem)] items-center gap-1 overflow-x-auto rounded-full bg-ink-2/90 p-1.5 ring-1 ring-primary/25 backdrop-blur-md shadow-xl sm:bottom-6"
      >
        {isMaster && (
          <>
            <Button
              size="sm"
              variant="ghost"
              aria-label={showGrid ? "Ocultar grade de movimento" : "Mostrar grade de movimento"}
              aria-pressed={showGrid}
              title="Grade de movimento — 1 quadrado = 1,5m"
              className={`h-9 w-9 p-0 sm:h-8 sm:w-8 hover:bg-primary/10 ${
                showGrid ? "text-primary bg-primary/15" : "text-primary/70"
              }`}
              onClick={() => setShowGrid((v) => !v)}
            >
              <Grid3x3 className="size-4" aria-hidden="true" />
            </Button>
            {onToggleDynamicLighting && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={dynamicLighting ? "Mudar para modo dia" : "Mudar para modo noite"}
                aria-pressed={dynamicLighting}
                title={
                  dynamicLighting
                    ? "Modo noite ativo — escuridão e névoa de guerra ligadas para os jogadores"
                    : "Modo dia ativo — sem escuridão, tudo visível aos jogadores"
                }
                className={`h-9 w-9 p-0 sm:h-8 sm:w-8 hover:bg-primary/10 ${
                  dynamicLighting ? "text-primary bg-primary/15" : "text-primary/70"
                }`}
                onClick={onToggleDynamicLighting}
              >
                {dynamicLighting ? (
                  <Moon className="size-4" aria-hidden="true" />
                ) : (
                  <Sun className="size-4" aria-hidden="true" />
                )}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-label={
                lockToolActive
                  ? "Ferramenta de cadeado ativa — clique em um objeto para travar/destravar, clique aqui para sair"
                  : "Ativar ferramenta de cadeado — clique em objetos para travá-los/destravá-los"
              }
              aria-pressed={lockToolActive}
              title={
                lockToolActive
                  ? "Ferramenta de cadeado ativa — clique em um objeto para travar/destravar"
                  : "Ferramenta de cadeado — clique e depois clique nos objetos para travá-los/destravá-los, sem abrir a barrinha de cada um"
              }
              className={`h-9 w-9 p-0 sm:h-8 sm:w-8 hover:bg-primary/10 ${
                lockToolActive ? "text-primary bg-primary/15" : "text-primary/70"
              }`}
              onClick={() => setLockToolActive((v) => !v)}
            >
              {lockToolActive ? (
                <Lock className="size-4" aria-hidden="true" />
              ) : (
                <Unlock className="size-4" aria-hidden="true" />
              )}
            </Button>
            <div className="h-4 w-px bg-primary/15" aria-hidden="true" />
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-label="Diminuir zoom"
          className="h-9 w-9 p-0 sm:h-8 sm:w-8 text-primary hover:bg-primary/10"
          onClick={() => setViewport((v) => ({ ...v, scale: Math.max(0.25, v.scale - 0.15) }))}
        >
          <span aria-hidden="true">−</span>
        </Button>
        <button
          onClick={resetView}
          aria-label="Redefinir zoom para 100%"
          className="flex items-center gap-2 px-3 py-1 text-xs font-medium text-primary/80 hover:text-primary"
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
          <span>{Math.round(viewport.scale * 100)}%</span>
        </button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Aumentar zoom"
          className="h-9 w-9 p-0 sm:h-8 sm:w-8 text-primary hover:bg-primary/10"
          onClick={() => setViewport((v) => ({ ...v, scale: Math.min(2.5, v.scale + 0.15) }))}
        >
          <span aria-hidden="true">+</span>
        </Button>
      </div>
    </div>
  );
}

function ObjectViewImpl({
  obj,
  isMaster,
  currentUserId,
  onDragStart,
  onObjectMove,
  onReorder,
  isDragging = false,
  showGrid = false,
  characters = [],
  onOpenCharacter,
  isSelected = false,
  onSelect,
  onResizeStart,
  onRotateStart,
  isResizing = false,
  hiddenByFog = false,
  onToggleLock,
  onToggleVisibility,
  onRemoveObject,
  onEditDocument,
  onSetLight,
  onSetAoeData,
  onLinkCharacter,
  lockToolActive = false,
  isEditing = false,
  onOpenProperties,
}: {
  obj: BoardObject;
  isMaster: boolean;
  /** Current viewer's user id — used to tell whether a pin's linked
   * character belongs to them, so they can move it / turn its cone. */
  currentUserId?: string | null;
  onDragStart: (obj: BoardObject, e: React.PointerEvent) => void;
  onObjectMove?: (id: string, x: number, y: number) => void;
  onReorder?: (obj: BoardObject, dir: "front" | "back") => void;
  isDragging?: boolean;
  showGrid?: boolean;
  characters?: Character[];
  onOpenCharacter?: (character: Character) => void;
  isSelected?: boolean;
  onSelect?: () => void;
  onResizeStart?: (obj: BoardObject, e: React.PointerEvent) => void;
  onRotateStart?: (obj: BoardObject, e: React.PointerEvent) => void;
  isResizing?: boolean;
  /** True when this object has `hidden_when_dark` set and no light reaches
   * it right now — only ever true for non-master viewers. */
  hiddenByFog?: boolean;
  onToggleLock?: (obj: BoardObject) => void;
  onToggleVisibility?: (obj: BoardObject) => void;
  onRemoveObject?: (obj: BoardObject) => void;
  onEditDocument?: (obj: BoardObject, content: string) => void;
  onSetLight?: (
    obj: BoardObject,
    patch: Partial<Pick<
      BoardObject,
      "has_light" | "light_radius" | "hidden_when_dark" | "light_shape" | "light_angle" | "light_cone_width"
    >>,
  ) => void;
  onSetAoeData?: (obj: BoardObject, patch: { color?: string }) => void;
  onLinkCharacter?: (obj: BoardObject, characterId: string | null) => void;
  /** Bottom-toolbar lock tool armed by the master — keeps a locked object
   * clickable (instead of pass-through, see lockedPassThrough below) so it
   * can still be tapped to toggle its lock. */
  lockToolActive?: boolean;
  /** True while this pin's properties side panel is open (double-clicked).
   * The resize handle only shows up while this is true. */
  isEditing?: boolean;
  /** Double-clicking a pin opens its properties panel (master only). */
  onOpenProperties?: () => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [isEditingDoc, setIsEditingDoc] = useState(false);
  // Pergaminho ("document") drafts used to live only in the uncontrolled
  // textarea's DOM value, saved solely on blur. Switching screens/routes
  // (or a browser tab switch on some engines) unmounts this card before a
  // native blur ever fires, silently discarding everything typed. This ref
  // tracks the latest draft so it can be flushed on a debounce, on blur,
  // and — critically — on unmount, so navigating away never loses text.
  const docDraftRef = useRef<{ value: string; dirty: boolean }>({ value: "", dirty: false });
  const docSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushDocSave = useCallback(() => {
    if (docSaveTimerRef.current) {
      clearTimeout(docSaveTimerRef.current);
      docSaveTimerRef.current = null;
    }
    if (docDraftRef.current.dirty) {
      onEditDocument?.(obj, docDraftRef.current.value);
      docDraftRef.current.dirty = false;
    }
  }, [obj, onEditDocument]);
  useEffect(() => {
    return () => {
      flushDocSave();
    };
  }, [flushDocSave]);
  const linkedCharacter = characters.find((c) => c.id === obj.character_id) ?? null;
  // A player can move their own token and turn its vision cone during a
  // scene without being the master — but only the one pin linked to a
  // character they own, so they can't touch anyone else's stuff.
  const canControl =
    isMaster || (!!currentUserId && !!linkedCharacter && linkedCharacter.owner_id === currentUserId);

  useEffect(() => {
    let cancelled = false;
    const data = (obj.data ?? {}) as { storage_path?: string; image_url?: string };
    // A pin can carry its own image two ways — a chosen file from the
    // campaign's gallery (data.storage_path, same as map/image objects) or a
    // pasted external URL (data.image_url) — and either one takes priority
    // over the linked character's portrait, since setting a custom image is
    // a deliberate override.
    const portraitPath = obj.kind === "pin" ? linkedCharacter?.portrait_path : undefined;
    const path = (obj.kind === "map" || obj.kind === "image" || obj.kind === "pin") && data.storage_path
      ? data.storage_path
      : portraitPath;
    if (obj.kind === "pin" && data.image_url && !data.storage_path) {
      // External URLs are used as-is — no Storage bucket to sign.
      setImgUrl(data.image_url);
      return () => {
        cancelled = true;
      };
    }
    if (path) {
      supabase.storage
        .from("campaign-assets")
        .createSignedUrl(path, 60 * 60)
        .then(({ data: sig, error }) => {
          if (cancelled) return;
          if (error) {
            toast.error("Não foi possível carregar a imagem: " + error.message);
            return;
          }
          if (sig?.signedUrl) setImgUrl(sig.signedUrl);
        });
    } else {
      setImgUrl(null);
    }
    return () => {
      cancelled = true;
    };
  }, [obj.id, obj.kind, obj.data, linkedCharacter?.portrait_path]);

  // Must come after every hook above so the hook count stays constant
  // across renders even as hiddenByFog flips true/false.
  if (hiddenByFog) return null;

  // Lock/visibility/remove are now owned by the campaign page (onToggleLock,
  // onToggleVisibility, onRemoveObject) for the same reason reorder is —
  // patch-then-write beats write-then-wait-for-Realtime.

  // Light settings are owned by the campaign page now too (onSetLight) —
  // same reason as everything else above.

  // Keyboard alternative to mouse-drag repositioning (accessibility): arrow
  // keys nudge the object; holding Shift moves it in larger steps. When the
  // movement grid is on, a nudge moves exactly one slot (1.5m) instead, so
  // arrow-key movement counts cleanly too — Shift then moves two slots.
  const nudge = async (e: React.KeyboardEvent) => {
    const stepMap: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    const dir = stepMap[e.key];
    if (!dir) return;
    e.preventDefault();
    const step = showGrid
      ? e.shiftKey
        ? GRID_CELL_PX * 2
        : GRID_CELL_PX
      : e.shiftKey
        ? KEYBOARD_NUDGE_STEP_LARGE
        : KEYBOARD_NUDGE_STEP;
    const x = obj.x + dir[0] * step;
    const y = obj.y + dir[1] * step;
    onObjectMove?.(obj.id, x, y);
    // Master writes any object directly; a player moving their own linked
    // token goes through the RPC instead, since board_objects writes are
    // otherwise master-only at the RLS level (see move_own_token).
    const { error } = isMaster
      ? await supabase.from("board_objects").update({ x, y }).eq("id", obj.id)
      : await supabase.rpc("move_own_token", { _object_id: obj.id, _x: x, _y: y });
    if (error) {
      toast.error("Não foi possível mover: " + error.message);
      onObjectMove?.(obj.id, obj.x, obj.y);
    }
  };

  // A locked pin/image/map used to keep swallowing pointer events for
  // everyone, which is exactly what made panning the canvas (or dropping a
  // new image) feel stuck whenever the drag/tap started on top of one —
  // including for the master themselves, not just players. Locked now means
  // "hands off the canvas" for everyone: it becomes click/drag-through so a
  // pan gesture (mouse or finger) passes straight through it. The one
  // exception is while the lock tool is armed, which needs the object to
  // stay clickable so it can be tapped to unlock it again; otherwise, use
  // the Camadas panel to select and unlock it.
  const lockedPassThrough =
    obj.locked &&
    !(isMaster && lockToolActive) &&
    (obj.kind === "pin" || obj.kind === "image" || obj.kind === "map");

  const commonHandleProps = {
    onPointerDown: (e: React.PointerEvent) => onDragStart(obj, e),
    onClick: () => onSelect?.(),
    // Without this, mobile browsers intercept the finger-down as a page
    // scroll/zoom gesture before our pointer handler gets a clean drag.
    style: {
      touchAction: "none" as const,
      pointerEvents: lockedPassThrough ? ("none" as const) : undefined,
    },
  };

  const controls = (isMaster || canControl) && (
    <div
      className={`pointer-events-auto absolute -top-9 left-0 flex gap-1 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${
        isSelected ? "opacity-100" : "opacity-0"
      }`}
    >
      {isMaster && (
      <button
        onClick={() => onToggleLock?.(obj)}
        aria-label={obj.locked ? "Destravar objeto" : "Travar objeto"}
        title={obj.locked ? "Destravar" : "Travar"}
        className="grid h-7 w-7 place-items-center rounded bg-ink-2/95 ring-1 ring-primary/25 text-primary hover:bg-primary/20"
      >
        {obj.locked ? (
          <Lock className="size-3.5" aria-hidden="true" />
        ) : (
          <Unlock className="size-3.5" aria-hidden="true" />
        )}
      </button>
      )}
      {isMaster && (
      <button
        onClick={() => onToggleVisibility?.(obj)}
        aria-label={obj.visible_to_players ? "Ocultar dos jogadores" : "Mostrar aos jogadores"}
        title={obj.visible_to_players ? "Ocultar dos jogadores" : "Mostrar aos jogadores"}
        className="grid h-7 w-7 place-items-center rounded bg-ink-2/95 ring-1 ring-primary/25 text-primary hover:bg-primary/20"
      >
        {obj.visible_to_players ? (
          <Eye className="size-3.5" aria-hidden="true" />
        ) : (
          <EyeOff className="size-3.5" aria-hidden="true" />
        )}
      </button>
      )}
      {isMaster && obj.kind !== "aoe" && (
      <Popover>
        <PopoverTrigger asChild>
          <button
            aria-label="Configurar luz e visão"
            title="Luz e visão"
            className={`grid h-7 w-7 place-items-center rounded ring-1 hover:bg-primary/20 ${
              obj.has_light
                ? "bg-primary/25 ring-primary/50 text-primary"
                : "bg-ink-2/95 ring-primary/25 text-primary"
            }`}
          >
            <Flame className="size-3.5" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="gold-frame w-56 bg-ink-2/95 p-3">
          <div className="mb-3 flex items-center justify-between">
            <label htmlFor={`light-${obj.id}`} className="flex items-center gap-1.5 text-xs">
              <Flame className="size-3.5 text-primary" aria-hidden="true" />
              Emite luz
            </label>
            <input
              id={`light-${obj.id}`}
              type="checkbox"
              checked={obj.has_light}
              onChange={() => onSetLight?.(obj, { has_light: !obj.has_light })}
              className="size-4 accent-primary"
            />
          </div>
          {obj.has_light && (
            <>
              <div className="mb-3">
                <span className="mb-1 block text-[10px] text-muted-foreground">Formato</span>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => onSetLight?.(obj, { light_shape: "circle" })}
                    className={`flex-1 rounded px-2 py-1 text-xs ring-1 ${
                      obj.light_shape === "circle"
                        ? "bg-primary/25 ring-primary/50 text-primary"
                        : "ring-primary/20 text-muted-foreground hover:bg-primary/10"
                    }`}
                  >
                    ◯ Círculo
                  </button>
                  <button
                    onClick={() => onSetLight?.(obj, { light_shape: "cone" })}
                    className={`flex-1 rounded px-2 py-1 text-xs ring-1 ${
                      obj.light_shape === "cone"
                        ? "bg-primary/25 ring-primary/50 text-primary"
                        : "ring-primary/20 text-muted-foreground hover:bg-primary/10"
                    }`}
                  >
                    ◣ Cone
                  </button>
                </div>
              </div>
              <div className="mb-3">
                <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>{obj.light_shape === "cone" ? "Alcance do cone" : "Raio da luz"}</span>
                  <span>{obj.light_radius}px</span>
                </div>
                <Slider
                  defaultValue={[obj.light_radius]}
                  min={50}
                  max={1000}
                  step={25}
                  onValueCommit={([v]) => onSetLight?.(obj, { light_radius: v })}
                />
              </div>
              {obj.light_shape === "cone" && (
                <div className="mb-3">
                  <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>Abertura do cone</span>
                    <span>{obj.light_cone_width}°</span>
                  </div>
                  <Slider
                    defaultValue={[obj.light_cone_width]}
                    min={15}
                    max={180}
                    step={5}
                    onValueCommit={([v]) => onSetLight?.(obj, { light_cone_width: v })}
                  />
                  <p className="mt-1 text-[10px] italic text-muted-foreground">
                    Arraste o pontinho dourado ao lado do pin para girar a direção.
                  </p>
                </div>
              )}
            </>
          )}
          <div className="flex items-center justify-between">
            <label htmlFor={`fog-${obj.id}`} className="flex items-center gap-1.5 text-xs">
              <Ghost className="size-3.5 text-primary" aria-hidden="true" />
              Só visível se iluminado
            </label>
            <input
              id={`fog-${obj.id}`}
              type="checkbox"
              checked={obj.hidden_when_dark}
              onChange={() => onSetLight?.(obj, { hidden_when_dark: !obj.hidden_when_dark })}
              className="size-4 accent-primary"
            />
          </div>
          {obj.kind === "pin" && (
            <div className="mt-3 border-t border-primary/10 pt-3">
              <label
                htmlFor={`char-${obj.id}`}
                className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground"
              >
                <UserRound className="size-3 text-primary/70" aria-hidden="true" />
                Personagem vinculado
              </label>
              <select
                id={`char-${obj.id}`}
                value={obj.character_id ?? ""}
                onChange={(e) => onLinkCharacter?.(obj, e.target.value || null)}
                className="w-full rounded border border-primary/20 bg-ink px-2 py-1.5 text-xs text-primary"
              >
                <option value="">Nenhum (letra)</option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </PopoverContent>
      </Popover>
      )}
      {/* Area-of-effect telegraph settings — shape/radius/cone width reuse
          the same light_* columns and Slider widgets as the popover above
          (see the migration comment for why), just with a color swatch
          picker instead of an "emits light" toggle, since an AoE marker
          never actually casts light (has_light stays false). */}
      {isMaster && obj.kind === "aoe" && (
      <Popover>
        <PopoverTrigger asChild>
          <button
            aria-label="Configurar área de efeito"
            title="Área de efeito"
            className="grid h-7 w-7 place-items-center rounded bg-ink-2/95 ring-1 ring-primary/25 text-primary hover:bg-primary/20"
          >
            <Sparkles className="size-3.5" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="gold-frame w-56 bg-ink-2/95 p-3">
          <div className="mb-3">
            <span className="mb-1 block text-[10px] text-muted-foreground">Formato</span>
            <div className="flex gap-1.5">
              <button
                onClick={() => onSetLight?.(obj, { light_shape: "circle" })}
                className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-xs ring-1 ${
                  obj.light_shape === "circle"
                    ? "bg-primary/25 ring-primary/50 text-primary"
                    : "ring-primary/20 text-muted-foreground hover:bg-primary/10"
                }`}
              >
                <Circle className="size-3" aria-hidden="true" /> Círculo
              </button>
              <button
                onClick={() => onSetLight?.(obj, { light_shape: "cone" })}
                className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-xs ring-1 ${
                  obj.light_shape === "cone"
                    ? "bg-primary/25 ring-primary/50 text-primary"
                    : "ring-primary/20 text-muted-foreground hover:bg-primary/10"
                }`}
              >
                <Triangle className="size-3 rotate-90" aria-hidden="true" /> Cone
              </button>
            </div>
          </div>
          <div className="mb-3">
            <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>Raio (grade: {Math.round(obj.light_radius / GRID_CELL_PX)} quadrados)</span>
              <span>{obj.light_radius}px</span>
            </div>
            <Slider
              defaultValue={[obj.light_radius]}
              min={GRID_CELL_PX}
              max={GRID_CELL_PX * 20}
              step={GRID_CELL_PX / 2}
              onValueCommit={([v]) =>
                onSetLight?.(obj, { light_radius: Math.round(v / GRID_CELL_PX) * GRID_CELL_PX })
              }
            />
          </div>
          {obj.light_shape === "cone" && (
            <div className="mb-3">
              <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
                <span>Abertura do cone</span>
                <span>{obj.light_cone_width}°</span>
              </div>
              <Slider
                defaultValue={[obj.light_cone_width]}
                min={15}
                max={180}
                step={5}
                onValueCommit={([v]) => onSetLight?.(obj, { light_cone_width: v })}
              />
              <p className="mt-1 text-[10px] italic text-muted-foreground">
                Arraste o pontinho dourado para girar a direção.
              </p>
            </div>
          )}
          <div>
            <span className="mb-1 block text-[10px] text-muted-foreground">Cor</span>
            <div className="flex gap-1.5">
              {Object.entries(AOE_COLORS).map(([key, c]) => (
                <button
                  key={key}
                  onClick={() => onSetAoeData?.(obj, { color: key })}
                  aria-label={c.label}
                  title={c.label}
                  className={`size-6 rounded-full ring-2 transition-transform ${
                    ((obj.data as { color?: string } | null)?.color ?? DEFAULT_AOE_COLOR) === key
                      ? "scale-110 ring-primary"
                      : "ring-transparent hover:scale-105"
                  }`}
                  style={{ backgroundColor: c.fill }}
                />
              ))}
            </div>
          </div>
        </PopoverContent>
      </Popover>
      )}
      {isMaster && (
      <button
        onClick={() => onReorder?.(obj, "back")}
        aria-label="Mandar para trás"
        title="Mandar para trás (sobreposição)"
        className="grid h-7 w-7 place-items-center rounded bg-ink-2/95 ring-1 ring-primary/25 text-primary hover:bg-primary/20"
      >
        <ChevronsDown className="size-3.5" aria-hidden="true" />
      </button>
      )}
      {isMaster && (
      <button
        onClick={() => onReorder?.(obj, "front")}
        aria-label="Trazer para frente"
        title="Trazer para frente (sobreposição)"
        className="grid h-7 w-7 place-items-center rounded bg-ink-2/95 ring-1 ring-primary/25 text-primary hover:bg-primary/20"
      >
        <ChevronsUp className="size-3.5" aria-hidden="true" />
      </button>
      )}
      {isMaster && (
      <button
        onClick={() => onRemoveObject?.(obj)}
        aria-label="Remover objeto"
        title="Remover"
        className="grid h-7 w-7 place-items-center rounded bg-ink-2/95 ring-1 ring-destructive/40 text-destructive hover:bg-destructive/20"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
      )}
      {/* Move handle: master can move anything; a player can move only the
          token their own linked character is on (canControl covers both). */}
      {canControl && !obj.locked && (
        <button
          type="button"
          {...commonHandleProps}
          onKeyDown={nudge}
          aria-label="Mover objeto (arraste ou use as setas do teclado)"
          title="Mover — arraste ou use as setas"
          className="grid h-7 w-7 cursor-grab place-items-center rounded bg-ink-2/95 ring-1 ring-primary/25 text-primary hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Move className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );

  // Pins now only reveal their resize handle once double-clicked (isEditing)
  // — a plain single-click select used to show it immediately, which made
  // an accidental drag near a selected token resize it instead of moving
  // it. Maps/images keep the old select-to-resize behavior unchanged.
  const showResizeHandle = obj.kind === "pin" ? isEditing || isResizing : isSelected || isResizing;
  const resizeHandle = isMaster && !obj.locked && (
    <div
      onPointerDown={(e) => onResizeStart?.(obj, e)}
      role="presentation"
      aria-label="Redimensionar objeto"
      title="Arraste para redimensionar"
      className={`pointer-events-auto absolute right-1 bottom-1 z-10 size-3.5 cursor-nwse-resize rounded-full bg-primary ring-2 ring-ink-2 transition-opacity ${
        obj.kind !== "pin" ? "group-hover:opacity-100 group-focus-within:opacity-100" : ""
      } ${showResizeHandle ? "opacity-100" : "opacity-0"}`}
      style={{ touchAction: "none" }}
    />
  );

  // Facing indicator — always present on a pin (regardless of whether it
  // emits light), so a token's direction reads at a glance for everyone and
  // can be dragged by whoever controls that token. When the pin also has
  // has_light + light_shape "cone" on, the cone in lightLayers reads this
  // same light_angle, so it just follows the facing automatically — no
  // separate "facing" field needed.
  const facingHandle = obj.kind === "pin" &&
    !obj.locked && (
      <div
        id={`bo-${obj.id}-light-anchor`}
        className="pointer-events-none absolute inset-0"
        style={{ transform: `rotate(${obj.light_angle}deg)` }}
      >
        {/* Static wedge on the rim — visible to every viewer, not just
            whoever controls the token, so facing is legible at a glance. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-y-1/2 opacity-80"
          style={{
            transform: `translateX(${(obj.width || 40) / 2 - 3}px)`,
            width: 0,
            height: 0,
            borderTop: "5px solid transparent",
            borderBottom: "5px solid transparent",
            borderLeft: "8px solid var(--primary)",
          }}
        />
        {canControl && (
          <div
            onPointerDown={(e) => onRotateStart?.(obj, e)}
            role="presentation"
            aria-label="Girar direção do personagem"
            title="Arraste para girar a direção"
            className="pointer-events-auto absolute top-1/2 left-1/2 size-3.5 -translate-y-1/2 cursor-grab rounded-full bg-amber-300 ring-2 ring-ink-2"
            style={{ transform: `translateX(${(obj.width || 40) / 2 + 14}px)`, touchAction: "none" }}
          />
        )}
      </div>
    );

  // AoE cone: same rotate-the-anchor mechanism as a pin's facing handle
  // (same anchor id, same onRotateStart → startObjRotate flow, which is why
  // this doesn't need its own pointer-drag logic) — just without the facing
  // wedge, since the cone's own conic-gradient fill already shows which way
  // it points. Positioned at the cone's own radius rather than a token's
  // half-width, so the handle always sits right on the rim.
  const aoeRotateHandle =
    obj.kind === "aoe" && obj.light_shape === "cone" && !obj.locked && canControl && (
      <div
        id={`bo-${obj.id}-light-anchor`}
        className="pointer-events-none absolute inset-0"
        style={{ transform: `rotate(${obj.light_angle}deg)` }}
      >
        <div
          onPointerDown={(e) => onRotateStart?.(obj, e)}
          role="presentation"
          aria-label="Girar direção da área de efeito"
          title="Arraste para girar a direção"
          className="pointer-events-auto absolute top-1/2 left-1/2 size-4 -translate-y-1/2 cursor-grab rounded-full bg-amber-300 ring-2 ring-ink-2"
          style={{ transform: `translateX(${obj.light_radius + 14}px)`, touchAction: "none" }}
        />
      </div>
    );

  const style: React.CSSProperties = {
    transform:
      obj.kind === "aoe"
        ? `translate(${obj.x - obj.light_radius}px, ${obj.y - obj.light_radius}px)${isDragging ? " scale(1.03)" : ""}`
        : `translate(${obj.x}px, ${obj.y}px)${isDragging ? " scale(1.03)" : ""}`,
    width: obj.kind === "aoe" ? obj.light_radius * 2 : obj.width,
    height: obj.kind === "pin" ? undefined : obj.kind === "aoe" ? obj.light_radius * 2 : obj.height,
    zIndex: isDragging ? 9999 : obj.z_index,
    opacity: !obj.visible_to_players && isMaster ? 0.55 : 1,
    boxShadow: isDragging ? "0 12px 28px -8px oklch(0 0 0 / 0.55)" : undefined,
    transition: isDragging || isResizing ? "none" : "box-shadow 120ms ease",
    // Pointer-events:none on the whole wrapper (not just the inner drag
    // handle) so a locked pin/image/map is truly click-through for anyone
    // who can't touch it anyway — a pointer-events:none only on the inner
    // handle would still leave this outer div as the hit-test target,
    // which still blocks canvas panning from starting on top of it.
    pointerEvents: lockedPassThrough ? "none" : undefined,
  };

  // Render by kind
  if (obj.kind === "pin") {
    const size = obj.width || 40;
    return (
      <div
        id={`bo-${obj.id}`}
        className="board-object-in group absolute top-0 left-0"
        style={{ ...style, width: "auto", height: "auto" }}
      >
        {controls}
        <div className="relative" style={{ width: size, height: size }}>
          <div
            {...commonHandleProps}
            onDoubleClick={() => {
              if (isMaster) onOpenProperties?.();
            }}
            className={`candle-glow grid h-full w-full cursor-grab place-items-center overflow-hidden rounded-full bg-wax ring-2 ring-primary/40 ${
              obj.locked ? "cursor-not-allowed" : ""
            }`}
            style={commonHandleProps.style}
          >
            {imgUrl ? (
              <img src={imgUrl} alt="" className="h-full w-full object-cover" draggable={false} />
            ) : (
              <span className="grimoire-title text-sm text-primary">
                {(linkedCharacter?.name ?? obj.label ?? "•").slice(0, 1).toUpperCase()}
              </span>
            )}
          </div>
          {/* facingHandle/resizeHandle live outside the circle above, not
              inside it — that div's overflow-hidden (needed to clip the
              portrait image into a circle) was also clipping these two,
              since both sit partly outside the circle's own edge. Clicks
              on the clipped-away part fell through to the circle itself,
              which is why dragging the rotate handle just moved the token
              instead of rotating it. */}
          {facingHandle}
          {resizeHandle}
        </div>
        {(linkedCharacter?.name ?? obj.label) && (
          <div className="mt-2 max-w-[10rem] text-center text-[11px] font-medium tracking-wide text-primary/80">
            {linkedCharacter?.name ?? obj.label}
          </div>
        )}
      </div>
    );
  }

  if (obj.kind === "aoe") {
    const aoeData = (obj.data ?? {}) as { color?: string };
    const aoeColor =
      AOE_COLORS[aoeData.color ?? DEFAULT_AOE_COLOR]?.fill ?? AOE_COLORS[DEFAULT_AOE_COLOR].fill;
    // Same conic-gradient-as-mask trick the light system uses for cones
    // (see lightLayers above) — but "at 50% 50%" instead of a pixel offset,
    // since this element is always exactly sized to its own 2×radius box
    // with the vertex dead center, unlike the shared darkness overlay.
    const coneMask =
      obj.light_shape === "cone"
        ? `conic-gradient(from ${(((obj.light_angle - obj.light_cone_width / 2 + 90) % 360) + 360) % 360}deg at 50% 50%, white 0deg, white ${obj.light_cone_width}deg, transparent ${obj.light_cone_width}deg, transparent 360deg)`
        : undefined;
    const shapeRadius = obj.light_shape === "cone" ? 0 : 9999;
    return (
      <div id={`bo-${obj.id}`} className="board-object-in group absolute top-0 left-0" style={style}>
        {controls}
        <div
          {...commonHandleProps}
          aria-label={obj.label || "Área de efeito"}
          className="aoe-pulse absolute inset-0 cursor-grab"
          style={{
            ...commonHandleProps.style,
            borderRadius: shapeRadius,
            backgroundColor: aoeColor,
            maskImage: coneMask,
            WebkitMaskImage: coneMask,
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            borderRadius: shapeRadius,
            boxShadow: `inset 0 0 0 2px ${aoeColor}`,
            maskImage: coneMask,
            WebkitMaskImage: coneMask,
          }}
        />
        {aoeRotateHandle}
      </div>
    );
  }

  if (obj.kind === "map") {
    return (
      <div
        id={`bo-${obj.id}`}
        className="board-object-in group absolute top-0 left-0 overflow-hidden parchment-surface rounded"
        style={style}
      >
        {controls}
        <div {...commonHandleProps} className="absolute inset-0 cursor-grab">
          {imgUrl ? (
            <img
              src={imgUrl}
              alt={obj.label ?? ""}
              className="h-full w-full object-cover mix-blend-multiply"
              draggable={false}
            />
          ) : (
            <div className="grid h-full w-full place-items-center text-xs uppercase tracking-widest text-ink/40">
              {obj.label ?? "Mapa"}
            </div>
          )}
        </div>
        {resizeHandle}
      </div>
    );
  }

  // image — standalone art (tokens, transparent-background PNGs, etc).
  // Unlike "map", this has no parchment card, no multiply blend, and no
  // cropping: a token's transparent background needs to stay transparent
  // (multiply against the dark table crushed light/transparent areas to
  // near-black) and its silhouette needs to stay uncropped (object-contain,
  // not object-cover) so the whole piece of art is visible as placed.
  if (obj.kind === "image") {
    return (
      <div id={`bo-${obj.id}`} className="board-object-in group absolute top-0 left-0" style={style}>
        {controls}
        <div {...commonHandleProps} className="absolute inset-0 cursor-grab">
          {imgUrl ? (
            <img
              src={imgUrl}
              alt={obj.label ?? ""}
              className="h-full w-full object-contain"
              draggable={false}
            />
          ) : (
            <div className="grid h-full w-full place-items-center rounded bg-ink-2/60 text-xs uppercase tracking-widest text-ink/40 ring-1 ring-primary/15">
              {obj.label ?? "Imagem"}
            </div>
          )}
        </div>
        {resizeHandle}
      </div>
    );
  }

  // sheet — real character preview, clickable to open the full editor
  if (obj.kind === "sheet") {
    const character = characters.find((c) => c.id === obj.character_id);
    const fields = normalizeSheet(character?.sheet)
      .flatMap((tab) => tab.fields)
      .filter((f) => f.type === "number" || f.type === "resource") as (
      | NumberField
      | ResourceField
    )[];
    return (
      <div
        id={`bo-${obj.id}`}
        className={`board-object-in group absolute top-0 left-0 parchment-surface rounded flex flex-col ${
          isSelected ? "ring-2 ring-primary" : ""
        }`}
        style={style}
      >
        {controls}
        <div
          {...commonHandleProps}
          onClick={() => onSelect?.()}
          onDoubleClick={() => character && onOpenCharacter?.(character)}
          className="flex flex-1 cursor-pointer flex-col gap-1.5 px-4 py-3"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && character) onOpenCharacter?.(character);
          }}
        >
          <div className="flex items-center justify-between">
            <span className="grimoire-title truncate text-base text-ink">
              {character?.name ?? obj.label ?? "Ficha"}
            </span>
            <span className="text-[9px] uppercase tracking-widest text-ink/50">Ficha</span>
          </div>
          {!character ? (
            <span className="text-xs italic text-ink/40">Personagem removido.</span>
          ) : fields.length === 0 ? (
            <span className="text-xs italic text-ink/40">
              Sem atributos ainda — toque duas vezes para editar.
            </span>
          ) : (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-ink/80">
              {fields.slice(0, 4).map((f) => (
                <div key={f.id} className="flex items-center justify-between">
                  <span className="truncate text-ink/60">{f.label}</span>
                  <span className="font-semibold">
                    {f.type === "resource" ? `${f.value}/${f.max}` : f.value}
                  </span>
                </div>
              ))}
            </div>
          )}
          {isSelected && (
            <span className="mt-auto text-[9px] italic text-ink/40">
              Toque duas vezes para abrir a ficha
            </span>
          )}
        </div>
        {resizeHandle}
      </div>
    );
  }

  // document — parchment card
  const content = ((obj.data ?? {}) as { content?: string }).content ?? "";
  const canEditDoc = isMaster && !obj.locked;
  return (
    <div
      id={`bo-${obj.id}`}
      className="board-object-in group absolute top-0 left-0 parchment-surface rounded flex flex-col"
      style={style}
    >
      {controls}
      <div
        {...commonHandleProps}
        className="flex cursor-grab items-center justify-between border-b border-ink/10 px-4 py-2"
      >
        <span className="grimoire-title text-base text-ink truncate">
          {obj.label ?? "Documento"}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] uppercase tracking-widest text-ink/50">Pergaminho</span>
          {canEditDoc && (
            <button
              onClick={() => {
                if (isEditingDoc) {
                  // Closing via the check button: same escape hatch as
                  // blur, in case the button click itself doesn't fire a
                  // native blur on the textarea before the DOM node swaps.
                  flushDocSave();
                }
                setIsEditingDoc((v) => {
                  const next = !v;
                  if (next) docDraftRef.current = { value: content, dirty: false };
                  return next;
                });
              }}
              aria-label={isEditingDoc ? "Parar de editar" : "Editar pergaminho"}
              title={isEditingDoc ? "Parar de editar" : "Editar pergaminho"}
              className="text-ink/50 hover:text-ink"
            >
              {isEditingDoc ? (
                <Check className="size-3.5" aria-hidden="true" />
              ) : (
                <Pencil className="size-3.5" aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      </div>
      {isEditingDoc ? (
        <textarea
          autoFocus
          defaultValue={content}
          onChange={(e) => {
            docDraftRef.current = { value: e.target.value, dirty: e.target.value !== content };
            if (docSaveTimerRef.current) clearTimeout(docSaveTimerRef.current);
            docSaveTimerRef.current = setTimeout(flushDocSave, 800);
          }}
          onBlur={(e) => {
            setIsEditingDoc(false);
            docDraftRef.current = { value: e.target.value, dirty: e.target.value !== content };
            flushDocSave();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.currentTarget.blur();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="grimoire-title flex-1 resize-none bg-transparent px-4 py-3 text-sm leading-relaxed text-ink/90 outline-none"
        />
      ) : (
        <div
          onDoubleClick={() => canEditDoc && setIsEditingDoc(true)}
          className="scrollbar-arcane grimoire-title flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed text-ink/90"
        >
          {content || (
            <span className="italic text-ink/40">
              {canEditDoc ? "Em branco — toque duas vezes para escrever." : "Este pergaminho está em branco."}
            </span>
          )}
        </div>
      )}
      {resizeHandle}
    </div>
  );
}

// Every board-level state change (panning, selecting a different object,
// a realtime update to some *other* object) used to re-render every single
// card, because none of them were memoized — on a board with a dozen+
// tokens this adds up fast, especially on weaker mobile CPUs. Callback
// props (onSelect, onReorder, etc.) are deliberately left out of the
// comparison: they get a new function identity most renders but always
// close over the same `obj`/id and call through to the same underlying
// handler, so comparing them would defeat the memoization for no benefit.
function objectViewPropsEqual(
  prev: Parameters<typeof ObjectViewImpl>[0],
  next: Parameters<typeof ObjectViewImpl>[0],
) {
  return (
    prev.obj === next.obj &&
    prev.isMaster === next.isMaster &&
    prev.currentUserId === next.currentUserId &&
    prev.isDragging === next.isDragging &&
    prev.isResizing === next.isResizing &&
    prev.isSelected === next.isSelected &&
    prev.showGrid === next.showGrid &&
    prev.hiddenByFog === next.hiddenByFog &&
    prev.characters === next.characters &&
    prev.lockToolActive === next.lockToolActive &&
    prev.isEditing === next.isEditing
  );
}

const ObjectView = memo(ObjectViewImpl, objectViewPropsEqual);

// Small thumbnail for the pin image gallery picker — resolves its own
// signed URL lazily so opening the picker doesn't sign every archived file
// up front, only the ones actually shown.
function GalleryThumb({ path, name }: { path: string | null; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!path) {
      setUrl(null);
      return;
    }
    supabase.storage
      .from("campaign-assets")
      .createSignedUrl(path, 60 * 60)
      .then(({ data, error }) => {
        if (cancelled || error) return;
        if (data?.signedUrl) setUrl(data.signedUrl);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (!url) return <div className="size-full animate-pulse bg-primary/10" />;
  return <img src={url} alt={name} className="size-full object-cover" />;
}

// A pin's full property editor — opened by double-clicking it (master
// only). The old floating toolbar only had room for a handful of icon
// buttons; this gives every pin property its own labeled control in one
// place, including things that had no UI at all before (renaming it,
// setting its size with a slider instead of only drag-resizing).
function PinPropertiesPanel({
  obj,
  characters,
  files,
  onClose,
  onUpdateObject,
  onResizeCommit,
  onSetLight,
  onToggleLock,
  onToggleVisibility,
  onLinkCharacter,
  onReorder,
  onRemoveObject,
  onDuplicateObject,
}: {
  obj: BoardObject;
  characters: Character[];
  files: FileRow[];
  onClose: () => void;
  onUpdateObject?: (obj: BoardObject, patch: Partial<BoardObject>) => void;
  onResizeCommit: (obj: BoardObject, width: number, height: number) => void;
  onSetLight?: (
    obj: BoardObject,
    patch: Partial<Pick<
      BoardObject,
      "has_light" | "light_radius" | "hidden_when_dark" | "light_shape" | "light_angle" | "light_cone_width"
    >>,
  ) => void;
  onToggleLock?: (obj: BoardObject) => void;
  onToggleVisibility?: (obj: BoardObject) => void;
  onLinkCharacter?: (obj: BoardObject, characterId: string | null) => void;
  onReorder?: (obj: BoardObject, dir: "front" | "back") => void;
  onRemoveObject?: (obj: BoardObject) => void;
  onDuplicateObject?: (obj: BoardObject) => void;
}) {
  const [label, setLabel] = useState(obj.label ?? "");
  // Keep the input in sync if a different pin's properties get opened, or
  // if the label changes from elsewhere (another master browser editing it
  // at the same time) — but only while this input isn't itself focused, so
  // an incoming update doesn't yank the caret out from under someone typing.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setLabel(obj.label ?? "");
  }, [obj.id, obj.label]);

  const commitLabel = () => {
    const next = label.trim();
    if (next !== (obj.label ?? "")) onUpdateObject?.(obj, { label: next || null });
  };

  const imgData = (obj.data ?? {}) as { storage_path?: string; image_url?: string };
  const [imageUrlInput, setImageUrlInput] = useState(imgData.image_url ?? "");
  const [showGalleryPicker, setShowGalleryPicker] = useState(false);
  useEffect(() => {
    if (document.activeElement?.id !== `pin-image-url-${obj.id}`) {
      setImageUrlInput(imgData.image_url ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obj.id, imgData.image_url]);

  const galleryImages = files.filter((f) => f.kind === "image" || f.kind === "map");

  const applyImageUrl = () => {
    const url = imageUrlInput.trim();
    const nextData = { ...(obj.data as Record<string, unknown> | null) };
    if (url) {
      nextData.image_url = url;
      delete nextData.storage_path;
    } else {
      delete nextData.image_url;
    }
    onUpdateObject?.(obj, { data: nextData as never });
  };

  const pickGalleryImage = (path: string) => {
    const nextData = { ...(obj.data as Record<string, unknown> | null), storage_path: path };
    delete nextData.image_url;
    setImageUrlInput("");
    onUpdateObject?.(obj, { data: nextData as never });
    setShowGalleryPicker(false);
  };

  const clearCustomImage = () => {
    const nextData = { ...(obj.data as Record<string, unknown> | null) };
    delete nextData.image_url;
    delete nextData.storage_path;
    setImageUrlInput("");
    onUpdateObject?.(obj, { data: nextData as never });
  };

  const hasCustomImage = !!imgData.image_url || !!imgData.storage_path;

  return (
    <div
      role="dialog"
      aria-label={`Propriedades de ${obj.label ?? "pin"}`}
      className="gold-frame pointer-events-auto absolute inset-x-0 bottom-0 top-auto z-40 flex max-h-[75vh] w-full flex-col overflow-hidden rounded-t-lg bg-ink-2/95 shadow-2xl backdrop-blur-md md:inset-x-auto md:top-4 md:right-4 md:bottom-4 md:max-h-none md:w-72 md:rounded-lg"
    >
      {/* Small drag-style grabber, mobile-only — signals "this is a sheet,
          not a full page" the way the rest of the app's bottom sheets do. */}
      <div className="mx-auto mt-1.5 h-1 w-10 shrink-0 rounded-full bg-primary/20 md:hidden" aria-hidden="true" />
      <div className="flex items-center justify-between border-b border-primary/15 px-4 py-3">
        <h3 className="grimoire-title text-sm text-primary">Propriedades do pin</h3>
        <button
          onClick={onClose}
          aria-label="Fechar propriedades"
          title="Fechar"
          className="grid size-6 place-items-center rounded hover:bg-primary/10 hover:text-primary"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="scrollbar-arcane flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <div>
          <label
            htmlFor={`pin-label-${obj.id}`}
            className="mb-1 block text-[10px] uppercase tracking-widest text-muted-foreground"
          >
            Nome
          </label>
          <input
            ref={inputRef}
            id={`pin-label-${obj.id}`}
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setLabel(obj.label ?? "");
                e.currentTarget.blur();
              }
            }}
            placeholder="Sem nome"
            className="w-full rounded border border-primary/20 bg-ink px-2 py-1.5 text-xs text-primary"
          />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-muted-foreground">
            <span>Tamanho</span>
            <span>{obj.width || 40}px</span>
          </div>
          <Slider
            defaultValue={[obj.width || 40]}
            min={20}
            max={200}
            step={4}
            onValueCommit={([v]) => onResizeCommit(obj, v, v)}
          />
        </div>

        <div>
          <label
            htmlFor={`pin-char-${obj.id}`}
            className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground"
          >
            <UserRound className="size-3 text-primary/70" aria-hidden="true" />
            Personagem vinculado
          </label>
          <select
            id={`pin-char-${obj.id}`}
            value={obj.character_id ?? ""}
            onChange={(e) => onLinkCharacter?.(obj, e.target.value || null)}
            className="w-full rounded border border-primary/20 bg-ink px-2 py-1.5 text-xs text-primary"
          >
            <option value="">Nenhum (letra)</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="border-t border-primary/10 pt-3">
          <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-widest text-muted-foreground">
            <span>Imagem do pin</span>
            {hasCustomImage && (
              <button
                onClick={clearCustomImage}
                className="text-primary/70 underline-offset-2 hover:text-primary hover:underline"
              >
                Remover
              </button>
            )}
          </div>
          {/* A custom image (URL or gallery pick) overrides the linked
              character's portrait — lets a pin show any art, even one with
              no character sheet behind it (a monster, a prop, a landmark). */}
          <p className="mb-2 text-[10px] leading-snug text-muted-foreground">
            Sobrepõe o retrato do personagem vinculado, se houver.
          </p>
          <div className="mb-2 flex gap-1.5">
            <input
              id={`pin-image-url-${obj.id}`}
              type="text"
              value={imageUrlInput}
              onChange={(e) => setImageUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyImageUrl();
              }}
              placeholder="Cole a URL de uma imagem"
              className="w-full rounded border border-primary/20 bg-ink px-2 py-1.5 text-xs text-primary"
            />
            <button
              onClick={applyImageUrl}
              className="shrink-0 rounded px-2 py-1.5 text-xs ring-1 ring-primary/25 text-primary hover:bg-primary/15"
            >
              Usar
            </button>
          </div>
          <button
            onClick={() => setShowGalleryPicker((v) => !v)}
            className="w-full rounded px-2 py-1.5 text-xs ring-1 ring-primary/20 text-muted-foreground hover:bg-primary/10"
          >
            {showGalleryPicker ? "Fechar galeria" : "Escolher da galeria…"}
          </button>
          {showGalleryPicker && (
            <div className="scrollbar-arcane mt-2 grid max-h-40 grid-cols-4 gap-1.5 overflow-y-auto rounded border border-primary/15 bg-ink/60 p-1.5">
              {galleryImages.length === 0 && (
                <p className="col-span-4 py-2 text-center text-[10px] text-muted-foreground">
                  Nenhuma imagem arquivada ainda.
                </p>
              )}
              {galleryImages.map((f) => (
                <button
                  key={f.id}
                  onClick={() => f.storage_path && pickGalleryImage(f.storage_path)}
                  title={f.name}
                  className={`aspect-square overflow-hidden rounded ring-1 ${
                    imgData.storage_path === f.storage_path
                      ? "ring-primary"
                      : "ring-primary/15 hover:ring-primary/40"
                  }`}
                >
                  <GalleryThumb path={f.storage_path} name={f.name} />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onToggleLock?.(obj)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs ring-1 ${
              obj.locked
                ? "bg-primary/25 ring-primary/50 text-primary"
                : "ring-primary/20 text-muted-foreground hover:bg-primary/10"
            }`}
          >
            {obj.locked ? (
              <Lock className="size-3.5" aria-hidden="true" />
            ) : (
              <Unlock className="size-3.5" aria-hidden="true" />
            )}
            {obj.locked ? "Travado" : "Destravado"}
          </button>
          <button
            onClick={() => onToggleVisibility?.(obj)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs ring-1 ${
              obj.visible_to_players
                ? "bg-primary/25 ring-primary/50 text-primary"
                : "ring-primary/20 text-muted-foreground hover:bg-primary/10"
            }`}
          >
            {obj.visible_to_players ? (
              <Eye className="size-3.5" aria-hidden="true" />
            ) : (
              <EyeOff className="size-3.5" aria-hidden="true" />
            )}
            {obj.visible_to_players ? "Visível" : "Oculto"}
          </button>
        </div>

        <div className="border-t border-primary/10 pt-3">
          <div className="mb-2 flex items-center justify-between">
            <label htmlFor={`pin-light-${obj.id}`} className="flex items-center gap-1.5 text-xs">
              <Flame className="size-3.5 text-primary" aria-hidden="true" />
              Emite luz
            </label>
            <input
              id={`pin-light-${obj.id}`}
              type="checkbox"
              checked={obj.has_light}
              onChange={() => onSetLight?.(obj, { has_light: !obj.has_light })}
              className="size-4 accent-primary"
            />
          </div>
          {obj.has_light && (
            <>
              <div className="mb-3 flex gap-1.5">
                <button
                  onClick={() => onSetLight?.(obj, { light_shape: "circle" })}
                  className={`flex-1 rounded px-2 py-1 text-xs ring-1 ${
                    obj.light_shape === "circle"
                      ? "bg-primary/25 ring-primary/50 text-primary"
                      : "ring-primary/20 text-muted-foreground hover:bg-primary/10"
                  }`}
                >
                  ◯ Círculo
                </button>
                <button
                  onClick={() => onSetLight?.(obj, { light_shape: "cone" })}
                  className={`flex-1 rounded px-2 py-1 text-xs ring-1 ${
                    obj.light_shape === "cone"
                      ? "bg-primary/25 ring-primary/50 text-primary"
                      : "ring-primary/20 text-muted-foreground hover:bg-primary/10"
                  }`}
                >
                  ◣ Cone
                </button>
              </div>
              <div className="mb-3">
                <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>{obj.light_shape === "cone" ? "Alcance do cone" : "Raio da luz"}</span>
                  <span>{obj.light_radius}px</span>
                </div>
                <Slider
                  defaultValue={[obj.light_radius]}
                  min={50}
                  max={1000}
                  step={25}
                  onValueCommit={([v]) => onSetLight?.(obj, { light_radius: v })}
                />
              </div>
              {obj.light_shape === "cone" && (
                <div className="mb-3">
                  <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>Abertura do cone</span>
                    <span>{obj.light_cone_width}°</span>
                  </div>
                  <Slider
                    defaultValue={[obj.light_cone_width]}
                    min={15}
                    max={180}
                    step={5}
                    onValueCommit={([v]) => onSetLight?.(obj, { light_cone_width: v })}
                  />
                </div>
              )}
            </>
          )}
          <div className="flex items-center justify-between">
            <label htmlFor={`pin-fog-${obj.id}`} className="flex items-center gap-1.5 text-xs">
              <Ghost className="size-3.5 text-primary" aria-hidden="true" />
              Só visível se iluminado
            </label>
            <input
              id={`pin-fog-${obj.id}`}
              type="checkbox"
              checked={obj.hidden_when_dark}
              onChange={() => onSetLight?.(obj, { hidden_when_dark: !obj.hidden_when_dark })}
              className="size-4 accent-primary"
            />
          </div>
        </div>

        <div className="border-t border-primary/10 pt-3">
          <span className="mb-1 block text-[10px] uppercase tracking-widest text-muted-foreground">
            Camada
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => onReorder?.(obj, "back")}
              className="flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs ring-1 ring-primary/20 text-muted-foreground hover:bg-primary/10"
            >
              <ChevronsDown className="size-3.5" aria-hidden="true" />
              Trás
            </button>
            <button
              onClick={() => onReorder?.(obj, "front")}
              className="flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs ring-1 ring-primary/20 text-muted-foreground hover:bg-primary/10"
            >
              <ChevronsUp className="size-3.5" aria-hidden="true" />
              Frente
            </button>
          </div>
        </div>
      </div>

      <div className="flex gap-2 border-t border-primary/15 px-4 py-3">
        <button
          onClick={() => onDuplicateObject?.(obj)}
          className="flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs ring-1 ring-primary/25 text-primary hover:bg-primary/15"
        >
          <Copy className="size-3.5" aria-hidden="true" />
          Duplicar
        </button>
        <button
          onClick={() => onRemoveObject?.(obj)}
          className="flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs ring-1 ring-destructive/40 text-destructive hover:bg-destructive/20"
        >
          <X className="size-3.5" aria-hidden="true" />
          Remover
        </button>
      </div>
    </div>
  );
}