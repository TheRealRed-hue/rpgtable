import { useCallback, useEffect, useRef, useState } from "react";
import type { CampaignPage, PageBlock, PageBlockType } from "@/lib/board-types";
import { PAGE_BLOCK_LABELS } from "@/lib/board-types";
import {
  ChevronUp,
  ChevronDown,
  Trash2,
  Plus,
  Minus,
} from "lucide-react";

function makeBlockId() {
  return crypto.randomUUID();
}

function normalizeBlocks(raw: unknown): PageBlock[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [{ id: makeBlockId(), type: "paragraph", text: "" }];
  }
  return raw.map((b) => {
    const block = b as Partial<PageBlock>;
    return {
      id: block.id ?? makeBlockId(),
      type: (block.type as PageBlockType) ?? "paragraph",
      text: block.text ?? "",
    };
  });
}

const TEXTUAL_TYPES = new Set<PageBlockType>([
  "heading1",
  "heading2",
  "paragraph",
  "bulleted_list",
  "numbered_list",
  "quote",
]);

interface BlockEditorProps {
  page: CampaignPage;
  readOnly: boolean;
  onSave: (blocks: PageBlock[]) => void;
}

// Keyed by page.id from the parent, so switching pages fully remounts this
// component — the unmount cleanup below then flushes whatever was still
// unsaved on the page being left, the same fix applied to the board's
// pergaminho editor (autosave on a debounce is not enough by itself: if the
// screen changes before the debounce fires, the draft has to be flushed on
// teardown or it's gone for good).
export function BlockEditor({ page, readOnly, onSave }: BlockEditorProps) {
  const [blocks, setBlocks] = useState<PageBlock[]>(() => normalizeBlocks(page.blocks));
  const draftRef = useRef<{ blocks: PageBlock[]; dirty: boolean }>({ blocks, dirty: false });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const textRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const focusRequest = useRef<{ id: string; caret: "start" | "end" } | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (draftRef.current.dirty) {
      onSaveRef.current(draftRef.current.blocks);
      draftRef.current.dirty = false;
    }
  }, []);

  useEffect(() => {
    return () => flush();
  }, [flush]);

  useEffect(() => {
    if (!focusRequest.current) return;
    const { id, caret } = focusRequest.current;
    focusRequest.current = null;
    const el = textRefs.current.get(id);
    if (el) {
      el.focus();
      const pos = caret === "start" ? 0 : el.value.length;
      el.setSelectionRange(pos, pos);
    }
  }, [blocks]);

  const commit = (next: PageBlock[], focus?: { id: string; caret: "start" | "end" }) => {
    setBlocks(next);
    draftRef.current = { blocks: next, dirty: true };
    if (focus) focusRequest.current = focus;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, 800);
  };

  const updateText = (id: string, text: string) => {
    commit(blocks.map((b) => (b.id === id ? { ...b, text } : b)));
  };

  const changeType = (id: string, type: PageBlockType) => {
    commit(
      blocks.map((b) => (b.id === id ? { ...b, type, text: type === "divider" ? undefined : b.text } : b)),
    );
  };

  const addBlockAfter = (id: string, type: PageBlockType = "paragraph") => {
    const idx = blocks.findIndex((b) => b.id === id);
    const newBlock: PageBlock = { id: makeBlockId(), type, text: "" };
    const next = [...blocks.slice(0, idx + 1), newBlock, ...blocks.slice(idx + 1)];
    commit(next, { id: newBlock.id, caret: "start" });
  };

  const removeBlock = (id: string) => {
    if (blocks.length <= 1) return;
    const idx = blocks.findIndex((b) => b.id === id);
    const prev = blocks[idx - 1];
    const next = blocks.filter((b) => b.id !== id);
    commit(next, prev ? { id: prev.id, caret: "end" } : undefined);
  };

  const moveBlock = (id: string, dir: -1 | 1) => {
    const idx = blocks.findIndex((b) => b.id === id);
    const target = idx + dir;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[idx], next[target]] = [next[target], next[idx]];
    commit(next);
  };

  return (
    <div className="scrollbar-arcane grimoire-title mx-auto max-w-4xl flex-1 overflow-auto px-6 py-10 text-ink/90 sm:px-12">
      <div className="flex flex-col gap-1">
        {blocks.map((block, i) => (
          <BlockRow
            key={block.id}
            block={block}
            readOnly={readOnly}
            isFirst={i === 0}
            isLast={i === blocks.length - 1}
            registerRef={(el) => {
              if (el) textRefs.current.set(block.id, el);
              else textRefs.current.delete(block.id);
            }}
            onTextChange={(text) => updateText(block.id, text)}
            onTypeChange={(type) => changeType(block.id, type)}
            onEnter={() => addBlockAfter(block.id)}
            onBackspaceEmpty={() => removeBlock(block.id)}
            onMoveUp={() => moveBlock(block.id, -1)}
            onMoveDown={() => moveBlock(block.id, 1)}
            onDelete={() => removeBlock(block.id)}
            onAddBelow={() => addBlockAfter(block.id)}
          />
        ))}
      </div>
      {readOnly && blocks.length === 1 && !blocks[0].text && (
        <p className="italic text-ink/40">Esta página está em branco.</p>
      )}
    </div>
  );
}

