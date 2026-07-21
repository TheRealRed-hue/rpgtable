import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { CampaignPage } from "@/lib/board-types";
import { PAGE_ICONS } from "@/lib/board-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronRight, Trash2, FolderPlus, FilePlus2, Eye, EyeOff, Lock, LockOpen, Pencil } from "lucide-react";
import { toast } from "sonner";

interface Props {
  campaignId: string;
  pages: CampaignPage[];
  selectedId: string | null;
  onSelect: (page: CampaignPage) => void;
  isMaster: boolean;
}

export function GrimoireSidebar({ campaignId, pages, selectedId, onSelect, isMaster }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newPageOpen, setNewPageOpen] = useState(false);
  const [targetParent, setTargetParent] = useState<string | null>(null);
  const [name, setName] = useState("");
  // Drag-and-drop re-parenting (master only). `draggedId` tracks what's
  // being carried; `dragOverId` is which drop target is currently
  // highlighted — `"__root"` stands in for the sidebar's empty background,
  // meaning "take this out of its chapter".
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const folders = pages.filter((p) => p.is_folder);
  const leaves = pages.filter((p) => !p.is_folder);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["campaign_pages", campaignId] });

  const createFolder = useMutation({
    mutationFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes.user) throw new Error("Não autenticado");
      const { error } = await supabase.from("campaign_pages").insert({
        campaign_id: campaignId,
        parent_id: targetParent,
        is_folder: true,
        title: name.trim(),
        icon: "book",
        created_by: userRes.user.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Capítulo criado.");
      setNewFolderOpen(false);
      setName("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createPage = useMutation({
    mutationFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes.user) throw new Error("Não autenticado");
      const { data, error } = await supabase
        .from("campaign_pages")
        .insert({
          campaign_id: campaignId,
          parent_id: targetParent,
          is_folder: false,
          title: name.trim(),
          icon: "scroll",
          blocks: [{ id: crypto.randomUUID(), type: "heading1", text: name.trim() }],
          created_by: userRes.user.id,
        })
        .select()
        .single();
      if (error) throw error;
      return data as CampaignPage;
    },
    onSuccess: (page) => {
      toast.success("Página criada.");
      setNewPageOpen(false);
      setName("");
      invalidate();
      onSelect(page);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ON DELETE CASCADE on campaign_pages.parent_id means removing a folder
  // here takes every nested folder/page with it at the database level — no
  // client-side tree-walking needed the way ArchiveSidebar has to for
  // folders/files (which don't cascade the same way).
  const deletePage = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("campaign_pages").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  const renamePage = useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      const { error } = await supabase.from("campaign_pages").update({ title }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  const togglePublish = useMutation({
    mutationFn: async (page: CampaignPage) => {
      const { error } = await supabase
        .from("campaign_pages")
        .update({ is_published: !page.is_published })
        .eq("id", page.id);
      if (error) throw error;
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  // Locking a chapter keeps its title visible to players (so they know it
  // exists) but hides everything inside it — enforced server-side by the
  // campaign_page_visible_to_player() RLS check, not just hidden in the UI.
  const toggleLock = useMutation({
    mutationFn: async (folder: CampaignPage) => {
      const { error } = await supabase
        .from("campaign_pages")
        .update({ is_locked: !folder.is_locked })
        .eq("id", folder.id);
      if (error) throw error;
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  // Re-parents a dragged page or chapter. `parentId: null` moves it to the
  // root of the grimório (dragged out of any chapter).
  const moveItem = useMutation({
    mutationFn: async ({ id, parentId }: { id: string; parentId: string | null }) => {
      const { error } = await supabase
        .from("campaign_pages")
        .update({ parent_id: parentId })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  // Walks down from `rootId` through its children looking for `targetId` —
  // used to stop a chapter from being dragged into one of its own
  // descendants, which would otherwise create a cycle in the tree.
  const isDescendant = (rootId: string, targetId: string): boolean => {
    const children = pages.filter((p) => p.parent_id === rootId);
    return children.some((c) => c.id === targetId || isDescendant(c.id, targetId));
  };

  const handleDrop = (targetFolderId: string | null) => {
    if (!draggedId) return;
    const dragged = pages.find((p) => p.id === draggedId);
    if (!dragged) return;
    if (draggedId === targetFolderId) return; // dropped on itself
    if (dragged.parent_id === targetFolderId) return; // no-op, already there
    if (dragged.is_folder && targetFolderId && isDescendant(draggedId, targetFolderId)) {
      toast.error("Não é possível mover um capítulo para dentro dele mesmo.");
      return;
    }
    moveItem.mutate({ id: draggedId, parentId: targetFolderId });
    setDraggedId(null);
    setDragOverId(null);
  };

  const rootFolders = folders.filter((f) => f.parent_id === null);
  const rootPages = leaves.filter((f) => f.parent_id === null);

  return (
    <aside className="scrollbar-arcane flex h-full w-64 max-w-[85vw] shrink-0 flex-col overflow-y-auto border-r border-primary/15 bg-ink-2/40">
      {isMaster && (
        <div className="flex gap-1 border-b border-primary/10 p-2">
          <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
            <DialogTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="flex-1 text-xs text-muted-foreground hover:text-primary"
                onClick={() => setTargetParent(null)}
              >
                <FolderPlus className="mr-1.5 size-3.5" aria-hidden="true" />
                Capítulo
              </Button>
            </DialogTrigger>
            <DialogContent className="gold-frame">
              <DialogHeader>
                <DialogTitle className="grimoire-title text-primary">Novo capítulo</DialogTitle>
                <DialogDescription>Organize suas páginas em capítulos.</DialogDescription>
              </DialogHeader>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim()) createFolder.mutate();
                }}
                className="space-y-4"
              >
                <div className="space-y-2">
                  <Label htmlFor="folder-name">Nome</Label>
                  <Input
                    id="folder-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ex: Bestiário"
                    required
                    autoFocus
                  />
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={createFolder.isPending}>
                    Criar
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog open={newPageOpen} onOpenChange={setNewPageOpen}>
            <DialogTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="flex-1 text-xs text-muted-foreground hover:text-primary"
                onClick={() => setTargetParent(null)}
              >
                <FilePlus2 className="mr-1.5 size-3.5" aria-hidden="true" />
                Página
              </Button>
            </DialogTrigger>
            <DialogContent className="gold-frame">
              <DialogHeader>
                <DialogTitle className="grimoire-title text-primary">Nova página</DialogTitle>
                <DialogDescription>Lore, sistema, skills — o que quiser registrar.</DialogDescription>
              </DialogHeader>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim()) createPage.mutate();
                }}
                className="space-y-4"
              >
                <div className="space-y-2">
                  <Label htmlFor="page-name">Título</Label>
                  <Input
                    id="page-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ex: Regras de combate"
                    required
                    autoFocus
                  />
                </div>
                <div className="space-y-2">
                  <Label>Capítulo</Label>
                  <Select
                    value={targetParent ?? "__root"}
                    onValueChange={(v) => setTargetParent(v === "__root" ? null : v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__root">Sem capítulo</SelectItem>
                      {folders.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={createPage.isPending}>
                    Criar
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      )}

      <div
        className={`flex-1 p-2 ${isMaster && draggedId && dragOverId === "__root" ? "bg-primary/5 ring-1 ring-inset ring-primary/25" : ""}`}
        onDragOver={(e) => {
          if (!isMaster || !draggedId) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDragOverId("__root");
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOverId(null);
        }}
        onDrop={(e) => {
          if (!isMaster) return;
          e.preventDefault();
          handleDrop(null);
        }}
      >
        {rootFolders.map((f) => (
          <FolderNode
            key={f.id}
            folder={f}
            allFolders={folders}
            allPages={leaves}
            open={open}
            setOpen={setOpen}
            isMaster={isMaster}
            selectedId={selectedId}
            onSelect={onSelect}
            onDeleteFolder={(id) => deletePage.mutate(id)}
            onDeletePage={(id) => deletePage.mutate(id)}
            onRename={(id, title) => renamePage.mutate({ id, title })}
            onTogglePublish={(p) => togglePublish.mutate(p)}
            onToggleLock={(f2) => toggleLock.mutate(f2)}
            draggedId={draggedId}
            setDraggedId={setDraggedId}
            dragOverId={dragOverId}
            setDragOverId={setDragOverId}
            onDropOnFolder={handleDrop}
            depth={0}
          />
        ))}
        {rootPages.map((p) => (
          <PageNode
            key={p.id}
            page={p}
            isMaster={isMaster}
            isSelected={p.id === selectedId}
            onSelect={() => onSelect(p)}
            onDelete={() => deletePage.mutate(p.id)}
            onRename={(title) => renamePage.mutate({ id: p.id, title })}
            onTogglePublish={() => togglePublish.mutate(p)}
            draggedId={draggedId}
            setDraggedId={setDraggedId}
            onDropOnFolder={handleDrop}
            depth={0}
          />
        ))}
        {rootFolders.length === 0 && rootPages.length === 0 && (
          <div className="py-8 text-center text-xs text-muted-foreground italic">
            {isMaster ? "Grimório em branco." : "Nada publicado ainda."}
          </div>
        )}
      </div>
    </aside>
  );
}

function FolderNode({
  folder,
  allFolders,
  allPages,
  open,
  setOpen,
  isMaster,
  selectedId,
  onSelect,
  onDeleteFolder,
  onDeletePage,
  onRename,
  onTogglePublish,
  onToggleLock,
  draggedId,
  setDraggedId,
  dragOverId,
  setDragOverId,
  onDropOnFolder,
  depth,
}: {
  folder: CampaignPage;
  allFolders: CampaignPage[];
  allPages: CampaignPage[];
  open: Record<string, boolean>;
  setOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  isMaster: boolean;
  selectedId: string | null;
  onSelect: (page: CampaignPage) => void;
  onDeleteFolder: (id: string) => void;
  onDeletePage: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePublish: (page: CampaignPage) => void;
  onToggleLock: (folder: CampaignPage) => void;
  draggedId: string | null;
  setDraggedId: React.Dispatch<React.SetStateAction<string | null>>;
  dragOverId: string | null;
  setDragOverId: React.Dispatch<React.SetStateAction<string | null>>;
  onDropOnFolder: (folderId: string | null) => void;
  depth: number;
}) {
  const isOpen = open[folder.id] ?? true;
  const children = allFolders.filter((f) => f.parent_id === folder.id);
  const childPages = allPages.filter((p) => p.parent_id === folder.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder.title);

  // Players never receive a locked chapter's descendants from the server
  // (RLS cuts them off), so there's nothing to expand into — the toggle is
  // disabled and shows a padlock instead of pretending there's content.
  const lockedForPlayer = folder.is_locked && !isMaster;
  const isDropTarget = draggedId && draggedId !== folder.id && dragOverId === folder.id;

  return (
    <div>
      <div
        draggable={isMaster && !editing}
        onDragStart={(e) => {
          if (!isMaster) return;
          e.stopPropagation();
          setDraggedId(folder.id);
        }}
        onDragEnd={() => {
          setDraggedId(null);
          setDragOverId(null);
        }}
        onDragOver={(e) => {
          if (!isMaster || !draggedId || draggedId === folder.id) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          setDragOverId(folder.id);
        }}
        onDragLeave={(e) => {
          e.stopPropagation();
          if (dragOverId === folder.id) setDragOverId(null);
        }}
        onDrop={(e) => {
          if (!isMaster) return;
          e.preventDefault();
          e.stopPropagation();
          onDropOnFolder(folder.id);
        }}
        className={`group flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-primary/5 hover:text-primary ${
          isDropTarget ? "bg-primary/10 ring-1 ring-inset ring-primary/40" : ""
        } ${draggedId === folder.id ? "opacity-40" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <button
          onClick={() => {
            if (lockedForPlayer) return;
            setOpen((s) => ({ ...s, [folder.id]: !isOpen }));
          }}
          aria-expanded={isOpen}
          aria-disabled={lockedForPlayer}
          className={`flex flex-1 items-center gap-2 text-left ${lockedForPlayer ? "cursor-default" : ""}`}
        >
          {lockedForPlayer ? (
            <Lock className="size-3 shrink-0 text-primary/50" aria-hidden="true" />
          ) : (
            <ChevronRight
              aria-hidden="true"
              className={`size-3 shrink-0 text-primary/60 transition-transform ${isOpen ? "rotate-90" : ""}`}
            />
          )}
          <span
            aria-hidden="true"
            className="grid size-5 shrink-0 place-items-center font-serif text-lg leading-none text-primary/80"
          >
            {PAGE_ICONS[folder.icon] ?? "◆"}
          </span>
          {editing ? (
            <input
              autoFocus
              value={draft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                setEditing(false);
                if (draft.trim() && draft !== folder.title) onRename(folder.id, draft.trim());
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  setDraft(folder.title);
                  e.currentTarget.blur();
                }
              }}
              className="flex-1 truncate border-b border-primary/40 bg-transparent font-medium outline-none"
            />
          ) : (
            <span
              className="truncate font-medium"
              onDoubleClick={(e) => {
                if (!isMaster) return;
                e.stopPropagation();
                setEditing(true);
              }}
            >
              {folder.title}
            </span>
          )}
        </button>
        {isMaster && !editing && (
          <>
            <button
              onClick={() => setEditing(true)}
              aria-label={`Renomear capítulo ${folder.title}`}
              title="Renomear"
              className="opacity-70 transition-opacity md:opacity-0 md:group-hover:opacity-70 hover:text-primary"
            >
              <Pencil className="size-3.5" aria-hidden="true" />
            </button>
            <button
              onClick={() => onToggleLock(folder)}
              aria-label={folder.is_locked ? "Destrancar capítulo" : "Trancar capítulo"}
              title={
                folder.is_locked
                  ? "Trancado — jogadores veem o nome, mas não abrem"
                  : "Trancar para os jogadores"
              }
              className={`transition-opacity hover:text-primary ${
                folder.is_locked ? "opacity-70" : "opacity-70 md:opacity-0 md:group-hover:opacity-70"
              }`}
            >
              {folder.is_locked ? (
                <Lock className="size-3.5" aria-hidden="true" />
              ) : (
                <LockOpen className="size-3.5" aria-hidden="true" />
              )}
            </button>
            <button
              onClick={() => onTogglePublish(folder)}
              aria-label={folder.is_published ? "Esconder capítulo" : "Mostrar capítulo aos jogadores"}
              title={folder.is_published ? "Visível para jogadores" : "Só o mestre vê"}
              className={`transition-opacity hover:text-primary ${
                folder.is_published ? "opacity-70" : "opacity-70 md:opacity-0 md:group-hover:opacity-70"
              }`}
            >
              {folder.is_published ? (
                <Eye className="size-3.5" aria-hidden="true" />
              ) : (
                <EyeOff className="size-3.5" aria-hidden="true" />
              )}
            </button>
            <button
              onClick={() => onDeleteFolder(folder.id)}
              aria-label={`Remover capítulo ${folder.title}`}
              className="opacity-70 transition-opacity md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
              title="Remover"
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </button>
          </>
        )}
      </div>

      {isOpen && !lockedForPlayer && (
        <div className="ml-4 mt-0.5 border-l border-primary/10">
          {children.map((c) => (
            <FolderNode
              key={c.id}
              folder={c}
              allFolders={allFolders}
              allPages={allPages}
              open={open}
              setOpen={setOpen}
              isMaster={isMaster}
              selectedId={selectedId}
              onSelect={onSelect}
              onDeleteFolder={onDeleteFolder}
              onDeletePage={onDeletePage}
              onRename={onRename}
              onTogglePublish={onTogglePublish}
              onToggleLock={onToggleLock}
              draggedId={draggedId}
              setDraggedId={setDraggedId}
              dragOverId={dragOverId}
              setDragOverId={setDragOverId}
              onDropOnFolder={onDropOnFolder}
              depth={depth + 1}
            />
          ))}
          {childPages.map((p) => (
            <PageNode
              key={p.id}
              page={p}
              isMaster={isMaster}
              isSelected={p.id === selectedId}
              onSelect={() => onSelect(p)}
              onDelete={() => onDeletePage(p.id)}
              onRename={(title) => onRename(p.id, title)}
              onTogglePublish={() => onTogglePublish(p)}
              draggedId={draggedId}
              setDraggedId={setDraggedId}
              onDropOnFolder={onDropOnFolder}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PageNode({
  page,
  isMaster,
  isSelected,
  onSelect,
  onDelete,
  onRename,
  onTogglePublish,
  draggedId,
  setDraggedId,
  onDropOnFolder,
  depth,
}: {
  page: CampaignPage;
  isMaster: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onTogglePublish: () => void;
  draggedId: string | null;
  setDraggedId: React.Dispatch<React.SetStateAction<string | null>>;
  onDropOnFolder: (folderId: string | null) => void;
  depth: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(page.title);

  return (
    <div
      draggable={isMaster && !editing}
      onDragStart={(e) => {
        if (!isMaster) return;
        e.stopPropagation();
        setDraggedId(page.id);
      }}
      onDragEnd={() => setDraggedId(null)}
      onDragOver={(e) => {
        if (!isMaster || !draggedId || draggedId === page.id) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        if (!isMaster || !draggedId || draggedId === page.id) return;
        e.preventDefault();
        e.stopPropagation();
        onDropOnFolder(page.parent_id);
      }}
      onClick={onSelect}
      className={`group flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-primary/5 hover:text-primary ${
        isSelected ? "bg-primary/10 text-primary" : "text-muted-foreground"
      } ${draggedId === page.id ? "opacity-40" : ""}`}
      style={{ paddingLeft: 8 + depth * 12 + 12 }}
    >
      <span aria-hidden="true" className="text-primary/60">
        {PAGE_ICONS[page.icon] ?? "❦"}
      </span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (draft.trim() && draft !== page.title) onRename(draft.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setDraft(page.title);
              e.currentTarget.blur();
            }
          }}
          className="flex-1 truncate border-b border-primary/40 bg-transparent outline-none"
        />
      ) : (
        <span
          className="flex-1 truncate"
          onDoubleClick={(e) => {
            if (!isMaster) return;
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {page.title}
        </span>
      )}
      {isMaster && !editing && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            aria-label={`Renomear ${page.title}`}
            title="Renomear"
            className="opacity-70 transition-opacity md:opacity-0 md:group-hover:opacity-70 hover:text-primary"
          >
            <Pencil className="size-3" aria-hidden="true" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onTogglePublish();
            }}
            aria-label={page.is_published ? "Despublicar" : "Publicar para jogadores"}
            title={page.is_published ? "Visível para jogadores" : "Só o mestre vê"}
            className={`transition-opacity hover:text-primary ${
              page.is_published ? "opacity-70" : "opacity-70 md:opacity-0 md:group-hover:opacity-70"
            }`}
          >
            {page.is_published ? (
              <Eye className="size-3.5" aria-hidden="true" />
            ) : (
              <EyeOff className="size-3.5" aria-hidden="true" />
            )}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            aria-label={`Remover ${page.title}`}
            className="opacity-70 transition-opacity md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
          >
            <Trash2 className="size-3" aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}
