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
import { ChevronRight, Trash2, FolderPlus, FilePlus2, Eye, EyeOff } from "lucide-react";
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

  const rootFolders = folders.filter((f) => f.parent_id === null);
  const rootPages = leaves.filter((f) => f.parent_id === null);

  return (
    <aside className="scrollbar-arcane flex h-full w-64 shrink-0 flex-col overflow-y-auto border-r border-primary/15 bg-ink-2/40">
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

      <div className="flex-1 p-2">
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
  depth: number;
}) {
  const isOpen = open[folder.id] ?? true;
  const children = allFolders.filter((f) => f.parent_id === folder.id);
  const childPages = allPages.filter((p) => p.parent_id === folder.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder.title);

  return (
    <div>
      <div
        className="group flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-primary/5 hover:text-primary"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <button
          onClick={() => setOpen((s) => ({ ...s, [folder.id]: !isOpen }))}
          aria-expanded={isOpen}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            aria-hidden="true"
            className={`size-3 shrink-0 text-primary/60 transition-transform ${isOpen ? "rotate-90" : ""}`}
          />
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
          <button
            onClick={() => onDeleteFolder(folder.id)}
            aria-label={`Remover capítulo ${folder.title}`}
            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
            title="Remover"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {isOpen && (
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
  depth,
}: {
  page: CampaignPage;
  isMaster: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onTogglePublish: () => void;
  depth: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(page.title);

  return (
    <div
      onClick={onSelect}
      className={`group flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-primary/5 hover:text-primary ${
        isSelected ? "bg-primary/10 text-primary" : "text-muted-foreground"
      }`}
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
              onTogglePublish();
            }}
            aria-label={page.is_published ? "Despublicar" : "Publicar para jogadores"}
            title={page.is_published ? "Visível para jogadores" : "Só o mestre vê"}
            className={`transition-opacity hover:text-primary ${
              page.is_published ? "opacity-70" : "opacity-0 group-hover:opacity-70"
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
            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
          >
            <Trash2 className="size-3" aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}
