import { useState, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Folder, FileRow } from "@/lib/board-types";
import { FOLDER_ICONS } from "@/lib/board-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronRight, Plus, Trash2, FolderPlus, FilePlus2, Upload, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Props {
  campaignId: string;
  folders: Folder[];
  files: FileRow[];
  isMaster: boolean;
  /** Native HTML5 drag-and-drop (draggable/dataTransfer) has no touch
   * equivalent in any mobile browser, so on mobile we fall back to
   * tap-to-add instead of drag-to-drop. */
  isMobile?: boolean;
  onAddFile?: (fileId: string) => void;
}

// Uploads land in a shared Storage bucket and are later rendered as <img>
// (for images) or offered for reference (for documents) to everyone in the
// campaign, so we validate both size and MIME type client-side before
// spending an upload round-trip. (Server-side, Storage/RLS still constrain
// who can write to a given campaign's path — this is a UX/cost guard, not
// the security boundary.)
const MAX_UPLOAD_SIZE_BYTES = 15 * 1024 * 1024; // 15MB
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
]);

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function ArchiveSidebar({
  campaignId,
  folders,
  files,
  isMaster,
  isMobile = false,
  onAddFile,
}: Props) {
  const qc = useQueryClient();
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [targetParent, setTargetParent] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [folderName, setFolderName] = useState("");
  const [folderIcon, setFolderIcon] = useState("moon");

  const [fileName, setFileName] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [fileFolderId, setFileFolderId] = useState<string>("__root");

  const createFolder = useMutation({
    mutationFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes.user) throw new Error("Não autenticado");
      const { error } = await supabase.from("folders").insert({
        campaign_id: campaignId,
        parent_id: targetParent,
        name: folderName.trim(),
        icon: folderIcon,
        created_by: userRes.user.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Pasta criada.");
      setNewFolderOpen(false);
      setFolderName("");
      qc.invalidateQueries({ queryKey: ["folders", campaignId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createFile = useMutation({
    mutationFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes.user) throw new Error("Não autenticado");
      const { error } = await supabase.from("files").insert({
        campaign_id: campaignId,
        folder_id: fileFolderId === "__root" ? null : fileFolderId,
        name: fileName.trim(),
        kind: "document",
        icon: "scroll",
        content: fileContent,
        created_by: userRes.user.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Pergaminho selado.");
      setNewFileOpen(false);
      setFileName("");
      setFileContent("");
      qc.invalidateQueries({ queryKey: ["files", campaignId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteItem = async (kind: "folder" | "file", id: string) => {
    const table = kind === "folder" ? "folders" : "files";
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) toast.error(error.message);
    else {
      toast.success("Removido.");
      qc.invalidateQueries({ queryKey: [kind === "folder" ? "folders" : "files", campaignId] });
    }
  };

  const uploadFile = async (file: File) => {
    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      toast.error(
        `Arquivo muito grande (${formatBytes(file.size)}). O limite é ${formatBytes(MAX_UPLOAD_SIZE_BYTES)}.`,
      );
      return;
    }
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(file.type)) {
      toast.error(
        "Tipo de arquivo não suportado. Envie imagens (PNG, JPEG, WEBP, GIF), PDF ou texto.",
      );
      return;
    }
    const { data: userRes } = await supabase.auth.getUser();
    if (!userRes.user) return;
    const ext = file.name.split(".").pop() ?? "bin";
    const path = `${campaignId}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from("campaign-assets")
      .upload(path, file, { cacheControl: "3600" });
    if (upErr) return toast.error(upErr.message);
    const kind = file.type.startsWith("image/") ? "image" : "document";
    const { error } = await supabase.from("files").insert({
      campaign_id: campaignId,
      folder_id: null,
      name: file.name,
      kind: kind as "image" | "document",
      icon: kind === "image" ? "map" : "scroll",
      storage_path: path,
      created_by: userRes.user.id,
    });
    if (error) return toast.error(error.message);
    toast.success("Arquivo arquivado.");
    qc.invalidateQueries({ queryKey: ["files", campaignId] });
  };

  const rootFolders = folders.filter((f) => f.parent_id === null);
  const rootFiles = files.filter((f) => f.folder_id === null);

  const onDragFile = (e: React.DragEvent, fileId: string) => {
    e.dataTransfer.setData("text/file-id", fileId);
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <aside className="flex h-full w-80 max-w-[85vw] shrink-0 flex-col border-l border-primary/15 bg-ink-2/60 backdrop-blur-md">
      <div className="border-b border-primary/15 p-4">
        <h2 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-primary/70">
          Arquivo Arcano
        </h2>
        <p className="grimoire-title text-base italic text-foreground/80">Cloud Archive</p>
      </div>

      {isMaster && (
        <div className="flex gap-1 border-b border-primary/10 p-3">
          <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
            <DialogTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="flex-1 text-xs text-primary/80 hover:bg-primary/10 hover:text-primary"
                onClick={() => setTargetParent(null)}
              >
                <FolderPlus className="mr-1.5 size-3.5" />
                Pasta
              </Button>
            </DialogTrigger>
            <DialogContent className="gold-frame">
              <DialogHeader>
                <DialogTitle className="grimoire-title text-primary">Nova pasta</DialogTitle>
                <DialogDescription>Organize seu grimório em capítulos.</DialogDescription>
              </DialogHeader>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!folderName.trim()) return;
                  createFolder.mutate();
                }}
                className="space-y-4"
              >
                <div className="space-y-2">
                  <Label htmlFor="fn">Nome</Label>
                  <Input
                    id="fn"
                    value={folderName}
                    onChange={(e) => setFolderName(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                <div className="space-y-2">
                  <Label>Ícone</Label>
                  <div className="grid grid-cols-7 gap-2">
                    {Object.entries(FOLDER_ICONS).map(([key, glyph]) => (
                      <button
                        type="button"
                        key={key}
                        onClick={() => setFolderIcon(key)}
                        className={`grid aspect-square place-items-center rounded font-serif text-lg transition-all ${
                          folderIcon === key
                            ? "bg-primary/20 text-primary ring-1 ring-primary/50"
                            : "bg-ink-2/60 text-muted-foreground hover:text-primary hover:bg-primary/10"
                        }`}
                      >
                        {glyph}
                      </button>
                    ))}
                  </div>
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={createFolder.isPending}>
                    {createFolder.isPending ? (
                      <>
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        <span className="sr-only">Criando…</span>
                      </>
                    ) : (
                      "Criar"
                    )}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog open={newFileOpen} onOpenChange={setNewFileOpen}>
            <DialogTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="flex-1 text-xs text-primary/80 hover:bg-primary/10 hover:text-primary"
              >
                <FilePlus2 className="mr-1.5 size-3.5" />
                Documento
              </Button>
            </DialogTrigger>
            <DialogContent className="gold-frame max-w-lg">
              <DialogHeader>
                <DialogTitle className="grimoire-title text-primary">Novo pergaminho</DialogTitle>
                <DialogDescription>Lore, regras, fichas — texto livre.</DialogDescription>
              </DialogHeader>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!fileName.trim()) return;
                  createFile.mutate();
                }}
                className="space-y-4"
              >
                <div className="space-y-2">
                  <Label htmlFor="doc-name">Título</Label>
                  <Input
                    id="doc-name"
                    value={fileName}
                    onChange={(e) => setFileName(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                <div className="space-y-2">
                  <Label>Pasta</Label>
                  <Select value={fileFolderId} onValueChange={setFileFolderId}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__root">Raiz</SelectItem>
                      {folders.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {FOLDER_ICONS[f.icon] ?? "◆"} {f.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="doc-body">Conteúdo</Label>
                  <Textarea
                    id="doc-body"
                    value={fileContent}
                    onChange={(e) => setFileContent(e.target.value)}
                    rows={10}
                    className="grimoire-title text-base"
                    placeholder="Escreva a lore, regras, notas do NPC…"
                  />
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={createFile.isPending}>
                    {createFile.isPending ? (
                      <>
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        <span className="sr-only">Selando…</span>
                      </>
                    ) : (
                      "Selar"
                    )}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      )}

      <div className="scrollbar-arcane flex-1 overflow-y-auto p-3">
        <div className="space-y-0.5">
          {rootFolders.map((f) => (
            <FolderNode
              key={f.id}
              folder={f}
              folders={folders}
              files={files}
              open={openFolders}
              setOpen={setOpenFolders}
              isMaster={isMaster}
              onDeleteFolder={(id) => deleteItem("folder", id)}
              onDeleteFile={(id) => deleteItem("file", id)}
              onDragFile={onDragFile}
              isMobile={isMobile}
              onAddFile={onAddFile}
              depth={0}
            />
          ))}
          {rootFiles.map((f) => (
            <FileNode
              key={f.id}
              file={f}
              isMaster={isMaster}
              onDelete={() => deleteItem("file", f.id)}
              onDragFile={onDragFile}
              isMobile={isMobile}
              onAddFile={onAddFile}
              depth={0}
            />
          ))}
          {rootFolders.length === 0 && rootFiles.length === 0 && (
            <div className="py-8 text-center text-xs text-muted-foreground italic">
              Grimório em branco.
            </div>
          )}
        </div>
      </div>

      {isMaster && (
        <div className="p-4">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadFile(f);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="group flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary/15 p-6 transition-all hover:border-primary/40 hover:bg-primary/5"
          >
            <div className="grid size-8 place-items-center rounded-full border border-primary/25 text-primary/50 group-hover:text-primary">
              <Upload className="size-4" />
            </div>
            <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground group-hover:text-primary">
              Arquivar imagem / mapa
            </span>
          </button>
        </div>
      )}
    </aside>
  );
}

function FolderNode({
  folder,
  folders,
  files,
  open,
  setOpen,
  isMaster,
  onDeleteFolder,
  onDeleteFile,
  onDragFile,
  isMobile = false,
  onAddFile,
  depth,
}: {
  folder: Folder;
  folders: Folder[];
  files: FileRow[];
  open: Record<string, boolean>;
  setOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  isMaster: boolean;
  onDeleteFolder: (id: string) => void;
  onDeleteFile: (id: string) => void;
  onDragFile: (e: React.DragEvent, fileId: string) => void;
  isMobile?: boolean;
  onAddFile?: (fileId: string) => void;
  depth: number;
}) {
  const isOpen = open[folder.id] ?? true;
  const children = folders.filter((f) => f.parent_id === folder.id);
  const childFiles = files.filter((f) => f.folder_id === folder.id);

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
            {FOLDER_ICONS[folder.icon] ?? "◆"}
          </span>
          <span className="truncate font-medium">{folder.name}</span>
        </button>
        {isMaster && (
          <button
            onClick={() => onDeleteFolder(folder.id)}
            aria-label={`Remover pasta ${folder.name}`}
            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
            title="Remover"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {isOpen && (
        <div className="border-l border-primary/10 ml-4 mt-0.5">
          {children.map((c) => (
            <FolderNode
              key={c.id}
              folder={c}
              folders={folders}
              files={files}
              open={open}
              setOpen={setOpen}
              isMaster={isMaster}
              onDeleteFolder={onDeleteFolder}
              onDeleteFile={onDeleteFile}
              onDragFile={onDragFile}
              isMobile={isMobile}
              onAddFile={onAddFile}
              depth={depth + 1}
            />
          ))}
          {childFiles.map((f) => (
            <FileNode
              key={f.id}
              file={f}
              isMaster={isMaster}
              onDelete={() => onDeleteFile(f.id)}
              onDragFile={onDragFile}
              isMobile={isMobile}
              onAddFile={onAddFile}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FileNode({
  file,
  isMaster,
  onDelete,
  onDragFile,
  isMobile = false,
  onAddFile,
  depth,
}: {
  file: FileRow;
  isMaster: boolean;
  onDelete: () => void;
  onDragFile: (e: React.DragEvent, fileId: string) => void;
  isMobile?: boolean;
  onAddFile?: (fileId: string) => void;
  depth: number;
}) {
  const glyph = file.kind === "image" || file.kind === "map" ? "✧" : "❦";
  return (
    <div
      draggable={!isMobile}
      onDragStart={isMobile ? undefined : (e) => onDragFile(e, file.id)}
      onClick={isMobile ? () => onAddFile?.(file.id) : undefined}
      className={`group flex items-center gap-2 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-primary/5 hover:text-primary ${
        isMobile ? "cursor-pointer active:bg-primary/10" : "cursor-grab"
      }`}
      style={{ paddingLeft: 8 + depth * 12 + 12 }}
      title={isMobile ? "Toque para adicionar à mesa" : "Arraste para a mesa"}
    >
      <span aria-hidden="true" className="text-primary/60">
        {glyph}
      </span>
      <span className="flex-1 truncate">{file.name}</span>
      {isMaster && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={`Remover ${file.name}`}
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
        >
          <Trash2 className="size-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