function blockClassName(type: PageBlockType): string {
  switch (type) {
    case "heading1":
      return "text-3xl font-semibold";
    case "heading2":
      return "text-xl font-semibold";
    case "quote":
      return "border-l-2 border-ink/30 pl-3 italic text-ink/80";
    case "bulleted_list":
    case "numbered_list":
      return "pl-1";
    default:
      return "";
  }
}

function BlockRow({
  block,
  readOnly,
  isFirst,
  isLast,
  registerRef,
  onTextChange,
  onTypeChange,
  onEnter,
  onBackspaceEmpty,
  onMoveUp,
  onMoveDown,
  onDelete,
  onAddBelow,
}: {
  block: PageBlock;
  readOnly: boolean;
  isFirst: boolean;
  isLast: boolean;
  registerRef: (el: HTMLTextAreaElement | null) => void;
  onTextChange: (text: string) => void;
  onTypeChange: (type: PageBlockType) => void;
  onEnter: () => void;
  onBackspaceEmpty: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onAddBelow: () => void;
}) {
  if (block.type === "divider") {
    return (
      <div className="group relative flex items-center gap-2 py-3">
        <hr className="flex-1 border-ink/20" />
        {!readOnly && (
          <BlockToolbar
            isFirst={isFirst}
            isLast={isLast}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            onDelete={onDelete}
            onAddBelow={onAddBelow}
          />
        )}
      </div>
    );
  }

  const marker =
    block.type === "bulleted_list" ? "•" : block.type === "numbered_list" ? "1." : null;

  return (
    <div className="group relative flex items-start gap-2">
      {marker && <span className="mt-0.5 select-none text-ink/50">{marker}</span>}
      {readOnly ? (
        <div className={`flex-1 whitespace-pre-wrap py-0.5 ${blockClassName(block.type)}`}>
          {block.text || <span className="text-ink/30">&nbsp;</span>}
        </div>
      ) : (
        <AutoTextarea
          value={block.text ?? ""}
          className={`flex-1 resize-none bg-transparent py-0.5 outline-none placeholder:text-ink/30 ${blockClassName(
            block.type,
          )}`}
          placeholder={PAGE_BLOCK_LABELS[block.type]}
          registerRef={registerRef}
          onChange={onTextChange}
          onEnter={onEnter}
          onBackspaceEmpty={onBackspaceEmpty}
        />
      )}
      {!readOnly && (
        <div className="flex items-center gap-1">
          <select
            value={block.type}
            onChange={(e) => onTypeChange(e.target.value as PageBlockType)}
            className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 rounded border border-ink/15 bg-transparent px-1 py-0.5 text-[10px] text-ink/60 outline-none"
            title="Tipo de bloco"
          >
            {(Object.keys(PAGE_BLOCK_LABELS) as PageBlockType[]).map((value) => (
              <option key={value} value={value}>
                {PAGE_BLOCK_LABELS[value]}
              </option>
            ))}
          </select>
          <BlockToolbar
            isFirst={isFirst}
            isLast={isLast}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            onDelete={onDelete}
            onAddBelow={onAddBelow}
          />
        </div>
      )}
    </div>
  );
}

function BlockToolbar({
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onDelete,
  onAddBelow,
}: {
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onAddBelow: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <button
        type="button"
        onClick={onAddBelow}
        title="Adicionar bloco abaixo"
        className="grid size-5 place-items-center rounded text-ink/40 hover:bg-ink/10 hover:text-ink"
      >
        <Plus className="size-3" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onMoveUp}
        disabled={isFirst}
        title="Mover para cima"
        className="grid size-5 place-items-center rounded text-ink/40 hover:bg-ink/10 hover:text-ink disabled:opacity-20"
      >
        <ChevronUp className="size-3" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onMoveDown}
        disabled={isLast}
        title="Mover para baixo"
        className="grid size-5 place-items-center rounded text-ink/40 hover:bg-ink/10 hover:text-ink disabled:opacity-20"
      >
        <ChevronDown className="size-3" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        title="Remover bloco"
        className="grid size-5 place-items-center rounded text-ink/40 hover:bg-destructive/10 hover:text-destructive"
      >
        <Minus className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}

// Grows with content instead of scrolling internally, and translates
// Enter/Backspace into block-level operations (new block / merge-delete)
// instead of literal newlines — Shift+Enter still inserts a real line break
// for the rare multi-line paragraph.
function AutoTextarea({
  value,
  className,
  placeholder,
  registerRef,
  onChange,
  onEnter,
  onBackspaceEmpty,
}: {
  value: string;
  className: string;
  placeholder: string;
  registerRef: (el: HTMLTextAreaElement | null) => void;
  onChange: (text: string) => void;
  onEnter: () => void;
  onBackspaceEmpty: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const resize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  return (
    <textarea
      ref={(el) => {
        ref.current = el;
        registerRef(el);
        if (el) resize(el);
      }}
      value={value}
      rows={1}
      placeholder={placeholder}
      onChange={(e) => {
        onChange(e.target.value);
        resize(e.target);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onEnter();
        } else if (e.key === "Backspace" && e.currentTarget.value === "") {
          e.preventDefault();
          onBackspaceEmpty();
        }
      }}
      className={className}
    />
  );
}
