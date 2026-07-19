import { useEffect, useRef, useState, useCallback, useMemo, memo } from "react";
import type { BoardObject, Character } from "@/lib/board-types";
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
  onDropCharacterFromSidebar,
  onOpenCharacter,
  themeId,
  onReorder,
  onToggleLock,
  onToggleVisibility,
  onRemoveObject,
  onEditDocument,
  onSetLight,
  onLinkCharacter,
  onRotateOwnLight,
  dynamicLighting = true,
  onToggleDynamicLighting,
}: Props) {
  const theme = getBoardTheme(themeId);
  const containerRef = useRef<HTMLDivElement>(null);
  const worldLayerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const [showGrid, setShowGrid] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  // Reorder/lock/visibility controls used to only reveal on :hover, which
  // has no touch equivalent — tapping an object now selects it and keeps
  // those controls visible until something else is tapped.
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      containerRef.current.style.backgroundSize = `${40 * v.scale}px ${40 * v.scale}px, ${8 * v.scale}px ${8 * v.scale}px`;
      containerRef.current.style.backgroundPosition = `${v.x}px ${v.y}px`;
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

  // Bring-to-front / send-to-back is now handled by the campaign page's
  // onReorder (it needs to patch the query cache immediately, not just
  // write to Supabase and wait for Realtime — see the Props comment above).

  // Dynamic light/vision: recomputed from current object positions (no
  // persisted "revealed" memory) — but only when `objects` itself changes,
  // not on every render (panning, selecting, opening a popover...). This
  // was rebuilding the whole light map — and, worse, the darkness overlay's
  // gradient string below — on every single render.
  const getObjectCenter = useCallback(
    (o: BoardObject) => ({
      cx: o.x + o.width / 2,
      cy: o.y + (o.kind === "pin" ? o.width : o.height) / 2,
    }),
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
  // showed up fully lit regardless of has_light/hidden_when_dark. Instead,
  // size it from the actual extent of whatever is on the board, padded out
  // generously so panning a bit past the edge still reads as dark, with a
  // sane floor for an empty/near-empty scene.
  const BOUNDS_PADDING = 2000;
  const BOUNDS_MIN_SIZE = 6000;
  const boardBounds = useMemo(() => {
    if (objects.length === 0) {
      return { left: -BOUNDS_MIN_SIZE / 2, top: -BOUNDS_MIN_SIZE / 2, size: BOUNDS_MIN_SIZE };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
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
  }, [objects]);

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
          backgroundImage: `radial-gradient(circle at ${x}px ${y}px, white 0%, transparent ${l.radius}px)`,
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
      opacity: 0.9,
      backgroundColor: "var(--ink)",
    }),
    [boardBounds],
  );

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) setSelectedId(null);
      }}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      className="relative h-full w-full overflow-hidden select-none touch-none"
      style={{
        cursor: isPanning ? "grabbing" : "default",
        touchAction: "none",
        backgroundImage: `radial-gradient(${theme.dot} 1px, transparent 1px), radial-gradient(oklch(0.25 0.02 60) 1px, transparent 1px)`,
        backgroundSize: `${40 * viewport.scale}px ${40 * viewport.scale}px, ${8 * viewport.scale}px ${8 * viewport.scale}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
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
        {showGrid && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute"
            style={{
              left: -3000,
              top: -3000,
              width: 6000,
              height: 6000,
              backgroundImage:
                "linear-gradient(to right, oklch(0.72 0.11 78 / 0.22) 1px, transparent 1px), linear-gradient(to bottom, oklch(0.72 0.11 78 / 0.22) 1px, transparent 1px)",
              backgroundSize: `${GRID_CELL_PX}px ${GRID_CELL_PX}px`,
            }}
          />
        )}

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
              onLinkCharacter={onLinkCharacter}
              isDragging={dragObj?.id === o.id}
              showGrid={showGrid}
              characters={characters}
              onOpenCharacter={onOpenCharacter}
              isSelected={selectedId === o.id}
              onSelect={() => setSelectedId(o.id)}
              onResizeStart={startObjResize}
              onRotateStart={startObjRotate}
              isResizing={resizeObj?.id === o.id}
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

      {/* Zoom controls */}
      <div
        role="group"
        aria-label="Controles de zoom"
        className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full bg-ink-2/90 p-1.5 ring-1 ring-primary/25 backdrop-blur-md shadow-xl"
      >
        {isMaster && (
          <>
            <Button
              size="sm"
              variant="ghost"
              aria-label={showGrid ? "Ocultar grade de movimento" : "Mostrar grade de movimento"}
              aria-pressed={showGrid}
              title="Grade de movimento — 1 quadrado = 1,5m"
              className={`h-8 w-8 p-0 hover:bg-primary/10 ${
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
                className={`h-8 w-8 p-0 hover:bg-primary/10 ${
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
            <div className="h-4 w-px bg-primary/15" aria-hidden="true" />
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-label="Diminuir zoom"
          className="h-8 w-8 p-0 text-primary hover:bg-primary/10"
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
          className="h-8 w-8 p-0 text-primary hover:bg-primary/10"
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
  onLinkCharacter,
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
  onLinkCharacter?: (obj: BoardObject, characterId: string | null) => void;
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
    const data = (obj.data ?? {}) as { storage_path?: string };
    const portraitPath = obj.kind === "pin" ? linkedCharacter?.portrait_path : undefined;
    const path = (obj.kind === "map" || obj.kind === "image") && data.storage_path
      ? data.storage_path
      : portraitPath;
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

  const commonHandleProps = {
    onPointerDown: (e: React.PointerEvent) => onDragStart(obj, e),
    onClick: () => onSelect?.(),
    // Without this, mobile browsers intercept the finger-down as a page
    // scroll/zoom gesture before our pointer handler gets a clean drag.
    style: { touchAction: "none" as const },
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
      {isMaster && (
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

  const resizeHandle = isMaster && !obj.locked && (
    <div
      onPointerDown={(e) => onResizeStart?.(obj, e)}
      role="presentation"
      aria-label="Redimensionar objeto"
      title="Arraste para redimensionar"
      className={`pointer-events-auto absolute right-1 bottom-1 z-10 size-3.5 cursor-nwse-resize rounded-full bg-primary ring-2 ring-ink-2 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${
        isSelected || isResizing ? "opacity-100" : "opacity-0"
      }`}
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

  const style: React.CSSProperties = {
    transform: `translate(${obj.x}px, ${obj.y}px)${isDragging ? " scale(1.03)" : ""}`,
    width: obj.width,
    height: obj.kind === "pin" ? undefined : obj.height,
    zIndex: isDragging ? 9999 : obj.z_index,
    opacity: !obj.visible_to_players && isMaster ? 0.55 : 1,
    boxShadow: isDragging ? "0 12px 28px -8px oklch(0 0 0 / 0.55)" : undefined,
    transition: isDragging || isResizing ? "none" : "box-shadow 120ms ease",
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
            className={`candle-glow grid h-full w-full cursor-grab place-items-center overflow-hidden rounded-full bg-wax ring-2 ring-primary/40 ${
              obj.locked ? "cursor-not-allowed" : ""
            }`}
            style={commonHandleProps.style}
          >
            {linkedCharacter?.portrait_path && imgUrl ? (
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
    prev.characters === next.characters
  );
}

const ObjectView = memo(ObjectViewImpl, objectViewPropsEqual);