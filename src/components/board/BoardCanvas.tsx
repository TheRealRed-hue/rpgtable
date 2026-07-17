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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";

interface Props {
  objects: BoardObject[];
  isMaster: boolean;
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
  onSetLight?: (
    obj: BoardObject,
    patch: Partial<Pick<BoardObject, "has_light" | "light_radius" | "hidden_when_dark">>,
  ) => void;
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

  // Object drag
  const startObjDrag = useCallback(
    (obj: BoardObject, e: React.PointerEvent) => {
      if (!isMaster || obj.locked) {
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
    [isMaster],
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
        const { error } = await supabase
          .from("board_objects")
          .update({ x, y })
          .eq("id", dragObj.id);
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
  }, [dragObj, viewport.scale, onObjectMove, showGrid]);

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
        .map((o) => ({ ...getObjectCenter(o), radius: o.light_radius })),
    [objects, getObjectCenter],
  );
  const isLit = useCallback(
    (o: BoardObject) => {
      if (lightSources.length === 0) return false;
      const { cx, cy } = getObjectCenter(o);
      return lightSources.some((l) => (cx - l.cx) ** 2 + (cy - l.cy) ** 2 <= l.radius ** 2);
    },
    [lightSources, getObjectCenter],
  );

  const FOG_BOUNDS = { left: -3000, top: -3000, size: 6000 };

  const fogStyle = useMemo((): React.CSSProperties => {
    const base: React.CSSProperties = {
      left: FOG_BOUNDS.left,
      top: FOG_BOUNDS.top,
      width: FOG_BOUNDS.size,
      height: FOG_BOUNDS.size,
      zIndex: 5000,
      mixBlendMode: "multiply",
      opacity: 0.9,
    };
    if (lightSources.length === 0) return { ...base, backgroundColor: "var(--ink)" };
    return {
      ...base,
      backgroundImage: lightSources
        .map(
          (l) =>
            `radial-gradient(circle at ${l.cx - FOG_BOUNDS.left}px ${
              l.cy - FOG_BOUNDS.top
            }px, white 0%, var(--ink) ${l.radius}px)`,
        )
        .join(", "),
      backgroundBlendMode: lightSources.length > 1 ? "screen" : undefined,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightSources]);

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
            with soft holes carved out around each light-emitting object. */}
        {!isMaster && <div aria-hidden="true" className="pointer-events-none absolute" style={fogStyle} />}

        {objects
          .slice()
          .sort((a, b) => a.z_index - b.z_index)
          .map((o) => (
            <ObjectView
              key={o.id}
              obj={o}
              isMaster={isMaster}
              onDragStart={startObjDrag}
              onObjectMove={onObjectMove}
              onReorder={onReorder}
              onToggleLock={onToggleLock}
              onToggleVisibility={onToggleVisibility}
              onRemoveObject={onRemoveObject}
              onEditDocument={onEditDocument}
              onSetLight={onSetLight}
              isDragging={dragObj?.id === o.id}
              showGrid={showGrid}
              characters={characters}
              onOpenCharacter={onOpenCharacter}
              isSelected={selectedId === o.id}
              onSelect={() => setSelectedId(o.id)}
              onResizeStart={startObjResize}
              isResizing={resizeObj?.id === o.id}
              hiddenByFog={!isMaster && o.hidden_when_dark && !isLit(o)}
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
  isResizing = false,
  hiddenByFog = false,
  onToggleLock,
  onToggleVisibility,
  onRemoveObject,
  onEditDocument,
  onSetLight,
}: {
  obj: BoardObject;
  isMaster: boolean;
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
    patch: Partial<Pick<BoardObject, "has_light" | "light_radius" | "hidden_when_dark">>,
  ) => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [isEditingDoc, setIsEditingDoc] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const data = (obj.data ?? {}) as { storage_path?: string };
    if ((obj.kind === "map" || obj.kind === "image") && data.storage_path) {
      supabase.storage
        .from("campaign-assets")
        .createSignedUrl(data.storage_path, 60 * 60)
        .then(({ data: sig, error }) => {
          if (cancelled) return;
          if (error) {
            toast.error("Não foi possível carregar a imagem: " + error.message);
            return;
          }
          if (sig?.signedUrl) setImgUrl(sig.signedUrl);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [obj.id, obj.kind, obj.data]);

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
    const { error } = await supabase.from("board_objects").update({ x, y }).eq("id", obj.id);
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

  const controls = isMaster && (
    <div
      className={`pointer-events-auto absolute -top-9 left-0 flex gap-1 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${
        isSelected ? "opacity-100" : "opacity-0"
      }`}
    >
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
            <div className="mb-3">
              <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
                <span>Raio da luz</span>
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
        </PopoverContent>
      </Popover>
      <button
        onClick={() => onReorder?.(obj, "back")}
        aria-label="Mandar para trás"
        title="Mandar para trás (sobreposição)"
        className="grid h-7 w-7 place-items-center rounded bg-ink-2/95 ring-1 ring-primary/25 text-primary hover:bg-primary/20"
      >
        <ChevronsDown className="size-3.5" aria-hidden="true" />
      </button>
      <button
        onClick={() => onReorder?.(obj, "front")}
        aria-label="Trazer para frente"
        title="Trazer para frente (sobreposição)"
        className="grid h-7 w-7 place-items-center rounded bg-ink-2/95 ring-1 ring-primary/25 text-primary hover:bg-primary/20"
      >
        <ChevronsUp className="size-3.5" aria-hidden="true" />
      </button>
      <button
        onClick={() => onRemoveObject?.(obj)}
        aria-label="Remover objeto"
        title="Remover"
        className="grid h-7 w-7 place-items-center rounded bg-ink-2/95 ring-1 ring-destructive/40 text-destructive hover:bg-destructive/20"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
      {!obj.locked && (
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
        <div
          {...commonHandleProps}
          className={`candle-glow relative grid cursor-grab place-items-center rounded-full bg-wax ring-2 ring-primary/40 ${
            obj.locked ? "cursor-not-allowed" : ""
          }`}
          style={{ ...commonHandleProps.style, width: size, height: size }}
        >
          <span className="grimoire-title text-sm text-primary">
            {(obj.label ?? "•").slice(0, 1).toUpperCase()}
          </span>
          {resizeHandle}
        </div>
        {obj.label && (
          <div className="mt-2 max-w-[10rem] text-center text-[11px] font-medium tracking-wide text-primary/80">
            {obj.label}
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
              onClick={() => setIsEditingDoc((v) => !v)}
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
          onBlur={(e) => {
            setIsEditingDoc(false);
            if (e.target.value !== content) onEditDocument?.(obj, e.target.value);
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
    prev.isDragging === next.isDragging &&
    prev.isResizing === next.isResizing &&
    prev.isSelected === next.isSelected &&
    prev.showGrid === next.showGrid &&
    prev.hiddenByFog === next.hiddenByFog &&
    prev.characters === next.characters
  );
}

const ObjectView = memo(ObjectViewImpl, objectViewPropsEqual);