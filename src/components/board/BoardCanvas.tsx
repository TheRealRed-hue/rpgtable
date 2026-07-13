import { useEffect, useRef, useState, useCallback } from "react";
import type { BoardObject } from "@/lib/board-types";
import { supabase } from "@/integrations/supabase/client";
import { Lock, Unlock, Eye, EyeOff, X, Move } from "lucide-react";
import { Button } from "@/components/ui/button";
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
}

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

const KEYBOARD_NUDGE_STEP = 10;
const KEYBOARD_NUDGE_STEP_LARGE = 40;

export function BoardCanvas({ objects, isMaster, onDropFromSidebar, onObjectMove }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const [dragObj, setDragObj] = useState<{
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  // Pan handling on canvas background
  const onMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).dataset.canvasBg !== "1" && e.button !== 1) return;
    setIsPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY, vx: viewport.x, vy: viewport.y };
  };

  useEffect(() => {
    if (!isPanning) return;
    const onMove = (e: MouseEvent) => {
      const start = panStart.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      setViewport((v) => ({ ...v, x: start.vx + dx, y: start.vy + dy }));
    };
    const onUp = () => {
      setIsPanning(false);
      panStart.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isPanning]);

  // Zoom with wheel
  const onWheel = (e: React.WheelEvent) => {
    if (!containerRef.current) return;
    e.preventDefault();
    const rect = containerRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const delta = -e.deltaY * 0.0015;
    const newScale = Math.max(0.25, Math.min(2.5, viewport.scale * (1 + delta)));
    // Keep the point under cursor fixed
    const wx = (mx - viewport.x) / viewport.scale;
    const wy = (my - viewport.y) / viewport.scale;
    const nx = mx - wx * newScale;
    const ny = my - wy * newScale;
    setViewport({ x: nx, y: ny, scale: newScale });
  };

  // Object drag
  const startObjDrag = useCallback(
    (obj: BoardObject, e: React.MouseEvent) => {
      if (!isMaster || obj.locked) return;
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
    const onMove = (e: MouseEvent) => {
      const dx = (e.clientX - dragObj.startX) / viewport.scale;
      const dy = (e.clientY - dragObj.startY) / viewport.scale;
      latest = { x: dragObj.origX + dx, y: dragObj.origY + dy };
      // Direct DOM write during the drag itself — avoids a React re-render
      // (and the cost of re-sorting/re-rendering every object) on every
      // mousemove, which matters once a scene has many objects on it.
      const el = document.getElementById(`bo-${dragObj.id}`);
      if (el) {
        el.style.transform = `translate(${latest.x}px, ${latest.y}px)`;
      }
    };
    const onUp = async () => {
      if (latest) {
        const { x, y } = latest;
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
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragObj, viewport.scale, onObjectMove]);

  // Drop from sidebar
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const fileId = e.dataTransfer.getData("text/file-id");
    if (!fileId || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const wx = (e.clientX - rect.left - viewport.x) / viewport.scale;
    const wy = (e.clientY - rect.top - viewport.y) / viewport.scale;
    onDropFromSidebar(fileId, wx, wy);
  };

  const resetView = () => setViewport({ x: 0, y: 0, scale: 1 });

  return (
    <div
      ref={containerRef}
      onMouseDown={onMouseDown}
      onWheel={onWheel}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      className="relative h-full w-full overflow-hidden select-none"
      style={{
        cursor: isPanning ? "grabbing" : "default",
        backgroundImage:
          "radial-gradient(oklch(0.72 0.11 78 / 0.06) 1px, transparent 1px), radial-gradient(oklch(0.25 0.02 60) 1px, transparent 1px)",
        backgroundSize: `${40 * viewport.scale}px ${40 * viewport.scale}px, ${8 * viewport.scale}px ${8 * viewport.scale}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
      }}
      data-canvas-bg="1"
    >
      {/* World layer */}
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
        }}
      >
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

      {/* Zoom controls */}
      <div
        role="group"
        aria-label="Controles de zoom"
        className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full bg-ink-2/90 p-1.5 ring-1 ring-primary/25 backdrop-blur-md shadow-xl"
      >
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

function ObjectView({
  obj,
  isMaster,
  onDragStart,
  onObjectMove,
}: {
  obj: BoardObject;
  isMaster: boolean;
  onDragStart: (obj: BoardObject, e: React.MouseEvent) => void;
  onObjectMove?: (id: string, x: number, y: number) => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);

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

  const removeObject = async () => {
    try {
      const { error } = await supabase.from("board_objects").delete().eq("id", obj.id);
      if (error) throw error;
    } catch (err) {
      toast.error(
        "Não foi possível remover: " + (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  const toggleLock = async () => {
    try {
      const { error } = await supabase
        .from("board_objects")
        .update({ locked: !obj.locked })
        .eq("id", obj.id);
      if (error) throw error;
    } catch (err) {
      toast.error(
        "Não foi possível travar/destravar: " + (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  const toggleVisibility = async () => {
    try {
      const { error } = await supabase
        .from("board_objects")
        .update({ visible_to_players: !obj.visible_to_players })
        .eq("id", obj.id);
      if (error) throw error;
    } catch (err) {
      toast.error(
        "Não foi possível alterar visibilidade: " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  // Keyboard alternative to mouse-drag repositioning (accessibility): arrow
  // keys nudge the object; holding Shift moves it in larger steps.
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
    const step = e.shiftKey ? KEYBOARD_NUDGE_STEP_LARGE : KEYBOARD_NUDGE_STEP;
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
    onMouseDown: (e: React.MouseEvent) => onDragStart(obj, e),
  };

  const controls = isMaster && (
    <div className="pointer-events-auto absolute -top-9 left-0 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <button
        onClick={toggleLock}
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
        onClick={toggleVisibility}
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
      <button
        onClick={removeObject}
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

  const style: React.CSSProperties = {
    transform: `translate(${obj.x}px, ${obj.y}px)`,
    width: obj.width,
    height: obj.kind === "pin" ? undefined : obj.height,
    zIndex: obj.z_index,
    opacity: !obj.visible_to_players && isMaster ? 0.55 : 1,
  };

  // Render by kind
  if (obj.kind === "pin") {
    return (
      <div
        id={`bo-${obj.id}`}
        className="ink-bleed-in group absolute top-0 left-0"
        style={{ ...style, width: "auto", height: "auto" }}
      >
        {controls}
        <div
          {...commonHandleProps}
          className={`candle-glow relative grid size-10 cursor-grab place-items-center rounded-full bg-wax ring-2 ring-primary/40 ${
            obj.locked ? "cursor-not-allowed" : ""
          }`}
        >
          <span className="grimoire-title text-sm text-primary">
            {(obj.label ?? "•").slice(0, 1).toUpperCase()}
          </span>
        </div>
        {obj.label && (
          <div className="mt-2 max-w-[10rem] text-center text-[11px] font-medium tracking-wide text-primary/80">
            {obj.label}
          </div>
        )}
      </div>
    );
  }

  if (obj.kind === "map" || obj.kind === "image") {
    return (
      <div
        id={`bo-${obj.id}`}
        className="ink-bleed-in group absolute top-0 left-0 overflow-hidden parchment-surface rounded"
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
      </div>
    );
  }

  // document / sheet — parchment card
  const content = ((obj.data ?? {}) as { content?: string }).content ?? "";
  return (
    <div
      id={`bo-${obj.id}`}
      className="ink-bleed-in group absolute top-0 left-0 parchment-surface rounded flex flex-col"
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
        <span className="text-[9px] uppercase tracking-widest text-ink/50">
          {obj.kind === "sheet" ? "Ficha" : "Pergaminho"}
        </span>
      </div>
      <div className="scrollbar-arcane grimoire-title flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed text-ink/90">
        {content || <span className="italic text-ink/40">Este pergaminho está em branco.</span>}
      </div>
    </div>
  );
}
